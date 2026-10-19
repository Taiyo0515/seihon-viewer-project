/**
 * 表示上のページ番号と、元の PDF のページ番号の対応。
 *
 * ページを削除すると、PDF.js は表示を組み替える(元の 3ページ目を消すと、元の 4ページ目が表示上の 3ページ目になる)。
 * 元の PDF のデータそのものは変わらないので、次のものは「元の PDF のページ番号」で扱う:
 *  - ページ役割の保存(PDF の内容の指紋ごと)
 *  - 収集(元の PDF のデータと、そのページ番号を保存する)
 *  - ページの抜き出し(PDF.js の extractPages に渡すページ番号)
 * 画面に出すページ番号・ページの描画(getPage)は「表示上のページ番号」で扱う。
 */

/** 表示上のページ番号(1始まり)→ 元の PDF のページ(0始まり) */
export function sourceIndex(doc, pageNumber) {
  const mapper = doc?.pagesMapper;
  return (mapper ? mapper.getPageId(pageNumber) : pageNumber) - 1;
}

/** 元の PDF のページ(0始まり)→ 表示上のページ番号(1始まり)。削除したページなら 0 */
export function viewPageNumber(doc, index) {
  const mapper = doc?.pagesMapper;
  if (!mapper) {
    return index + 1;
  }
  if (index < 0 || index >= (doc.numPages || 0)) {
    return 0;
  }
  return mapper.getPageNumber(index + 1);
}

/** 表示しているページ数(削除したページを除く) */
export function viewPageCount(doc) {
  if (!doc) {
    return 0;
  }
  return doc.pagesMapper?.pagesNumber || doc.numPages || 0;
}

/**
 * ページの並びが元の PDF と違うか(削除した・並べ替えた)。
 * 削除を「元に戻す」と、PDF.js の内部の記録は残ったまま元と同じ並びに戻るため、並びそのものを比べる。
 */
export function isRearranged(doc) {
  return mappingSignature(doc) !== "";
}

/**
 * ページの並びを表す文字列(元のままなら空文字)。保存したときの並びと比べるのに使う。
 */
export function mappingSignature(doc) {
  const mapping = doc?.pagesMapper?.getMapping?.();
  if (!mapping) {
    return "";
  }
  const n = doc.numPages || 0;
  if (mapping.length === n && mapping.every((id, i) => id === i + 1)) {
    return "";
  }
  return Array.from(mapping).join(",");
}

/** 表示上のページの並び(元の PDF のページ番号、0始まり) */
export function sourceOrder(doc) {
  const count = viewPageCount(doc);
  return Array.from({ length: count }, (_, i) => sourceIndex(doc, i + 1));
}
