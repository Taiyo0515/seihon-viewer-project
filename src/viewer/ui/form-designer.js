import { baseName, saveBlobAs } from "../../common/files.js";
import { loadPdfFromBytes } from "../page-export.js";

export const FORM_TOOLS = [{
  id: "form-designer", title: "入力フォームを作成", description: "ページをドラッグしてテキスト欄やチェック欄を配置", category: "編集",
}];

/** 元ページの座標で保存し、表示の回転やCropBoxの原点を引き継ぐ。 */
export async function addFormFields(bytes, placements) {
  const { PDFDocument, PDFName, PDFDict, rgb } = await import("../../lib/pdf-lib.esm.min.js");
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const acroName = PDFName.of("AcroForm");
  const existing = doc.catalog.lookupMaybe(acroName, PDFDict);
  if (existing?.has(PDFName.of("XFA"))) {
    throw new Error("このPDFはXFAフォームです。通常のPDFフォームを選んでください。");
  }
  const form = doc.getForm(), pages = doc.getPages();
  const existingNames = new Set(form.getFields().map(f => f.getName()));
  for (const { pageNumber, name, type, rect } of placements) {
    const page = pages[pageNumber - 1];
    if (!page || !name || existingNames.has(name) || !["text", "check"].includes(type)) {
      throw new Error("ページ番号・欄名・欄の種類を確認してください。");
    }
    existingNames.add(name);
    const [x, y, width, height] = rect;
    if (!rect.every(Number.isFinite) || width <= 0 || height <= 0) { throw new Error("欄をもう少し大きく描いてください。"); }
    const field = type === "check" ? form.createCheckBox(name) : form.createTextField(name);
    field.addToPage(page, { x, y, width, height, backgroundColor: undefined, borderColor: rgb(.35, .37, .4), borderWidth: .8 });
    // pdf-lib の枠線幅による余白・回転による位置ずれを除き、ドラッグした四辺に合わせる。
    const widget = field.acroField.getWidgets()[0];
    widget.setRectangle({ x, y, width, height });
    widget.getOrCreateAppearanceCharacteristics().setRotation(((page.getRotation().angle % 360) + 360) % 360);
    field.defaultUpdateAppearances(form.getDefaultFont());
  }
  // 既存の入力欄の表示ストリームは再生成しない。
  return doc.save({ updateFieldAppearances: false });
}

