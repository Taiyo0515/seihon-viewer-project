import { baseName, createZip, formatBytes, sanitizeFileName, saveBlobAs } from "../../common/files.js";
import { MAX_PIXELS, MAX_SIDE } from "../image-export.js";
import { loadPdfFromBytes } from "../page-export.js";

export const ASSET_TOOLS = [
  { id: "embedded-images", title: "埋め込み画像を抽出", description: "ページ内の写真や図版を元の画素数のPNGとしてZIPに保存", category: "形式変換" },
  { id: "attachments", title: "添付ファイルを抽出", description: "文書やページに添付されたファイルをZIPに保存", category: "形式変換" },
];

async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), v => v.toString(16).padStart(2, "0")).join("");
}

function imageCanvas(image) {
  const { width, height, kind, data, bitmap } = image || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || Math.min(width, height) < 1 ||
      Math.max(width, height) > MAX_SIDE || width * height > MAX_PIXELS) { return null; }
  // PDF.jsがメモリ保護で縮小したビットマップを元の画素数として保存しない。
  if (bitmap && (bitmap.width !== width || bitmap.height !== height)) { return null; }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) { return null; }
  if (bitmap) { ctx.drawImage(bitmap, 0, 0); return canvas; }
  if (!data) { canvas.width = canvas.height = 0; return null; }
  const { GRAYSCALE_1BPP, RGB_24BPP, RGBA_32BPP } = globalThis.pdfjsLib.ImageKind;
  const stride = kind === GRAYSCALE_1BPP ? Math.ceil(width / 8) : kind === RGB_24BPP ? width * 3 : kind === RGBA_32BPP ? width * 4 : 0;
  if (!stride || data.length < stride * height) { canvas.width = canvas.height = 0; return null; }
  for (let y = 0; y < height; y += 64) {
    const rows = Math.min(64, height - y);
    const tile = ctx.createImageData(width, rows);
    if (kind === RGBA_32BPP) { tile.data.set(data.subarray(y * stride, (y + rows) * stride)); }
    else {
      for (let row = 0; row < rows; row++) {
        const first = (y + row) * stride;
        for (let x = 0; x < width; x++) {
          const dest = (row * width + x) * 4;
          if (kind === RGB_24BPP) {
            const src = first + 3 * x;
            tile.data[dest] = data[src]; tile.data[dest + 1] = data[src + 1]; tile.data[dest + 2] = data[src + 2];
          } else {
            const white = (data[first + (x >> 3)] >> (7 - x % 8)) & 1;
            tile.data[dest] = tile.data[dest + 1] = tile.data[dest + 2] = white * 255;
          }
          tile.data[dest + 3] = 255;
        }
      }
    }
    ctx.putImageData(tile, 0, y);
  }
  return canvas;
}

