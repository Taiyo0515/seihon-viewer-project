/** ホームの PDF ツール。入力は読み取り専用、結果は独立したファイルとして返す。 */
import { baseName, createZip, formatBytes, sanitizeFileName } from "../common/files.js";
import { extractPagesToPdf, loadPdfFromBytes } from "./page-export.js";
import { pageImageFile } from "./image-export.js";
import { parseOutputPages } from "./ui/output-dialog.js";

const pdfLib = () => import("../lib/pdf-lib.esm.min.js");
const bytesOf = async file => new Uint8Array(await file.arrayBuffer());
const pdfBlob = bytes => new Blob([bytes], { type: "application/pdf" });
const saveOptions = { useObjectStreams: true, updateFieldAppearances: false };
const pdfName = file => sanitizeFileName(baseName(file.name));

function integer(value, min, max, label) {
  const n = Number(value);
  if (value === "" || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${label}は ${min}〜${max} の整数で指定してください`);
  }
  return n;
}

function naturalPages(count) {
  return Array.from({ length: count }, (_, i) => i);
}

function requestedPages(input, count, required = false) {
  const text = String(input ?? "").normalize("NFKC").trim().replace(/[–−ー]/g, "-");
  if (required && !text) { throw new Error("対象ページを指定してください"); }
  return parseOutputPages(text, count);
}

function requireActive(signal) {
  signal?.throwIfAborted();
}

async function readPdf(bytes) {
  const { PDFDocument } = await pdfLib();
  return PDFDocument.load(bytes, { updateMetadata: false });
}

export async function describeToolFile(file) {
  const pdf = await readPdf(await bytesOf(file));
  return {
    count: pdf.getPageCount(), title: pdf.getTitle() || "", author: pdf.getAuthor() || "",
    subject: pdf.getSubject() || "",
  };
}

async function withPages(file, fn) {
  const doc = await loadPdfFromBytes(await bytesOf(file));
  try { return await fn(doc); }
  finally { await doc.loadingTask.destroy(); }
}

function extract(doc, pages) {
  return extractPagesToPdf(doc, pages.map(pageIndex => ({ source: "current", pageIndex })));
}

async function merge(files, progress, signal) {
  if (files.length < 2) { throw new Error("結合するPDFを2つ以上選んでください"); }
  return withPages(files[0], async doc => {
    const pages = naturalPages(doc.numPages).map(pageIndex => ({ source: "current", pageIndex }));
    for (let i = 1; i < files.length; i++) {
      requireActive(signal);
      progress(`ファイルを読み込んでいます（${i + 1}/${files.length}）`);
      const source = await bytesOf(files[i]);
      const pdf = await readPdf(source);
      for (let pageIndex = 0; pageIndex < pdf.getPageCount(); pageIndex++) {
        pages.push({ source, pageIndex });
      }
    }
    requireActive(signal);
    progress(`${pages.length}ページを結合しています…`);
    return pdfBlob(await extractPagesToPdf(doc, pages));
  });
}

async function organize(id, file, options, progress, signal) {
  return withPages(file, async doc => {
    const count = doc.numPages;
    if (id === "split") {
      let groups;
      if (options.splitMode === "range") {
        const ranges = String(options.pages || "").normalize("NFKC").replaceAll("、", ",").split(",");
        groups = ranges.map(range => requestedPages(range, count, true));
      } else {
        const step = integer(options.step ?? 1, 1, count, "分割するページ数");
        groups = [];
        for (let i = 0; i < count; i += step) {
          groups.push(Array.from({ length: Math.min(step, count - i) }, (_, j) => i + j));
        }
      }
      if (groups.length > 65535) { throw new Error("1つのZIPに保存できるファイルは65,535個までです"); }
      const parts = [];
      for (let i = 0; i < groups.length; i++) {
        requireActive(signal);
        progress(`分割しています（${i + 1}/${groups.length}）`);
        const group = groups[i];
        const serial = String(i + 1).padStart(String(groups.length).length, "0");
        const range = group.length === 1 ? group[0] + 1 : `${group[0] + 1}-${group.at(-1) + 1}`;
        parts.push({ name: `${pdfName(file)}_${serial}_p${range}.pdf`, blob: pdfBlob(await extract(doc, group)) });
      }
      requireActive(signal);
      return createZip(parts);
    }
    let pages = requestedPages(options.pages, count, true);
    if (id === "reorder" && pages.length !== count) {
      throw new Error(`並べ替える順に、全${count}ページを指定してください`);
    }
    if (id === "delete") {
      const removed = new Set(pages);
      pages = naturalPages(count).filter(page => !removed.has(page));
      if (!pages.length) { throw new Error("少なくとも1ページを残してください"); }
    }
    requireActive(signal);
    return pdfBlob(await extract(doc, pages));
  });
}

async function compress(file, options, progress, signal) {
  let compressed;
  if (!options.quality || options.quality === "lossless") {
    const pdf = await readPdf(await bytesOf(file));
    compressed = pdfBlob(await pdf.save(saveOptions));
  } else {
    const dpi = integer(options.quality, 100, 300, "解像度");
    compressed = await withPages(file, async doc => {
      const { PDFDocument } = await pdfLib();
      const out = await PDFDocument.create();
      for (let i = 1; i <= doc.numPages; i++) {
        requireActive(signal);
        progress(`ページを画像にしています（${i}/${doc.numPages}）`);
        const page = await doc.getPage(i);
        const { width, height } = page.getViewport({ scale: 1 });
        const { blob } = await pageImageFile(doc, i, i - 1, {
          settings: { imageQuality: "custom", imageDpi: dpi }, format: "jpeg", allowOriginal: false,
        });
        const image = await out.embedJpg(await blob.arrayBuffer());
        out.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
      }
      return pdfBlob(await out.save(saveOptions));
    });
  }
  if (compressed.size >= file.size) {
    return { blob: file, message: `元のPDF（${formatBytes(file.size)}）が最小です。元の内容で保存できます。` };
  }
  const ratio = Math.round(100 * (1 - compressed.size / file.size));
  return { blob: compressed, message: `${formatBytes(file.size)} → ${formatBytes(compressed.size)}（${ratio}%削減）` };
}

// 回転・原点が異なるページでも、画面上の左下を基準に文字や画像を置く。
function pageFrame(page, lib) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const x = Math.max(media.x, crop.x);
  const y = Math.max(media.y, crop.y);
  const w = Math.min(media.x + media.width, crop.x + crop.width) - x;
  const h = Math.min(media.y + media.height, crop.y + crop.height) - y;
  if (!(w > 0 && h > 0)) { throw new Error("ページの表示範囲が正しくありません"); }
  const r = ((page.getRotation().angle % 360) + 360) % 360;
  const unit = page.node.lookupMaybe(lib.PDFName.of("UserUnit"), lib.PDFNumber)?.asNumber() || 1;
  const point = (u, v) => {
    if (r === 90) { return { x: x + w - v, y: y + u }; }
    if (r === 180) { return { x: x + w - u, y: y + h - v }; }
    if (r === 270) { return { x: x + v, y: y + h - u }; }
    return { x: x + u, y: y + v };
  };
  return { x, y, w, h, width: r % 180 ? h : w, height: r % 180 ? w : h, r, unit, point };
}

async function watermarkImage(pdf, text) {
  const value = String(text ?? "").trim();
  if (!value || [...value].length > 120) { throw new Error("透かしは1〜120文字で入力してください"); }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = 'bold 96px system-ui, "Yu Gothic", sans-serif';
  ctx.font = font;
  const measured = Math.ceil(ctx.measureText(value).width);
  const scale = Math.min(1, 4096 / (measured + 8));
  canvas.width = Math.ceil((measured + 8) * scale);
  canvas.height = 144;
  ctx.scale(scale, 1);
  ctx.font = font;
  ctx.fillStyle = "#30343b";
  ctx.fillText(value, 4, 106);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  canvas.width = canvas.height = 0;
  if (!blob) { throw new Error("透かし文字を準備できませんでした"); }
  return { image: await pdf.embedPng(await blob.arrayBuffer()), aspect: (measured + 8) / 144 };
}

async function edit(id, file, options, progress, signal) {
  const pdf = await readPdf(await bytesOf(file));
  const lib = await pdfLib();
  const count = pdf.getPageCount();
  if (id === "metadata") {
    pdf.setTitle(options.title || "");
    pdf.setAuthor(options.author || "");
    pdf.setSubject(options.subject || "");
  } else if (id === "insert-blank") {
    const after = integer(options.after ?? 0, 0, count, "挿入位置");
    const n = integer(options.amount ?? 1, 1, 1000, "白紙の枚数");
    const frame = pageFrame(pdf.getPage(Math.max(0, after - 1)), lib);
    for (let i = 0; i < n; i++) {
      pdf.insertPage(after + i, [frame.width * frame.unit, frame.height * frame.unit]);
    }
  } else {
    const selected = requestedPages(options.pages, count);
    const font = id === "number" ? await pdf.embedFont(lib.StandardFonts.Helvetica) : null;
    const start = id === "number" ? integer(options.start ?? 1, 0, 99999999, "開始番号") : 0;
    const mark = id === "watermark" ? await watermarkImage(pdf, options.text) : null;
    const opacity = mark ? integer(options.opacity ?? 25, 1, 100, "透かしの濃さ") / 100 : 1;
    const mm = Number(options.margin ?? 5);
    for (const [order, index] of selected.entries()) {
      requireActive(signal);
      const page = pdf.getPage(index);
      const f = pageFrame(page, lib);
      if (id === "rotate") {
        const angle = Number(options.angle ?? 90);
        if (![90, 180, 270].includes(angle)) { throw new Error("回転角を選んでください"); }
        page.setRotation(lib.degrees((f.r + angle) % 360));
      } else if (id === "crop-margins") {
        const delta = mm * 72 / 25.4 / f.unit;
        if (!Number.isFinite(delta) || delta <= 0 || 2 * delta >= Math.min(f.w, f.h)) {
          throw new Error(`${index + 1}ページ目に収まる余白をmmで指定してください`);
        }
        page.setCropBox(f.x + delta, f.y + delta, f.w - 2 * delta, f.h - 2 * delta);
      } else if (font) {
        const text = String(start + order);
        const size = Math.min(12 / f.unit, f.height / 6, f.width / (text.length + 1));
        const width = font.widthOfTextAtSize(text, size);
        const margin = Math.min(14 / f.unit, f.height * 0.06, f.width * 0.06);
        let x = (f.width - width) / 2;
        if (options.align === "left") { x = margin; }
        if (options.align === "right") { x = f.width - margin - width; }
        page.drawText(text, { ...f.point(x, margin), rotate: lib.degrees(f.r), font, size });
      } else if (mark) {
        const width = Math.min(f.width * 0.66, f.height * 0.22 * mark.aspect);
        const height = width / mark.aspect;
        page.drawImage(mark.image, {
          ...f.point((f.width - width) / 2, (f.height - height) / 2),
          width, height, rotate: lib.degrees(f.r), opacity,
        });
      }
      if (order % 50 === 49) {
        progress(`処理しています（${order + 1}/${selected.length}）`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }
  requireActive(signal);
  return pdfBlob(await pdf.save(saveOptions));
}

const suffix = {
  merge: "結合", split: "分割", extract: "抜粋", reorder: "並べ替え", delete: "ページ削除",
  rotate: "回転", compress: "圧縮", watermark: "透かし", number: "ページ番号",
  metadata: "文書情報", "crop-margins": "余白調整", "insert-blank": "白紙追加",
};

export async function preparePdfTool(id, files, options = {}, progress = () => {}, signal) {
  if (!Object.hasOwn(suffix, id)) { throw new Error("未対応のツールです"); }
  if (!files.length) { throw new Error("PDFを選んでください"); }
  requireActive(signal);
  const file = files[0];
  const fileName = `${pdfName(file)}_${suffix[id]}.${id === "split" ? "zip" : "pdf"}`;
  if (id === "compress") { return { fileName, ...await compress(file, options, progress, signal) }; }
  let blob;
  if (id === "merge") { blob = await merge(files, progress, signal); }
  else if (["split", "extract", "reorder", "delete"].includes(id)) {
    blob = await organize(id, file, options, progress, signal);
  } else { blob = await edit(id, file, options, progress, signal); }
  return { blob, fileName };
}
