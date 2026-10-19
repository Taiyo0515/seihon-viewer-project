/**
 * ページを画像にする(コピー・画像の保存・画像の ZIP・収集の「画像としてコピー」で使う)。
 *
 * 画質(設定 imageQuality):
 *  - "max" 最高画質(初期値): 元の画質のまま。
 *      ・スキャンしたページ(画像だけのページ)は、元の画像の解像度で描く(拡大も縮小もしない)。
 *      ・文字・図(ベクター)のあるページは 600dpi で描く(画像を含むときは、画像の解像度と高い方)。
 *        OCR の文字(見えない文字)は、見える文字としては数えない。
 *      ・ファイルに保存するときは、ページが1枚の JPEG 画像だけでできていれば(スキャンした PDF の多く)、
 *        元の JPEG をそのまま取り出す(作り直さないので、画質も大きさも元とまったく同じ)。
 *  - "high" 高画質: 長辺 2400 ピクセル / "standard" 標準: 長辺 1600 ピクセル
 *  - "custom" 指定する: 詳細設定の pngMode(長辺 / 倍率)
 *
 * 描いた画像は劣化しない PNG にする。メモリ不足で失敗しないよう、1枚の画素数には上限がある(64M 画素)。
 */

import { blankPdfBytes } from "./page-export.js";

const PDF_POINTS_TO_CSS = 96 / 72;
/** 文字・図を描く解像度(最高画質) */
export const VECTOR_DPI = 600;
/** 1枚の画像の最大画素数(これを超える指定は自動で縮める) */
export const MAX_PIXELS = 64 * 1024 * 1024;
export const MAX_SIDE = 16000;
const PRESET_LONG_SIDE = Object.freeze({ high: 2400, standard: 1600 });
/** 画像の大きさの判断で無視する小さな画像(ページの面積に対する割合) */
const SMALL_IMAGE_AREA = 0.02;

function pdfjs() {
  return globalThis.pdfjsLib;
}

// ---------------------------------------------------------------------------
// ページの中身を調べる(画像の解像度、見える文字・図があるか)
// ---------------------------------------------------------------------------

function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/**
 * ページの中身を調べる。
 * @param {PDFPageProxy} page
 * @returns {Promise<{imageScale:number, hasVisibleVector:boolean, hasAnnotations:boolean, images:Array, imageOps:number,
 *   coverImage:object|null}>}
 *   imageScale: 主な画像の「1pt あたりの画素数」(72dpi で 1)。画像が無ければ 0
 *   coverImage: ページ全体をちょうど覆う1枚の画像(ほかに見えるものが無いとき)。元の画像を取り出せるかの判断に使う
 */