async function imageFiles(doc, progress, signal) {
  const ops = globalThis.pdfjsLib.OPS;
  const parts = [], seen = new Set(), seenGlobal = new Set();
  let skipped = 0, masks = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    signal?.throwIfAborted();
    progress(`画像を探しています（${n}/${doc.numPages}ページ）`);
    const page = await doc.getPage(n), seenLocal = new Set();
    let ordinal = 0;
    try {
      const list = await page.getOperatorList({ annotationMode: globalThis.pdfjsLib.AnnotationMode.DISABLE });
      for (let i = 0; i < list.fnArray.length; i++) {
        signal?.throwIfAborted();
        const op = list.fnArray[i], args = list.argsArray[i];
        let image, tiles;
        if (op === ops.paintImageXObject || op === ops.paintImageXObjectRepeat) {
          const key = args[0], global = key.startsWith("g_"), visited = global ? seenGlobal : seenLocal;
          if (visited.has(key)) { continue; }
          visited.add(key);
          image = await new Promise(resolve => (global ? page.commonObjs : page.objs).get(key, resolve));
          if (op === ops.paintImageXObject && (image?.width !== args[1] || image?.height !== args[2])) { skipped++; continue; }
        } else if (op === ops.paintInlineImageXObject || op === ops.paintInlineImageXObjectGroup) {
          image = args[0]; tiles = op === ops.paintInlineImageXObjectGroup ? args[1] : null;
        } else {
          if ([ops.paintImageMaskXObject, ops.paintImageMaskXObjectGroup, ops.paintImageMaskXObjectRepeat, ops.paintSolidColorImageMask].includes(op)) { masks++; }
          continue;
        }
        const canvas = imageCanvas(image);
        if (!canvas) { skipped++; continue; }
        try {
          const areas = tiles || [{ x: 0, y: 0, w: canvas.width, h: canvas.height }];
          for (const rect of areas) {
            let cut = canvas;
            try {
              if (tiles) {
                cut = document.createElement("canvas"); cut.width = rect.w; cut.height = rect.h;
                cut.getContext("2d").drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
              }
              const blob = await new Promise(resolve => cut.toBlob(resolve, "image/png"));
              if (!blob) { skipped++; continue; }
              const hash = await digest(await blob.arrayBuffer());
              if (seen.has(hash)) { continue; }
              seen.add(hash);
              const number = String(n).padStart(String(doc.numPages).length, "0");
              parts.push({ name: `p${number}_${++ordinal}_${cut.width}x${cut.height}.png`, blob });
            } finally { if (cut !== canvas) { cut.width = cut.height = 0; } }
          }
        } finally { canvas.width = canvas.height = 0; }
      }
    } finally { page.cleanup(); }
  }
  return { parts, note: [skipped && `元解像度で取得できない画像 ${skipped}件`, masks && `対象外の画像マスク描画 ${masks}件`].filter(Boolean).join("、") };
}

