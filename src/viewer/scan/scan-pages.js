/**
 * スキャンの PDF のページを調べ、整えた PDF を作る(0.3。pdf-lib を使う)。
 *
 * 整えた PDF の作り方(元の画質のまま):
 *   画像は作り直さない。1ページを2ページに分けるときは、元のページの中身(画像を描く命令)を
 *   そのまま使い、「表示する範囲」だけを変えた新しいページを作る(画像のデータは2ページで共有)。
 *   ページの左下が (0, 0) になるよう中身をずらすので、ほかのソフトや印刷でも同じ範囲が出る。
 *   OCR の文字は、そのページの範囲にあるものだけを残す(検索・文字のコピーで、もう片方の文字を拾わない)。
 */

import { applyPoint, multiply, parseOperations, removeTextOutside, walkOperations } from "./content-stream.js";

let libPromise = null;
/** 同梱の pdf-lib */
export function pdfLib() {
  libPromise ||= import("../../lib/pdf-lib.esm.min.js");
  return libPromise;
}

const num = (lib, v) => (v instanceof lib.PDFNumber ? v.asNumber() : typeof v === "number" ? v : null);

/** [x0 y0 x1 y1] の配列(参照も読む)。読めなければ null */
function readBox(lib, context, value) {
  const arr = value instanceof lib.PDFRef ? context.lookup(value) : value;
  if (!(arr instanceof lib.PDFArray) || arr.size() < 4) {
    return null;
  }
  const v = [0, 1, 2, 3].map(i => num(lib, context.lookup(arr.get(i))));
  if (v.some(x => x === null || !Number.isFinite(x))) {
    return null;
  }
  return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
}

/** ストリームの中身(フィルターを解いたもの)。解けなければ null */
function streamBytes(lib, stream) {
  try {
    if (stream instanceof lib.PDFRawStream) {
      return lib.decodePDFRawStream(stream).decode();
    }
    if (typeof stream?.getUnencodedContents === "function") {
      return stream.getUnencodedContents();
    }
    if (typeof stream?.getContents === "function") {
      return stream.getContents();
    }
  } catch (e) {
    console.warn("[製本ビューア] ページの中身を読めませんでした", e);
  }
  return null;
}

function filterNames(lib, dict) {
  const f = dict.lookup(lib.PDFName.of("Filter"));
  if (f instanceof lib.PDFName) {
    return [f.asString()];
  }
  if (f instanceof lib.PDFArray) {
    const out = [];
    for (let i = 0; i < f.size(); i++) {
      const v = f.lookup(i);
      if (v instanceof lib.PDFName) {
        out.push(v.asString());
      }
    }
    return out;
  }
  return [];
}

/**
 * スキャンの PDF(pdf-lib で読み込んだもの)。調べるのに使う。
 */
export class ScanSource {
  /**
   * @param {Uint8Array} bytes 暗号化されていない PDF のデータ
   */
  static async open(bytes) {
    const lib = await pdfLib();
    const pdf = await lib.PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
    return new ScanSource(lib, pdf);
  }

  constructor(lib, pdf) {
    this.lib = lib;
    this.pdf = pdf;
    this.context = pdf.context;
    this.pages = pdf.getPages();
    this.info = new Map();
  }

  get pageCount() {
    return this.pages.length;
  }

  /** ページ(0始まり)の中身のデータ(全部のストリームをつなげたもの) */
  contentBytes(index) {
    const { lib, context } = this;
    const leaf = this.pages[index].node;
    const contents = leaf.get(lib.PDFName.of("Contents"));
    const list = [];
    const resolved = contents instanceof lib.PDFRef ? context.lookup(contents) : contents;
    if (resolved instanceof lib.PDFArray) {
      for (let i = 0; i < resolved.size(); i++) {
        list.push(context.lookup(resolved.get(i)));
      }
    } else if (resolved) {
      list.push(resolved);
    }
    const parts = [];
    for (const s of list) {
      const b = streamBytes(lib, s);
      if (!b) {
        return null;
      }
      parts.push(b);
    }
    const total = parts.reduce((sum, p) => sum + p.length + 1, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
      out.set(p, pos);
      pos += p.length;
      out[pos++] = 10; // ストリームの区切りは改行にする
    }
    return out;
  }

