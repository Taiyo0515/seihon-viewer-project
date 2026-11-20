import { convertPdf } from "../ebook/pdf-convert.js";
import { loadPdfFromBytes } from "../page-export.js";
import { baseName, sanitizeFileName, saveBlobAs } from "../../common/files.js";

const summary = { type: "key-points", length: "medium", expectedInputLanguages: ["ja", "en"], outputLanguage: "ja", format: "plain-text" };
const choices = [
  { id: "summarize", title: "PDFの本文を要約", description: "ページごとに日本語で要点を取り出す", api: "Summarizer", options: summary },
  { id: "translate-ja", title: "英語のPDFを和訳", description: "各ページの英文を日本語のテキストにする", api: "Translator", options: { sourceLanguage: "en", targetLanguage: "ja" } },
  { id: "translate-en", title: "日本語のPDFを英訳", description: "各ページの日本語を英語のテキストにする", api: "Translator", options: { sourceLanguage: "ja", targetLanguage: "en" } },
];

// ブラウザがモデルを用意済みの項目だけ表示する。文書を外部サービスへ送信しない。
export async function availableLanguageTools() {
  const usable = await Promise.all(choices.map(async item => {
    try { return await globalThis[item.api]?.availability(item.options) === "available"; } catch { return false; }
  }));
  return choices.filter((_, i) => usable[i]).map(item => ({ ...item, category: "文章" }));
}

export function runLanguageTool(id) {
  const item = choices.find(t => t.id === id);
  const d = document.createElement("dialog");
  d.className = "sh-local-tool";
  d.setAttribute("aria-label", item.title);
  d.innerHTML = `<form><header><h2></h2><button type="button" class="sh-btn" data-close>閉じる</button></header>
    <label>文字を含むPDF<input type="file" accept=".pdf,application/pdf" required></label>
    <p>この端末のChromeで処理します。結果を原文と照合してから利用してください。</p>
    <textarea rows="8" aria-label="処理結果" readonly hidden></textarea><p role="status"></p>
    <footer><button type="submit" class="sh-btn sh-btn-primary">開始</button><button type="button" class="sh-btn" data-save disabled>テキストを保存…</button></footer></form>`;
  const q = s => d.querySelector(s), input = q("input"), submit = q("[type=submit]"), save = q("[data-save]"), output = q("textarea"), status = q("[role=status]");
  q("h2").textContent = item.title;
  const controller = new AbortController(), signal = controller.signal;
  let filename = "";
  input.onchange = () => { output.value = ""; output.hidden = true; save.disabled = true; status.textContent = ""; };
  q("form").onsubmit = async e => {
    e.preventDefault();
    const file = input.files[0];
    if (submit.disabled || !file) { return; }
    input.disabled = submit.disabled = save.disabled = true;
    output.hidden = true; output.value = "";
    let session, doc;
    try {
      session = await globalThis[item.api].create({ ...item.options, signal });
      doc = await loadPdfFromBytes(new Uint8Array(await file.arrayBuffer()));
      const { blob, emptyText } = await convertPdf(doc, "text", { isCanceled: () => signal.aborted });
      if (emptyText) { throw new Error("読む文字がありません。先に文字認識（OCR）を実行してください"); }
      const pages = (await blob.text()).split("\f"), blocks = [];
      for (const [i, page] of pages.entries()) {
        signal.throwIfAborted();
        status.textContent = (i + 1) + " / " + pages.length + " ページを処理中…";
        const segments = [];
        const chars = Array.from(page.trim());
        for (let start = 0; start < chars.length; start += 1800) {
          const part = chars.slice(start, start + 1800).join("");
          segments.push(id === "summarize" ? await session.summarize(part, { signal }) : await session.translate(part, { signal }));
        }
        blocks.push("［" + (i + 1) + "ページ］\n" + segments.join("\n"));
      }
      output.value = blocks.join("\n\n"); output.hidden = false; save.disabled = false;
      filename = sanitizeFileName(baseName(file.name)) + "_" + item.title + ".txt";
      status.textContent = "処理が完了しました";
    } catch (err) { status.textContent = err.message || String(err); }
    finally {
      input.disabled = submit.disabled = false;
      try { session?.destroy(); } finally { await doc?.loadingTask.destroy(); }
    }
  };
  save.onclick = async () => {
    const r = await saveBlobAs(new Blob([output.value], { type: "text/plain;charset=utf-8" }), filename);
    if (!r.ok && !r.canceled) { status.textContent = r.error || "保存できませんでした"; }
  };
  q("[data-close]").onclick = () => d.close();
  d.addEventListener("close", () => { controller.abort(); d.remove(); }, { once:true });
  document.body.append(d); d.showModal();
}