export async function analyzePage(page) {
  const lib = pdfjs();
  const OPS = lib.OPS;
  const opList = await page.getOperatorList({ intent: "print", annotationMode: lib.AnnotationMode.ENABLE_STORAGE });
  const { fnArray, argsArray } = opList;
  const PAINT = new Set([
    OPS.stroke,
    OPS.closeStroke,
    OPS.fill,
    OPS.eoFill,
    OPS.fillStroke,
    OPS.eoFillStroke,
    OPS.closeFillStroke,
    OPS.closeEOFillStroke,
  ]);
  const SHOW_TEXT = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
  let ctm = [1, 0, 0, 1, 0, 0];
  let textMode = 0;
  const stack = [];
  const images = [];
  let hasVisibleVector = false;
  let hasAnnotations = false;
  let imageOps = 0;
  const push = () => stack.push([ctm, textMode]);
  const pop = () => {
    const top = stack.pop();
    if (top) {
      [ctm, textMode] = top;
    }
  };
  const addImage = (width, height, kind, objId = null) => {
    imageOps++;
    if (!(width > 0 && height > 0)) {
      return;
    }
    // 画像は単位正方形を CTM で写した範囲に描かれる
    const w = Math.hypot(ctm[0], ctm[1]);
    const h = Math.hypot(ctm[2], ctm[3]);
    if (!(w > 0 && h > 0)) {
      return;
    }
    images.push({ kind, objId, width, height, ctm: ctm.slice(), scale: Math.max(width / w, height / h), area: w * h });
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save:
        push();
        break;
      case OPS.restore:
        pop();
        break;
      case OPS.transform:
        ctm = multiply(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        push();
        if (args?.[0]?.length === 6) {
          ctm = multiply(ctm, Array.from(args[0]));
        }
        break;
      case OPS.paintFormXObjectEnd:
        pop();
        break;
      case OPS.beginAnnotation:
        hasAnnotations = true;
        push();
        break;
      case OPS.endAnnotation:
        pop();
        break;
      case OPS.setTextRenderingMode:
        textMode = args?.[0] ?? 0;
        break;
      case OPS.constructPath:
        if (PAINT.has(args?.[0])) {
          hasVisibleVector = true;
        }
        break;
      case OPS.paintImageXObject:
        addImage(args?.[1], args?.[2], "xobject", args?.[0]);
        break;
      case OPS.paintInlineImageXObject:
        addImage(args?.[0]?.width, args?.[0]?.height, "inline");
        break;
      case OPS.paintImageMaskXObject:
        addImage(args?.[0]?.width, args?.[0]?.height, "mask");
        break;
      case OPS.shadingFill:
      case OPS.paintSolidColorImageMask:
      case OPS.paintImageXObjectRepeat:
      case OPS.paintImageMaskXObjectRepeat:
      case OPS.paintInlineImageXObjectGroup:
      case OPS.paintImageMaskXObjectGroup:
        hasVisibleVector = true;
        imageOps++;
        break;
      default:
        if (PAINT.has(fn)) {
          hasVisibleVector = true;
        } else if (SHOW_TEXT.has(fn) && textMode !== 3 && textMode !== 7) {
          // 3 = 見えない文字(OCR の文字など)、7 = 切り抜きだけ
          hasVisibleVector = true;
        }
    }
  }
  // 主な画像(小さな飾りの画像は除く)のうち、いちばん細かいもの
  const [x1, y1, x2, y2] = page.view;
  const pageArea = Math.abs((x2 - x1) * (y2 - y1)) || 1;
  const main = images.filter(img => img.area >= pageArea * SMALL_IMAGE_AREA);
  const imageScale = main.length ? Math.max(...main.map(img => img.scale)) : 0;
  // ページ全体をちょうど覆う1枚の画像(向き・反転なし)だけのページか
  let coverImage = null;
  if (images.length === 1 && imageOps === 1 && !hasVisibleVector && !hasAnnotations && images[0].kind === "xobject") {
    const [a, b, c, d, e, f] = images[0].ctm;
    const tol = 1.0; // pt
    if (
      Math.abs(b) < 1e-6 &&
      Math.abs(c) < 1e-6 &&
      a > 0 &&
      d > 0 &&
      Math.abs(e - x1) <= tol &&
      Math.abs(f - y1) <= tol &&
      Math.abs(e + a - x2) <= tol &&
      Math.abs(f + d - y2) <= tol
    ) {
      coverImage = images[0];
    }
  }
  return { imageScale, hasVisibleVector, hasAnnotations, images, imageOps, coverImage };
}

// ---------------------------------------------------------------------------
// 描く大きさ
// ---------------------------------------------------------------------------

/** 上限を超えないように縮めた倍率 */
export function clampScale(base, scale) {
  const w = base.width * scale;
  const h = base.height * scale;
  const areaLimit = Math.sqrt(MAX_PIXELS / (w * h));
  const sideLimit = MAX_SIDE / Math.max(w, h);
  return scale * Math.min(1, areaLimit, sideLimit);
}

/**
 * 画質の設定から、描く倍率(倍率 1 = 72dpi)を決める。
 * @param {{width:number,height:number}} base 倍率 1 のときの大きさ
 * @param {object} settings
 * @param {object|null} analysis analyzePage() の結果(最高画質のときに使う)
 * @param {number} [shrink] 失敗時の縮小率
 */
export function renderScaleFor(base, settings, analysis, shrink = 1) {
  const quality = settings.imageQuality || "custom";
  let scale;
  if (quality === "max") {
    const img = analysis?.imageScale || 0;
    scale = img > 0 && !analysis.hasVisibleVector && !analysis.hasAnnotations ? img : Math.max(img, VECTOR_DPI / 72);
  } else if (PRESET_LONG_SIDE[quality]) {
    scale = PRESET_LONG_SIDE[quality] / Math.max(base.width, base.height);
  } else if (settings.pngMode === "scale") {
    // 倍率 1 = ビューアの 100% 表示(96dpi)と同じ大きさ
    scale = settings.pngScale * PDF_POINTS_TO_CSS;
  } else {
    scale = settings.pngLongSide / Math.max(base.width, base.height);
  }
  return clampScale(base, scale * shrink);
}

