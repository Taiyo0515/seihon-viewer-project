import { addCollectedClip } from "../../common/db.js";
import { sanitizeFileName, saveBlobAs } from "../../common/files.js";
import { renderSpreadPng } from "../spread-image.js";
import { renderPagePng } from "../image-export.js";
import { loadPdfFromBytes } from "../page-export.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// All edits use page-relative coordinates, including after scrolling or zooming.
function adjustRegion(box, edge, dx, dy, minWidth, minHeight) {
  if (edge === "move") {
    return { ...box, x: clamp(box.x + dx, 0, 1 - box.w), y: clamp(box.y + dy, 0, 1 - box.h) };
  }
  let left = box.x, top = box.y, right = left + box.w, bottom = top + box.h;
  if (edge.includes("w")) left = clamp(left + dx, 0, right - minWidth);
  if (edge.includes("e")) right = clamp(right + dx, left + minWidth, 1);
  if (edge.includes("n")) top = clamp(top + dy, 0, bottom - minHeight);
  if (edge.includes("s")) bottom = clamp(bottom + dy, top + minHeight, 1);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// Use displayed page rectangles so right-bound spreads and different page sizes
// share the same geometry for pointer selection and export.
function measurePages(elements) {
  const pages = elements.map(el => {
    const rect = el.getBoundingClientRect();
    return { number: Number(el.dataset.pageNumber), x: rect.left + el.clientLeft,
      y: rect.top + el.clientTop, w: el.clientWidth, h: el.clientHeight };
  });
  const left = Math.min(...pages.map(p => p.x)), top = Math.min(...pages.map(p => p.y));
  const width = Math.max(...pages.map(p => p.x + p.w)) - left;
  const height = Math.max(...pages.map(p => p.y + p.h)) - top;
  return { left, top, width, height, pages };
}

function selectedParts(layout, region) {
  const x = layout.left + region.x * layout.width, y = layout.top + region.y * layout.height;
  const w = region.w * layout.width, h = region.h * layout.height;
  const parts = [];
  for (const page of layout.pages) {
    const left = Math.max(x, page.x), top = Math.max(y, page.y);
    const width = Math.min(x + w, page.x + page.w) - left;
    const height = Math.min(y + h, page.y + page.h) - top;
    if (width <= 0 || height <= 0) continue;
    parts.push({ number: page.number, x: (left-x)/w, y: (top-y)/h, w: width/w, h: height/h,
      region: { x: (left-page.x)/page.w, y: (top-page.y)/page.h, w: width/page.w, h: height/page.h } });
  }
  return parts;
}
export class RegionCapture {
  constructor({ app, collection, docSource, pageCopy, getSettings }) {
    Object.assign(this, { app, collection, docSource, pageCopy, getSettings });
    for (const event of ["pagesdestroy", "pagesedited", "rotationchanging", "spreadmodechanged", "scrollmodechanged"]) {
      app.eventBus.on(event, () => this.close());
    }
  }

  close() {
    this.observer?.disconnect();
    this.abort?.abort();
    this.layer?.remove();
    this.bar?.remove();
    this.layer = null;
  }

  async start(number = this.app.page) {
    this.close();
    const doc = this.app.pdfDocument;
    const view = this.app.pdfViewer.getPageView(number - 1);
    if (!doc || !view) { return; }
    const viewer = this.app.pdfViewer;
    if (!viewer._getVisiblePages().ids.has(number)) {
      this.app.page = number;
    }
    const rotation = viewer.pagesRotation;
    const baseName = sanitizeFileName(this.docSource.baseName());
    const pageElements = new Set([view.div]);
    let first = number, last = number;
    const includePages = () => {
      const visible = viewer._getVisiblePages().ids;
      if (!visible.size) return;
      first = Math.min(first, Math.max(1, Math.min(...visible) - 1));
      last = Math.max(last, Math.min(viewer.pagesCount, Math.max(...visible) + 1));
      for (let pageNumber = first; pageNumber <= last; pageNumber++) {
        const page = viewer.getPageView(pageNumber - 1)?.div;
        if (!page?.isConnected || pageElements.has(page)) continue;
        pageElements.add(page);
      }
    };
    includePages();
    const group = view.div.parentElement;
    if (viewer.spreadMode && group?.classList.contains("spread")) {
      for (const page of group.querySelectorAll(":scope > .page[data-page-number]")) pageElements.add(page);
    }
    const elements = [...pageElements];
    const layer = document.createElement("div");
    this.layer = layer;
    layer.className = "sh-region-layer";
    const rect = document.createElement("div");
    rect.className = "sh-region-rect";
    rect.hidden = true;
    rect.tabIndex = 0;
    rect.setAttribute("role", "group");
    rect.setAttribute("aria-label", "選択範囲。矢印キーで移動、Shiftと矢印キーで10倍移動");
    const handles = { n:"上辺", s:"下辺", e:"右辺", w:"左辺", nw:"左上", ne:"右上", sw:"左下", se:"右下" };
    for (const [edge, label] of Object.entries(handles)) {
      const handle = document.createElement("span");
      handle.className = "sh-region-handle";
      handle.dataset.edge = edge;
      handle.tabIndex = 0;
      handle.setAttribute("role", "group");
      handle.setAttribute("aria-label", label + "。矢印キーでサイズ調整");
      handle.title = label + "を調整";
      rect.append(handle);
    }
    layer.append(rect);
    // PDF.js は拡大・初回描画の際にページ要素の子を再作成する。
    // 選択面はスクロールする親に置き、そのページの内側へ追従させる。
    const container = this.app.pdfViewer.container;
    container.append(layer);
    const align = () => {
      const { left, top, width, height } = measurePages(elements);
      const c = container.getBoundingClientRect();
      Object.assign(layer.style, {
        position: "fixed", inset: "auto", left: left + "px", top: top + "px", width: width + "px", height: height + "px",
        clipPath: "inset(" + [Math.max(0, c.top - top), Math.max(0, left + width - c.right),
          Math.max(0, top + height - c.bottom), Math.max(0, c.left - left)].map(n => n + "px").join(" ") + ")",
      });
    };
    this.observer = new ResizeObserver(align);
    for (const el of elements) this.observer.observe(el);
    this.observer.observe(container);
    align();
    const bar = document.createElement("div");
    this.bar = bar;
    bar.className = "sh-region-bar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "ページの一部分を選択");
    bar.innerHTML = `<span role="status">ページ上で範囲をドラッグしてください</span>
      <button type="button" class="sh-btn" data-op="collect" disabled>収集に追加</button>
      <button type="button" class="sh-btn" data-op="save" disabled>PNGを保存…</button>
      <button type="button" class="sh-btn sh-btn-primary" data-op="copy" disabled>画像をコピー</button>
      <button type="button" class="sh-btn" data-op="close">閉じる</button>`;
    const status = bar.querySelector("[role=status]");
    const drawHint = elements.length > 1
      ? "ページをまたいでドラッグできます。ホイールでスクロールできます"
      : status.textContent;
    status.textContent = drawHint;
    document.body.append(bar);
    const actions = [...bar.querySelectorAll("button[disabled]")];
    const enable = value => { for (const button of actions) { button.disabled = !value; } };
    const controller = this.abort = new AbortController();
    this.app.eventBus.on("updateviewarea", align, { signal: controller.signal });
    const live = () => this.layer === layer && this.app.pdfDocument === doc && layer.isConnected;
    let drag, region, prepared, preparedLayout, running = false;
    const hint = "内側で移動・辺や角でサイズ調整・矢印で微移動";
    const point = e => {
      const r = layer.getBoundingClientRect();
      return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
    };
    const paint = next => {
      region = next;
      prepared = null;
      rect.hidden = !region;
      if (!region) return;
      Object.assign(rect.style, { left: region.x * 100 + "%", top: region.y * 100 + "%", width: region.w * 100 + "%", height: region.h * 100 + "%" });
    };
    const adjust = (box, edge, dx, dy) => adjustRegion(box, edge, dx, dy,
      Math.min(box.w, 3 / layer.clientWidth), Math.min(box.h, 3 / layer.clientHeight));
    const update = e => {
      drag.position = { clientX: e.clientX, clientY: e.clientY };
      const p = point(e), a = drag.anchor;
      if (drag.mode === "draw") {
        paint({ x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(a.x - p.x), h: Math.abs(a.y - p.y) });
      } else {
        paint(adjust(drag.before, drag.mode, p.x - a.x, p.y - a.y));
      }
    };
    layer.addEventListener("wheel", e => {
      if (e.ctrlKey || e.metaKey || e.defaultPrevented) return;
      // The fixed selection surface does not inherit the viewer's scroll behavior.
      e.preventDefault();
      const xUnit = e.deltaMode === 2 ? container.clientWidth : e.deltaMode === 1 ? 16 : 1;
      const yUnit = e.deltaMode === 2 ? container.clientHeight : e.deltaMode === 1 ? 16 : 1;
      container.scrollBy({ left: e.deltaX * xUnit, top: e.deltaY * yUnit, behavior: "instant" });
    }, { passive: false, signal: controller.signal });
    container.addEventListener("scroll", () => {
      if (!running) {
        const before = measurePages(elements);
        includePages();
        if (pageElements.size !== elements.length) {
          for (const page of pageElements) {
            if (elements.includes(page)) continue;
            elements.push(page);
            this.observer.observe(page);
          }
          const after = measurePages(elements);
          const rebase = box => box && {
            x: (before.left - after.left + box.x * before.width) / after.width,
            y: (before.top - after.top + box.y * before.height) / after.height,
            w: box.w * before.width / after.width,
            h: box.h * before.height / after.height,
          };
          if (drag) {
            drag.anchor = rebase(drag.anchor);
            drag.before = rebase(drag.before);
          } else if (region) {
            paint(rebase(region));
          }
        }
      }
      align();
      if (drag?.position) update(drag.position);
    }, { passive: true, signal: controller.signal });
    layer.onpointerdown = e => {
      if (running || drag || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const mode = e.target.dataset.edge || (rect.contains(e.target) ? "move" : "draw");
      drag = { id: e.pointerId, mode, anchor: point(e), before: region };
      layer.setPointerCapture(e.pointerId);
      layer.style.cursor = getComputedStyle(e.target).cursor;
      enable(false);
      update(e);
    };
    layer.onpointermove = e => { if (e.pointerId === drag?.id) update(e); };
    const finish = (e, cancel) => {
      if (e.pointerId !== drag?.id) return;
      if (!cancel) update(e);
      if (cancel || (drag.mode === "draw" && (region.w * layer.clientWidth < 3 || region.h * layer.clientHeight < 3))) paint(drag.before);
      drag = null;
      layer.style.cursor = "";
      enable(!!region);
      status.textContent = region ? hint : drawHint;
      if (region) bar.querySelector("[data-op=copy]").focus({ preventScroll: true });
    };
    layer.onpointerup = e => finish(e, false);
    layer.onpointercancel = layer.onlostpointercapture = e => finish(e, true);
    layer.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); };
    const makeImage = async parts => {
      if (!parts.length) throw new Error("ページの内容を含む範囲を選択してください");
      const numbers = parts.map(p => p.number);
      const name = baseName + "_p" + numbers.join("-") + "_範囲";
      const options = { settings: this.getSettings(), rotation };
      let source = doc, snapshot;
      try {
        if (doc.annotationStorage?.size) {
          const bytes = await this.pageCopy.buildPdf(this.pageCopy.currentPages(numbers));
          snapshot = source = await loadPdfFromBytes(bytes);
          parts.forEach((p, i) => { p.number = i + 1; });
        }
        const first = parts[0];
        if (parts.length === 1 && first.w > .999999 && first.h > .999999) {
          return { ...await renderPagePng(source, first.number, { ...options, region: first.region }), name };
        }
        const page = await source.getPage(first.number);
        const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation + 360) % 360 });
        const width = viewport.width * first.region.w / first.w;
        const height = viewport.height * first.region.h / first.h;
        return { ...await renderSpreadPng(source, parts, options, width, height), name };
      } finally {
        if (snapshot) await snapshot.loadingTask.destroy();
      }
    };
    window.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); this.close(); }
      const arrows = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] };
      if (region && !drag && !running && arrows[e.key] && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const [x, y] = arrows[e.key], step = e.shiftKey ? 10 : 1;
        const edge = rect.contains(e.target) && e.target.dataset.edge;
        paint(adjust(region, edge || "move", x * step / layer.clientWidth, y * step / layer.clientHeight));
        status.textContent = edge ? e.target.title : hint;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c" && region && !drag) {
        e.preventDefault(); e.stopImmediatePropagation(); bar.querySelector("[data-op=copy]").click();
      }
    }, { capture: true, signal: controller.signal });
    bar.onclick = async e => {
      const op = e.target.closest("button")?.dataset.op;
      if (op === "close") { this.close(); return; }
      if (!op || running || !region || !live()) { return; }
      enable(false);
      running = true;
      status.textContent = "選んだ範囲を画像にしています…";
      try {
        const parts = selectedParts(measurePages(elements), region);
        // Changing the binding direction can swap pages without changing the selection.
        const layoutKey = JSON.stringify(parts);
        if (!prepared || preparedLayout !== layoutKey) {
          preparedLayout = layoutKey;
          prepared = makeImage(parts);
        }
        const getImage = async () => {
          const result = await prepared;
          if (!live()) { throw new Error("選択を終了しました"); }
          return result;
        };
        if (op === "copy") {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": getImage().then(result => result.blob) })]);
        }
        const result = await getImage();
        if (op === "save") {
          const saved = await saveBlobAs(result.blob, result.name + ".png");
          if (!saved.ok && !saved.canceled) { throw new Error(saved.error || "保存できませんでした"); }
          if (saved.canceled) { status.textContent = "保存をキャンセルしました"; return; }
        }
        if (op === "collect") {
          const { PDFDocument } = await import("../../lib/pdf-lib.esm.min.js");
          const out = await PDFDocument.create();
          const image = await out.embedPng(await result.blob.arrayBuffer());
          const w = result.pointWidth, h = result.pointHeight;
          out.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
          const bytes = await out.save();
          if (!live()) { return; }
          await addCollectedClip(result.name, bytes, this.getSettings().collectLimitMB * 1024 * 1024);
          await this.collection.refresh();
        }
        const label = { collect: "収集に追加しました", save: "保存しました", copy: "コピーしました" }[op];
        status.textContent = result.width + " × " + result.height + " px の画像を" + label;
      } catch (err) {
        prepared = null;
        if (live()) { status.textContent = "操作できませんでした（" + (err.message || err) + "）"; }
      } finally {
        running = false; if (live()) { enable(true); }
      }
    };
  }
}