  /**
   * ページ(0始まり)を調べる。
   * @returns {{view:number[], rotate:number, pureImage:boolean, hasText:boolean, image:object|null}}
   *   view: 表示される範囲(ユーザー空間の [x0 y0 x1 y1])/ rotate: ページの回転(度)
   *   pureImage: 画像1枚がページのほとんどを覆い、ほかに見えるものが無い(スキャンしたページ)
   *   image: その画像 {width, height, ctm, filters, jpeg(JPEG のデータ。JPEG で取り出せるとき)}
   */
  inspect(index) {
    if (this.info.has(index)) {
      return this.info.get(index);
    }
    const { lib, context } = this;
    const N = n => lib.PDFName.of(n);
    const leaf = this.pages[index].node;
    const media = readBox(lib, context, leaf.getInheritableAttribute(N("MediaBox"))) || [0, 0, 612, 792];
    const crop = readBox(lib, context, leaf.getInheritableAttribute(N("CropBox")));
    const view = crop
      ? [Math.max(media[0], crop[0]), Math.max(media[1], crop[1]), Math.min(media[2], crop[2]), Math.min(media[3], crop[3])]
      : media;
    if (view[2] <= view[0] || view[3] <= view[1]) {
      view.splice(0, 4, ...media);
    }
    const rotateValue = num(lib, context.lookup(leaf.getInheritableAttribute(N("Rotate"))));
    const rotate = ((((Math.round((rotateValue || 0) / 90) * 90) % 360) + 360) % 360);
    const result = { view, rotate, pureImage: false, hasText: false, image: null };
    this.info.set(index, result);

    const resources = context.lookup(leaf.getInheritableAttribute(N("Resources")));
    const bytes = this.contentBytes(index);
    if (!bytes) {
      return result;
    }
    let walk;
    const images = [];
    let visible = false;
    let hasText = false;
    const visit = (data, res, ctm, depth) => {
      const xobjects = res instanceof lib.PDFDict ? res.lookup(N("XObject")) : null;
      const lookupX = name => (xobjects instanceof lib.PDFDict ? xobjects.lookup(N(name)) : null);
      const typeOf = name => {
        const x = lookupX(name);
        const subtype = x?.dict?.lookup?.(N("Subtype"));
        return subtype instanceof lib.PDFName ? (subtype.asString() === "/Image" ? "image" : subtype.asString() === "/Form" ? "form" : null) : null;
      };
      const ops = parseOperations(data);
      const w = walkOperations(ops, { ctm, xobjectType: typeOf });
      if (depth === 0) {
        walk = { ops, ...w };
      }
      visible ||= w.visiblePaint || w.visibleText;
      hasText ||= w.texts.length > 0;
      for (const img of w.images) {
        images.push({ ...img, stream: img.name ? lookupX(img.name) : null });
      }
      for (const form of w.forms) {
        if (depth >= 2) {
          visible = true; // 深い入れ子までは調べない(スキャンではない扱い)
          continue;
        }
        const stream = lookupX(form.name);
        const formBytes = stream ? streamBytes(lib, stream) : null;
        if (!formBytes) {
          visible = true;
          continue;
        }
        const matrixArr = stream.dict.lookup(N("Matrix"));
        let matrix = [1, 0, 0, 1, 0, 0];
        if (matrixArr instanceof lib.PDFArray && matrixArr.size() === 6) {
          const m = [0, 1, 2, 3, 4, 5].map(i => num(lib, matrixArr.lookup(i)));
          if (m.every(v => v !== null)) {
            matrix = m;
          }
        }
        const formRes = stream.dict.lookup(N("Resources")) || res;
        visit(formBytes, formRes, multiply(matrix, form.ctm), depth + 1);
      }
    };
    try {
      visit(bytes, resources, [1, 0, 0, 1, 0, 0], 0);
    } catch (e) {
      console.warn("[製本ビューア] ページの中身を調べられませんでした", e);
      return result;
    }
    result.hasText = hasText;
    result.textOps = walk?.texts?.length || 0;
    const pageArea = (view[2] - view[0]) * (view[3] - view[1]);
    // ページの大部分を覆う画像
    const covering = images.filter(img => {
      const pts = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([x, y]) => applyPoint(img.ctm, x, y));
      const xs = pts.map(p => p[0]);
      const ys = pts.map(p => p[1]);
      const ix0 = Math.max(view[0], Math.min(...xs));
      const iy0 = Math.max(view[1], Math.min(...ys));
      const ix1 = Math.min(view[2], Math.max(...xs));
      const iy1 = Math.min(view[3], Math.max(...ys));
      return ix1 > ix0 && iy1 > iy0 && ((ix1 - ix0) * (iy1 - iy0)) / pageArea >= 0.85;
    });
    if (covering.length === 1 && images.length === 1 && !visible) {
      result.pureImage = true;
    }
    const main = covering[covering.length - 1] || null;
    if (main?.stream && !main.inline) {
      const dict = main.stream.dict;
      const width = num(lib, dict.lookup(N("Width")));
      const height = num(lib, dict.lookup(N("Height")));
      const filters = filterNames(lib, dict);
      const plain =
        !dict.has(N("SMask")) && !dict.has(N("Mask")) && !dict.has(N("Decode")) && !(dict.lookup(N("ImageMask")) instanceof lib.PDFBool && dict.lookup(N("ImageMask")).asBoolean());
      const bpc = num(lib, dict.lookup(N("BitsPerComponent")));
      const jpeg = filters.length === 1 && filters[0] === "/DCTDecode" && plain && bpc === 8 && main.stream instanceof lib.PDFRawStream;
      result.image = { width, height, ctm: main.ctm, filters, jpeg: jpeg ? main.stream.contents : null };
    }
    return result;
  }
}

