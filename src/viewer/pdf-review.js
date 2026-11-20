/** ページの見た目の比較・墨消し・手書きサイン。座標は表示後のページに対する比率。 */
import { clampScale } from "./image-export.js";

const library = () => import("../lib/pdf-lib.esm.min.js");

function surface(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function disposeCanvas(canvas) {
  if (canvas) { canvas.width = canvas.height = 0; }
}

export async function renderReviewPage(doc, number, { scale = 1, longest = 1600 } = {}) {
  const page = await doc.getPage(number);
  const base = page.getViewport({ scale: 1 });
  scale = clampScale(base, Math.min(scale, longest / Math.max(base.width, base.height)));
  const view = page.getViewport({ scale });
  const canvas = surface(Math.max(1, Math.ceil(view.width)), Math.max(1, Math.ceil(view.height)));
  try {
    await page.render({
      canvas, viewport: view, intent: "print", background: "#fff",
      annotationMode: globalThis.pdfjsLib.AnnotationMode.ENABLE_STORAGE,
    }).promise;
    return { canvas, base };
  } catch (error) { disposeCanvas(canvas); throw error; }
  finally { page.cleanup(); }
}

export async function comparePage(first, second, number) {
  const docs = [first, second];
  const sizes = [];
  for (const doc of docs) {
    const page = number <= doc.numPages ? await doc.getPage(number) : null;
    sizes.push(page?.getViewport({ scale: 1 }) || null);
  }
  const width = Math.max(...sizes.map(size => size?.width || 0));
  const height = Math.max(...sizes.map(size => size?.height || 0));
  if (!width || !height) { throw new Error("比較するページがありません"); }
  const scale = Math.min(2, 1600 / Math.max(width, height));
  const bitmaps = [];
  let out;
  try {
    for (let i = 0; i < docs.length; i++) {
      bitmaps[i] = sizes[i] ? (await renderReviewPage(docs[i], number, { scale })).canvas : null;
    }
    out = surface(Math.ceil(width * scale), Math.ceil(height * scale));
    const sources = bitmaps.map(c => c?.getContext("2d").getImageData(0, 0, c.width, c.height).data);
    const ctx = out.getContext("2d");
    const image = ctx.createImageData(out.width, out.height);
    const data = image.data;
    let changed = 0;
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const target = (y * out.width + x) * 4;
        const insideA = bitmaps[0] && x < bitmaps[0].width && y < bitmaps[0].height;
        const insideB = bitmaps[1] && x < bitmaps[1].width && y < bitmaps[1].height;
        const a = insideA ? 4 * (y * bitmaps[0].width + x) : 0;
        const b = insideB ? 4 * (y * bitmaps[1].width + x) : 0;
        let different = Boolean(insideA) !== Boolean(insideB);
        let oldGray = 255, newGray = 255;
        if (insideA) { oldGray = (sources[0][a] + sources[0][a + 1] + sources[0][a + 2]) / 3; }
        if (insideB) { newGray = (sources[1][b] + sources[1][b + 1] + sources[1][b + 2]) / 3; }
        if (insideA && insideB) {
          for (let k = 0; k < 3; k++) {
            if (Math.abs(sources[0][a + k] - sources[1][b + k]) >= 12) { different = true; break; }
          }
        }
        if (different) {
          changed++;
          const added = !insideA || (insideB && newGray <= oldGray);
          data[target] = added ? 31 : 207;
          data[target + 1] = added ? 105 : 49;
          data[target + 2] = added ? 219 : 61;
        } else {
          data[target] = data[target + 1] = data[target + 2] = 175 + newGray * 80 / 255;
        }
        data[target + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return { canvas: out, changed, ratio: changed / (out.width * out.height), width, height,
      added: !sizes[0], removed: !sizes[1] };
  } catch (e) { disposeCanvas(out); throw e; }
  finally { bitmaps.forEach(disposeCanvas); }
}

async function pngBytes(canvas) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) { throw new Error("ページの画像を作成できませんでした"); }
  return blob.arrayBuffer();
}

