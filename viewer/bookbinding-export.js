/**
 * 製本用 PDF の作成(計画は bookbinding.js)。
 *
 * - ページの抜き出しと並べ替えは PDF.js のページ抽出機能で行う(元のテキスト・ベクター・画像のまま。暗号化も外れる)。
 * - 白紙の挿入と面付けは pdf-lib で行う。面付けでは元のページをそのまま「部品」として用紙に配置するので、
 *   再ラスタライズ(画像化)はしない。
 * - 面付けすると、ページの注釈(書き込み・フォームの入力内容など)は、印刷される見た目をページに描き込んでから配置する。
 */

import { blankPdfBytes, editedDocumentBytes } from "./page-export.js";
import { imposition } from "./bookbinding.js";

let libPromise = null;
function pdfLib() {
  libPromise ||= import("../lib/pdf-lib.esm.min.js");
  return libPromise;
}

/**
 * 開いている文書から、指定のページを指定の順に並べた PDF を作る(暗号化なし)。
 * @param {PDFDocumentProxy} doc
 * @param {number[]} order 出力順の 0始まりのページ番号(重複なし)
 */
async function extractInOrder(doc, order, edited = null) {
  const sorted = [...order].sort((a, b) => a - b);
  const position = new Map(order.map((pageIndex, pos) => [pageIndex, pos]));
  // 空白の1ページを末尾に足して「複数の文書の結合」として書き出す(元の暗号化を引き継がないため)。足したページは後で消す
  // フォームの入力内容などを書き込んでいれば、それを反映した文書から抜き出す
  const bytes = await doc.extractPages([
    { document: edited, includePages: sorted, pageIndices: sorted.map(i => position.get(i)) },
    { document: blankPdfBytes(), pageIndices: [order.length] },
  ]);
  if (!bytes?.length) {
    throw new Error("ページを抜き出せませんでした");
  }
  const { PDFDocument } = await pdfLib();
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  pdf.removePage(pdf.getPageCount() - 1);
  // pdf-lib 1.17.1 は removePage の後にページの一覧を作り直さないため、ここで作り直させる
  pdf.pageCache?.invalidate?.();
  if (pdf.getPages().length !== order.length) {
    throw new Error("ページの抜き出しに失敗しました");
  }
  return pdf;
}