/**
 * 2つの数字の16進(ID 用)
 */
function hex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** 文字列から、整えた PDF の ID(同じ元の PDF・同じ整え方なら同じ)を作る */
export async function arrangedId(seed) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  return hex(digest.subarray(0, 16)).toUpperCase();
}

/** 参照をたどって、使われているオブジェクトの番号を集める */
function reachable(lib, context, roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const obj = stack.pop();
    if (!obj) {
      continue;
    }
    if (obj instanceof lib.PDFRef) {
      if (seen.has(obj.tag)) {
        continue;
      }
      seen.add(obj.tag);
      stack.push(context.lookup(obj));
    } else if (obj instanceof lib.PDFDict) {
      for (const [, v] of obj.entries()) {
        stack.push(v);
      }
    } else if (obj instanceof lib.PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        stack.push(obj.get(i));
      }
    } else if (obj.dict instanceof lib.PDFDict) {
      stack.push(obj.dict);
    }
  }
  return seen;
}

const fmt = v => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

/**
 * 整えた PDF を作る。
 * @param {Uint8Array} bytes 元の PDF(暗号化されていないもの)
 * @param {Array<{src:number, rect:number[]|null, rotate:number, masks?:number[][]}>} pages 作るページ(順に)。
 *   src: 元のページ(0始まり)/ rect: 表示する範囲(元のページのユーザー空間 [x0 y0 x1 y1]。null ならそのまま)/
 *   rotate: 元の回転に足す回転(度)/ matrix: 中身にかける変換 [a b c d e f](傾きを直す。0.6)/ masks: 白く覆う範囲(元のページのユーザー空間。スキャンで入った本の縁など)
 * @param {{id:string, onProgress?:Function, pdf?:object}} o id: 32桁の16進(文書の ID)/
 *   pdf: bytes を pdf-lib で読み込んだ文書(あれば読み直さずに使う。中身を書き換えるので、使えるのは1回だけ)
 * @returns {Promise<Uint8Array>}
 */