// ---------------------------------------------------------------------------
// 描く
// ---------------------------------------------------------------------------

/**
 * ページを PNG にする。
 * @param {PDFDocumentProxy} pdfDoc
 * @param {number} pageNumber 1始まり(表示上のページ番号。getPage で引ける番号)
 * @param {object} o
 * @param {object} o.settings
 * @param {number} [o.rotation] 表示上の回転(度)。ページ本来の回転に加える
 * @param {number} [o.shrink] 縮小率(失敗したときの再挑戦用)
 * @param {object} [o.analysis] 調べた結果(無ければ必要なときに調べる)
 * @returns {Promise<{blob:Blob, width:number, height:number, type:"image/png"}>}
 */
export async function renderPagePng(pdfDoc, pageNumber, { settings, rotation = 0, shrink = 1, analysis = null }) {
  const page = await pdfDoc.getPage(pageNumber);
  const totalRotation = (((page.rotate + rotation) % 360) + 360) % 360;
  const base = page.getViewport({ scale: 1, rotation: totalRotation });
  if (!analysis && settings.imageQuality === "max") {
    analysis = await analyzePage(page);
  }
  const scale = renderScaleFor(base, settings, analysis, shrink);
  const viewport = page.getViewport({ scale, rotation: totalRotation });
  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  try {
    await page.render({
      canvas,
      viewport,
      // 「印刷」と同じ描き方: フォームの入力内容と、自分で書き込んだ注釈も画像に含める
      intent: "print",
      annotationMode: pdfjs().AnnotationMode.ENABLE_STORAGE,
      background: "#ffffff",
    }).promise;
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error("PNG に変換できませんでした"))), "image/png")
    );
    return { blob, width, height, type: "image/png" };
  } finally {
    // 大きな画像のメモリをすぐに解放する
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 元の JPEG をそのまま取り出す(最高画質でファイルに保存するとき)
// ---------------------------------------------------------------------------

let pdfLibPromise = null;
function pdfLib() {
  pdfLibPromise ||= import("../lib/pdf-lib.esm.min.js");
  return pdfLibPromise;
}

/** JPEG の大きさと色の数(SOF マーカーから読む)。JPEG でなければ null */
export function inspectJpeg(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let i = 2;
  let adobeTransform = null;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) {
      return null;
    }
    // APP14(Adobe): 色の変換の指定
    if (marker === 0xee && len >= 12 && String.fromCharCode(...bytes.subarray(i + 4, i + 9)) === "Adobe") {
      adobeTransform = bytes[i + 4 + 11];
    }
    // SOF0〜SOF15(DHT=C4, JPG=C8, DAC=CC を除く)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const precision = bytes[i + 4];
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      const components = bytes[i + 9];
      return { width, height, components, precision, progressive: marker === 0xc2, adobeTransform, sof: marker };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * ページが1枚の JPEG 画像だけでできていれば、その JPEG をそのまま取り出す(作り直さない)。
 * 取り出せないとき(回転している、ほかに文字や図がある、CMYK など)は null。
 * @param {PDFDocumentProxy} doc ビューアで開いている文書(または保存済みのデータから開いた文書)
 * @param {number} pageNumber 表示上のページ番号(1始まり)
 * @param {number} sourcePageIndex そのページの元の PDF でのページ番号(0始まり。抜き出しに使う)
 * @param {object} o
 * @param {number} [o.rotation] 表示上の回転
 * @param {object} [o.analysis]
 * @returns {Promise<{bytes:Uint8Array, width:number, height:number, type:"image/jpeg"}|null>}
 */
export async function extractOriginalJpeg(doc, pageNumber, sourcePageIndex, { rotation = 0, analysis = null } = {}) {
  try {
    const page = await doc.getPage(pageNumber);
    const totalRotation = (((page.rotate + rotation) % 360) + 360) % 360;
    if (totalRotation !== 0) {
      return null;
    }
    analysis ||= await analyzePage(page);
    const cover = analysis.coverImage;
    if (!cover) {
      return null;
    }
    // そのページだけを、暗号化の無い PDF として抜き出す(空白のページを足して「結合」にすると暗号化を引き継がない)
    const bytes = await doc.extractPages([{ document: null, includePages: [sourcePageIndex] }, { document: blankPdfBytes() }]);
    if (!bytes?.length) {
      return null;
    }
    const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFNumber } = await pdfLib();
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const node = pdf.getPage(0).node;
    const resources = node.Resources();
    const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (!xobjects) {
      return null;
    }
    const imageStreams = [];
    for (const key of xobjects.keys()) {
      const obj = xobjects.lookup(key);
      const dict = obj?.dict;
      const subtype = dict?.lookupMaybe?.(PDFName.of("Subtype"), PDFName)?.asString();
      if (subtype === "/Form") {
        return null; // フォーム XObject の中身までは確かめない
      }
      if (subtype === "/Image") {
        imageStreams.push(obj);
      }
    }
    if (imageStreams.length !== 1 || !(imageStreams[0] instanceof PDFRawStream)) {
      return null;
    }
    const stream = imageStreams[0];
    const dict = stream.dict;
    const filter = dict.lookup(PDFName.of("Filter"));
    const filterName =
      filter instanceof PDFName ? filter.asString() : filter instanceof PDFArray && filter.size() === 1 ? filter.lookup(0)?.asString?.() : null;
    if (filterName !== "/DCTDecode") {
      return null;
    }
    if (dict.has(PDFName.of("SMask")) || dict.has(PDFName.of("Mask")) || dict.has(PDFName.of("Decode")) || dict.has(PDFName.of("ImageMask"))) {
      return null;
    }
    const num = key => {
      const v = dict.lookup(PDFName.of(key));
      return v instanceof PDFNumber ? v.asNumber() : null;
    };
    const width = num("Width");
    const height = num("Height");
    if (width !== cover.width || height !== cover.height) {
      return null;
    }
    // 色: グレー・RGB だけ(CMYK の JPEG は、表示するソフトによって色が変わるため取り出さない)
    const cs = dict.lookup(PDFName.of("ColorSpace"));
    let csName = cs instanceof PDFName ? cs.asString() : null;
    if (cs instanceof PDFArray && cs.lookup(0)?.asString?.() === "/ICCBased") {
      const icc = cs.lookup(1);
      const n = icc?.dict?.lookup?.(PDFName.of("N"));
      csName = n instanceof PDFNumber ? (n.asNumber() === 1 ? "/DeviceGray" : n.asNumber() === 3 ? "/DeviceRGB" : null) : null;
    }
    if (csName !== "/DeviceGray" && csName !== "/DeviceRGB") {
      return null;
    }
    const jpeg = stream.contents;
    const info = inspectJpeg(jpeg);
    if (!info || info.width !== width || info.height !== height || info.precision !== 8) {
      return null;
    }
    if ((csName === "/DeviceGray" && info.components !== 1) || (csName === "/DeviceRGB" && info.components !== 3)) {
      return null;
    }
    return { bytes: jpeg, width, height, type: "image/jpeg" };
  } catch (e) {
    console.warn("[製本ビューア] 元の画像を取り出せませんでした(描き直します)", e);
    return null;
  }
}