/** 注釈の「印刷される見た目」をページの内容に描き込み、注釈を取り除く */
async function flattenAnnotations(pdf) {
  const lib = await pdfLib();
  const { PDFName, PDFDict, PDFArray, PDFStream, PDFRef, PDFNumber } = lib;
  const { pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = lib;
  const ctx = pdf.context;
  for (const page of pdf.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) {
      continue;
    }
    const ops = [];
    for (let i = 0; i < annots.size(); i++) {
      try {
        const annot = annots.lookupMaybe(i, PDFDict);
        if (!annot) {
          continue;
        }
        const subtype = annot.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString();
        if (subtype === "/Popup" || subtype === "/Link") {
          continue;
        }
        const flags = annot.lookupMaybe(PDFName.of("F"), PDFNumber)?.asNumber() ?? 0;
        if (flags & 2 || !(flags & 4)) {
          continue; // 非表示、または印刷しない注釈
        }
        const ap = annot.lookupMaybe(PDFName.of("AP"), PDFDict);
        if (!ap) {
          continue;
        }
        let entry = ap.get(PDFName.of("N"));
        let stream = entry instanceof PDFRef ? ctx.lookup(entry) : entry;
        if (stream instanceof PDFDict && !(stream instanceof PDFStream)) {
          const state = annot.lookupMaybe(PDFName.of("AS"), PDFName);
          if (!state) {
            continue;
          }
          entry = stream.get(state);
          stream = entry instanceof PDFRef ? ctx.lookup(entry) : entry;
        }
        if (!(stream instanceof PDFStream)) {
          continue;
        }
        const ref = entry instanceof PDFRef ? entry : ctx.register(stream);
        stream.dict.set(PDFName.of("Type"), PDFName.of("XObject"));
        stream.dict.set(PDFName.of("Subtype"), PDFName.of("Form"));
        const rectArr = annot.lookupMaybe(PDFName.of("Rect"), PDFArray);
        const bboxArr = stream.dict.lookupMaybe(PDFName.of("BBox"), PDFArray);
        if (!rectArr || !bboxArr) {
          continue;
        }
        const nums = arr => arr.asArray().map(o => (o instanceof PDFNumber ? o.asNumber() : Number(ctx.lookup(o)?.asNumber?.() ?? 0)));
        const [rx1, ry1, rx2, ry2] = nums(rectArr);
        const rect = { x: Math.min(rx1, rx2), y: Math.min(ry1, ry2), w: Math.abs(rx2 - rx1), h: Math.abs(ry2 - ry1) };
        const [bx1, by1, bx2, by2] = nums(bboxArr);
        const matrixArr = stream.dict.lookupMaybe(PDFName.of("Matrix"), PDFArray);
        const [a, b, c, d, e, f] = matrixArr ? nums(matrixArr) : [1, 0, 0, 1, 0, 0];
        // 見た目の枠(BBox)を Matrix で変換した範囲を、注釈の位置(Rect)に合わせる(PDF の仕様 12.5.5)
        const corners = [
          [bx1, by1],
          [bx2, by1],
          [bx1, by2],
          [bx2, by2],
        ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
        const minX = Math.min(...corners.map(p => p[0]));
        const maxX = Math.max(...corners.map(p => p[0]));
        const minY = Math.min(...corners.map(p => p[1]));
        const maxY = Math.max(...corners.map(p => p[1]));
        const sx = maxX - minX > 0 ? rect.w / (maxX - minX) : 1;
        const sy = maxY - minY > 0 ? rect.h / (maxY - minY) : 1;
        page.node.normalize();
        const name = page.node.newXObject("SeihonAnnot", ref);
        ops.push(
          pushGraphicsState(),
          concatTransformationMatrix(sx, 0, 0, sy, rect.x - minX * sx, rect.y - minY * sy),
          drawObject(name),
          popGraphicsState()
        );
      } catch (e) {
        console.warn("[製本ビューア] 注釈を描き込めませんでした", e);
      }
    }
    if (ops.length) {
      page.pushOperators(...ops);
    }
    page.node.delete(PDFName.of("Annots"));
  }
}

function setMetadata(pdf, title) {
  pdf.setTitle(title);
  pdf.setCreator("製本ビューア");
  pdf.setProducer("製本ビューア(pdf-lib)");
  pdf.setCreationDate(new Date());
  pdf.setModificationDate(new Date());
}

/**
 * 製本用の PDF を作る。
 * @param {object} o
 * @param {PDFDocumentProxy} o.doc 開いている文書
 * @param {object} o.plan planBook() の結果
 * @param {{width:number,height:number}} o.refSize 白紙の大きさ(基準のページの大きさ)
 * @param {boolean} o.impose 面付けする
 * @param {"ltr"|"rtl"} o.direction 綴じ方向
 * @param {{width:number,height:number,label:string}} o.paper 用紙(横向き)
 * @param {"short"|"long"} o.duplex 両面の綴じ方向
 * @param {"separate"|"append"|"none"} o.obiOutput 帯の出力
 * @param {{book:string, imposed:string, obi:string}} o.fileNames
 * @param {(message:string) => void} [o.progress]
 * @returns {Promise<Array<{kind:string, fileName:string, bytes:Uint8Array, pages:number}>>}
 */
export async function buildBookbindingFiles(o) {
  const { doc, plan, refSize, impose, direction, paper, duplex, obiOutput, fileNames, includeEdits = true } = o;
  const progress = o.progress || (() => {});
  const lib = await pdfLib();
  const { PDFDocument, degrees, Duplex, PrintScaling } = lib;
  const files = [];

  // ---- 1. 本体(表紙 + 本文 + 裏表紙)を読む順に並べ、白紙を入れる ----
  progress("ページを並べています…");
  const edited = includeEdits ? await editedDocumentBytes(doc) : null;
  const order = plan.sequence.filter(s => s.kind === "page").map(s => s.pageIndex);
  const book = await extractInOrder(doc, order, edited);
  plan.sequence.forEach((item, index) => {
    if (item.kind === "blank") {
      book.insertPage(index, [refSize.width, refSize.height]);
    }
  });
  if (book.getPageCount() !== plan.N) {
    throw new Error(`ページ数が合いません(${book.getPageCount()} / ${plan.N})`);
  }

  // ---- 帯 ----
  let obiPdf = null;
  if (plan.obi.length && obiOutput !== "none") {
    progress("帯のページを抜き出しています…");
    obiPdf = await extractInOrder(doc, plan.obi, edited);
  }

  let main;
  let mainKind;
  if (!impose) {
    main = book;
    mainKind = "book";
  } else {
    // ---- 2. 面付け ----
    progress("面付けしています…");
    await flattenAnnotations(book);
    main = await PDFDocument.create();
    const pages = book.getPages();
    const blank = new Set(plan.sequence.map((s, i) => (s.kind === "blank" ? i : -1)).filter(i => i >= 0));
    const embedded = new Map();
    for (let i = 0; i < pages.length; i++) {
      if (blank.has(i)) {
        continue;
      }
      const page = pages[i];
      const box = page.getCropBox();
      try {
        const [emb] = await main.embedPages([page], [
          { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height },
        ]);
        embedded.set(i, { emb, box, rotate: ((page.getRotation().angle % 360) + 360) % 360 });
      } catch (e) {
        // 中身の無いページなどは白紙として扱う
        console.warn("[製本ビューア] ページを配置できませんでした", i + 1, e);
      }
    }
    const W = paper.width;
    const H = paper.height;
    const draw = (sheet, position, cellIndex, extraRotate) => {
      const item = embedded.get(position - 1);
      if (!item) {
        return;
      }
      const { emb, box } = item;
      const rot = (item.rotate + extraRotate) % 360;
      const w = box.width;
      const h = box.height;
      const dw = rot % 180 ? h : w;
      const dh = rot % 180 ? w : h;
      const cellW = W / 2;
      const s = Math.min(cellW / dw, H / dh);
      const X = cellIndex * cellW + (cellW - dw * s) / 2;
      const Y = (H - dh * s) / 2;
      // pdf-lib の rotate は左下を中心に反時計回り。表示上の回転(時計回り)に合わせて位置を補正する
      let x = X;
      let y = Y;
      let r = 0;
      if (rot === 90) {
        y = Y + w * s;
        r = -90;
      } else if (rot === 180) {
        x = X + w * s;
        y = Y + h * s;
        r = 180;
      } else if (rot === 270) {
        x = X + h * s;
        r = 90;
      }
      sheet.drawPage(emb, { x, y, xScale: s, yScale: s, rotate: degrees(r) });
    };
    const sheets = imposition(plan.N, direction);
    for (const { front, back } of sheets) {
      const f = main.addPage([W, H]);
      draw(f, front[0], 0, 0);
      draw(f, front[1], 1, 0);
      const b = main.addPage([W, H]);
      if (duplex === "long") {
        // 長辺とじで印刷すると裏面が上下逆さまになるため、裏面を180度回して作る
        draw(b, back[1], 0, 180);
        draw(b, back[0], 1, 180);
      } else {
        draw(b, back[0], 0, 0);
        draw(b, back[1], 1, 0);
      }
    }
    // 印刷の設定の目安(対応している印刷画面では、この設定が初期値になる)
    const prefs = main.catalog.getOrCreateViewerPreferences();
    prefs.setDuplex(duplex === "long" ? Duplex.DuplexFlipLongEdge : Duplex.DuplexFlipShortEdge);
    prefs.setPrintScaling(PrintScaling.None);
    mainKind = "imposed";
  }

  // ---- 3. 帯を本体の後ろに同梱する場合 ----
  if (obiPdf && obiOutput === "append") {
    const copied = await main.copyPages(obiPdf, obiPdf.getPageIndices());
    for (const p of copied) {
      main.addPage(p);
    }
  }

  progress("保存しています…");
  const mainName = mainKind === "imposed" ? fileNames.imposed : fileNames.book;
  setMetadata(main, mainName.replace(/\.pdf$/i, ""));
  files.push({ kind: mainKind, fileName: mainName, bytes: await main.save({ useObjectStreams: true }), pages: main.getPageCount() });
  if (obiPdf && obiOutput === "separate") {
    setMetadata(obiPdf, fileNames.obi.replace(/\.pdf$/i, ""));
    files.push({ kind: "obi", fileName: fileNames.obi, bytes: await obiPdf.save({ useObjectStreams: true }), pages: obiPdf.getPageCount() });
  }
  return files;
}

/**
 * ページの見た目の大きさ(回転を反映)を調べる。
 * @returns {Promise<Array<{width:number,height:number}>>} pageIndices の順
 */
export async function pageDisplaySizes(doc, pageIndices) {
  const out = [];
  for (const i of pageIndices) {
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    out.push({ width: vp.width, height: vp.height });
  }
  return out;
}
