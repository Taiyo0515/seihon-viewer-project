/** 収集ページの非破壊編集。元PDFの文字・ベクターを保ったまま出力する。 */
import { extractPagesToPdf } from "./page-export.js";

/** 収集した1ページに回転と切り取りを反映したPDFを作る。 */
export async function editedCollectionPdf(bytes, item, { uncropped = false } = {}) {
  const single = await extractPagesToPdf(null, [{ source: bytes, pageIndex: item.pageIndex }]);
  const { PDFDocument, degrees } = await import("../lib/pdf-lib.esm.min.js");
  const doc = await PDFDocument.load(single, { updateMetadata: false });
  const page = doc.getPage(0);
  const edits = item.edits || {};
  page.setRotation(degrees(((page.getRotation().angle + (edits.rotation || 0)) % 360 + 360) % 360));
  if (!uncropped && edits.crop) {
    const [x, y, width, height] = edits.crop;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      throw new Error("切り取り範囲が正しくありません");
    }
    page.setMediaBox(x, y, width, height);
    page.setCropBox(x, y, width, height);
    page.setTrimBox(x, y, width, height);
    page.setBleedBox(x, y, width, height);
    page.setArtBox(x, y, width, height);
  }
  return doc.save();
}

/** 選択範囲(画面上の比率)をPDFの座標へ変換する。 */
export function cropFromSelection(viewport, box) {
  const a = viewport.convertToPdfPoint(box.x * viewport.width, box.y * viewport.height);
  const b = viewport.convertToPdfPoint((box.x + box.w) * viewport.width, (box.y + box.h) * viewport.height);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
}
