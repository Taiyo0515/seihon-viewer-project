/**
 * 最高画質の印刷(0.2): 元の PDF(編集していれば、編集を反映した PDF)を、Chrome の PDF 表示機能で印刷する。
 *
 * ビューアの通常の印刷(PDF.js)は、ページを画像にしてから印刷するため、画質が解像度(150dpi・300dpi)で決まり、
 * 印刷画面で「PDF に保存」すると、文字(OCR の文字を含む)も画像になってしまう。
 * 最高画質では、見えない小さな枠(iframe)に PDF を読み込んで、Chrome の印刷画面を出す。
 * 画像は元の解像度のまま、文字は文字のまま印刷され、「PDF に保存」でも元の画質と OCR の文字が残る。
 */

let frame = null;
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
 * @param {Uint8Array} bytes 印刷する PDF(暗号化されていないもの)
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