export function runFormTool(id) {
  if (id !== FORM_TOOLS[0].id || document.getElementById("shFormDesigner")) { return; }
  const dialog = document.createElement("dialog");
  dialog.id = "shFormDesigner";
  dialog.className = "sh-dialog sh-form-designer";
  dialog.setAttribute("aria-labelledby", "shFormDesignerTitle");
  dialog.innerHTML = `<header><h2 id="shFormDesignerTitle">入力フォームを作成</h2>
    <button type="button" class="sh-btn" data-close>閉じる</button></header>
    <div class="sh-form-tools"><button class="sh-btn" type="button" data-choose>PDFを選ぶ…</button>
    <button class="sh-btn" type="button" data-current>開いているPDFを使う</button><input type="file" accept="application/pdf,.pdf" hidden>
    <span data-filename></span></div>
    <div class="sh-form-tools"><label>種類 <select class="sh-select" data-kind><option value="text">テキスト欄</option><option value="check">チェック欄</option></select></label>
    <label>欄名 <input type="text" data-name maxlength="100" placeholder="自動で付ける"></label>
    <button class="sh-btn" type="button" data-center>中央に追加</button>
    <button class="sh-btn" type="button" data-undo>最後の欄を取り消す</button></div>
    <div class="sh-form-stage"><div class="sh-form-sheet" hidden><canvas></canvas><div class="sh-form-marks"></div></div></div>
    <footer><div><label>ページ <input type="number" data-page min="1" step="1" value="1"></label> / <span data-total>–</span></div>
    <span role="status" aria-live="polite">PDFを選んでください</span>
    <button class="sh-btn sh-btn-primary" type="button" data-save>フォーム付きPDFを作成</button></footer>`;
  const q = selector => dialog.querySelector(selector);
  const choose = q("[data-choose]"), current = q("[data-current]"), picker = q("input[type=file]");
  const fileName = q("[data-filename]"), kind = q("[data-kind]"), nameInput = q("[data-name]");
  const stage = q(".sh-form-stage"), sheet = q(".sh-form-sheet"), marks = q(".sh-form-marks");
  const pageInput = q("[data-page]"), status = q("[role=status]"), save = q("[data-save]");
  const info = window.__seihonViewer, candidate = info?.app.pdfDocument;
  const opener = document.activeElement;
  current.hidden = !candidate;
  let bytes, doc, viewport, sourceName, result, task, drawing;
  let pageNumber = 1, version = 0, busy = false, saving = false;
  let existingNames = new Set();
  const placements = [];
  const controls = () => {
    choose.disabled = current.disabled = busy;
    for (const el of [kind, nameInput, q("[data-center]"), pageInput]) { el.disabled = !viewport || busy; }
    q("[data-undo]").disabled = save.disabled = !placements.length || busy;
    q("[data-close]").disabled = saving;
  };
  const invalidate = () => {
    result = null;
    save.textContent = "フォーム付きPDFを作成";
    status.textContent = placements.length ? `追加した欄は ${placements.length} 件です` : "ページ上で欄を置く範囲をドラッグしてください";
    controls();
  };
  function mark(start, end, label) {
    const el = document.createElement("span");
    Object.assign(el.style, {
      left: Math.min(start.x, end.x) * 100 + "%", top: Math.min(start.y, end.y) * 100 + "%",
      width: Math.abs(start.x - end.x) * 100 + "%", height: Math.abs(start.y - end.y) * 100 + "%",
    });
    el.textContent = label;
    marks.append(el);
  }
  function drawMarks() {
    marks.replaceChildren();
    if (!viewport) { return; }
    for (const field of placements.filter(f => f.pageNumber === pageNumber)) {
      const [x, y, width, height] = field.rect;
      const [x1, y1] = viewport.convertToViewportPoint(x, y);
      const [x2, y2] = viewport.convertToViewportPoint(x + width, y + height);
      mark({ x: x1 / viewport.width, y: y1 / viewport.height }, { x: x2 / viewport.width, y: y2 / viewport.height }, field.name);
    }
    if (drawing) { mark(drawing.start, drawing.end, ""); }
  }
  function place(a, b) {
    const p = viewport.convertToPdfPoint(a.x * viewport.width, a.y * viewport.height);
    const t = viewport.convertToPdfPoint(b.x * viewport.width, b.y * viewport.height);
    const width = Math.abs(p[0] - t[0]), height = Math.abs(p[1] - t[1]);
    if (width < 2 || height < 2) { status.textContent = "始点からドラッグして欄の大きさを指定してください"; return; }
    const taken = new Set([...existingNames, ...placements.map(f => f.name)]);
    const conflicts = n => taken.has(n) || [...taken].some(other => other.startsWith(n + "."));
    let name = nameInput.value.trim();
    if (!name) {
      const prefix = kind.value === "text" ? "入力欄" : "チェック欄";
      let number = 1;
      while (conflicts(prefix + number)) { number++; }
      name = prefix + number;
    }
    if (name.includes(".") || conflicts(name)) { status.textContent = "重複しない欄名を指定してください。ピリオドは使えません。"; return; }
    placements.push({ type: kind.value, name, pageNumber, rect: [Math.min(p[0], t[0]), Math.min(p[1], t[1]), width, height] });
    nameInput.value = ""; drawMarks(); invalidate();
  }
  function point(event) {
    const r = sheet.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (event.clientY - r.top) / r.height)) };
  }
  marks.onpointerdown = event => {
    if (!viewport || busy || event.button !== 0 || drawing) { return; }
    marks.setPointerCapture(event.pointerId);
    drawing = { id: event.pointerId, start: point(event), end: point(event) };
    drawMarks();
  };
  marks.onpointermove = event => {
    if (drawing?.id !== event.pointerId) { return; }
    drawing.end = point(event); drawMarks();
  };
  marks.onpointerup = event => {
    if (drawing?.id !== event.pointerId) { return; }
    const start = drawing.start; drawing = null; drawMarks(); place(start, point(event));
  };
  marks.onlostpointercapture = () => { if (drawing) { drawing = null; drawMarks(); } };
  q("[data-center]").onclick = () => {
    const h = Math.min(.1, 16 / viewport.height), w = Math.min(.75, (kind.value === "check" ? h * viewport.height : 150) / viewport.width);
    place({ x: .5 - w / 2, y: .5 - h / 2 }, { x: .5 + w / 2, y: .5 + h / 2 });
  };
  q("[data-undo]").onclick = () => { placements.pop(); drawMarks(); invalidate(); };

  async function showPage(number) {
    task?.cancel();
    drawing = viewport = null;
    sheet.hidden = true;
    const active = ++version;
    pageNumber = number; pageInput.value = String(number);
    const page = await doc.getPage(number);
    if (!dialog.open || active !== version) { return; }
    const base = page.getViewport({ scale: 1 });
    const cssWidth = Math.min(1000, Math.max(100, stage.clientWidth - 24));
    const scale = Math.min(cssWidth / base.width * devicePixelRatio, Math.sqrt(8e6 / (base.width * base.height)), 6000 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    task = page.render({ canvas, viewport: vp, background: "#fff", annotationMode: 1 });
    await task.promise;
    if (!dialog.open || active !== version) { return; }
    sheet.querySelector("canvas").replaceWith(canvas);
    sheet.style.maxWidth = "1000px";
    sheet.hidden = false; viewport = base; stage.scrollTop = 0;
    drawMarks(); controls();
  }
  async function guarded(fn) {
    if (busy) { return; }
    busy = true; controls();
    try { await fn(); } catch (e) {
      if (dialog.open) { status.textContent = /password|encrypted/i.test(e.message) ? "パスワード保護を解除したPDFを選んでください" : (e.message || String(e)); }
    } finally { busy = saving = false; controls(); }
  }
  function load(source) {
    return guarded(async () => {
      if (placements.length && !window.confirm("追加した欄を破棄して別のPDFを開きますか？")) { return; }
      const active = ++version;
      status.textContent = "PDFを読み込んでいます…";
      let next;
      try {
        if (source === "current" && candidate !== info.app.pdfDocument) { throw new Error("表示中のPDFが変わりました。ツールを開き直してください"); }
        const nextBytes = source === "current" ? await info.pageEditor.buildEditedBytes(candidate) : new Uint8Array(await source.arrayBuffer());
        if (source === "current" && candidate !== info.app.pdfDocument) { throw new Error("表示中のPDFが変わりました"); }
        next = await loadPdfFromBytes(nextBytes.slice());
        const fields = await next.getFieldObjects();
        if (!dialog.open || active !== version) { return; }
        await doc?.loadingTask.destroy();
        bytes = nextBytes; doc = next; next = null;
        existingNames = new Set(fields?.keys());
        sourceName = source === "current" ? info.docSource.baseName() : baseName(source.name);
        fileName.textContent = sourceName; placements.length = 0;
        q("[data-total]").textContent = pageInput.max = String(doc.numPages);
        invalidate(); await showPage(1);
      } finally { await next?.loadingTask.destroy(); }
    });
  }
  choose.onclick = () => picker.click();
  picker.onchange = () => { const file = picker.files[0]; picker.value = ""; if (file) { load(file); } };
  current.onclick = () => load("current");
  pageInput.onchange = () => {
    const n = pageInput.valueAsNumber;
    if (!pageInput.reportValidity() || !Number.isInteger(n)) { pageInput.value = String(pageNumber); return; }
    guarded(() => showPage(n));
  };
  save.onclick = () => guarded(async () => {
    if (!result) {
      status.textContent = "入力フォームを作成しています…";
      result = new Blob([await addFormFields(bytes, placements)], { type: "application/pdf" });
      save.textContent = "保存先を選ぶ…"; status.textContent = "フォーム付きPDFを作成しました";
      return;
    }
    saving = true; controls();
    const saved = await saveBlobAs(result, sourceName + "_フォーム.pdf");
    status.textContent = saved.ok ? "フォーム付きPDFを保存しました" : saved.canceled ? "保存をキャンセルしました" : (saved.error || "保存できませんでした");
  });
  q("[data-close]").onclick = () => dialog.close();
  dialog.addEventListener("cancel", e => { if (saving) { e.preventDefault(); } });
  dialog.addEventListener("close", () => {
    version++; task?.cancel(); doc?.loadingTask.destroy().catch(console.error);
    result = bytes = null; dialog.remove(); opener?.focus();
  }, { once: true });
  document.body.append(dialog); controls(); dialog.showModal();
}
