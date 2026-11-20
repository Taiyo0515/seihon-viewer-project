import { formatBytes, sanitizeFileName, saveBlobAs } from "../../common/files.js";
import { loadPdfFromBytes } from "../page-export.js";
import { convertPdf } from "../ebook/pdf-convert.js";
import { pdfToOffice } from "../office-export.js";
import { renderForPrint } from "../office-print.js";
import { imagesToPdf } from "../image-input.js";
import { bindScanCamera } from "./scan-camera.js";

const catalog = [
  ["pdf-docx", "PDF → Word", "本文を編集できる DOCX に変換。ページ全体を画像にすることもできます。", ".pdf", "docx"],
  ["pdf-pptx", "PDF → PowerPoint", "各ページの見た目を保ち、1 枚ずつ画像のスライドにします。", ".pdf", "pptx"],
  ["pdf-xlsx", "PDF → Excel", "文字の位置から行・列を推定し、ページごとにシートを作ります。", ".pdf", "xlsx"],
  ["docx-pdf", "Word → PDF", "DOCX の本文・表・画像を印刷用に整えます。", ".docx", "pdf"],
  ["pptx-pdf", "PowerPoint → PDF", "PPTX のスライドにある文字・表・画像を印刷します。", ".pptx", "pdf"],
  ["xlsx-pdf", "Excel → PDF", "XLSX の表示シートのセル値を、読みやすい表にして印刷します。", ".xlsx", "pdf"],
  ["images-pdf", "画像 → PDF", "写真・スキャン・複数ページ TIFF を並べ、撮影した画像も追加できます。", ".jpg,.jpeg,.png,.webp,.bmp,.gif,.tif,.tiff,.avif", "pdf"],
  ["pdf-images", "PDF → 画像", "ページごとの JPEG または PNG を ZIP にまとめます。", ".pdf", "zip"],
  ["pdf-text", "PDF → テキスト", "PDF に含まれる文字をページ順に取り出します。", ".pdf", "txt"],
  ["text-pdf", "テキスト → PDF", "UTF-8 の文章を印刷用に折り返し、PDF に保存します。", ".txt,.md,.log", "pdf"],
  ["html-pdf", "HTML → PDF", "ローカルHTMLの見出し・本文・表・埋め込み画像を印刷します。", ".html,.htm", "pdf"],
  ["pdf-md", "PDF → Markdown", "各ページの文字をページ見出し付きのMarkdownに保存します。", ".pdf", "md"],
  ["pdf-cbz", "PDF → CBZ", "ページ画像をコミックリーダー向けにまとめます。", ".pdf", "cbz"],
  ["pdf-epub", "PDF → EPUB", "ページ画像と目次を収めた固定レイアウトの電子書籍を作ります。", ".pdf", "epub"],
];
export const CONVERSION_TOOLS = catalog.map(([id, title, description, accept, extension]) => ({
  id, title, description, category: "形式変換", accept, extension,
}));

const printFormats = { "docx-pdf": "docx", "pptx-pdf": "pptx", "xlsx-pdf": "xlsx", "text-pdf": "txt", "html-pdf": "html" };
const help = {
  "images-pdf": "画像を選ぶたび、または撮影するたびに末尾に追加します。TIFF は全ページ、アニメーション GIF は先頭フレームを使います。",
  "html-pdf": "HTMLファイルの本文と基本的な書式を印刷します。外部画像・CSS・スクリプトは読み込みません。",
  "pdf-docx": "本文を編集する場合は PDF の文字を使います。図表が必要なページは「見た目を保つ」を選べます。文字のないページは自動で画像になります。",
  "pdf-xlsx": "横書きの表向けです。画像内の文字や数式の復元には対応していません。",
  "docx-pdf": "本文・基本書式・表・埋め込み画像に対応。ヘッダー、段組み、変更履歴などを含む場合はプレビューで配置を確認してください。",
  "pptx-pdf": "基本的なテキスト、画像、表に対応。テーマ、グラフ、グループ化した図形、動画、アニメーションは再現に制限があります。",
  "xlsx-pdf": "保存時のセル値を使用します。グラフや元の印刷設定は含まれません。横に長い表は 8 列ごとに区切ります。",
};

const escapeAbort = () => new DOMException("処理を中止しました。", "AbortError");

