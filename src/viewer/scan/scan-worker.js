/**
 * スキャンの画像を調べる Worker(0.3)。調べる処理(scan-analysis.js)を画面の処理と別に動かし、
 * 調べている間もスクロールなどが重くならないようにする。
 *
 * 受け取る: {id, gray(ArrayBuffer), width, height, pxPerMm, previewWidth, turn}
 *   turn(0.6): 縦長のページを、横に置いた見開きとしても調べるか(true / "force" はノドが無くても / false)
 * 返す: {id, scan, preview} / {id, error}
 */

import { analyzeFull, shrinkGray } from "./scan-analysis.js";

self.onmessage = ({ data }) => {
  const { id, width, height, pxPerMm, previewWidth, turn } = data;
  try {
    const img = { gray: new Uint8Array(data.gray), width, height, pxPerMm };
    const scan = analyzeFull(img, { turn: turn ?? true });
    const preview = shrinkGray(img.gray, width, height, previewWidth);
    self.postMessage({ id, scan, preview }, [preview.data.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
