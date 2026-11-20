import { baseName, formatBytes, sanitizeFileName, saveBlobAs } from "../../common/files.js";
import { recognizePdf, rewritePdf } from "../document-processing.js";

export const DOCUMENT_TOOLS = [
  { id: "ocr", title: "文字認識（OCR）", description: "スキャンから検索できるPDF・テキストを作成", category: "文字認識・保護" },
  { id: "protect", title: "パスワードで保護", description: "開くときにパスワードが必要なPDFを作成", category: "文字認識・保護" },
  { id: "unlock", title: "パスワード保護を解除", description: "パスワードで開いて保護を解除した写しを保存", category: "文字認識・保護" },
  { id: "repair", title: "PDFの構造を修復", description: "読み取れるオブジェクトからファイル構造を再構築", category: "最適化" },
];

export function runDocumentTool(id) {
  const tool = DOCUMENT_TOOLS.find(t => t.id === id);
  if (!tool) { throw new Error("不明なツールです"); }
  const d = document.createElement("dialog");
  d.className = "sh-local-tool";
  d.setAttribute("aria-label", tool.title);
  const ocr = id === "ocr", lock = id === "protect", pass = lock || id === "unlock";
  d.innerHTML = `<form>
    <header><h2></h2><button type="button" class="sh-btn" data-close>閉じる</button></header>
    <label>元のPDF<input type="file" accept=".pdf,application/pdf" required></label>
    ${pass ? '<label>パスワード<input type="password" required maxlength="120" autocomplete="off"></label>' : ""}
    ${lock ? '<label>もう一度入力<input type="password" required autocomplete="off"></label>' : ""}
    ${ocr ? '<label>文書の言語<select name="lang"><option value="jpn+eng">日本語・英語（横書き）</option><option value="eng">英語</option></select></label><label>保存する形式<select name="format"><option value="pdf">検索できる画像PDF</option><option value="txt">テキスト</option></select></label><p>PDFは各ページの見た目と認識した文字を保存します。認識結果には読み違いが含まれる場合があります。</p>' : ""}
    ${id === "repair" ? "<p>破損した参照表などを再構築します。欠けたページや画像の復元には対応していません。</p>" : ""}
    <p role="status"></p>
    <footer><button type="submit" class="sh-btn sh-btn-primary">作成する</button>
      <button type="button" class="sh-btn sh-btn-primary" data-save hidden>保存先を選ぶ…</button></footer>
    </form>`;
  d.querySelector("h2").textContent = tool.title;
  const form = d.querySelector("form"), save = d.querySelector("[data-save]"), submit = d.querySelector("[type=submit]");
  const fields = [...form.querySelectorAll("input,select")], status = form.querySelector("[role=status]");
  const controller = new AbortController();
  let result, filename, busy = false;
  const reset = () => { result = null; save.hidden = true; submit.hidden = false; status.textContent = ""; };
  form.oninput = reset;
  form.onsubmit = async e => {
    e.preventDefault(); if (busy) { return; }
    const file = fields[0].files[0];
    if (!file) { return; }
    const password = pass ? fields[1].value : "";
    if (lock && (fields[2].value !== password || new TextEncoder().encode(password).length > 127 || password.startsWith("@") || /[\x00-\x1F]/u.test(password))) {
      status.textContent = "パスワードを確認してください（確認欄と一致、UTF-8で127バイト以内、先頭の@と制御文字は使用不可）"; return;
    }
    busy = true; submit.disabled = true;
    fields.forEach(f => { f.disabled = true; });
    status.textContent = "処理しています…";
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const textOnly = ocr && form.elements.format.value === "txt";
      const signal = controller.signal;
      const output = ocr ? await recognizePdf(bytes, { language: form.elements.lang.value, textOnly, signal, progress: msg => { status.textContent = msg; } })
        : await rewritePdf(id, bytes, password, signal);
      signal.throwIfAborted();
      result = output.blob;
      const suffix = { ocr: "OCR", protect: "保護", unlock: "解除", repair: "修復" }[id];
      filename = sanitizeFileName(baseName(file.name)) + "_" + suffix + (textOnly ? ".txt" : ".pdf");
      status.textContent = formatBytes(result.size) + " のファイルを作成しました。" + (output.warning ? "読み取り時に警告があったので、保存後に内容を確認してください。" : "");
      save.hidden = false; submit.hidden = true; save.focus();
    } catch (err) { if (!controller.signal.aborted) { status.textContent = "処理できませんでした（" + (err.message || err) + "）"; } }
    finally { fields.forEach(f => { f.disabled = false; }); submit.disabled = false; busy = false; }
  };
  save.onclick = async () => {
    if (!result) { return; }
    save.disabled = true;
    try {
      const r = await saveBlobAs(result, filename);
      if (r.ok) { d.close(); } else if (!r.canceled) { status.textContent = r.error || "保存できませんでした"; }
    } finally { save.disabled = false; }
  };
  d.querySelector("[data-close]").onclick = () => d.close();
  d.addEventListener("close", () => { controller.abort(); form.reset(); result = null; d.remove(); }, { once: true });
  document.body.append(d);
  d.showModal();
}