/**
 * ページを画像ファイルにする(最高画質で取り出せるときは元の JPEG、それ以外は PNG)。
 * @returns {Promise<{blob:Blob, width:number, height:number, ext:"png"|"jpg", original:boolean}>}
 */
export async function pageImageFile(doc, pageNumber, sourcePageIndex, { settings, rotation = 0, shrink = 1, allowOriginal = true }) {
  let analysis = null;
  if (settings.imageQuality === "max") {
    const page = await doc.getPage(pageNumber);
    analysis = await analyzePage(page);
    if (allowOriginal && shrink === 1 && analysis.coverImage) {
      const jpeg = await extractOriginalJpeg(doc, pageNumber, sourcePageIndex, { rotation, analysis });
      if (jpeg) {
        return { blob: new Blob([jpeg.bytes], { type: "image/jpeg" }), width: jpeg.width, height: jpeg.height, ext: "jpg", original: true };
      }
    }
  }
  const png = await renderPagePng(doc, pageNumber, { settings, rotation, shrink, analysis });
  return { blob: png.blob, width: png.width, height: png.height, ext: "png", original: false };
}

/** 画質の説明(通知に出す) */
export function qualityLabel(settings) {
  switch (settings.imageQuality) {
    case "max":
      return "最高画質";
    case "high":
      return "高画質";
    case "standard":
      return "標準";
    default:
      return "指定の画質";
  }
}
