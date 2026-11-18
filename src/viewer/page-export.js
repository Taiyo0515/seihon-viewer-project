/**
 * ページの書き出しの共通処理。
 *
 *  - PDF の指紋(ファイルサイズ + 内容の SHA-256)
 *  - ページを PDF として抜き出す(元のテキスト・ベクター・画像をそのまま。再エンコードしない。OCR の文字も残る)
 *  (ページを画像にする処理は image-export.js)
 *
 * PDF の抜き出しには、同梱の PDF.js が持つページ抽出機能(extractPages)を使う。
 * 暗号化された PDF、文書内リンク、しおり、フォントや画像の重複除去にも対応している。
 * まれに PDF.js で抜き出せない文書は、pdf-lib(同梱)で抜き出す。
 */

import { repairFreeTextAnnotations } from "./free-text-appearance.js";

// ---------------------------------------------------------------------------
// 指紋
// ---------------------------------------------------------------------------

/** PDF の指紋。URL に頼らず、内容から同じ PDF かどうかを判定するために使う */
export async function computePdfKey(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}:${bytes.length}`;
}

// ---------------------------------------------------------------------------
// PDF の読み込み(保存済みのデータから)
// ---------------------------------------------------------------------------

let utilityWorker = null;

function pdfjs() {
  return globalThis.pdfjsLib;
}

/** 保存済みの PDF データを PDF.js で開く(ビューアと同じ Worker を共有する) */
export function loadPdfFromBytes(bytes) {
  const opts = window.PDFViewerApplicationOptions;
  // 補助文書は明示的に所有するWorkerを共有する。文書を閉じてもWorkerを破棄せず、
  // 次のプレビューやメインの文書のWorkerまで終了してしまう競合を防ぐ。
  pdfjs().GlobalWorkerOptions.workerSrc = opts.get("workerSrc");
  if (!utilityWorker || utilityWorker.destroyed) {
    utilityWorker = new (pdfjs().PDFWorker)({ name: "seihon-tools" });
  }
  return pdfjs().getDocument({
    worker: utilityWorker,
    // PDF.js はデータを Worker に移すので、呼び出し側のデータが使えなくならないよう複製を渡す
    data: bytes.slice(),
    cMapUrl: opts.get("cMapUrl"),
    cMapPacked: true,
    standardFontDataUrl: opts.get("standardFontDataUrl"),
    wasmUrl: opts.get("wasmUrl"),
    iccUrl: opts.get("iccUrl"),
    isEvalSupported: false,
    enableXfa: false,
  }).promise;
}

// ---------------------------------------------------------------------------
// 書き込み・フォームの入力内容
// ---------------------------------------------------------------------------

/**
 * ビューアで書き込んだ注釈やフォームの入力内容を反映した文書のデータを作る(何も書き込んでいなければ null)。
 * PDF.js のページ抽出は「新しく書き込んだ注釈」しか反映しないため、フォームの入力内容も含めたいときに使う。
 * PDF.js の保存処理と同じ内部の呼び出しを使うが、保存済みの扱いにはしない
 * (「保存していない変更があります」の確認が消えないように)。
 * @param {PDFDocumentProxy} doc
 */
export async function editedDocumentBytes(doc) {
  const storage = doc?.annotationStorage;
  if (!storage || storage.size <= 0) {
    return null;
  }
  try {
    let { map, transfer } = storage.serializable;
    if (!map || map.size === 0) {
      return null;
    }
    // ページを削除・並べ替えた後は、書き込みのページ番号が表示上の番号になっているので、
    // 元の PDF のページ番号に直してから渡す(できあがるのは、元のページの並びのままの PDF)
    const mapping = doc.pagesMapper?.getMapping?.();
    if (mapping) {
      const remapped = new Map();
      for (const [key, value] of map) {
        if (Number.isInteger(value?.pageIndex) && value.pageIndex >= 0 && value.pageIndex < mapping.length) {
          remapped.set(key, { ...value, pageIndex: mapping[value.pageIndex] - 1 });
        } else {
          remapped.set(key, value);
        }
      }
      map = remapped;
    }
    const transport = doc._transport;
    const bytes = await transport.messageHandler.sendWithPromise(
      "SaveDocument",
      {
        isPureXfa: !!transport._htmlForXfa,
        numPages: transport._numPages,
        annotationStorage: map,
        supportsPrintToPDF: false,
        filename: null,
      },
      transfer
    );
    if (!bytes?.length) { throw new Error("編集したPDFのデータが空でした"); }
    return await repairFreeTextAnnotations(bytes, { annotations: [...map.values()] });
  } catch (e) {
    console.error("[製本ビューア] 書き込みを反映した文書を作れませんでした", e);
    throw new Error("書き込みを保存できませんでした。編集内容を残したまま、保存を中止します。", { cause: e });
  }
}

// ---------------------------------------------------------------------------
// PDF の抜き出し
// ---------------------------------------------------------------------------

/**
 * ページを抜き出して1つの PDF にする。
 * @param {PDFDocumentProxy|null} hostDoc 処理を実行する文書(ビューアで開いている文書)。無ければ自動で用意する
 * @param {Array<{source:"current"|Uint8Array, pageIndex:number}>} pages 出力順。pageIndex は元の PDF の 0始まりのページ番号
 *   (ページを削除した後も、表示上の番号ではなく元の番号。page-map.js の sourceIndex で求める)。
 *   source が "current" のときは hostDoc のページ(書き込んだ注釈も含む)、Uint8Array のときはそのデータの PDF
 * @returns {Promise<Uint8Array>}
 */
export async function extractPagesToPdf(hostDoc, pages) {
  if (!pages.length) {
    throw new Error("ページが選ばれていません");
  }
  let temporary = null;
  if (!hostDoc) {
    const firstBytes = pages.find(p => p.source !== "current")?.source;
    if (!firstBytes) {
      throw new Error("文書が開かれていません");
    }
    temporary = await loadPdfFromBytes(firstBytes);
    hostDoc = temporary;
  }
  try {
    const mapping = hostDoc.pagesMapper?.getMapping?.();
    const annotations = [...(hostDoc.annotationStorage?.serializable?.map?.values() || [])].map(edit =>
      mapping && Number.isInteger(edit.pageIndex) && edit.pageIndex >= 0 && edit.pageIndex < mapping.length
        ? { ...edit, pageIndex: mapping[edit.pageIndex] - 1 } : edit);
    const pageInfos = buildPageInfos(pages);
    let out = null;
    try {
      out = await hostDoc.extractPages(pageInfos);
    } catch (e) {
      console.warn("[製本ビューア] PDF.js での抜き出しに失敗しました", e);
    }
    if (out && out.length) {
      const outputAnnotations = pages.flatMap((page, pageIndex) => page.source === "current"
        ? annotations.filter(edit => edit.pageIndex === page.pageIndex).map(edit => ({ ...edit, pageIndex })) : []);
      return await repairFreeTextAnnotations(out, { annotations: outputAnnotations });
    }
    if (annotations.length) {
      throw new Error("編集内容を含めてページを保存できませんでした。編集内容を残したまま、保存を中止します。");
    }
    // 予備の方法: pdf-lib(暗号化されていない文書のみ)
    return await extractWithPdfLib(hostDoc, pages);
  } finally {
    temporary?.loadingTask?.destroy();
  }
}

/**
 * extractPages に渡す指定を組み立てる。
 * 同じデータの PDF のページはまとめて1つの指定にし、出力位置(pageIndices)で並び順を指定する。
 * 同じページが2回以上出てくるときは、別の指定に分ける(PDF.js は1つの指定の中で同じページを重ねられない)。
 */
function buildPageInfos(pages) {
  /** source -> { layers: [{pageIndex, position}][], counts: Map } (重複ごとの層) */
  const groups = new Map();
  pages.forEach((p, position) => {
    let group = groups.get(p.source);
    if (!group) {
      group = { layers: [], counts: new Map() };
      groups.set(p.source, group);
    }
    // 同じページの何回目の登場かで層を決める。前の全ページを毎回探さない。
    const depth = group.counts.get(p.pageIndex) || 0;
    const layer = group.layers[depth] ||= [];
    group.counts.set(p.pageIndex, depth + 1);
    layer.push({ pageIndex: p.pageIndex, position });
  });
  const infos = [];
  for (const [source, { layers }] of groups) {
    for (const layer of layers) {
      // PDF.js は元のページ番号の昇順に pageIndices を割り当てるので、その順に並べる
      layer.sort((a, b) => a.pageIndex - b.pageIndex);
      infos.push({
        document: source === "current" ? null : source,
        includePages: layer.map(e => e.pageIndex),
        pageIndices: layer.map(e => e.position),
      });
    }
  }
  return infos;
}

async function extractWithPdfLib(hostDoc, pages) {
  const { PDFDocument } = await import("../lib/pdf-lib.esm.min.js");
  const out = await PDFDocument.create();
  const loaded = new Map();
  for (const p of pages) {
    let src = loaded.get(p.source);
    if (!src) {
      const bytes = p.source === "current" ? await hostDoc.getData() : p.source;
      src = await PDFDocument.load(bytes, { updateMetadata: false });
      loaded.set(p.source, src);
    }
    const [copied] = await out.copyPages(src, [p.pageIndex]);
    out.addPage(copied);
  }
  out.setProducer("製本ビューア");
  return out.save({ useObjectStreams: true });
}

/** 1ページだけの空白の PDF */
export function blankPdfBytes() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    out += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