export function runConversionTool(id) {
  const tool = CONVERSION_TOOLS.find(entry => entry.id === id);
  if (!tool) { throw new Error("変換機能が見つかりません。"); }
  const active = document.getElementById("shFileConversion");
  if (active?.open) { return; }
  active?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "shFileConversion";
  dialog.className = "sh-dialog sh-file-conversion";
  dialog.setAttribute("aria-labelledby", "shFileConversionTitle");
  dialog.innerHTML = `<header><h2 id="shFileConversionTitle"></h2><button type="button" class="sh-btn" data-close>閉じる</button></header>
    <p data-help></p><div class="sh-conversion-inputs">
    <label class="sh-btn" data-choose>ファイルを選ぶ<input type="file" data-file></label>
    <button type="button" class="sh-btn" data-camera-open hidden>カメラで追加</button>
    <input type="file" accept="image/*" capture="environment" data-device-camera hidden>
    <button type="button" class="sh-btn" data-current hidden>開いている PDF を使う</button></div>
    <div data-camera hidden><video muted playsinline></video>
      <button type="button" class="sh-btn" data-camera-shot>撮影して追加</button>
      <button type="button" class="sh-btn" data-camera-stop>撮影を終える</button></div>
    <ol data-list></ol><label data-options hidden><span></span> <select></select></label>
    <label data-direction hidden>綴じ方向 <select><option value="ltr">左綴じ（左から右）</option><option value="rtl">右綴じ（右から左）</option></select></label>
    <div data-preview></div><footer><div role="status" aria-live="polite"></div>
    <button type="button" class="sh-btn sh-btn-primary" data-run disabled>変換する</button></footer>`;
  document.body.append(dialog);
  const q = sel => dialog.querySelector(sel);
  const input = q("[data-file]"), run = q("[data-run]"), status = q("[role=status]"), options = q("[data-options] select");
  const info = window.__seihonViewer, candidate = info?.app.pdfDocument;
  const isImages = id === "images-pdf", print = printFormats[id];
  q("h2").textContent = tool.title;
  q("[data-help]").textContent = help[id] || tool.description;
  q("[data-current]").hidden = !candidate || tool.accept !== ".pdf";
  q("[data-direction]").hidden = id !== "pdf-cbz" && id !== "pdf-epub";
  input.accept = tool.accept;
  input.multiple = isImages;
  const selectors = {
    "pdf-docx": ["変換方法", [["text", "本文を編集する"], ["appearance", "ページの見た目を保つ（画像）"]]],
    "pdf-images": ["画像形式", [["jpeg", "JPEG"], ["png", "PNG"]]],
    "images-pdf": ["用紙", [["image", "画像の縦横比に合わせる"], ["a4", "A4 縦"]]],
  };
  if (selectors[id]) {
    const [title, entries] = selectors[id];
    q("[data-options]").hidden = false;
    q("[data-options] span").textContent = title;
    for (const [value, label] of entries) { options.add(new Option(label, value)); }
  }
  let files = [], usingCurrent = false, result = null, frame = null, busy = false;
  const controller = new AbortController();
  const urls = new Map();
  const clearResult = () => {
    result = null;
    frame?.remove();
    frame = null;
    for (const url of urls.values()) { URL.revokeObjectURL(url); }
    urls.clear();
    status.textContent = "";
    run.textContent = print ? "プレビューを作る" : "変換する";
    run.disabled = !files.length && !usingCurrent;
  };
  function refresh() {
    clearResult();
    const list = q("[data-list]");
    list.replaceChildren();
    if (usingCurrent) {
      const li = document.createElement("li");
      li.textContent = info.docSource.baseName() + ".pdf";
      list.append(li);
    }
    files.forEach((file, i) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = file.name;
      li.append(label);
      if (isImages) {
        for (const [action, text] of [["up", "上へ"], ["down", "下へ"], ["remove", "外す"]]) {
          const button = document.createElement("button");
          button.className = "sh-btn"; button.type = "button"; button.textContent = text;
          button.disabled = (action === "up" && !i) || (action === "down" && i === files.length - 1);
          button.setAttribute("aria-label", file.name + "を" + text);
          button.onclick = () => {
            if (action === "remove") { files.splice(i, 1); }
            else { const dest = i + (action === "up" ? -1 : 1); [files[i], files[dest]] = [files[dest], files[i]]; }
            refresh();
          };
          li.append(button);
        }
      }
      list.append(li);
    });
  }
  const addFiles = added => {
    if (!added.length || busy) { return; }
    files = isImages ? files.concat(added) : added;
    usingCurrent = false;
    refresh();
  };
  const stopCamera = isImages ? bindScanCamera(dialog, addFiles, text => { status.textContent = text; }) : null;
  input.onchange = () => {
    addFiles(Array.from(input.files));
    input.value = "";
  };
  q("[data-current]").onclick = () => { usingCurrent = true; files = []; refresh(); };
  options.onchange = clearResult;
  q("[data-direction] select").onchange = clearResult;
  q("[data-close]").onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    controller.abort(); stopCamera?.(); clearResult(); dialog.remove();
  }, { once: true });
  const check = () => {
    if (!dialog.open) { throw escapeAbort(); }
    if (usingCurrent && candidate !== info.app.pdfDocument) { throw new Error("開いている PDF が切り替わりました。変換画面を開き直してください。"); }
  };
  const progress = (n, total, detail = "") => { check(); status.textContent = `変換中… ${n} / ${total}${detail}`; };
  run.onclick = async () => {
    if (busy) { return; }
    busy = true;
    stopCamera?.();
    const controls = dialog.querySelectorAll("input, select, button:not([data-close])");
    const states = Array.from(controls, el => el.disabled);
    for (const el of controls) { el.disabled = true; }
    let temp;
    try {
      check();
      if (result && frame) {
        frame.contentWindow.focus(); frame.contentWindow.print();
        return;
      }
      if (result) {
        const saved = await saveBlobAs(result.blob, result.fileName);
        if (!saved.ok && !saved.canceled) { throw new Error(saved.error || "保存できませんでした。"); }
        if (saved.ok) { status.textContent = `${result.fileName} を保存しました。`; }
        return;
      }
      status.textContent = "ファイルを読み込んでいます…";
      let name = sanitizeFileName(usingCurrent ? info.docSource.baseName() : files[0].name.replace(/\.[^.]*$/, ""));
      if (print) {
        frame = document.createElement("iframe");
        frame.title = "印刷プレビュー";
        frame.setAttribute("sandbox", "allow-same-origin allow-modals");
        q("[data-preview]").append(frame);
        await renderForPrint(files[0], print, frame.contentDocument, urls);
        check();
        result = { fileName: name + ".pdf" };
        run.textContent = "印刷・PDF に保存…";
        status.textContent = "プレビューを確認し、印刷画面の送信先で「PDF に保存」を選んでください。";
        return;
      }
      let blob, note;
      if (isImages) {
        blob = await imagesToPdf(files, options.value, progress, controller.signal);
      } else {
        let bytes;
        if (usingCurrent) {
          info.pageEditor.sweepDeletedEditors();
          bytes = await info.pageEditor.buildEditedBytes(candidate);
        } else { bytes = new Uint8Array(await files[0].arrayBuffer()); }
        check();
        temp = await loadPdfFromBytes(bytes);
        const format = id.split("-")[1];
        if (["docx", "xlsx", "pptx"].includes(format)) {
          ({ blob, note } = await pdfToOffice(temp, format, { mode: options.value, progress }));
        } else {
          const markdown = format === "md";
          const output = await convertPdf(temp, markdown ? "text" : format, {
            baseName: name, dpi: 150, imageType: options.value || "png", keepOriginal: false,
            pageMarks: !markdown, direction: q("[data-direction] select").value,
            onProgress: progress, isCanceled: () => !dialog.open,
          });
          if (output.emptyText) { throw new Error("抽出できる文字がありません。文字情報を含む PDF を選んでください。"); }
          blob = output.blob;
          if (markdown) {
            const pages = (await blob.text()).split("\f");
            const blocks = pages.map((s, i) => "## " + (i + 1) + "ページ\n\n" +
              s.trim().replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
                .replace(/([\\`*_{}\[\]#!|~])/g, "\\$1"));
            blob = new Blob([blocks.join("\n\n") + "\n"], { type: "text/markdown;charset=utf-8" });
          }
        }
      }
      check();
      result = { blob, fileName: `${name}.${tool.extension}` };
      run.textContent = "保存先を選ぶ…";
      status.textContent = `${result.fileName}（${formatBytes(blob.size)}）${note || ""}`;
    } catch (e) {
      if (dialog.open) {
        clearResult();
        status.textContent = e?.name === "PasswordException" ? "パスワードを解除した PDF を選んでください。" : (e.message || String(e));
      }
    } finally {
      await temp?.loadingTask.destroy().catch(() => {});
      busy = false;
      controls.forEach((el, i) => { el.disabled = states[i]; });
      if (!dialog.open) { clearResult(); }
    }
  };
  dialog.showModal();
  clearResult();
}

