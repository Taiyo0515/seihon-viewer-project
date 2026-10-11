/**
 * 0.4: 画像を並べて PDF を作る(コミック・画像だけの EPUB の表示・変換に使う。Worker の中で動く)。
 *
 * 画質について
 *  - JPEG はデータをそのまま PDF に入れる(作り直さないので、画質は元のまま)。
 *  - PNG もそのまま(色の情報は失わない。PDF の中では圧縮の形式だけが変わる)。
 *  - GIF・BMP・可逆の WebP は、PNG にして入れる(画質は元のまま)。
 *  - 非可逆の WebP・AVIF は PDF にそのまま入れられないため、JPEG(品質 95)にして入れる。
 *  - 見開きの画像を2ページに分けるときも画像は作り直さず、同じ画像の左半分・右半分を表示するページにする。
 */

import * as PDFLib from "../../lib/pdf-lib.esm.min.js";
import { IMAGE_NAME, naturalCompare, pickImageNames } from "./comic-names.js";

export { IMAGE_NAME, naturalCompare, pickImageNames };

const { PDFDocument, PDFName, PDFHexString, PDFNumber } = PDFLib;

/** 画像の種類(先頭の数バイトから) */
export function imageKind(b) {
  if (!b || b.length < 12) {
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "jpeg";
  }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "png";
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return "gif";
  }
  if (b[0] === 0x42 && b[1] === 0x4d) {
    return "bmp";
  }
  const s = String.fromCharCode(...b.subarray(0, 16));
  if (s.startsWith("RIFF") && s.slice(8, 12) === "WEBP") {
    return s.slice(12, 16) === "VP8L" ? "webp-lossless" : "webp";
  }
  if (s.slice(4, 8) === "ftyp" && /avif|avis/.test(s.slice(8, 12))) {
    return "avif";
  }
  return null;
}

/** JPEG の向き(EXIF の Orientation。無ければ 1) */
export function jpegOrientation(b) {
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) {
      return 1;
    }
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xda || marker === 0xd9) {
      return 1;
    }
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const t = i + 10; // TIFF ヘッダー
      const le = b[t] === 0x49;
      const u16 = p => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
      const u32 = p => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
      const ifd = t + u32(t + 4);
      const n = u16(ifd);
      for (let k = 0; k < n && ifd + 2 + k * 12 + 12 <= b.length; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) {
          return u16(e + 8) || 1;
        }
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

/** ブラウザで画像を読み、PNG(可逆)か JPEG にする */
async function reencode(bytes, kind) {
  const bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: "from-image" });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    const lossy = kind === "webp" || kind === "avif";
    if (lossy) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, bitmap.width, bitmap.height);
    }
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob(lossy ? { type: "image/jpeg", quality: 0.95 } : { type: "image/png" });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), kind: lossy ? "jpeg" : "png" };
  } finally {
    bitmap.close();
  }
}

const ROTATION = { 3: 180, 6: 90, 8: 270 };

/**
 * 1枚の画像を PDF に入れる。
 * @returns {Promise<{image, width:number, height:number, rotate:number}|null>}
 */
async function embedImage(pdf, bytes) {
  let kind = imageKind(bytes);
  if (!kind) {
    return null;
  }
  let rotate = 0;
  if (kind === "jpeg") {
    const o = jpegOrientation(bytes);
    if (ROTATION[o] !== undefined) {
      rotate = ROTATION[o];
    } else if (o !== 1) {
      ({ bytes, kind } = await reencode(bytes, kind)); // 鏡写しの向き(まれ)は作り直す
    }
  } else if (kind !== "png") {
    ({ bytes, kind } = await reencode(bytes, kind));
  }
  let image;
  try {
    image = kind === "jpeg" ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
  } catch (e) {
    // pdf-lib が読めない画像(16 ビットの PNG など): ブラウザで読んで PNG にする
    const again = await reencode(bytes, "png");
    image = await pdf.embedPng(again.bytes);
    rotate = 0;
  }
  return { image, width: image.width, height: image.height, rotate };
}