function uniqueAttachmentName(raw, names) {
  const name = String(raw || "").split(/[\\/]/).pop();
  const match = /^(.*?)(\.[A-Za-z0-9]{1,16})?$/.exec(name);
  let base = sanitizeFileName(match?.[1], "attachment");
  if (/^(?:con|aux|prn|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) { base = "_" + base; }
  const extension = match?.[2] || "";
  for (let copy = 0; ; copy++) {
    const candidate = base + (copy ? ` (${copy + 1})` : "") + extension;
    const key = candidate.toLowerCase();
    if (!names.has(key)) { names.add(key); return candidate; }
  }
}

async function attachmentFiles(doc, progress, signal) {
  const named = await doc.getAttachments();
  const entries = named instanceof Map ? new Map(named) : new Map(Object.entries(named || {}));
  for (let n = 1; n <= doc.numPages; n++) {
    signal?.throwIfAborted();
    progress(`ページの添付ファイルを探しています（${n}/${doc.numPages}）`);
    const page = await doc.getPage(n);
    try {
      for (const annot of await page.getAnnotations()) {
        if (annot.fileId && annot.file && !entries.has(annot.fileId)) { entries.set(annot.fileId, annot.file); }
      }
    } finally { page.cleanup(); }
  }
  const parts = [], names = new Set(), seen = new Set();
  let skipped = 0;
  for (const [id, file] of entries) {
    signal?.throwIfAborted();
    const content = file.content || await doc.getAttachmentContent(id);
    if (content == null) { skipped++; continue; }
    const name = file.filename || id;
    const key = name + "/" + await digest(content);
    if (seen.has(key)) { continue; }
    seen.add(key);
    parts.push({ name: uniqueAttachmentName(name, names), blob: new Blob([content]) });
  }
  return { parts, note: skipped ? `内容を取得できない添付 ${skipped}件` : "" };
}

export async function extractAssets(id, doc, progress = () => {}, signal) {
  const result = id === "embedded-images" ? await imageFiles(doc, progress, signal) : await attachmentFiles(doc, progress, signal);
  signal?.throwIfAborted();
  if (!result.parts.length) { throw new Error("取り出せるファイルがありません" + (result.note ? "（" + result.note + "）" : "")); }
  if (result.parts.length > 65535) { throw new Error("1つのZIPに保存できるファイルは65,535個までです"); }
  return { blob: await createZip(result.parts), count: result.parts.length, note: result.note };
}

export function runAssetTool(id) {
  const tool = ASSET_TOOLS.find(entry => entry.id === id);
  if (!tool) { throw new Error("未対応のツールです"); }
  if (document.getElementById("shAssetTool")?.open) { return; }
  const dialog = document.createElement("dialog");
  dialog.id = "shAssetTool"; dialog.className = "sh-dialog sh-pdf-tool-dialog";
  dialog.setAttribute("aria-labelledby", "shAssetTitle");
  dialog.innerHTML = `<header><h2 id="shAssetTitle"></h2><button class="sh-btn" data-close>閉じる</button></header>
    <div class="sh-tool-body"><div class="sh-tool-fields"><label>対象のPDF<input type="file" accept=".pdf,application/pdf"></label></div><p data-hint></p></div>
    <footer><p role="status"></p><button class="sh-btn sh-btn-primary" data-run disabled>取り出す</button></footer>`;
  const q = selector => dialog.querySelector(selector);
  const picker = q("input"), status = q("[role=status]"), run = q("[data-run]"), close = q("[data-close]");
  q("h2").textContent = tool.title;
  const images = id === "embedded-images";
  q("[data-hint]").textContent = images
    ? "各ページで描画される画像をPNGに変換します。同じ画像は最初の1枚だけ保存します。文字・ベクター図形・注釈・画像マスクは対象外です。縮小された画像や1辺16,000px・64メガピクセルを超える画像は除きます。"
    : "文書の添付一覧とページの添付注釈から、埋め込まれたファイルを取り出します。同名で内容が違うファイルには連番を付けます。";
  let abort, prepared, saving = false;
  const opener = document.activeElement;
  picker.onchange = () => { run.disabled = !picker.files.length; prepared = null; status.textContent = ""; run.textContent = "取り出す"; };
  close.onclick = () => { if (!saving) { abort?.abort(); dialog.close(); } };
  dialog.oncancel = e => { if (saving) { e.preventDefault(); } else { abort?.abort(); } };
  dialog.onclose = () => { abort?.abort(); prepared = null; dialog.remove(); opener?.focus(); };
  run.onclick = async () => {
    if (run.disabled) { return; }
    const file = picker.files[0];
    run.disabled = picker.disabled = true;
    const controller = abort = new AbortController();
    const progress = msg => { if (!controller.signal.aborted) { status.textContent = msg; } };
    try {
      if (prepared) {
        saving = close.disabled = true;
        const saved = await saveBlobAs(prepared.blob, prepared.name);
        progress(saved.ok ? "保存しました" : saved.canceled ? "保存をキャンセルしました" : saved.error || "保存できませんでした");
      } else {
        progress("PDFを開いています…");
        const doc = await loadPdfFromBytes(new Uint8Array(await file.arrayBuffer()));
        try {
          const result = await extractAssets(id, doc, progress, controller.signal);
          controller.signal.throwIfAborted();
          prepared = { blob: result.blob, name: `${sanitizeFileName(baseName(file.name))}_${images ? "埋め込み画像" : "添付"}.zip` };
          run.textContent = "保存先を選ぶ…";
          progress(`${result.count}ファイル（${formatBytes(result.blob.size)}）${result.note ? "・" + result.note : ""}`);
        } finally { await doc.loadingTask.destroy(); }
      }
    } catch (error) { progress(error.name === "PasswordException" ? "保護を解除したPDFを選んでください" : error.message); }
    finally { saving = close.disabled = run.disabled = picker.disabled = false; }
  };
  document.body.append(dialog); dialog.showModal(); picker.focus();
}
