/** TIFF の各画像を必要になった時点で 1 ページずつ復号する。 */
import { unzlibSync } from "../lib/fflate/fflate.js";

self.pako = { inflate: unzlibSync };

let source, pages;

function validateDirectories(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 8) { throw new Error("TIFF のヘッダーを読めません。"); }
  const order = view.getUint16(0);
  const little = order === 0x4949;
  if ((!little && order !== 0x4d4d) || view.getUint16(2, little) !== 42) {
    throw new Error("通常の TIFF 形式を選んでください。BigTIFF は対象外です。");
  }
  const visited = new Set();
  let offset = view.getUint32(4, little);
  while (offset !== 0) {
    if (visited.has(offset) || offset + 2 > buffer.byteLength) { throw new Error("TIFF のページ情報が壊れています。"); }
    visited.add(offset);
    const next = offset + 2 + view.getUint16(offset, little) * 12;
    if (next + 4 > buffer.byteLength) { throw new Error("TIFF のページ情報が欠けています。"); }
    offset = view.getUint32(next, little);
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.file) {
      await import("../lib/utif/UTIF.js");
      source = await data.file.arrayBuffer();
      validateDirectories(source);
      pages = self.UTIF.decode(source).filter(p => p.t256?.[0] && p.t257?.[0] && !(p.t254?.[0] & 5) && p.t255?.[0] !== 2);
      if (!pages.length) { throw new Error("TIFF からページを読み取れませんでした。"); }
      self.postMessage({ count: pages.length });
      return;
    }
    const item = pages[data.index], width = item.t256[0], height = item.t257[0];
    if (width * height > 64 * 1024 * 1024 || Math.max(width, height) > 32767) { throw new Error("TIFF のページが大きすぎます（1 ページ 6400 万画素まで）。"); }
    const compression = item.t259?.[0] || 1;
    if (![1, 3, 4, 5, 6, 7, 8, 32946, 32773, 32809].includes(compression) || (item.t284?.[0] || 1) !== 1) {
      throw new Error("この TIFF の圧縮方式または色の並びには対応していません。");
    }
    if (compression === 32946) { item.t259 = [8]; }
    self.UTIF.decodeImage(source, item, pages);
    const pixels = self.UTIF.toRGBA8(item);
    delete item.data;
    self.postMessage({ pixels, width, height, orientation: item.t274?.[0] || 1 }, [pixels.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message || "TIFF の読み込みに失敗しました。" });
  }
};

