import { loadPdfFromBytes } from "./page-export.js";
import { clampScale } from "./image-export.js";

export function rewritePdf(id, bytes, password, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./qpdf-worker.js", import.meta.url));
    const stop = () => { worker.terminate(); signal.removeEventListener("abort", abort); };
    const abort = () => { stop(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = e => { stop(); reject(new Error(e.message)); };
    worker.onmessage = ({ data }) => {
      stop();
      if (data.error) { reject(new Error(data.error)); }
      else { resolve({ blob: new Blob([data.bytes], { type: "application/pdf" }), warning: data.warning }); }
    };
    worker.postMessage({ id, bytes, password }, [bytes.buffer]);
  });
}

let ocrRuntime;
function loadOcr() {
  ocrRuntime ||= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("vendor/ocr/tesseract.min.js");
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => { ocrRuntime = null; script.remove(); reject(new Error("文字認識エンジンを読み込めませんでした")); };
    document.head.append(script);
  });
  return ocrRuntime;
}

export async function recognizePdf(bytes, { language, textOnly, signal, progress }) {
  const doc = await loadPdfFromBytes(bytes);
  let worker, pageNumber = 1;
  // terminateだけでは実行中のrecognizeが決着しないため、中止を明示的に伝える。
  let cancel;
  const canceled = new Promise((_, reject) => { cancel = reject; });
  canceled.catch(() => {});
  const onAbort = () => cancel(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const runtime = await loadOcr();
    const base = chrome.runtime.getURL("vendor/ocr/");
    const created = runtime.createWorker(language, 1, {
      workerPath: base + "worker.min.js", corePath: base + "tesseract-core-lstm.wasm.js",
      langPath: base, workerBlobURL: false, cacheMethod: "none",
      errorHandler: e => cancel(new Error(String(e))),
      logger: m => {
        if (m.status === "recognizing text") { progress(pageNumber + " / " + doc.numPages + " ページ（" + Math.round(m.progress * 100) + "%）"); }
      },
    });
    created.then(w => { if (signal.aborted) { w.terminate(); } }, () => {});
    worker = await Promise.race([created, canceled]);
    const { PDFDocument } = await import("../lib/pdf-lib.esm.min.js");
    const out = textOnly ? null : await PDFDocument.create();
    const text = [];
    for (; pageNumber <= doc.numPages; pageNumber++) {
      signal.throwIfAborted();
      progress(pageNumber + " / " + doc.numPages + " ページを準備中…");
      const page = await doc.getPage(pageNumber);
      const basePage = page.getViewport({ scale: 1 });
      const scale = Math.min(clampScale(basePage, 300 / 72), Math.sqrt(12e6 / (basePage.width * basePage.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      try {
        await page.render({ canvas, viewport, background: "#ffffff" }).promise;
        signal.throwIfAborted();
        const { data } = await Promise.race([
          worker.recognize(canvas, { pdfTitle: "OCR" }, { text: textOnly, pdf: !textOnly }), canceled,
        ]);
        if (textOnly) {
          text.push(data.text.trimEnd());
        } else {
          const [sheet] = await out.embedPdf(data.pdf, [0]);
          out.addPage([basePage.width, basePage.height]).drawPage(sheet, { width: basePage.width, height: basePage.height });
        }
      } finally { canvas.width = canvas.height = 0; page.cleanup(); }
    }
    signal.throwIfAborted();
    return { blob: textOnly ? new Blob([text.join("\n\n")], { type: "text/plain;charset=utf-8" }) : new Blob([await out.save()], { type: "application/pdf" }) };
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { await worker?.terminate(); } finally { await doc.loadingTask.destroy(); }
  }
}
