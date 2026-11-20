import { addCollectedClip } from "../../common/db.js";
import { sanitizeFileName, saveBlobAs } from "../../common/files.js";
import { renderPagePng } from "../image-export.js";
import { loadPdfFromBytes } from "../page-export.js";

// ページ枠の内側に選択面を重ねる。見開きでもクリックした側のページだけを使う。
export class RegionCapture {
  constructor({ app, collection, docSource, pageCopy, getSettings }) {
    Object.assign(this, { app, collection, docSource, pageCopy, getSettings });
    for (const event of ["pagesdestroy", "pagesedited", "rotationchanging"]) {
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
    if (!this.app.pdfViewer._getVisiblePages().ids.has(number)) {
      this.app.page = number;
    }
    const rotation = this.app.pdfViewer.pagesRotation;
    const name = sanitizeFileName(this.docSource.baseName()) + "_p" + number + "_範囲";
    const layer = document.createElement("div");
    this.layer = layer;
    layer.className = "sh-region-layer";
    const rect = document.createElement("div");
    rect.className = "sh-region-rect";
    rect.hidden = true;
    layer.append(rect);
    // PDF.js は拡大・初回描画の際にページ要素の子を再作成する。
    // 選択面はスクロールする親に置き、そのページの内側へ追従させる。
    const container = this.app.pdfViewer.container;
    container.append(layer);
    const align = () => {
      const p = view.div.getBoundingClientRect(), c = container.getBoundingClientRect();
      const left = p.left + view.div.clientLeft, top = p.top + view.div.clientTop;
      const width = view.div.clientWidth, height = view.div.clientHeight;
      Object.assign(layer.style, {
        position: "fixed", inset: "auto", left: left + "px", top: top + "px", width: width + "px", height: height + "px",
        clipPath: "inset(" + [Math.max(0, c.top - top), Math.max(0, left + width - c.right),
          Math.max(0, top + height - c.bottom), Math.max(0, c.left - left)].map(n => n + "px").join(" ") + ")",
      });
    };
    this.observer = new ResizeObserver(align);
    this.observer.observe(view.div);
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
    document.body.append(bar);
    const status = bar.querySelector("[role=status]");
    const actions = [...bar.querySelectorAll("button[disabled]")];
    const enable = value => { for (const button of actions) { button.disabled = !value; } };
    const controller = this.abort = new AbortController();
    container.addEventListener("scroll", align, { passive: true, signal: controller.signal });
    this.app.eventBus.on("updateviewarea", align, { signal: controller.signal });
    const live = () => this.layer === layer && this.app.pdfDocument === doc && layer.isConnected;
    let anchor, pointer, region, prepared, running = false;
    const point = e => {
      const r = layer.getBoundingClientRect();
      const clamp = n => Math.min(1, Math.max(0, n));
      return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
    };
    const update = e => {
      const p = point(e);
      region = { x: Math.min(anchor.x, p.x), y: Math.min(anchor.y, p.y), w: Math.abs(anchor.x - p.x), h: Math.abs(anchor.y - p.y) };
      Object.assign(rect.style, { left: region.x * 100 + "%", top: region.y * 100 + "%", width: region.w * 100 + "%", height: region.h * 100 + "%" });
    };
    layer.onpointerdown = e => {
      if (running || pointer != null || e.button !== 0) { return; }
      e.preventDefault();
      e.stopPropagation();
      prepared = null;
      enable(false);
      pointer = e.pointerId;
      layer.setPointerCapture(pointer);
      anchor = point(e);
      rect.hidden = false;
      update(e);
    };
    layer.onpointermove = e => { if (e.pointerId === pointer) { update(e); } };
    layer.onpointercancel = () => {
      pointer = null; region = null; rect.hidden = true;
      status.textContent = "ページ上で範囲をドラッグしてください";
    };
    layer.onpointerup = e => {
      if (e.pointerId !== pointer) { return; }
      update(e);
      pointer = null;
      if (region.w * layer.clientWidth < 3 || region.h * layer.clientHeight < 3) {
        layer.onpointercancel(); return;
      }
      status.textContent = number + "ページ目の選択範囲";
      enable(true);
      bar.querySelector("[data-op=copy]").focus({ preventScroll: true });
    };
    layer.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); };
    const makeImage = async () => {
      const options = { settings: this.getSettings(), rotation, region };
      if (!doc.annotationStorage?.size) { return renderPagePng(doc, number, options); }
      // 未保存のフォーム・日本語注釈も、PDF保存と同じ外観を使う。
      const bytes = await this.pageCopy.buildPdf(this.pageCopy.currentPages([number]));
      const snapshot = await loadPdfFromBytes(bytes);
      try { return await renderPagePng(snapshot, 1, options); }
      finally { await snapshot.loadingTask.destroy(); }
    };
    window.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); this.close(); }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c" && region && pointer == null) {
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
        prepared ||= makeImage();
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
          const saved = await saveBlobAs(result.blob, name + ".png");
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
          await addCollectedClip(name, bytes, this.getSettings().collectLimitMB * 1024 * 1024);
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
