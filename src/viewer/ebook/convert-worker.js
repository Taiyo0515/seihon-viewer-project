/**
 * 0.4: 画像を並べた PDF を作る Worker(画面の処理と別に動かし、作っている間も画面が固まらないようにする)。
 *
 * 受け取る
 *   {id, type:"build-zip", zip(ArrayBuffer), names:string[], options}   … ZIP(CBZ・EPUB)の中の画像から作る
 *   {id, type:"build-images", images:[{name, bytes(ArrayBuffer)}], options} … 取り出し済みの画像から作る(CBR・CB7)
 * 返す
 *   {id, type:"progress", done, total}
 *   {id, type:"done", bytes(ArrayBuffer), pages, skipped, split}
 *   {id, type:"error", message}
 */

import { unzipSync } from "../../lib/fflate/fflate.js";
import { buildImagePdf } from "./comic-build.js";

self.onmessage = async ({ data }) => {
  const { id, type, options = {} } = data;
  try {
    let images;
    if (type === "build-zip") {
      const wanted = new Set(data.names);
      const files = unzipSync(new Uint8Array(data.zip), { filter: f => wanted.has(f.name) });
      if (data.order) {
        // EPUB: ページの順(null は白紙のページ)
        images = data.order.map(n => (n ? { name: n, bytes: files[n] || null } : { name: "(白紙)", blank: true }));
      } else {
        images = data.names.filter(n => files[n]).map(n => ({ name: n, bytes: files[n] }));
      }
    } else if (type === "build-images") {
      images = data.images.map(i => ({ name: i.name, bytes: new Uint8Array(i.bytes) }));
    } else {
      throw new Error(`unknown request: ${type}`);
    }
    let last = 0;
    const result = await buildImagePdf(images, {
      ...options,
      onProgress: (done, total) => {
        const now = performance.now();
        if (now - last > 150 || done === total) {
          last = now;
          self.postMessage({ id, type: "progress", done, total });
        }
      },
    });
    const buf = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength);
    self.postMessage({ id, type: "done", bytes: buf, pages: result.pages, skipped: result.skipped, split: result.split, padded: result.padded }, [buf]);
  } catch (e) {
    self.postMessage({ id, type: "error", message: String(e?.message || e) });
  }
};
