/** 収集したページを大きく表示し、回転・切り取り・整理する編集画面。 */
import { addCollectionItems, duplicateCollectionItem, editCollectionItem, getPdfBytes, putPdf, removeCollectionItems, reorderCollection, setCollectionThumb, storageUsage } from "../../common/db.js";
import { computePdfKey, loadPdfFromBytes } from "../page-export.js";
import { cropFromSelection, editedCollectionPdf } from "../collection-edit.js";

export class CollectionEditor {
  constructor(collection, toast) {
    this.collection = collection;
    this.toast = toast;
    this.generation = 0;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "sh-collection-editor";
    this.dialog.id = "shCollectionEditor";
    this.dialog.setAttribute("aria-label", "収集したページを編集");
    this.dialog.innerHTML = `
      <header>
        <h2>収集したページを編集</h2>
        <button class="sh-btn sh-btn-primary" type="button" data-action="pdf">PDFを保存…</button>
        <details class="sh-edit-export-menu"><summary>その他の出力</summary><div class="sh-edit-popup sh-edit-exports" role="group" aria-label="収集した全ページの出力">
          <button class="sh-btn" type="button" data-action="zip">画像ZIPを保存…</button>
          <button class="sh-btn" type="button" data-action="copyPdf">PDFとしてコピー</button>
          <button class="sh-btn" type="button" data-action="copyImages">画像としてコピー</button>
        </div></details>
        <button class="sh-btn" type="button" data-action="close">閉じる</button>
      </header>
      <div class="sh-edit-tools" role="group" aria-label="選択したページの編集">
        <div class="sh-edit-tool-group"><button class="sh-btn" type="button" data-action="left">左に回転</button><button class="sh-btn" type="button" data-action="right">右に回転</button><button class="sh-btn" type="button" data-action="crop">トリミング</button></div>
        <div class="sh-edit-tool-group"><button class="sh-btn" type="button" data-action="duplicate">複製</button><button class="sh-btn sh-btn-text" type="button" data-action="reset" title="選択ページの回転とトリミングを元に戻します">回転・トリミングを戻す</button><button class="sh-btn sh-btn-danger-text" type="button" data-action="delete">削除</button></div>
        <div class="sh-edit-tool-group"><button class="sh-btn" type="button" data-action="add" title="ドラッグや貼り付けでも追加できます">画像を追加</button>
        <details class="sh-edit-add-settings"><summary>追加設定</summary><div class="sh-edit-popup sh-edit-add-fields">
          <label>挿入位置 <select class="sh-select" data-field="position"><option value="after">選択ページの後</option><option value="before">選択ページの前</option><option value="end">末尾</option></select></label>
          <label>ページサイズ <select class="sh-select" data-field="size"><option value="neighbor">周囲のページと同じ（ない場合はA4）</option><option value="image">画像に合わせる</option><option value="a4">A4</option><option value="letter">レター</option></select></label>
        </div></details></div>
      </div>
      <div class="sh-edit-crop-tools" hidden><span>残す範囲をドラッグ。枠の四隅・辺で調整できます。</span><button class="sh-btn" type="button" data-action="pan" aria-pressed="false" title="ドラッグやスワイプでページを移動">手のひら移動</button><button class="sh-btn sh-btn-primary" type="button" data-action="apply">適用</button><button class="sh-btn" type="button" data-action="cancel">キャンセル</button></div>
      <div class="sh-edit-body"><ol id="shEditorPages" aria-label="ページ一覧"></ol><div class="sh-edit-preview">
        <div class="sh-edit-stage" tabindex="0" aria-label="ページプレビュー。ドラッグで移動、Ctrlキーとホイールで拡大縮小"><div class="sh-edit-sheet"><canvas width="0" height="0"></canvas><div class="sh-edit-crop" hidden></div></div></div>
      </div></div>
      <footer>
        <button class="sh-btn" type="button" data-action="sidebar" aria-controls="shEditorPages" aria-expanded="true">ページ一覧</button>
        <div class="sh-edit-navigation"><button class="sh-btn" type="button" data-action="prev" aria-label="前のページ">‹</button><span data-field="count"></span><button class="sh-btn" type="button" data-action="next" aria-label="次のページ">›</button></div>
        <p role="status" aria-live="polite"></p>
        <div class="sh-edit-zoom-controls" role="group" aria-label="プレビュー倍率">
          <button class="sh-btn" type="button" data-action="zoomOut" aria-label="縮小">−</button>
          <output data-field="zoom" aria-label="表示倍率"></output>
          <button class="sh-btn" type="button" data-action="zoomIn" aria-label="拡大">＋</button>
          <select class="sh-select" data-field="zoomMode" aria-label="表示サイズ"><option value="width">幅に合わせる</option><option value="page">全体を表示</option><option value="actual">100%</option><option value="custom" hidden>指定倍率</option></select>
        </div>
      </footer>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/bmp" multiple hidden>`;
    document.body.append(this.dialog);
    this.list = this.dialog.querySelector("ol");
    this.canvas = this.dialog.querySelector("canvas");
    this.overlay = this.dialog.querySelector(".sh-edit-crop");
    this.status = this.dialog.querySelector("[role=status]");
    this.stage = this.dialog.querySelector(".sh-edit-stage");
    this.zoomMode = this.dialog.querySelector("[data-field=zoomMode]");
    this.zoom = 1;
    this.zoomMode.addEventListener("change", () => this.setZoom(this.zoomMode.value));
    this.stage.addEventListener("wheel", e => {
      if (!e.ctrlKey && !e.metaKey) { return; }
      e.preventDefault();
      if (e.deltaY) { this.setZoom(e.deltaY < 0 ? "in" : "out", e.clientX, e.clientY); }
    }, { passive: false });
    this.stage.addEventListener("pointerdown", e => this.startPan(e));
    new ResizeObserver(() => this.fitPreview()).observe(this.stage);
    this.fileInput = this.dialog.querySelector("input[type=file]");
    this.urls = [];
    this.thumbQueue = Promise.resolve();
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) { continue; }
        this.observer.unobserve(entry.target);
        const item = this.collection.items.find(i => i.id === Number(entry.target.dataset.id));
        if (item) {
          this.thumbQueue = this.thumbQueue.then(() => this.makeThumb(item, entry.target)).catch(() => {});
        }
      }
    }, { root: this.list, rootMargin: "160px" });
    this.dialog.addEventListener("click", e => {
      const action = e.target.closest("[data-action]")?.dataset.action;
      for (const menu of this.dialog.querySelectorAll("details[open]")) {
        if (!menu.contains(e.target) || action) { menu.open = false; }
      }
      if (action) { this.run(() => this.action(action)); }
    });
    this.dialog.addEventListener("cancel", e => {
      if (this.cropping) { e.preventDefault(); this.run(() => this.action("cancel")); }
    });
    this.dialog.addEventListener("close", () => { this.generation++; this.observer.disconnect(); this.release(); this.clearPreview(); this.opener?.focus(); });
    this.fileInput.addEventListener("change", () => this.run(async () => {
      await this.addImages([...this.fileInput.files]); this.fileInput.value = "";
    }));
    this.dialog.addEventListener("dragover", e => { e.preventDefault(); });
    this.dialog.addEventListener("drop", e => {
      e.preventDefault();
      if (e.dataTransfer.files.length) { this.run(() => this.addImages([...e.dataTransfer.files])); return; }
      const target = e.target.closest("li[data-id]");
      const id = Number(e.dataTransfer.getData("text/x-seihon-item"));
      if (target && id && !this.cropping) {
        this.run(async () => {
          const ids = this.collection.items.map(i => i.id).filter(i => i !== id);
          const at = ids.indexOf(Number(target.dataset.id));
          if (at < 0) { return; }
          ids.splice(at, 0, id); await reorderCollection(ids); await this.collection.refresh();
        });
      }
    });
    this.dialog.addEventListener("paste", e => {
      const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
      if (files.length) { e.preventDefault(); this.run(() => this.addImages(files)); }
    });
    this.overlay.addEventListener("pointerdown", e => this.startCrop(e));
    this.dialog.addEventListener("keydown", e => {
      if (e.target.matches("input, select, textarea")) { return; }
      if (e.code === "Space" && e.target === this.stage) {
        e.preventDefault(); this.stage.classList.add("sh-edit-pan-key"); return;
      }
      if (this.cropping) { return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault(); this.run(() => this.action(e.key === "ArrowLeft" ? "prev" : "next"));
      }
    });
    this.dialog.addEventListener("keyup", e => {
      if (e.code === "Space") { this.stage.classList.remove("sh-edit-pan-key"); }
    });
    this.stage.addEventListener("blur", () => this.stage.classList.remove("sh-edit-pan-key"));
    collection.onChange(() => { if (this.dialog.open) { this.render(); } });
  }

  /** 操作中は重ねて変更せず、失敗を利用者に知らせる。 */
  async run(fn) {
    if (this.busy) { return; }
    this.busy = true;
    this.dialog.setAttribute("aria-busy", "true");
    try { await fn(); }
    catch (e) { this.toast.show(`収集の編集ができませんでした: ${e.message || e}`, { kind: "error", duration: 8000 }); }
    finally { this.busy = false; this.dialog.removeAttribute("aria-busy"); }
  }

  async open() {
    this.opener = document.activeElement;
    await this.collection.ready;
    await this.collection.refresh();
    this.cropping = false;
    this.list.hidden = matchMedia("(max-width: 700px)").matches;
    this.dialog.querySelector("[data-action=sidebar]").setAttribute("aria-expanded", String(!this.list.hidden));
    for (const menu of this.dialog.querySelectorAll("details[open]")) { menu.open = false; }
    this.dialog.showModal();
    await this.render();
  }

  get item() { return this.collection.items.find(i => i.id === this.selected); }

  release() {
    for (const url of this.urls) { URL.revokeObjectURL(url); }
    this.urls = [];
  }

  /** 一覧とプレビューを最新の保存内容へ合わせる。 */
  async render() {
    if (!this.dialog.open) { return; }
    const items = this.collection.items;
    if (!this.item) { this.selected = items[0]?.id; this.cropping = false; }
    this.observer.disconnect();
    this.release();
    this.list.replaceChildren();
    items.forEach((item, i) => {
      const li = document.createElement("li");
      li.dataset.id = item.id;
      li.draggable = !this.cropping;
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-current", String(item.id === this.selected));
      if (item.thumb) {
        const img = document.createElement("img"); img.loading = "lazy";
        const url = URL.createObjectURL(item.thumb); this.urls.push(url); img.src = url; img.alt = ""; button.append(img);
      }
      const text = document.createElement("span");
      text.textContent = `${i + 1}. ${item.name || "名前なし"} / ${item.sourceType === "image" ? "画像" : `${item.pageIndex + 1}ページ目`}`;
      button.append(text); button.onclick = () => this.run(async () => { this.selected = item.id; this.cropping = false; await this.render(); });
      li.addEventListener("dragstart", e => e.dataTransfer.setData("text/x-seihon-item", String(item.id)));
      li.append(button); this.list.append(li);
      if (!item.thumb) { this.observer.observe(li); }
    });
    const i = items.findIndex(item => item.id === this.selected);
    this.list.querySelector("[aria-current=true]")?.closest("li")?.scrollIntoView({ block: "nearest", inline: "nearest", container: "nearest" });
    this.dialog.querySelector("[data-field=count]").textContent = items.length ? `${i + 1} / ${items.length}` : "収集したページがありません";
    for (const b of this.dialog.querySelectorAll("[data-action]")) {
      const a = b.dataset.action;
      b.disabled = !items.length && !["add", "close", "sidebar"].includes(a);
      if (this.cropping && !["apply", "cancel", "close", "sidebar", "pan", "zoomIn", "zoomOut"].includes(a)) { b.disabled = true; }
    }
    this.dialog.querySelector("[data-action=prev]").disabled ||= i <= 0;
    this.dialog.querySelector("[data-action=next]").disabled ||= i >= items.length - 1;
    this.zoomMode.disabled = !items.length;
    this.dialog.querySelector(".sh-edit-tools").hidden = this.cropping;
    this.dialog.querySelector(".sh-edit-crop-tools").hidden = !this.cropping;
    this.overlay.hidden = !this.cropping;
    if (!this.cropping) {
      this.stage.classList.remove("sh-edit-pan-mode");
      this.dialog.querySelector("[data-action=pan]").setAttribute("aria-pressed", "false");
    }
    await this.preview();
  }

  clearPreview() {
    clearTimeout(this.paintTimer);
    this.paintTask?.cancel();
    this.paintTask = null;
    this.renderScale = 0;
    this.previewKey = null;
    this.page = null;
    this.viewport = null;
    this.box = null;
    this.previewDoc?.loadingTask.destroy().catch(console.error);
    this.previewDoc = null;
    this.canvas.width = this.canvas.height = 0;
    this.canvas.style.width = this.canvas.style.height = "0px";
    this.dialog.querySelector("[data-field=zoom]").textContent = "";
    this.overlay.replaceChildren();
  }

  /** ページや編集が変わった時だけ元データを読み直し、倍率変更には表示中のページを使う。 */
  preview() {
    const item = this.item;
    const key = item && JSON.stringify([item.id, item.pdfKey, item.pageIndex, item.edits, this.cropping]);
    if (key && this.previewKey === key) { return this.previewPromise; }
    const gen = ++this.generation;
    this.clearPreview();
    if (!item) {
      this.status.textContent = "画像を追加するか、PDFからページを収集してください";
      return;
    }
    this.previewKey = key;
    this.status.textContent = "プレビューを準備しています…";
    this.previewPromise = this.loadPreview(item, gen);
    return this.previewPromise;
  }

  async loadPreview(item, gen) {
    let doc;
    try {
      const bytes = await getPdfBytes(item.pdfKey);
      if (gen !== this.generation) { return; }
      if (!bytes) { throw new Error("元のPDFがありません"); }
      const edited = await editedCollectionPdf(bytes, item, { uncropped: this.cropping });
      if (gen !== this.generation) { return; }
      doc = await loadPdfFromBytes(edited);
      const page = await doc.getPage(1);
      if (gen !== this.generation || !this.dialog.open) { return; }
      this.previewDoc = doc; doc = null;
      this.page = page;
      const vp = this.viewport = page.getViewport({ scale: 1 });
      this.status.textContent = `${item.name || "名前なし"} — ${Math.round(vp.width * 25.4 / 72)} × ${Math.round(vp.height * 25.4 / 72)} mm`;
      this.status.title = this.status.textContent;
      if (this.cropping) {
        this.box = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
        if (item.edits?.crop) {
          const [x, y, w, h] = item.edits.crop;
          const a = vp.convertToViewportPoint(x, y), b = vp.convertToViewportPoint(x + w, y + h);
          this.box = { x: Math.min(a[0], b[0]) / vp.width, y: Math.min(a[1], b[1]) / vp.height, w: Math.abs(a[0] - b[0]) / vp.width, h: Math.abs(a[1] - b[1]) / vp.height };
        }
        this.drawCrop();
      }
      this.fitPreview();
      this.stage.scrollTo(0, 0);
      clearTimeout(this.paintTimer);
      await this.paintPreview();
    } catch (e) {
      if (gen === this.generation) {
        this.clearPreview();
        this.status.textContent = `プレビューを表示できません: ${e.message || e}`;
      }
    } finally { await doc?.loadingTask.destroy(); }
  }

  /** 100% は PDF の 72pt を画面上の 96px に換算する。 */
  fitPreview() {
    const vp = this.viewport;
    if (!vp || !this.stage.clientWidth || !this.stage.clientHeight) { return; }
    const widthFit = this.stage.clientWidth / vp.width;
    const mode = this.zoomMode.value;
    if (mode === "width") { this.zoom = widthFit * 72 / 96; }
    if (mode === "page") { this.zoom = Math.min(widthFit, this.stage.clientHeight / vp.height) * 72 / 96; }
    if (mode === "actual") { this.zoom = 1; }
    const scale = this.zoom * 96 / 72;
    this.canvas.style.width = `${Math.max(1, Math.floor(vp.width * scale))}px`;
    this.canvas.style.height = `${Math.max(1, Math.floor(vp.height * scale))}px`;
    this.dialog.querySelector("[data-field=zoom]").textContent = `${Math.round(this.zoom * 100)}%`;
    clearTimeout(this.paintTimer);
    this.paintTimer = setTimeout(() => this.paintPreview(), 100);
  }

  /** 拡大時に元のPDFから描き直す。高倍率・高DPIでも描画用メモリに上限を設ける。 */
  async paintPreview() {
    if (!this.page) { return; }
    const { width, height } = this.viewport;
    const scale = Math.min(this.zoom * 96 / 72 * (devicePixelRatio || 1),
      Math.sqrt(12_000_000 / (width * height)), 6000 / Math.max(width, height));
    if (Math.abs(this.renderScale - scale) < scale * 0.01) { return; }
    this.paintTask?.cancel();
    this.renderScale = scale;
    const vp = this.page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const task = this.paintTask = this.page.render({ canvas, viewport: vp, background: "#ffffff" });
    try {
      await task.promise;
      if (this.paintTask !== task) { return; }
      this.canvas.width = canvas.width; this.canvas.height = canvas.height;
      this.canvas.getContext("2d").drawImage(canvas, 0, 0);
    } catch (e) {
      if (this.paintTask === task && e.name !== "RenderingCancelledException") {
        this.renderScale = 0;
        this.status.textContent = `プレビューを表示できません: ${e.message || e}`;
      }
    } finally {
      if (this.paintTask === task) { this.paintTask = null; }
      canvas.width = canvas.height = 0;
    }
  }

  /** ポインターか画面中央の同じ箇所を見たまま倍率を変える。 */
  setZoom(mode, clientX, clientY) {
    if (!this.viewport) { return; }
    const stage = this.stage.getBoundingClientRect(), before = this.canvas.getBoundingClientRect();
    clientX ??= stage.left + this.stage.clientWidth / 2;
    clientY ??= stage.top + this.stage.clientHeight / 2;
    const x = Math.max(0, Math.min(1, (clientX - before.left) / before.width));
    const y = Math.max(0, Math.min(1, (clientY - before.top) / before.height));
    if (mode === "in" || mode === "out") {
      this.zoom = mode === "in" ? Math.max(this.zoom, Math.min(16, this.zoom * 1.25))
        : Math.min(this.zoom, Math.max(0.05, this.zoom * 0.8));
      this.zoomMode.value = "custom";
    } else { this.zoomMode.value = mode; }
    this.fitPreview();
    const after = this.canvas.getBoundingClientRect();
    this.stage.scrollBy(after.left + x * after.width - clientX, after.top + y * after.height - clientY);
  }

  startPan(e) {
    if (e.pointerType === "touch" || !this.viewport || ![0, 1].includes(e.button)) { return; }
    if (this.cropping && e.button === 0 && !this.stage.matches(".sh-edit-pan-key, .sh-edit-pan-mode")) { return; }
    e.preventDefault();
    this.stage.focus({ preventScroll: true });
    const startX = e.clientX, startY = e.clientY;
    const left = this.stage.scrollLeft, top = this.stage.scrollTop;
    this.stage.setPointerCapture(e.pointerId);
    this.stage.classList.add("sh-edit-panning");
    const move = event => {
      if (event.pointerId === e.pointerId) { this.stage.scrollTo(left + startX - event.clientX, top + startY - event.clientY); }
    };
    const end = event => {
      if (event.pointerId !== e.pointerId) { return; }
      this.stage.classList.remove("sh-edit-panning");
      this.stage.removeEventListener("pointermove", move);
      this.stage.removeEventListener("lostpointercapture", end);
    };
    this.stage.addEventListener("pointermove", move);
    this.stage.addEventListener("lostpointercapture", end);
  }

  /** 一覧に近づいたページだけサムネイルを作り、再表示用に保存する。 */
  async makeThumb(item, li) {
    if (!this.dialog.open || !li.isConnected) { return; }
    let doc;
    try {
      const bytes = await getPdfBytes(item.pdfKey);
      if (!bytes) { return; }
      doc = await loadPdfFromBytes(await editedCollectionPdf(bytes, item));
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 120 / Math.max(base.width, base.height) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      canvas.width = canvas.height = 0;
      if (!blob || !li.isConnected || !this.dialog.open) { return; }
      await setCollectionThumb(item.id, blob, JSON.stringify(item.edits || {}));
      const img = document.createElement("img");
      img.alt = ""; img.src = URL.createObjectURL(blob); this.urls.push(img.src);
      li.querySelector("button").prepend(img);
    } finally { await doc?.loadingTask?.destroy(); }
  }

  drawCrop() {
    this.overlay.replaceChildren();
    const box = document.createElement("div"); box.className = "sh-edit-selection";
    Object.assign(box.style, { left: `${this.box.x * 100}%`, top: `${this.box.y * 100}%`, width: `${this.box.w * 100}%`, height: `${this.box.h * 100}%` });
    box.dataset.handle = "move";
    for (const dir of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      const handle = document.createElement("span"); handle.dataset.handle = dir; box.append(handle);
    }
    this.overlay.append(box);
  }

  /** ドラッグで範囲の作成・移動・四隅と辺の調整。 */
  startCrop(e) {
    if (!this.cropping || this.busy || e.button !== 0 || !this.box) { return; }
    if (this.stage.classList.contains("sh-edit-pan-key")) { return; }
    this.stage.focus({ preventScroll: true });
    e.preventDefault();
    const point = event => {
      const rect = this.overlay.getBoundingClientRect();
      return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
    };
    const start = point(e), old = { ...this.box }, mode = e.target.dataset.handle || "new";
    this.overlay.setPointerCapture(e.pointerId);
    const move = event => {
      const p = point(event); let x1 = old.x, y1 = old.y, x2 = old.x + old.w, y2 = old.y + old.h;
      if (mode === "move") {
        x1 = Math.max(0, Math.min(1 - old.w, old.x + p.x - start.x));
        y1 = Math.max(0, Math.min(1 - old.h, old.y + p.y - start.y)); x2 = x1 + old.w; y2 = y1 + old.h;
      } else if (mode === "new") { x1 = start.x; y1 = start.y; x2 = p.x; y2 = p.y; }
      else {
        if (mode.includes("w")) { x1 = p.x; } if (mode.includes("e")) { x2 = p.x; }
        if (mode.includes("n")) { y1 = p.y; } if (mode.includes("s")) { y2 = p.y; }
      }
      this.box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }; this.drawCrop();
    };
    const end = () => { this.overlay.removeEventListener("pointermove", move); this.overlay.removeEventListener("pointerup", end); this.overlay.removeEventListener("pointercancel", end); };
    this.overlay.addEventListener("pointermove", move); this.overlay.addEventListener("pointerup", end); this.overlay.addEventListener("pointercancel", end);
  }

  async action(action) {
    const item = this.item;
    if (action === "close") { this.dialog.close(); return; }
    if (action === "pan") {
      const active = this.stage.classList.toggle("sh-edit-pan-mode");
      this.dialog.querySelector("[data-action=pan]").setAttribute("aria-pressed", String(active));
      return;
    }
    if (action === "sidebar") {
      this.list.hidden = !this.list.hidden;
      this.dialog.querySelector("[data-action=sidebar]").setAttribute("aria-expanded", String(!this.list.hidden));
      return;
    }
    if (action === "zoomIn" || action === "zoomOut") { this.setZoom(action === "zoomIn" ? "in" : "out"); return; }
    if (action === "add") { this.fileInput.click(); return; }
    if (action === "pdf" || action === "zip") { await this.collection.exportAll(action); return; }
    if (action === "copyPdf" || action === "copyImages") { await this.collection.copyAll(action === "copyPdf" ? "pdf" : "images"); return; }
    if (!item) { return; }
    if (action === "prev" || action === "next") {
      const at = this.collection.items.findIndex(i => i.id === item.id);
      this.selected = this.collection.items[Math.max(0, Math.min(this.collection.count - 1, at + (action === "next" ? 1 : -1)))].id;
    } else if (action === "crop") { this.cropping = true; this.stage.focus({ preventScroll: true }); }
    else if (action === "cancel") { this.cropping = false; }
    else if (action === "apply") {
      if (!this.viewport || !this.box || this.box.w < 0.005 || this.box.h < 0.005) { throw new Error("切り取り範囲を広げてください"); }
      const crop = cropFromSelection(this.viewport, this.box);
      this.cropping = false; await editCollectionItem(item.id, { ...item.edits, crop });
    } else if (action === "left" || action === "right") {
      await editCollectionItem(item.id, { ...item.edits, rotation: ((item.edits?.rotation || 0) + (action === "left" ? 270 : 90)) % 360 });
    } else if (action === "reset") { await editCollectionItem(item.id, {}); }
    else if (action === "duplicate") { this.selected = await duplicateCollectionItem(item.id); }
    else if (action === "delete") {
      if (!window.confirm("選択したページを収集から削除しますか？ 元のPDF・画像は残ります。")) { return; }
      await removeCollectionItems([item.id]);
    }
    await this.collection.refresh(); await this.render();
  }

  /** 画像は元データを保つPDFとして既存の保存領域へ追加する。 */
  async addImages(files) {
    if (this.cropping) { throw new Error("トリミングを適用するかキャンセルしてください"); }
    const { PDFDocument } = await import("../../lib/pdf-lib.esm.min.js");
    const size = this.dialog.querySelector("[data-field=size]").value;
    const position = this.dialog.querySelector("[data-field=position]").value;
    let paper = size === "letter" ? [612, 792] : [595.276, 841.89];
    if (size === "neighbor" && this.item) {
      let doc;
      try {
        doc = await loadPdfFromBytes(await editedCollectionPdf(await getPdfBytes(this.item.pdfKey), this.item));
        const vp = (await doc.getPage(1)).getViewport({ scale: 1 }); paper = [vp.width, vp.height];
      } finally { await doc?.loadingTask?.destroy(); }
    }
    const before = this.collection.items.map(i => i.id);
    const anchor = before.indexOf(this.selected);
    const added = [];
    const failures = [];
    for (const file of files) {
      try {
        if (!["image/png", "image/jpeg", "image/webp", "image/bmp"].includes(file.type)) { throw new Error("PNG・JPEG・WebP・BMPの画像を選んでください"); }
        const doc = await PDFDocument.create();
        let bytes = new Uint8Array(await file.arrayBuffer());
        if (file.type !== "image/jpeg" && file.type !== "image/png") {
          const bitmap = await createImageBitmap(file);
          const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
          canvas.getContext("2d").drawImage(bitmap, 0, 0); bitmap.close();
          const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
          bytes = new Uint8Array(await png.arrayBuffer()); canvas.width = canvas.height = 0;
        }
        const image = file.type === "image/jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
        // 画像基準は144dpi相当、長辺はA4以内。巨大な物理ページを作らない。
        const factor = Math.min(0.5, 841.89 / Math.max(image.width, image.height));
        const pageSize = size === "image" ? [Math.max(1, image.width * factor), Math.max(1, image.height * factor)] : paper;
        const page = doc.addPage(pageSize);
        const scale = Math.min(pageSize[0] / image.width, pageSize[1] / image.height);
        const width = image.width * scale, height = image.height * scale;
        page.drawImage(image, { x: (pageSize[0] - width) / 2, y: (pageSize[1] - height) / 2, width, height });
        const pdf = await doc.save(), key = `image:${await computePdfKey(pdf)}`;
        const usage = await storageUsage();
        if (usage.total + pdf.length > this.collection.getSettings().collectLimitMB * 1024 * 1024) {
          throw new Error("収集の保存容量の上限です。不要な収集を削除するか、詳細設定で上限を増やしてください");
        }
        await putPdf({ key, name: file.name || "貼り付けた画像", bytes: pdf, size: pdf.length, pages: 1 });
        added.push(...await addCollectionItems(key, file.name || "貼り付けた画像", [{ pageIndex: 0, sourceType: "image" }]));
      } catch (e) { failures.push(`${file.name}: ${e.message || e}`); }
    }
    await this.collection.refresh();
    const existing = this.collection.items.map(i => i.id).filter(id => !added.includes(id));
    const at = position === "end" || anchor < 0 ? existing.length : Math.max(0, existing.indexOf(before[anchor])) + (position === "after" ? 1 : 0);
    existing.splice(at, 0, ...added); await reorderCollection(existing);
    this.selected = added[0] || this.selected; await this.collection.refresh(); await this.render();
    if (failures.length) { throw new Error(failures.join("、")); }
  }
}