function checkRect(rect) {
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ||
      rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 ||
      rect.x + rect.w > 1.000001 || rect.y + rect.h > 1.000001) {
    throw new Error("範囲をページ内に指定してください");
  }
}

async function addRasterPage(pdf, canvas, width, height) {
  const image = await pdf.embedPng(await pngBytes(canvas));
  pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
}

export async function comparisonPdf(first, second, progress, signal) {
  const { PDFDocument } = await library();
  const pdf = await PDFDocument.create();
  const count = Math.max(first.numPages, second.numPages);
  for (let n = 1; n <= count; n++) {
    signal?.throwIfAborted();
    progress?.(`比較しています（${n}/${count}）`);
    const result = await comparePage(first, second, n);
    try { await addRasterPage(pdf, result.canvas, result.width, result.height); }
    finally { disposeCanvas(result.canvas); }
  }
  signal?.throwIfAborted();
  return pdf.save();
}

export async function redactPdf(doc, regions, progress, signal) {
  if (!regions.length) { throw new Error("墨消しする範囲を選択してください"); }
  for (const item of regions) {
    if (!Number.isInteger(item.page) || item.page < 1 || item.page > doc.numPages) { throw new Error("対象ページがありません"); }
    checkRect(item);
  }
  const { PDFDocument } = await library();
  const pdf = await PDFDocument.create();
  // 元の文書をコピーせず、墨消し後の画素だけで新しいPDFを構成する。
  for (let n = 1; n <= doc.numPages; n++) {
    signal?.throwIfAborted();
    progress?.(`墨消し済みのページを作成しています（${n}/${doc.numPages}）`);
    const { canvas, base } = await renderReviewPage(doc, n, { scale: 200 / 72, longest: 4800 });
    try {
      const ctx = canvas.getContext("2d");
      for (const rect of regions.filter(r => r.page === n)) {
        const left = Math.floor(rect.x * canvas.width), top = Math.floor(rect.y * canvas.height);
        ctx.fillStyle = "#000";
        ctx.fillRect(left, top, Math.ceil((rect.x + rect.w) * canvas.width) - left,
          Math.ceil((rect.y + rect.h) * canvas.height) - top);
      }
      await addRasterPage(pdf, canvas, base.width, base.height);
    } finally { disposeCanvas(canvas); }
  }
  signal?.throwIfAborted();
  return pdf.save();
}

export function fitSignature(rect, aspect, pageAspect) {
  const width = Math.min(rect.w, rect.h * aspect / pageAspect);
  const height = width * pageAspect / aspect;
  return { x: rect.x + (rect.w - width) / 2, y: rect.y + (rect.h - height) / 2, w: width, h: height };
}

export async function signedPdf(doc, regions, signature, progress, signal) {
  if (!regions.length || !signature) { throw new Error("サインを描き、ページ上の位置を指定してください"); }
  const { PDFDocument, degrees } = await library();
  const pdf = await PDFDocument.load(await doc.getData(), { updateMetadata: false });
  const ink = await pdf.embedPng(await signature.arrayBuffer());
  for (const rect of regions) {
    signal?.throwIfAborted();
    checkRect(rect);
    progress?.(`サインを配置しています（${rect.page}ページ）`);
    const sheet = await doc.getPage(rect.page);
    const view = sheet.getViewport({ scale: 1 });
    const box = fitSignature(rect, ink.width / ink.height, view.width / view.height);
    const [x, y] = view.convertToPdfPoint(box.x * view.width, (box.y + box.h) * view.height);
    pdf.getPage(rect.page - 1).drawImage(ink, { x, y, width: box.w * view.width / sheet.userUnit,
      height: box.h * view.height / sheet.userUnit, rotate: degrees(sheet.rotate) });
  }
  return pdf.save({ updateFieldAppearances: false });
}
