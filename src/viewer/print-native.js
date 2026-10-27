/**
 * 元の PDF で印刷(0.2 〜 0.6.8 の「最高画質」): 元の PDF(編集していれば、編集を反映した PDF)を、Chrome の PDF 表示機能で印刷する。
 *
 * ビューアの通常の印刷(PDF.js)は、ページを画像にしてから印刷するため、画質が解像度(150dpi・300dpi)で決まり、
 * 印刷画面で「PDF に保存」すると、文字(OCR の文字を含む)も画像になってしまう。
 * この方式では、見えない小さな枠(iframe)に PDF を読み込んで、Chrome の印刷画面を出す。
 * 画像は元の解像度のまま、文字は文字のまま印刷され、「PDF に保存」でも元の画質と OCR の文字が残る。
 */

let frame = null;
let pdfLibPromise = null;

/**
 * PDF に題名(/Title)を付ける。Chrome の印刷画面の「PDF に保存」は、PDF の題名をファイル名の候補にするため、
 * 題名の無い PDF では、印刷用の仮の名前(英数字の羅列)になってしまう。付けられなければ、元のまま(同じもの)を返す。
 * (画像などの中身は作り直さずにそのまま写す)
 * 0.4.2: XMP(PDF の中のもう1つの情報)に題名があれば、そちらも書き換える
 * (PDF.js や Acrobat は XMP の題名を優先して表示するため)。
 */
export async function withTitle(bytes, title) {
  try {
    pdfLibPromise ||= import("../lib/pdf-lib.esm.min.js");
    const lib = await pdfLibPromise;
    const pdf = await lib.PDFDocument.load(bytes, { updateMetadata: false });
    pdf.setTitle(title);
    updateXmpTitle(lib, pdf, title);
    return await pdf.save({ useObjectStreams: false });
  } catch (e) {
    console.warn("[製本ビューア] PDF に題名を付けられませんでした", e);
    return bytes;
  }
}

/** XMP の dc:title を書き換える(読めない XMP は外す。古い題名が残って表示されないように) */
function updateXmpTitle(lib, pdf, title) {
  const { PDFName, PDFRawStream, decodePDFRawStream } = lib;
  const ref = pdf.catalog.get(PDFName.of("Metadata"));
  if (!ref) {
    return;
  }
  const stream = pdf.context.lookup(ref);
  let xml = null;
  try {
    if (stream instanceof PDFRawStream) {
      xml = new TextDecoder("utf-8", { fatal: true }).decode(decodePDFRawStream(stream).decode());
    }
  } catch {
    xml = null;
  }
  if (xml === null || !/<dc:title\b/.test(xml)) {
    if (xml === null) {
      pdf.catalog.delete(PDFName.of("Metadata"));
    }
    return;
  }
  const esc = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // 開きのタグ(xmlns:dc などの指定が付いていることがある)はそのまま残す
  const alt = `<rdf:Alt><rdf:li xml:lang="x-default">${esc}</rdf:li></rdf:Alt>`;
  const replaced = xml.replace(/(<dc:title\b[^>]*?)(\/>|>[\s\S]*?<\/dc:title>)/, (m, open) => `${open}>${alt}</dc:title>`);
  const data = new TextEncoder().encode(replaced);
  const next = pdf.context.stream(data, { Type: "Metadata", Subtype: "XML" });
  pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(next));
}
let frameUrl = null;
let cleanupTimer = 0;

/** Chrome の PDF 表示機能を使えるか(Chrome の設定で「PDF をダウンロードする」にしていると使えない) */
export function canPrintWithChrome() {
  return navigator.pdfViewerEnabled !== false;
}

/** 印刷用の枠を消す */
export function removePrintFrame() {
  clearTimeout(cleanupTimer);
  frame?.remove();
  frame = null;
  if (frameUrl) {
    URL.revokeObjectURL(frameUrl);
    frameUrl = null;
  }
}

/**
 * PDF を Chrome の印刷画面で印刷する。
 * @param {Uint8Array} bytes 印刷する PDF(暗号化されていないもの。題名は withTitle で付けておく)
 */
export async function printWithChrome(bytes) {
  if (!canPrintWithChrome()) {
    throw new Error("Chrome の PDF 表示機能がオフになっています");
  }
  removePrintFrame();
  frameUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  frame = document.createElement("iframe");
  frame.className = "sh-print-frame";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.title = "印刷用";
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("印刷用の PDF を読み込めませんでした")), 60000);
    frame.addEventListener(
      "load",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
  frame.src = frameUrl;
  document.body.append(frame);
  await loaded;
  const win = frame.contentWindow;
  let ok = false;
  try {
    ok = !!win.document.querySelector('embed[type="application/pdf"]');
  } catch {
    ok = false;
  }
  if (!ok) {
    removePrintFrame();
    throw new Error("Chrome の PDF 表示機能を使えませんでした");
  }
  // PDF の読み込みが終わる前に呼んでも、Chrome は読み込みを待ってから印刷画面を出す
  win.focus();
  win.print();
  // 印刷が終わった後もしばらく残す(印刷は裏で続くため)。次の印刷・別の PDF を開いたとき・10分後に消す
  clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(removePrintFrame, 10 * 60 * 1000);
}
