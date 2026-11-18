/** 通常の印刷・PDF保存の設定と準備。製本は同じ入口から専用設定へ進む。 */
import { saveBlobAs, sanitizeFileName } from "../../common/files.js";
import { viewPageCount } from "../page-map.js";
import { loadPdfFromBytes, extractPagesToPdf } from "../page-export.js";
import { rasterizePdf } from "../bookbinding-export.js";
import { decryptedCopy } from "../doc-source.js";
import { canPrintWithChrome, printWithChrome } from "../print-native.js";

/** 表示上のページ指定。重複は除き、指定した順番を保つ。 */
export function parseOutputPages(text, count) {
  if (!String(text).trim()) { return Array.from({ length: count }, (_, i) => i); }
  const pages = [];
  const seen = new Set();
  for (const token of String(text).replaceAll("、", ",").split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(token);
    if (!match) { throw new Error("ページは「1-3,5」のように指定してください"); }
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end > count || start > end) { throw new Error(`1〜${count}ページの範囲で指定してください`); }
    for (let p = start - 1; p < end; p++) {
      if (!seen.has(p)) { seen.add(p); pages.push(p); }
    }
  }
  return pages;
}

export class OutputDialog {
  constructor(options) {
    Object.assign(this, options);
    this.generation = 0;
    this.dialog = document.createElement("dialog");
    this.dialog.id = "shOutputDialog";
    this.dialog.className = "sh-dialog sh-output-dialog";
    this.dialog.setAttribute("aria-labelledby", "shOutputTitle");
    this.dialog.innerHTML = `
      <h2 id="shOutputTitle">印刷・PDF保存</h2>
      <p data-summary></p>
      <label class="sh-output-field">対象ページ <input data-pages type="text" placeholder="すべて（例: 1-3,5）" aria-describedby="shOutputPagesHelp"></label>
      <p id="shOutputPagesHelp">空欄はすべて。現在表示されているページ番号で指定します。</p>
      <label class="sh-output-field">出力品質 <select data-quality>
        <option value="max">元のPDFを使用（文字・図・画像を維持）</option>
        <option value="standard">画像として作成・150dpi</option>
        <option value="high">画像として作成・300dpi</option>
      </select></label>
      <p>プリンター・部数・カラー・両面印刷は、次のChromeの印刷画面で指定します。画像として作成すると文字の検索・選択はできなくなります。</p>
      <p data-status role="status" aria-live="polite"></p>
      <div class="sh-dialog-buttons"><button class="sh-btn" data-bind type="button">製本用PDF出力へ…</button></div>
      <div class="sh-dialog-buttons">
        <button class="sh-btn" data-close type="button">閉じる</button>
        <button class="sh-btn" data-save type="button">PDFを保存…</button>
        <button class="sh-btn sh-btn-primary" data-print type="button">印刷へ進む…</button>
      </div>`;
    document.body.append(this.dialog);
    const q = selector => this.dialog.querySelector(selector);
    this.pagesInput = q("[data-pages]"); this.quality = q("[data-quality]"); this.status = q("[data-status]");
    this.saveButton = q("[data-save]");
    q("[data-close]").onclick = () => this.dialog.close();
    q("[data-bind]").onclick = () => { this.dialog.close(); this.onBookbinding(); };
    this.saveButton.onclick = () => this.run("save");
    q("[data-print]").onclick = () => this.run("print");
    this.pagesInput.oninput = this.quality.onchange = () => this.clearPrepared();
    this.dialog.addEventListener("cancel", e => { if (this.busy) { e.preventDefault(); } });
    this.dialog.addEventListener("close", () => { if (!this.dialog.open) { this.busy = false; this.clearPrepared(); this.opener?.focus(); } });
    this.app.eventBus.on("documentinit", () => this.dialog.close());
  }

  updateFeatureVisibility() {
    this.dialog.querySelector("[data-bind]").hidden = !this.getSettings().bindingEnabled;
  }

  clearPrepared() { this.prepared = null; this.saveButton.textContent = "PDFを保存…"; }

  open() {
    if (!this.app.pdfDocument || this.dialog.open) { return; }
    this.generation++;
    this.busy = false;
    this.dialog.querySelectorAll("button,input,select").forEach(el => { el.disabled = false; });
    this.opener = document.activeElement;
    this.doc = this.app.pdfDocument;
    this.clearPrepared(); this.pagesInput.value = ""; this.status.textContent = "";
    const count = viewPageCount(this.doc);
    const quality = this.getSettings().printQuality;
    this.quality.value = quality === "auto" ? (count <= 50 ? "high" : "standard") : quality;
    this.dialog.querySelector("[data-summary]").textContent = `${this.docSource.displayName()} — ${count}ページ`;
    this.updateFeatureVisibility();
    this.dialog.showModal();
    this.dialog.querySelector("[data-print]").focus();
  }