/** 中央値 */
function median(values) {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

const MM = 72 / 25.4;

/**
 * 画像を並べた PDF を作る。
 * @param {Array<{name:string, bytes:Uint8Array}>|(() => AsyncIterable)} images 並べる画像(この順にページにする)
 * @param {object} o
 * @param {string} o.title 題名
 * @param {"ltr"|"rtl"} o.direction 綴じ方向(右綴じなら見開きの分け方と、ほかのソフト向けの表示方向に使う)
 * @param {boolean} o.splitSpreads 見開きの画像(横長)を2ページに分ける
 * @param {number} o.pageHeightMm 標準のページの高さ(画像の高さの中央値をこの高さにする)
 * @param {Array<{label:string, index:number, children?:Array}>} [o.toc] 目次(index は画像の番号)
 * @param {(done:number, total:number) => void} [o.onProgress]
 * @returns {Promise<{bytes:Uint8Array, pages:number, skipped:string[], split:number, padded:number}>}
 */
export async function buildImagePdf(images, { title = "", direction = "ltr", splitSpreads = true, pageHeightMm = 182, toc = null, onProgress = null } = {}) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const embedded = [];
  const skipped = [];
  let done = 0;
  for (const item of images) {
    let e = null;
    if (item.blank) {
      embedded.push({ blank: true, name: item.name, index: done });
      done++;
      onProgress?.(done, images.length);
      continue;
    }
    try {
      e = item.bytes ? await embedImage(pdf, item.bytes) : null;
    } catch (err) {
      console.warn("[製本ビューア] 画像を読めませんでした", item.name, err);
    }
    if (e) {
      embedded.push({ ...e, name: item.name, index: done });
    } else {
      skipped.push(item.name);
    }
    item.bytes = null; // 使い終わったデータは手放す(大きな本でメモリーを使いすぎない)
    done++;
    onProgress?.(done, images.length);
  }
  const real = embedded.filter(e => !e.blank);
  if (!real.length) {
    throw new Error("ページにできる画像がありませんでした");
  }
  // 見かけの大きさ(回転を含めた縦・横)
  const shown = e => (e.rotate % 180 ? { w: e.height, h: e.width } : { w: e.width, h: e.height });
  const portrait = real.filter(e => shown(e).w < shown(e).h);
  const mostlyPortrait = portrait.length >= real.length * 0.6;
  const refHeight = median((portrait.length ? portrait : real).map(e => shown(e).h)) || 1000;
  const refWidth = median((portrait.length ? portrait : real).map(e => shown(e).w)) || 700;
  const scale = (pageHeightMm * MM) / refHeight;

  const pageOfImage = new Map();
  let split = 0;
  let padded = 0;
  const rtl = direction === "rtl";
  for (let k = 0; k < embedded.length; k++) {
    const e = embedded[k];
    pageOfImage.set(e.index, pdf.getPageCount());
    if (e.blank) {
      pdf.addPage([refWidth * scale, refHeight * scale]); // 白紙のページ
      continue;
    }
    const { w, h } = shown(e);
    const W = w * scale;
    const H = h * scale;
    const isSpread = splitSpreads && mostlyPortrait && k > 0 && e.rotate === 0 && w > h * 1.2;
    if (isSpread) {
      // 製本表示(表紙が単独、2-3・4-5… ページが見開き)で、分けた2ページが同じ見開きに並ぶよう、
      // 必要なら前に白紙のページを1枚入れる(分けた1ページ目が偶数ページになるように)
      if (pdf.getPageCount() % 2 === 0) {
        pdf.addPage([refWidth * scale, refHeight * scale]);
        padded++;
      }
      // 見開きの画像: 右綴じなら右半分が先(読む順)
      const halves = rtl ? [1, 0] : [0, 1];
      for (const half of halves) {
        const page = pdf.addPage([W / 2, H]);
        page.drawImage(e.image, { x: -half * (W / 2), y: 0, width: W, height: H });
      }
      split++;
      continue;
    }
    const page = pdf.addPage([W, H]);
    if (e.rotate) {
      // 画像は向きを変えずに入れ、ページの向き(/Rotate)で正しい向きにする(画像は作り直さない)
      page.setSize(e.width * scale, e.height * scale);
      page.drawImage(e.image, { x: 0, y: 0, width: e.width * scale, height: e.height * scale });
      page.setRotation(PDFLib.degrees(e.rotate));
    } else {
      page.drawImage(e.image, { x: 0, y: 0, width: W, height: H });
    }
  }

  // 文書の情報(作り直しても同じ内容になるよう、日付は入れない)
  if (title) {
    pdf.setTitle(title, { showInWindowTitleBar: true });
  }
  pdf.setCreator("製本ビューア");
  pdf.setProducer("製本ビューア(pdf-lib)");
  const catalog = pdf.catalog;
  const prefs = pdf.context.obj({});
  if (rtl) {
    prefs.set(PDFName.of("Direction"), PDFName.of("R2L"));
  }
  if (title) {
    prefs.set(PDFName.of("DisplayDocTitle"), PDFLib.PDFBool.True);
  }
  catalog.set(PDFName.of("ViewerPreferences"), prefs);
  catalog.set(PDFName.of("PageLayout"), PDFName.of("TwoPageRight"));

  if (toc?.length) {
    try {
      addOutline(pdf, toc, pageOfImage);
    } catch (err) {
      console.warn("[製本ビューア] 目次を入れられませんでした", err);
    }
  }
  const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });
  return { bytes, pages: pdf.getPageCount(), skipped, split, padded };
}

