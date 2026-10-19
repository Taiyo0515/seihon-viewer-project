/**
 * 0.4: 書庫(ZIP・RAR)の中の、ページにする画像の選び方と並べ方(PDF の部品を読み込まずに使えるよう分けたもの)。
 */

/** 画像として扱うファイル名か */
export const IMAGE_NAME = /\.(jpe?g|jfif|png|gif|webp|bmp|avif)$/i;

/** 並べる順(数字は数として比べる: 2 < 10) */
const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
export function naturalCompare(a, b) {
  return collator.compare(a, b);
}

/** 書庫の中のファイル名のうち、ページの画像として使うもの(並べ替え済み) */
export function pickImageNames(names) {
  return names
    .filter(n => IMAGE_NAME.test(n))
    .filter(n => !/(^|\/)(__MACOSX|\.)/.test(n)) // macOS の付属ファイル・隠しファイル
    .filter(n => !/(^|\/)thumbs?\.db$/i.test(n))
    .sort((a, b) => {
      // フォルダごとにまとめて並べる(フォルダの名前 → ファイルの名前)
      const da = a.includes("/") ? a.slice(0, a.lastIndexOf("/")) : "";
      const db = b.includes("/") ? b.slice(0, b.lastIndexOf("/")) : "";
      return da === db ? naturalCompare(a, b) : naturalCompare(da, db);
    });
}