  /** 未編集の全ページは、題名の追加やPDFの再保存を行わずそのまま渡す。 */
  async prepare(doc, pages, quality, generation = this.generation) {
    const edited = this.hasEdits();
    const password = this.docSource.passwordDocs.has(doc);
    if (password && edited) { throw new Error("パスワード付きPDFの編集内容を安全に反映できません。編集を保存したPDFを開いてから印刷してください"); }
    let bytes;
    if (edited) {
      this.pageEditor.sweepDeletedEditors();
      bytes = await this.pageEditor.buildEditedBytes(doc);
    } else { bytes = password ? await decryptedCopy(doc) : await doc.getData(); }
    if (!bytes?.length) { throw new Error("PDFを準備できませんでした"); }
    const all = pages.length === viewPageCount(doc) && pages.every((p, i) => p === i);
    if (!all) {
      const temporary = await loadPdfFromBytes(bytes);
      try { bytes = await extractPagesToPdf(temporary, pages.map(pageIndex => ({ source: "current", pageIndex }))); }
      finally { await temporary.loadingTask.destroy(); }
    }
    if (quality !== "max") {
      const pdf = await rasterizePdf(bytes, { dpi: quality === "high" ? 300 : 150, progress: text => { if (this.generation === generation && this.app.pdfDocument === doc) { this.status.textContent = text; } } });
      bytes = await pdf.save();
    }
    return { bytes, fileName: `${sanitizeFileName(this.docSource.baseName())}${edited ? "_編集済み" : ""}${all ? "" : "_選択ページ"}${quality === "max" ? "" : "_画像"}.pdf` };
  }

  async run(action) {
    if (this.busy || this.app.pdfDocument !== this.doc) { return; }
    const doc = this.doc;
    const generation = this.generation;
    const current = () => this.generation === generation && this.app.pdfDocument === doc && this.dialog.open;
    this.busy = true;
    const controls = [...this.dialog.querySelectorAll("button,input,select")];
    controls.forEach(el => { el.disabled = true; });
    try {
      const pages = parseOutputPages(this.pagesInput.value, viewPageCount(this.doc));
      if (action === "print" && this.docSource.passwordDocs.has(this.doc) && this.hasEdits()) {
        const all = pages.length === viewPageCount(this.doc) && pages.every((p, i) => p === i);
        if (!all) { throw new Error("パスワード付きPDFの編集内容は画像として印刷します。対象ページを空欄にして、次の印刷画面で範囲を選んでください"); }
        this.dialog.close();
        this.toast.show("パスワード付きPDFの編集内容を、ページを画像にして印刷します。ページ範囲はChromeの印刷画面で指定してください。", { duration: 8000 });
        this.onFallback(this.quality.value); return;
      }
      if (action === "print" && !canPrintWithChrome()) {
        const all = pages.length === viewPageCount(this.doc) && pages.every((p, i) => p === i);
        if (!all) { throw new Error("ページ指定の印刷にはChromeのPDF表示機能が必要です。PDFを保存してから印刷してください"); }
        this.dialog.close(); this.onFallback(this.quality.value); return;
      }
      this.status.textContent = "PDFを準備しています…";
      const result = this.prepared || await this.prepare(doc, pages, this.quality.value, generation);
      if (!current()) { return; }
      if (action === "save") {
        if (!this.prepared && navigator.userActivation && !navigator.userActivation.isActive) {
          this.prepared = result; this.saveButton.textContent = "保存先を選ぶ…";
          this.status.textContent = "PDFの準備ができました。「保存先を選ぶ」を押してください。"; return;
        }
        const saved = await saveBlobAs(new Blob([result.bytes], { type: "application/pdf" }), result.fileName);
        if (!saved.ok && !saved.canceled) { throw new Error(saved.error || "保存できませんでした"); }
        if (!current()) { return; }
        this.status.textContent = saved.ok ? "保存しました" : "保存をやめました"; this.clearPrepared();
      } else {
        this.status.textContent = "Chromeの印刷画面を開いています…";
        if (!current()) { return; }
        await this.printBytes(result.bytes);
        if (current()) { this.dialog.close(); }
      }
    } catch (e) { if (current()) { this.status.textContent = e.message || String(e); } }
    finally { if (this.generation === generation) { this.busy = false; controls.forEach(el => { el.disabled = false; }); } }
  }

  /** 実機ではChromeへ渡し、試験時にはこの境界を差し替えて内容を検証する。 */
  printBytes(bytes) { return printWithChrome(bytes); }
}