/** PDF の目次(しおり)を作る */
export function addOutline(pdf, toc, pageOfImage = null) {
  const ctx = pdf.context;
  const pages = pdf.getPages();
  const pageFor = index => {
    const p = pageOfImage ? pageOfImage.get(index) : index;
    return pages[Math.max(0, Math.min(pages.length - 1, p ?? 0))];
  };
  const build = (items, parentRef) => {
    const refs = items.map(() => ctx.nextRef());
    let count = 0;
    items.forEach((item, i) => {
      const dict = ctx.obj({});
      dict.set(PDFName.of("Title"), PDFHexString.fromText(String(item.label || "").trim() || "(無題)"));
      dict.set(PDFName.of("Parent"), parentRef);
      if (i > 0) {
        dict.set(PDFName.of("Prev"), refs[i - 1]);
      }
      if (i < items.length - 1) {
        dict.set(PDFName.of("Next"), refs[i + 1]);
      }
      const page = pageFor(item.index);
      dict.set(PDFName.of("Dest"), ctx.obj([page.ref, PDFName.of("Fit")]));
      count++;
      if (item.children?.length) {
        const sub = build(item.children, refs[i]);
        dict.set(PDFName.of("First"), sub.refs[0]);
        dict.set(PDFName.of("Last"), sub.refs[sub.refs.length - 1]);
        dict.set(PDFName.of("Count"), PDFNumber.of(sub.count));
        count += sub.count;
      }
      ctx.assign(refs[i], dict);
    });
    return { refs, count };
  };
  const rootRef = ctx.nextRef();
  const top = build(toc, rootRef);
  const root = ctx.obj({});
  root.set(PDFName.of("Type"), PDFName.of("Outlines"));
  root.set(PDFName.of("First"), top.refs[0]);
  root.set(PDFName.of("Last"), top.refs[top.refs.length - 1]);
  root.set(PDFName.of("Count"), PDFNumber.of(top.count));
  ctx.assign(rootRef, root);
  pdf.catalog.set(PDFName.of("Outlines"), rootRef);
}