export async function buildArrangedPdf(bytes, pages, { id, onProgress = null, pdf: loaded = null }) {
  const lib = await pdfLib();
  const { PDFName, PDFArray, PDFDict, PDFRef, PDFNumber, PDFHexString } = lib;
  const N = n => PDFName.of(n);
  const pdf = loaded || (await lib.PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false }));
  const context = pdf.context;
  const source = new ScanSource(lib, pdf);
  const srcPages = source.pages;
  const contentRefs = index => {
    const contents = srcPages[index].node.get(N("Contents"));
    const resolved = contents instanceof PDFRef ? context.lookup(contents) : null;
    if (resolved instanceof PDFArray) {
      const out = [];
      for (let i = 0; i < resolved.size(); i++) {
        out.push(resolved.get(i));
      }
      return out;
    }
    if (contents instanceof PDFArray) {
      const out = [];
      for (let i = 0; i < contents.size(); i++) {
        out.push(contents.get(i));
      }
      return out;
    }
    return contents instanceof PDFRef ? [contents] : [];
  };
  const parsedCache = new Map();
  const parsed = index => {
    if (!parsedCache.has(index)) {
      const data = source.contentBytes(index);
      let entry = null;
      if (data) {
        try {
          const ops = parseOperations(data);
          const { texts } = walkOperations(ops);
          entry = { data, ops, texts };
        } catch (e) {
          console.warn("[製本ビューア] ページの中身を読めませんでした(文字の振り分けをしません)", e);
        }
      }
      parsedCache.set(index, entry);
    }
    return parsedCache.get(index);
  };

  const newRefs = [];
  for (let k = 0; k < pages.length; k++) {
    const out = pages[k];
    const leaf = srcPages[out.src].node;
    const info = source.inspect(out.src);
    const rect = out.rect || info.view;
    const [x0, y0, x1, y1] = rect;
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const dict = context.obj({});
    dict.set(N("Type"), N("Page"));
    const resources = leaf.getInheritableAttribute(N("Resources"));
    if (resources) {
      dict.set(N("Resources"), resources);
    }
    const group = leaf.get(N("Group"));
    if (group) {
      dict.set(N("Group"), group);
    }
    dict.set(N("MediaBox"), context.obj([0, 0, Number(fmt(w)), Number(fmt(h))]));
    const rotate = (((info.rotate + (out.rotate || 0)) % 360) + 360) % 360;
    if (rotate) {
      dict.set(N("Rotate"), PDFNumber.of(rotate));
    }
    // 中身: 範囲の左下が (0, 0) になるようにずらす。元の中身は q … Q で囲み、その後で白く覆う範囲を塗る
    // 傾きを直すときは、その後で、中身をまっすぐにする変換(out.matrix)をかける
    const m = out.matrix && out.matrix.length === 6 && out.matrix.every(Number.isFinite) ? out.matrix : null;
    const head = `q 1 0 0 1 ${fmt(-x0)} ${fmt(-y0)} cm\nq\n${m ? `${m.map(v => (Math.round(v * 1e6) / 1e6).toString()).join(" ")} cm\n` : ""}`;
    const masks = (out.masks || []).filter(m => m[2] > m[0] && m[3] > m[1]);
    const maskOps = masks.map(m => `${fmt(m[0])} ${fmt(m[1])} ${fmt(m[2] - m[0])} ${fmt(m[3] - m[1])} re`).join("\n");
    const tail = `\nQ\n${masks.length ? `q 1 g\n${maskOps}\nf\nQ\n` : ""}Q\n`;
    let contents = null;
    const cropped = !!out.rect;
    const p = cropped && info.hasText ? parsed(out.src) : null;
    if (p && p.texts.length) {
      // 範囲の外の文字(もう片方のページの OCR の文字)を取り除いた中身を作る
      const margin = 2; // pt(文字の書き始めが少しはみ出していても残す)
      const keep = (tx, ty) => {
        // 文字の位置は、傾きを直したあとの位置で調べる
        const x = m ? m[0] * tx + m[2] * ty + m[4] : tx;
        const y = m ? m[1] * tx + m[3] * ty + m[5] : ty;
        return x >= x0 - margin && x <= x1 + margin && y >= y0 - margin && y <= y1 + margin;
      };
      const filtered = removeTextOutside(p.data, p.ops, p.texts, keep);
      const enc = new TextEncoder();
      const headBytes = enc.encode(head);
      const tailBytes = enc.encode(tail);
      const all = new Uint8Array(headBytes.length + filtered.bytes.length + tailBytes.length);
      all.set(headBytes, 0);
      all.set(filtered.bytes, headBytes.length);
      all.set(tailBytes, headBytes.length + filtered.bytes.length);
      contents = context.register(context.flateStream(all));
    } else {
      const refs = contentRefs(out.src);
      const headRef = context.register(context.stream(head));
      const tailRef = context.register(context.stream(tail));
      contents = context.obj([headRef, ...refs, tailRef]);
    }
    dict.set(N("Contents"), contents);
    newRefs.push(context.register(dict));
    if (onProgress && k % 20 === 0) {
      onProgress(k, pages.length);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // ページの一覧を作り直す
  const pagesRef = context.register(context.obj({ Type: "Pages", Kids: newRefs, Count: newRefs.length }));
  for (const ref of newRefs) {
    context.lookup(ref, PDFDict).set(N("Parent"), pagesRef);
  }
  const catalog = pdf.catalog;
  catalog.set(N("Pages"), pagesRef);
  // 元のページを指していたもの(目次・ページ番号の付け方・構造・フォームなど)は使えないので外す
  for (const key of ["Outlines", "PageLabels", "StructTreeRoot", "MarkInfo", "OpenAction", "AcroForm", "Threads", "AA", "Collection"]) {
    catalog.delete(N(key));
  }
  const names = catalog.lookup(N("Names"));
  if (names instanceof PDFDict && names.has(N("Dests"))) {
    const copy = names.clone(context);
    copy.delete(N("Dests"));
    catalog.set(N("Names"), copy);
  }
  if (catalog.lookup(N("PageMode"))?.asString?.() === "/UseOutlines") {
    catalog.delete(N("PageMode"));
  }
  catalog.delete(N("Dests"));
  context.trailerInfo.ID = context.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  context.trailerInfo.Encrypt = undefined;

  // 使われなくなったもの(元のページ・目次など)は書き出さない
  const keep = reachable(lib, context, [context.trailerInfo.Root, context.trailerInfo.Info].filter(Boolean));
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!keep.has(ref.tag)) {
      context.delete(ref);
    }
  }
  return pdf.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
}
