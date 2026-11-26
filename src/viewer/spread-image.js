import { analyzePage, clampScale, renderScaleFor } from "./image-export.js";

/** parts hold a rotated page crop (region) and its normalized destination in the selection. */
export async function renderSpreadPng(doc, parts, { settings, rotation = 0 }, pointWidth, pointHeight) {
  if (!parts.length || !(pointWidth > 0 && pointHeight > 0)) {
    throw new Error("ページの内側を含む範囲を選択してください");
  }
  const output = document.createElement("canvas");
  const tile = document.createElement("canvas");
  const pages = [];
  try {
    let wantedScale = 0;
    for (const part of parts) {
      const page = await doc.getPage(part.number);
      const pageRotation = (page.rotate + rotation + 360) % 360;
      const base = page.getViewport({ scale: 1, rotation: pageRotation });
      const crop = { width: base.width * part.region.w, height: base.height * part.region.h };
      pages.push({ page, pageRotation, part, crop });
      const analysis = settings.imageQuality === "original" || settings.scanOriginal ? await analyzePage(page) : null;
      const scale = renderScaleFor(crop, settings, analysis);
      wantedScale = Math.max(wantedScale, scale * crop.width / (pointWidth * part.w),
        scale * crop.height / (pointHeight * part.h));
    }
    const scale = clampScale({ width: pointWidth, height: pointHeight }, wantedScale);
    const width = output.width = Math.max(1, Math.floor(pointWidth * scale + 1e-8));
    const height = output.height = Math.max(1, Math.floor(pointHeight * scale + 1e-8));
    const ctx = output.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    for (const { page, pageRotation, part, crop } of pages) {
      // Round both edges so adjacent crops share exactly the same pixel boundary.
      const left = Math.round(part.x * width), top = Math.round(part.y * height);
      tile.width = Math.round((part.x + part.w) * width) - left;
      tile.height = Math.round((part.y + part.h) * height) - top;
      if (!tile.width || !tile.height) continue;
      const viewport = page.getViewport({ scale: tile.width / crop.width, rotation: pageRotation });
      const sy = tile.height / (viewport.height * part.region.h);
      await page.render({
        canvas: tile, viewport,
        transform: [1, 0, 0, sy, -viewport.width * part.region.x, -viewport.height * sy * part.region.y],
        intent: "print", annotationMode: globalThis.pdfjsLib.AnnotationMode.ENABLE_STORAGE, background: "#ffffff",
      }).promise;
      ctx.drawImage(tile, left, top);
    }
    const blob = await new Promise((resolve, reject) =>
      output.toBlob(result => result ? resolve(result) : reject(new Error("PNGに変換できませんでした")), "image/png")
    );
    return { blob, width, height, type: "image/png", pointWidth, pointHeight };
  } finally {
    tile.width = tile.height = output.width = output.height = 0;
    for (const { page } of pages) page.cleanup();
  }
}
