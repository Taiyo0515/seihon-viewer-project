/**
 * スキャンの整え(0.3): スキャンした見開きを1ページずつに分ける・余白を除く・ばらした冊子を読む順に並べ替える。
 *
 * 流れ:
 *  1. PDF を開くと、横長のページの PDF なら最初の数ページを調べる(画像1枚だけのページか、ノドがあるか)。
 *  2. 本・ノートを開いてスキャンした見開きなら(詳細設定が「自動」のとき)、いまのページのまわりを先に調べて
 *     整えた PDF を作って表示し(0.8 部分表示)、残りのページは表示しながら順に調べて組み直す。
 *     ばらした冊子のような平らな紙なら、ツールバーのボタンで知らせる。
 *  3. 整えた PDF は、元の画像をそのまま使って表示する範囲だけを変えたもの(scan-pages.js)。元の画質のまま。
 *     「元のスキャンに戻す」で元の PDF に戻せる。PDF ごとに選んだ整え方を覚えておき、次に開いたときも同じにする。
 *  元の PDF のファイルは変えない(整えた PDF は、保存を選んだときだけ新しいファイルとして保存する)。
 */

import { saveBlobAs, sanitizeFileName } from "../../common/files.js";
import { deleteScanCache, deleteScanPlan, getScanCache, getScanPlan, putScanCache, putScanPlan } from "../../common/db.js";
import { decryptedCopy } from "../doc-source.js";
import { loadPdfFromBytes } from "../page-export.js";
import { isRearranged, sourceIndex } from "../page-map.js";
import {
  SKEW_MIN_DEG,
  analyzeFull,
  chooseSplits,
  classifyDocument,
  cropRects,
  cropSingles,
  halvesFor,
  isSkewed,
  orderBooklet,
  orderSpread,
  shrinkGray,
  toGray,
  turnMatrix,
} from "./scan-analysis.js";
import { ScanSource, arrangedId, buildArrangedPdf } from "./scan-pages.js";

/** PDF ごとに選んだ整え方(chrome.storage.local) */
const CHOICES_KEY = "scanChoices";
const MAX_CHOICES = 300;
/** 保存しておく整えの計画・PDF の版(0.6.7)。スキャンの判定や作り方を変えたら、この数を上げて古い保存を捨てさせる */
const SCAN_CACHE_SCHEMA = 8;
/** 角度を指定できる範囲(度) */
const SKEW_LIMIT = 8;
/** 調べるときの画像の長辺(画素) */
const ANALYSIS_LONG_SIDE = 1100;
/** プレビューに使う小さな画像の幅(画素) */
const PREVIEW_WIDTH = 240;
/** 開いたときに調べる最初のページ数 */
const QUICK_PAGES = 4;
/** これより大きな PDF は、開いたときには調べない(メニューからは整えられる) */
const AUTO_LIMIT_BYTES = 1024 * 1024 * 1024;
/** 縦長の PDF は、これより大きければ傾きを調べない(ふつうの文書を開くのを遅くしないため) */
const PORTRAIT_LIMIT_BYTES = 1024 * 1024 * 1024;
/** 縦長の PDF で、1ページがこれより軽く文字があれば、スキャンではないとみなす */
const LIGHT_PAGE_BYTES = 100 * 1024;

export const MODE_SUFFIX = Object.freeze({ spread: "_分割", booklet: "_並べ替え", straighten: "_傾き補正", trim: "_余白" });

/** 整えた PDF のファイル名に付ける言葉(0.8: モードと補正から決める。構成の無い「傾き補正」「余白」は補正の名を使う) */
export function fileNameSuffix(options) {
  if (options.mode === "spread") {
    return MODE_SUFFIX.spread;
  }
  if (options.mode === "booklet") {
    return MODE_SUFFIX.booklet;
  }
  if (options.deskew) {
    return MODE_SUFFIX.straighten;
  }
  if (options.trim) {
    return MODE_SUFFIX.trim;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 整え方
// ---------------------------------------------------------------------------

/**
 * 整え方を検証する(0.8: 「ページの構成」と「補正」と「条件」を1つの形にまとめた)。
 * mode: "spread" 見開きを1ページずつに分ける / "booklet" 冊子の読む順に並べ替える / "none" 分けない・並べ替えない。
 *   0.7 までの "straighten"(傾きだけ直す)と "trim"(余白だけ除く)は、それぞれ
 *   {mode:"none", deskew:true, angle} と {mode:"none", trim:true} に置き換えて読む(選び方を覚えてあるものも)。
 * 補正: trim(余白を除く)・deskew(傾きをまっすぐにする)・angle(傾きの角度。mode "none" のとき指定できる)。
 * 条件: turn(spread のとき・横に置いた見開きを回す向き)/ direction・reverse(spread の読む向き・1ページ目)/
 *   sheetOrder・firstSide・flipBacks(booklet の紙の順・スキャンした面の向き)。
 * @returns {object|null}
 */
export function normalizeOptions(o) {
  if (!o || typeof o !== "object") {
    return null;
  }
  const mode = ["spread", "booklet", "straighten", "none", "trim"].includes(o.mode) ? o.mode : null;
  if (!mode) {
    return null;
  }
  // "straighten"(0.6〜0.7)/ "trim"(0.6.5〜0.7)は、構成「元のまま」+ 補正のチェックにまとめた
  if (mode === "straighten") {
    return normalizeOptions({
      mode: "none",
      deskew: true,
      trim: false,
      angle: Number.isFinite(o.angle) ? o.angle : null,
      direction: o.direction,
    });
  }
  if (mode === "trim") {
    return normalizeOptions({ mode: "none", trim: true, deskew: o.deskew === true, direction: o.direction });
  }
  return {
    mode,
    // 余白を除く(見開きを分けるときの初期値は設定と同じ。指定が無いときだけ既定を使う)
    trim: typeof o.trim === "boolean" ? o.trim : mode === "spread",
    // 傾きをまっすぐにする。
    deskew: !!o.deskew,
    // 傾きの角度(度)。「元のまま」で傾きを直すとき、指定すると全部のページをその角度だけ回す
    angle:
      mode === "none" && !!o.deskew && Number.isFinite(o.angle) && Math.abs(o.angle) <= SKEW_LIMIT
        ? Math.round(o.angle * 100) / 100
        : null,
    // 見開きを横に置いてスキャンした縦長のページ: "none" 回さない / "auto" 文字の向きから決める / "cw" 時計回りに回す / "ccw" 反時計回りに回す
    turn: mode === "spread" && ["auto", "cw", "ccw"].includes(o.turn) ? o.turn : "none",
    direction: o.direction === "rtl" ? "rtl" : "ltr",
    sheetOrder: o.sheetOrder === "inner" ? "inner" : "outer",
    firstSide: o.firstSide === "inner" ? "inner" : "outer",
    flipBacks: !!o.flipBacks,
    // 0.4.1: 見開きのスキャンが、最後の見開きから順に並んでいる
    reverse: !!o.reverse,
  };
}

/** 整え方を表す文字列(整えた PDF の ID と指紋に使う。同じ整え方なら同じ) */
function signature(o) {
  return [
    o.mode,
    o.trim ? 1 : 0,
    o.direction,
    o.sheetOrder,
    o.firstSide,
    o.flipBacks ? 1 : 0,
    ...(o.reverse ? ["rev"] : []),
    ...(o.deskew ? ["skew", o.angle ?? "auto"] : []),
    ...(o.turn !== "none" ? ["turn", o.turn] : []),
  ].join("|");
}

/**
 * 保存しておいた計画(0.6.7)の中身を確かめる。ページ数が合わない・中身が壊れている・
 * 元のページが1つでも抜けている(調べていないページが残っている計画。0.8 では保存しないが、保険)ときは null
 * @param {Array<{src:number, ...}>} [pages]
 * @returns {Array|null}
 */
function validCachedPages(pages, pageCount) {
  if (!Array.isArray(pages) || !pages.length || !Number.isInteger(pageCount) || pageCount < 1) {
    return null;
  }
  const rectOk = r =>
    r === null || (Array.isArray(r) && r.length === 4 && r.every(n => typeof n === "number" && Number.isFinite(n)));
  const seen = new Uint8Array(pageCount);
  for (const p of pages) {
    if (!Number.isInteger(p?.src) || p.src < 0 || p.src >= pageCount) {
      return null;
    }
    if (p.pending) {
      return null; // 調べていないページをそのまま入れる計画(0.8 部分表示)は保存に使わない
    }
    seen[p.src] = 1;
    if (!rectOk(p.rect) || !rectOk(p.rectPx)) {
      return null;
    }
    if (!Array.isArray(p.masks) || !Array.isArray(p.masksPx)) {
      return null;
    }
    if (!(p.masks.length === p.masksPx.length) || !p.masks.every(rectOk)) {
      return null;
    }
    if (p.matrix != null && !(Array.isArray(p.matrix) && p.matrix.length === 6 && p.matrix.every(n => typeof n === "number" && Number.isFinite(n)))) {
      return null;
    }
    if (typeof p.rotate !== "number" || !Number.isFinite(p.rotate) || p.rotate % 90 !== 0 || p.rotate < 0 || p.rotate > 270) {
      return null;
    }
  }
  if (!seen.every(v => v)) {
    return null; // 元のページが1つでも抜けている計画は、部分の計画なので使わない
  }
  return pages;
}

/** 保存しておく計画の鍵(0.6.7) */
function scanPlanKey(baseKey, sig) {
  return `${SCAN_CACHE_SCHEMA}|${baseKey}|${sig}`;
}

async function loadChoices() {
  try {
    const items = await chrome.storage.local.get(CHOICES_KEY);
    const all = items[CHOICES_KEY];
    return all && typeof all === "object" ? all : {};
  } catch {
    return {};
  }
}

/** PDF(元の PDF の指紋)ごとに選んだ整え方 */
export async function loadChoice(key) {
  if (!key) {
    return null;
  }
  const all = await loadChoices();
  return normalizeOptions(all[key]);
}

export async function storeChoice(key, options) {
  if (!key) {
    return;
  }
  const all = await loadChoices();
  all[key] = { ...normalizeOptions(options), t: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > MAX_CHOICES) {
    keys.sort((a, b) => (all[a].t || 0) - (all[b].t || 0));
    for (const k of keys.slice(0, keys.length - MAX_CHOICES)) {
      delete all[k];
    }
  }
  try {
    await chrome.storage.local.set({ [CHOICES_KEY]: all });
  } catch (e) {
    console.warn("[製本ビューア] 整え方を覚えておけませんでした", e);
  }
}

// ---------------------------------------------------------------------------
// 画像
// ---------------------------------------------------------------------------

/** JPEG を縮めて読む割合(1/1・1/2・1/4・1/8。JPEG はこの割合なら速く縮めて読める)。長辺が ANALYSIS_LONG_SIDE 前後になるようにする */
function jpegShrink(image) {
  let f = 1;
  while (f < 8 && Math.max(image.width, image.height) / (f * 2) >= ANALYSIS_LONG_SIDE * 0.9) {
    f *= 2;
  }
  return f;
}

/**
 * JPEG を縮めて読み込み、ページに置かれている位置に描く(元の大きさで読むより何倍も速い)。
 * @returns {Promise<boolean>} 描けたら true
 */
async function drawJpeg(ctx, viewport, image) {
  const ctm = image.ctm;
  const f = jpegShrink(image);
  // ImageDecoder には、ほかのデータと共有していない新しい領域を渡す
  const decoder = new ImageDecoder({
    data: image.jpeg.slice(),
    type: "image/jpeg",
    desiredWidth: Math.ceil(image.width / f),
    desiredHeight: Math.ceil(image.height / f),
  });
  try {
    const { image: frame } = await decoder.decode();
    try {
      ctx.save();
      ctx.setTransform(...viewport.transform);
      ctx.transform(ctm[0], ctm[1], ctm[2], ctm[3], ctm[4], ctm[5]);
      // PDF の画像は、単位正方形の上(y = 1)が1行目
      ctx.transform(1, 0, 0, -1, 0, 1);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "medium";
      ctx.drawImage(frame, 0, 0, 1, 1);
      ctx.restore();
    } finally {
      frame.close();
    }
  } finally {
    decoder.close();
  }
  return true;
}

/** 画像の座標(ビューポート)の点を、PDF のユーザー空間の点にする */
function toPdfPoint(t, x, y) {
  const [a, b, c, d, e, f] = t;
  const det = a * d - b * c;
  return [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det];
}

function toPdfRect(t, rect) {
  const [x0, y0, x1, y1] = rect;
  const p = toPdfPoint(t, x0, y0);
  const q = toPdfPoint(t, x1, y1);
  return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
}

/** 変換 t を先にかけ、そのあとで m をかけた変換(キャンバスの [a b c d e f]) */
function composeTransform(m, t) {
  return [
    m[0] * t[0] + m[2] * t[1],
    m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3],
    m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4],
    m[1] * t[4] + m[3] * t[5] + m[5],
  ];
}

/**
 * 回すと決めた向き("cw" / "ccw")。"auto" は、調べた全ページの文字の向きから決める(根拠が無ければ時計回り)。
 * 横に置いたページが無ければ "none"。
 */
export function resolveTurn(options, scans) {
  if (!options.turn || options.turn === "none") {
    return "none";
  }
  if (!scans.some(s => s?.turned)) {
    return "none";
  }
  if (options.turn !== "auto") {
    return options.turn;
  }
  let sum = 0;
  for (const s of scans) {
    if (s?.turned) {
      sum += s.turned.score * s.turned.bands;
    }
  }
  return sum >= 0 ? "cw" : "ccw";
}

/** 画像の座標(ビューポート)の点を、中心のまわりに phi 度(画面で時計回りが正)回す */
function rotateAbout(x, y, cx, cy, phiDeg) {
  const t = (phiDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const dx = x - cx;
  const dy = y - cy;
  return [dx * c - dy * s + cx, dx * s + dy * c + cy];
}

/**
 * 傾きを直すために、ページの中身にかける変換(PDF の cm。元のページのユーザー空間の点 → 直したあとの点)。
 * 調べた画像(幅 W・高さ H 画素。ページ全体を覆う)の中心のまわりに、画像を phi 度回すのと同じ動きになる。
 * @param {number[]} transform 画像の座標へのビューポートの変換(scan.transform)
 * @param {{angle:number, cx:number, cy:number}|null} [resid] 続けて、分けた1ページの範囲の中心(画像の座標)のまわりに回す角度(0.6.2)
 */
export function deskewMatrix(transform, W, H, phiDeg, resid = null) {
  const f = (ux, uy) => {
    const [a, b, c, d, e, g] = transform;
    const px = a * ux + c * uy + e;
    const py = b * ux + d * uy + g;
    let [qx, qy] = rotateAbout(px, py, W / 2, H / 2, phiDeg);
    // 続けて、分けた1ページごとの傾き(そのページの範囲の中心のまわり。画像の座標)
    if (resid) {
      [qx, qy] = rotateAbout(qx, qy, resid.cx, resid.cy, resid.angle);
    }
    return toPdfPoint(transform, qx, qy);
  };
  const p0 = f(0, 0);
  const p1 = f(1, 0);
  const p2 = f(0, 1);
  return [p1[0] - p0[0], p1[1] - p0[1], p2[0] - p0[0], p2[1] - p0[1], p0[0], p0[1]];
}

/**
 * 見開きを分けた1ページごとの、残りの傾き(0.6.2)。見開き全体では傾いていなくても、左のページだけ傾いていることがある。
 * 全体を phi0 だけ直したあと、そのページ自身の傾き(半分だけで調べたもの)との差を、そのページの中心のまわりで直す。
 */
function pageResidual(raws, o, phi0) {
  const hs = raws?.halfSkew;
  const h = hs && o.rect && (o.half === "L" || o.half === "R") ? hs[o.half] : null;
  if (!h || !isSkewed(h)) {
    return null;
  }
  const angle = Math.round((h.angle - phi0) * 100) / 100;
  if (Math.abs(angle) < SKEW_MIN_DEG) {
    return null;
  }
  const [x0, y0, x1, y1] = o.rect;
  return { angle, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/**
 * 調べた結果から、直す傾き(度)を決める。直さないページは 0。
 * mode "none" で傾きを直す(0.8: 旧 straighten)ときに使う。angle を指定していれば、全部のページをその角度だけ回す
 */
function pageAngle(scan, options) {
  if (typeof options.angle === "number") {
    return Math.abs(options.angle) >= 0.01 ? options.angle : 0;
  }
  return isSkewed(scan?.skew) ? scan.skew.angle : 0;
}

/** 調べ終えたページの傾きのまとめ: 直すページの数と、その角度の中央値 */
export function skewSummary(scans) {
  const list = scans.filter(Boolean);
  const angles = list.filter(s => isSkewed(s.skew)).map(s => s.skew.angle);
  angles.sort((a, b) => a - b);
  const mid = angles.length >> 1;
  const median = angles.length ? (angles.length % 2 ? angles[mid] : (angles[mid - 1] + angles[mid]) / 2) : 0;
  return { pages: list.length, skewed: angles.length, median: Math.round(median * 100) / 100 };
}

const idle = (timeout = 1500) =>
  new Promise(resolve => {
    if ("requestIdleCallback" in window) {
      requestIdleCallback(() => resolve(), { timeout });
    } else {
      setTimeout(resolve, 300);
    }
  });

const PLAN_ERRORS = {
  noskew: "傾いているページが見つかりませんでした(角度を指定して直すこともできます)。",
  odd: "スキャンの枚数が奇数のため、冊子の順に並べ替えられません(両面スキャンした冊子なら偶数になります)。",
  unsplit: "縦長のページなど、2つに分けられないページがあるため、冊子の順に並べ替えられません。",
  mapping: "冊子の順に並べ替えられませんでした。",
  empty: "分けられるページがありませんでした。",
  notrim: "余白を除けるページがありませんでした(紙がページいっぱいに写っているものなど)。",
};

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export class ScanArranger {
  /**
   * @param {object} o
   * @param {object} o.app PDFViewerApplication
   * @param {object} o.toast
   * @param {object} o.docSource
   * @param {object} o.pageEditor
   * @param {() => object} o.getSettings
   * @param {() => object} o.getCurrent いま開いている文書の出どころ(main.js)
   * @param {() => "ltr"|"rtl"} o.getDirection いまの綴じ方向
   * @param {(args:object) => Promise} o.openDocument 文書を開く(main.js の app.open。args.seihon で出どころを引き継ぐ)
   * @param {object} [o.book] BookLayout(表示モードを合わせるため)
   */
  constructor({ app, toast, docSource, pageEditor, getSettings, getCurrent, getDirection, openDocument, book = null }) {
    this.book = book;
    /** 整えたときに変えた表示モード(元に戻すときに戻す) */
    this.modeBefore = null;
    this.app = app;
    this.toast = toast;
    this.docSource = docSource;
    this.pageEditor = pageEditor;
    this.getSettings = getSettings;
    this.getCurrent = getCurrent;
    this.getDirection = getDirection;
    this.openDocument = openDocument;
    /** 元のスキャン(整える前の PDF)の情報 */
    this.base = null;
    /** いま表示している、整えた PDF の情報 */
    this.arranged = null;
    /** "none" 何も無い / "suggest" 整えられる / "busy" 整えている / "arranged" 整えて表示している */
    this.state = "none";
    this.progress = "";
    this.seq = 0;
    this.listeners = new Set();
    this.busyToast = null;
    /** 「整えられます」の通知(整えたら消す) */
    this.suggestToast = null;
    app.eventBus.on("documentloaded", () => this.onDocumentLoaded());
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      try {
        fn(this);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /**
   * 0.8.2: 処理の記録(開発者向け)。詳細設定の「スキャンの処理の表示」がオンのときだけ記録して、
   * 聞き手(画面の表示など)に変わったことを知らせる。記録は新しいものだけを残す。
   * @param {string} text
   */
  debugNote(text) {
    if (!this.getSettings().scanDebugShow) {
      return;
    }
    const t = new Date();
    const at = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    (this.debugLog ||= []).push({ at, text });
    if (this.debugLog.length > 60) {
      this.debugLog.splice(0, this.debugLog.length - 60);
    }
    this.emit();
  }

  setState(state, progress = "") {
    this.state = state;
    this.progress = progress;
    this.emit();
  }

  /** いま表示しているのが、整えた PDF か */
  get isArranged() {
    return !!this.arranged?.doc && this.app.pdfDocument === this.arranged.doc;
  }

  /** 調べた結果の種類("spread" 見開き / "sheets" 平らな紙 / null) */
  get kind() {
    return this.base?.kind || null;
  }

  /** 元のスキャンのページ数 */
  get sourcePageCount() {
    return this.base?.pageCount || 0;
  }

  /** base がまだ今の文書のものか */
  alive(base) {
    return !!base && this.base === base;
  }

  // -------------------------------------------------------------------------
  // 開いたとき
  // -------------------------------------------------------------------------

  onDocumentLoaded() {
    const doc = this.app.pdfDocument;
    const cur = this.getCurrent();
    if (this.base && cur.arranged?.baseId === this.base.id) {
      this.afterArrangedLoaded(doc);
      return;
    }
    if (this.base && cur.restoredFrom === this.base.id) {
      this.afterOriginalLoaded(doc);
      return;
    }
    // ほかの PDF を開いた
    // 0.5: 読む向きに合わせて綴じ方向を変えていたら、設定の綴じ方向に戻す
    if (this.directionOverridden && this.book) {
      this.directionOverridden = false;
      const dir = this.getSettings().bindingDirection;
      if (this.book.direction !== dir) {
        this.directionChanging = true;
        try {
          this.book.setDirection(dir);
        } finally {
          this.directionChanging = false;
        }
      }
    }
    this.base?.analysisDoc?.destroy().catch(() => {});
    this.base = null;
    this.arranged = null;
    this.busyToast?.();
    this.busyToast = null;
    this.suggestToast?.();
    this.suggestToast = null;
    this.setState("none");
    if (!doc || cur.converted) {
      return; // 0.4: コミックなどから作った PDF は調べない(見開きの画像はすでに分けてある)
    }
    const base = {
      id: ++this.seq,
      doc,
      pageCount: doc.numPages,
      current: { ...cur },
      fileName: this.docSource.displayName(),
      baseName: this.docSource.baseName(),
      key: null,
      bytes: null,
      plain: null,
      source: null,
      kind: null,
      choice: null,
      scans: [],
      previews: [],
      analyzed: false,
      checked: false,
    };
    this.base = base;
    this.debugNote(`PDF を開きました(${base.pageCount}ページ)。スキャンかどうかを調べます`);
    this.detect(base).catch(e => console.warn("[製本ビューア] スキャンかどうかを調べられませんでした", e));
  }

  /** 横長のページが多いか(ページの大きさだけ見る。速い) */
  async mostlyLandscape(doc) {
    const sample = Math.min(doc.numPages, 6);
    let land = 0;
    for (let i = 1; i <= sample; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1, rotation: page.rotate });
      if (vp.width >= vp.height * 1.15) {
        land++;
      }
    }
    return land >= Math.max(1, Math.ceil(sample * 0.6));
  }

  /**
   * 開いている PDF のページが横長か(分けたり並べ替えたりできるか)。整えて表示しているときは、元の文書(手放している)を読まず、
   * 調べた結果から答える。
   */
  async isLandscape(base = this.base) {
    if (base.landscape === undefined) {
      const scans = base.scans.filter(Boolean);
      if (scans.length) {
        base.landscape = scans.filter(s => s.landscape).length >= Math.ceil(scans.length * 0.6);
      } else {
        try {
          base.landscape = await this.mostlyLandscape(base.doc);
        } catch {
          return true;
        }
      }
    }
    return base.landscape;
  }

  /** 開いた PDF が、スキャンした見開き・冊子の紙かを調べる */
  async detect(base) {
    await idle();
    if (!this.alive(base)) {
      return;
    }
    const settings = this.getSettings();
    if (settings.scanArrange === "off" && settings.scanDeskew === "off") {
      return;
    }
    const landscape = await this.isLandscape(base);
    if (!this.alive(base)) {
      return;
    }
    if (!landscape) {
      // 0.6: 縦長のスキャン。傾いていれば、まっすぐにして表示できると知らせる
      await this.detectPortrait(base);
      return;
    }
    if (settings.scanArrange === "off") {
      return;
    }
    const info = await base.doc.getDownloadInfo().catch(() => null);
    if ((info?.length || 0) > AUTO_LIMIT_BYTES) {
      return;
    }
    base.key = await this.ensureKey(base);
    base.choice = await loadChoice(base.key);
    if (!this.alive(base)) {
      return;
    }
    // 0.8: この PDF について選んだ整え方があれば(構成と補正のどちらかが決まっていれば)、
    // スキャンを調べる前に、保存しておいた結果で表示を試す(使えたら解析はしないで済む)
    const choice = base.choice;
    const choiceActive = !!choice && (choice.mode !== "none" || choice.trim || choice.deskew);
    if (choiceActive && (await this.cachedArrange(choice, base, { auto: true })) === true) {
      return;
    }
    if (!choiceActive) {
      if (!(await this.prepareSource(base))) {
        return;
      }
      // 調べる最初のページは、いま見ているページのまわりと中ほどの数ページ(0.8.2)
      const quick = this.samplePages(base);
      const pure = quick.filter(i => base.source.inspect(i).pureImage);
      if (pure.length < Math.ceil(quick.length * 0.6)) {
        return; // スキャンではない(文字・図の PDF)
      }
      for (const i of quick) {
        await this.analyzePage(base, i);
        if (!this.alive(base)) {
          return;
        }
      }
      base.kind = classifyDocument(quick.map(i => base.scans[i]));
      base.checked = true;
      this.debugNote(`判定サンプル(${quick.length}ページ)で種類を判定しました: ${base.kind || "スキャンではない"}`);
      if (!base.kind) {
        return;
      }
    }
    if (choiceActive) {
      await this.arrange(choice, { auto: true });
      return;
    }
    if (!choice && base.kind === "spread" && settings.scanArrange === "auto") {
      await this.arrange(this.defaultOptions(), { auto: true });
      return;
    }
    this.setState("suggest");
    if (!choice) {
      const message =
        base.kind === "spread"
          ? "スキャンした見開きのようです。1ページずつに分けて、余白を除いて表示できます"
          : "2ページ分が並んだスキャン(ばらした冊子など)のようです。分けて、表紙から順に並べ替えられます";
      this.suggestToast = this.toast.show(message, {
        duration: 10000,
        actions: [
          { label: base.kind === "spread" ? "分けて表示" : "並べ替える", onClick: () => this.arrange(this.defaultOptions()) },
          { label: "整え方…", onClick: () => this.openDialog?.() },
        ],
      });
    }
  }

  /**
   * 縦長のページの PDF が、傾いたスキャンかを調べる(0.6)。文字のある PDF や大きな PDF は調べない(ふつうの文書を遅くしないため)。
   */
  async detectPortrait(base) {
    const settings = this.getSettings();
    if (settings.scanDeskew === "off") {
      return;
    }
    const info = await base.doc.getDownloadInfo().catch(() => null);
    if ((info?.length || 0) > PORTRAIT_LIMIT_BYTES) {
      return;
    }
    // 文字(テキスト)のあるページで、1ページが軽い(文字の PDF)ものは、スキャンではない。
    // OCR の文字つきのスキャンは1ページが重い(画像を含む)ので、調べる
    const perPage = (info?.length || 0) / Math.max(1, base.pageCount);
    if (perPage < LIGHT_PAGE_BYTES) {
      for (let i = 1; i <= Math.min(base.pageCount, 2); i++) {
        const page = await base.doc.getPage(i);
        const text = await page.getTextContent().catch(() => null);
        if (!this.alive(base)) {
          return;
        }
        if (text?.items?.some(t => t.str?.trim())) {
          return;
        }
      }
    }
    base.key = await this.ensureKey(base);
    base.choice = await loadChoice(base.key);
    if (!this.alive(base)) {
      return;
    }
    // 0.8: 保存しておいた整え方で表示を試す(使えたら調べないで済む)
    const prechoice = base.choice;
    if (
      prechoice &&
      (prechoice.mode !== "none" || prechoice.trim || prechoice.deskew) &&
      (await this.cachedArrange(prechoice, base, { auto: true })) === true
    ) {
      return;
    }
    if (!(await this.prepareSource(base))) {
      return;
    }
    // 調べる最初のページは、いま見ているページのまわりと中ほどの数ページ(0.8.1)
    const quick = this.samplePages(base);
    const pure = quick.filter(i => base.source.inspect(i).pureImage);
    if (pure.length < Math.ceil(quick.length * 0.6)) {
      return; // スキャンではない(図・写真の PDF)
    }
    for (const i of quick) {
      await this.analyzePage(base, i);
      if (!this.alive(base)) {
        return;
      }
    }
    const sum = skewSummary(quick.map(i => base.scans[i]));
    base.checked = true;
    this.debugNote(`判定サンプル(${quick.length}ページ): 傾きあり ${sum.skewed} ページ・横置き ${quick.filter(i => base.scans[i]?.turned).length} ページ`);
    const choice = base.choice;
    // 横に置いてスキャンした見開き(回すとノドが見つかるページが多い)。
    // 設定「スキャンした見開き」が「何もしない」なら、横長の見開きと同じく案内も自動の分割もしない(⋮ メニューからは使える)
    const turned = quick.filter(i => base.scans[i]?.turned).length;
    if (settings.scanArrange !== "off" && turned >= Math.ceil(quick.length * 0.5)) {
      base.kind = "turned";
      base.turnable = true;
      await this.forceTurned(base);
      if (!this.alive(base)) {
        return;
      }
      if (choice && choice.mode !== "none") {
        await this.arrange(choice, { auto: true });
        return;
      }
      if (!choice && settings.scanArrange === "auto") {
        await this.arrange(this.defaultOptions("turned"), { auto: true });
        return;
      }
      this.setState("suggest");
      if (!choice) {
        this.suggestToast = this.toast.show("見開きを横に置いてスキャンしたようです。回して、1ページずつに分けて表示できます", {
          duration: 10000,
          actions: [
            { label: "回して分ける", onClick: () => this.arrange(this.defaultOptions("turned")) },
            { label: "整え方…", onClick: () => this.openDialog?.() },
          ],
        });
      }
      return;
    }
    if (choice && choice.mode === "none" && choice.deskew) {
      base.kind = "skewed";
      await this.arrange(choice, { auto: true });
      return;
    }
    if (sum.skewed < Math.ceil(quick.length / 3)) {
      // 傾いていない: 紙が余白の中に写っている(写真など)なら、余白を除いて表示できると知らせる(0.6.5)
      await this.suggestTrim(base);
      return;
    }
    base.kind = "skewed";
    base.skew = sum;
    this.debugNote(`傾いたスキャンと判定しました(サンプル ${quick.length} ページ中 ${sum.skewed} ページで傾き)`);
    // 0.8.1: 設定「スキャンした見開き」が「自動」のときは、開いたときにまっすぐにして表示する(案内は出さない)
    if (!choice && settings.scanArrange === "auto") {
      await this.arrange(this.defaultOptions("skewed"), { auto: true });
      return;
    }
    this.setState("suggest");
    if (!choice) {
      this.suggestToast = this.toast.show(`傾いたスキャンのようです(約 ${Math.abs(sum.median)}° ${sum.median > 0 ? "反時計回り" : "時計回り"}に傾いています)。まっすぐにして表示できます`, {
        duration: 10000,
        actions: [
          { label: "まっすぐにする", onClick: () => this.arrange(this.defaultOptions("skewed")) },
          { label: "整え方…", onClick: () => this.openDialog?.() },
        ],
      });
    }
  }

  /**
   * 縦長のスキャンで、分けられない・傾いていないとき(写真など): 紙の周りの余白を除けるときは、知らせる(0.6.5)。
   * 傾きも見つからず、横に置いた見開きでもない縦長のスキャン(はがきを撮った写真など)に使う。
   */
  async suggestTrim(base) {
    const settings = this.getSettings();
    if (settings.scanArrange === "off" || !settings.scanTrim) {
      return;
    }
    // 大きな PDF は、勝手に整えない(見開きの自動の分割と同じ目安)
    const info = await base.doc.getDownloadInfo().catch(() => null);
    if ((info?.length || 0) > AUTO_LIMIT_BYTES || !this.alive(base) || !base.scans) {
      return;
    }
    // 調べたページに、余白を除けるものが無いときは、何もしない(ふつうのスキャン・文書)
    if (!cropSingles(base.scans).some(Boolean)) {
      return;
    }
    base.kind = "trim";
    base.checked = true;
    const choice = base.choice;
    if (choice && (choice.mode !== "none" || choice.trim)) {
      await this.arrange(choice, { auto: true });
      return;
    }
    if (!choice && settings.scanArrange === "auto") {
      await this.arrange(this.defaultOptions(), { auto: true });
      return;
    }
    this.setState("suggest");
    if (!choice) {
      this.suggestToast = this.toast.show("紙が背景の中に小さく写っているようです(写真など)。余白を除いて表示できます", {
        duration: 10000,
        actions: [
          { label: "余白を除く", onClick: () => this.arrange(this.defaultOptions()) },
          { label: "整え方…", onClick: () => this.openDialog?.() },
        ],
      });
    }
  }

  /**
   * 横に置いた見開きと決まった文書で、ノドが見つからなかったページも、横に置いた見開きとして調べ直す
   * (真ん中で分ける)。調べ済みのページだけ(これから調べるページは、はじめから同じ扱い)。
   */
  async forceTurned(base) {
    base.turnForce = true;
    for (let i = 0; i < base.scans.length; i++) {
      if (base.scans[i] && !base.scans[i].turned && !base.scans[i].landscape) {
        await this.analyzePage(base, i, { force: true });
        if (!this.alive(base)) {
          return;
        }
      }
    }
  }

  /** 整え方の初期値 */
  defaultOptions(kind = this.base?.kind) {
    const settings = this.getSettings();
    // 0.5: 読む向き・1ページ目の初期値は設定から(「ビューアの綴じ方向に合わせる」なら、いまの綴じ方向)
    const direction = settings.scanDirection === "rtl" || settings.scanDirection === "ltr" ? settings.scanDirection : this.getDirection();
    const deskew = settings.scanDeskew !== "off";
    if (kind === "turned") {
      return normalizeOptions({ mode: "spread", trim: settings.scanTrim, direction, reverse: settings.scanFirstPage === "last", deskew, turn: "auto" });
    }
    if (kind === "skewed" || kind === "portrait") {
      // 0.8: 傾きだけ直す(分けたり並べ替えたりしない)
      return normalizeOptions({ mode: "none", deskew: true, direction });
    }
    if (kind === "sheets") {
      return normalizeOptions({ mode: "booklet", trim: false, direction, deskew });
    }
    if (kind === "trim") {
      // 0.6.5: 分けないページの余白を除く(写真など)
      return normalizeOptions({ mode: "none", trim: true, direction, deskew });
    }
    return normalizeOptions({ mode: "spread", trim: settings.scanTrim, direction, reverse: settings.scanFirstPage === "last", deskew });
  }

  /** いま選ばれている(または選ぶとよい)整え方 */
  currentOptions() {
    if (this.arranged) {
      return { ...this.arranged.options };
    }
    const choice = this.base?.choice;
    if (choice && (choice.mode !== "none" || choice.trim || choice.deskew)) {
      // 0.5: 選んだ読み方(0.8 からは補正だけのものも含む)を覚えているので、そのまま使う
      return { ...choice };
    }
    return this.defaultOptions();
  }

  /**
   * この PDF の指紋(0.8: 元のデータの取得も1回だけにするため、取得した bytes を渡して共有する)。
   * @returns {Promise<string|null>}
   */
  async ensureKey(base) {
    if (base.key) {
      return base.key;
    }
    base.bytes ||= await base.doc.getData();
    if (!this.alive(base)) {
      return null;
    }
    base.key = await this.docSource.key(base.doc, base.bytes);
    return base.key;
  }

  /**
   * いま見ているページから、前後に広げる順で調べるページ番号(0始まり)を作る(0.8)。
   * 部分表示では、この順で調べて、すぐに整えて表示する。
   * @returns {number[]}
   */
  analysisOrder(base = this.base) {
    if (!base) {
      return [];
    }
    const n = Math.max(0, base.pageCount);
    const cur = Math.min(Math.max(0, this.currentSourcePage()), n - 1);
    const order = [cur];
    for (let d = 1; d < n; d++) {
      if (cur - d >= 0) {
        order.push(cur - d);
      }
      if (cur + d < n) {
        order.push(cur + d);
      }
    }
    return order;
  }

  /** 自動適用の判断に使うページ: いまのページのまわりと、中ほどの2ページ(約40%・約70%の位置。重複は除く)(0.8.1) */
  samplePages(base = this.base) {
    const n = Math.max(0, base?.pageCount || 0);
    const list = [...this.analysisOrder(base).slice(0, Math.min(n, QUICK_PAGES + 2))];
    for (const part of [0.4, 0.7]) {
      const i = n > 0 ? Math.min(n - 1, Math.floor(n * part)) : -1;
      if (i >= 0 && !list.includes(i)) {
        list.push(i);
      }
    }
    return list;
  }

  /** pdf-lib で元の PDF を読み込む(暗号化されていれば、パスワード無しの写しを作って読む)。同じ読み込みを2度始めない(0.8) */
  async prepareSource(base) {
    if (base.source) {
      return true;
    }
    if (!base.sourceJob) {
      base.sourceJob = this.prepareSourceNow(base).finally(() => {
        base.sourceJob = null;
      });
    }
    return base.sourceJob;
  }

  /** prepareSource() の中身 */
  async prepareSourceNow(base) {
    try {
      base.bytes ||= await base.doc.getData();
      let plain = base.bytes;
      let source;
      try {
        source = await ScanSource.open(plain);
      } catch (e) {
        if (!/encrypt/i.test(`${e?.name} ${e?.message}`)) {
          throw e;
        }
        plain = await decryptedCopy(base.doc);
        if (!plain?.length) {
          return false;
        }
        source = await ScanSource.open(plain);
      }
      if (!this.alive(base)) {
        return false;
      }
      if (source.pageCount !== base.pageCount) {
        console.warn("[製本ビューア] ページ数が合わないため、スキャンの整えを使いません");
        return false;
      }
      base.plain = plain;
      base.source = source;
      return true;
    } catch (e) {
      console.warn("[製本ビューア] PDF を読み込めませんでした(スキャンの整え)", e);
      return false;
    }
  }

  /**
   * 調べるのに使う PDF.js の文書。表示中の文書のページを削除していれば、ページ番号がずれるので、
   * 元のデータから別に開いた文書を使う。同じ読み込みを2度始めない(0.8)。
   */
  async analysisDoc(base) {
    if (base.analysisDoc) {
      return base.analysisDoc;
    }
    if (!isRearranged(base.doc)) {
      return base.doc;
    }
    if (!base.analysisDocJob) {
      base.analysisDocJob = loadPdfFromBytes(base.plain || (await base.doc.getData()))
        .then(doc => (base.analysisDoc = doc))
        .finally(() => {
          base.analysisDocJob = null;
        });
    }
    return base.analysisDocJob;
  }

  /** 1ページを調べる(0始まり)。同じページを並行して調べない(0.8) */
  async analyzePage(base, i, { force = false } = {}) {
    if (base.scans[i] && !force) {
      return base.scans[i];
    }
    const jobs = (base.jobs ||= new Map());
    if (!force) {
      const running = jobs.get(i);
      if (running) {
        return running;
      }
    }
    const job = this.analyzePageNow(base, i, { force }).finally(() => jobs?.delete(i));
    if (!force) {
      jobs.set(i, job);
    }
    return job;
  }

  /** analyzePage() の中身 */
  async analyzePageNow(base, i, { force = false } = {}) {
    if (base.scans[i] && !force) {
      return base.scans[i];
    }
    // 横に置いた見開きと決まった文書は、ノドが見つからないページも、横に置いた見開きとして調べる
    const turn = base.turnForce ? "force" : true;
    const pdfDoc = await this.analysisDoc(base);
    const page = await pdfDoc.getPage(i + 1);
    const info = base.source?.inspect(i) || null;
    const base1 = page.getViewport({ scale: 1, rotation: page.rotate });
    let scale = ANALYSIS_LONG_SIDE / Math.max(base1.width, base1.height);
    const useJpeg = info?.pureImage && info.image?.jpeg && typeof ImageDecoder === "function";
    if (useJpeg) {
      // 縮めて読んだ JPEG の1画素が、調べる画像の1画素になる倍率にする(描き直しでぼけないように)
      const img = info.image;
      const f = jpegShrink(img);
      const longPx = Math.max(Math.ceil(img.width / f), Math.ceil(img.height / f));
      const ctm = img.ctm;
      const longPt = img.width >= img.height ? Math.hypot(ctm[0], ctm[1]) : Math.hypot(ctm[2], ctm[3]);
      if (longPt > 0) {
        scale = longPx / longPt;
      }
    }
    const viewport = page.getViewport({ scale, rotation: page.rotate });
    const W = Math.max(8, Math.round(viewport.width));
    const H = Math.max(8, Math.round(viewport.height));
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    let drawn = false;
    if (useJpeg) {
      try {
        drawn = await drawJpeg(ctx, viewport, info.image);
      } catch (e) {
        console.warn("[製本ビューア] JPEG を縮めて読めなかったため、ページを描いて調べます", e);
      }
    }
    if (!drawn) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      await page.render({
        canvasContext: ctx,
        viewport,
        intent: "display",
        annotationMode: globalThis.pdfjsLib.AnnotationMode.DISABLE,
      }).promise;
    }
    const { data } = ctx.getImageData(0, 0, W, H);
    canvas.width = 0;
    canvas.height = 0;
    const gray = toGray(data, W, H);
    const img = { gray, width: W, height: H, pxPerMm: (scale * 72) / 25.4 };
    // 開発時の確認用(試験から調べた画像を見るため。ふだんは何もしない)
    globalThis.__seihonScanDebug?.push({ index: i, gray: gray.slice(), width: W, height: H, pxPerMm: img.pxPerMm, jpeg: drawn });
    let result;
    try {
      result = await this.runAnalysis(img, turn);
    } catch (e) {
      if (this.workerBroken && !base.retried?.has(i)) {
        // Worker が途中で止まった(画像は渡してしまった): この画面で調べ直す
        (base.retried ||= new Set()).add(i);
        return this.analyzePageNow(base, i, { force });
      }
      throw e;
    }
    const { scan, preview } = result;
    scan.transform = viewport.transform.slice();
    scan.pure = !!info?.pureImage;
    if (scan.turned) {
      // 横に置いたページを 90° 回した画像の座標 → ページの座標の変換
      for (const dir of ["cw", "ccw"]) {
        const frame = scan.turned[dir];
        frame.transform = composeTransform(turnMatrix(scan.width, scan.height, dir), scan.transform);
        frame.pure = scan.pure;
      }
    }
    base.scans[i] = scan;
    base.previews[i] = preview;
    return scan;
  }

  /**
   * 画像を調べる(Worker で。Worker が使えなければ、この画面で)。
   * @returns {Promise<{scan:object, preview:object}>}
   */
  async runAnalysis(img, turn = true) {
    if (this.workerBroken !== true) {
      try {
        if (!this.worker) {
          this.worker = new Worker(new URL("./scan-worker.js", import.meta.url), { type: "module" });
          this.workerJobs = new Map();
          this.workerSeq = 0;
          this.worker.onmessage = ({ data }) => {
            const job = this.workerJobs.get(data.id);
            this.workerJobs.delete(data.id);
            if (data.error) {
              job?.reject(new Error(data.error));
            } else {
              job?.resolve(data);
            }
          };
          this.worker.onerror = e => {
            this.workerBroken = true;
            for (const job of this.workerJobs.values()) {
              job.reject(new Error(e?.message || "Worker のエラー"));
            }
            this.workerJobs.clear();
          };
        }
        const id = ++this.workerSeq;
        const result = await new Promise((resolve, reject) => {
          this.workerJobs.set(id, { resolve, reject });
          const buffer = img.gray.buffer;
          this.worker.postMessage(
            { id, gray: buffer, width: img.width, height: img.height, pxPerMm: img.pxPerMm, previewWidth: PREVIEW_WIDTH, turn },
            [buffer]
          );
        });
        return { scan: result.scan, preview: result.preview };
      } catch (e) {
        console.warn("[製本ビューア] スキャンを調べる Worker が使えないため、この画面で調べます", e);
        this.workerBroken = true;
        if (!img.gray.byteLength) {
          throw e; // 画像を Worker に渡してしまった(呼び出し側で調べ直す)
        }
      }
    }
    const scan = analyzeFull(img, { turn });
    return { scan, preview: shrinkGray(img.gray, img.width, img.height, PREVIEW_WIDTH) };
  }

  /**
   * 全部のページを調べる(0.8.2: まだ調べていないページを、そのつど「いま見ているページのまわり」から調べる。ページを移動したら、移動先のまわりを先に調べる)。
   * @param {(done:number, total:number) => void} [onProgress] done: 調べたページの数
   * @returns {Promise<boolean>} やめた(ほかの PDF を開いた)ときは false
   */
  async analyzeAll(base, onProgress = null) {
    if (base.analyzed) {
      return true;
    }
    if (!(await this.prepareSource(base))) {
      throw new Error("PDF を読み込めませんでした");
    }
    const total = base.pageCount;
    base.cancel = false;
    // 0.8.2: 次に調べるページは、そのつど「いま見ているページのまわり」で選び直す。
    // ページを移動したら移動先のまわりを先に調べるので、動いているページの表示がすぐ整う
    while (true) {
      if (!this.alive(base)) {
        return false;
      }
      if (base.cancel) {
        // 途中でやめた(整え方のダイアログを閉じた)。調べたページの結果は残す
        base.cancel = false;
        return false;
      }
      const i = this.analysisOrder(base).find(idx => !base.scans[idx]);
      if (i === undefined) {
        break;
      }
      this.debugNote(`ページ ${i + 1} を調べます`);
      await this.analyzePage(base, i);
      onProgress?.(base.scans.filter(Boolean).length, total);
    }
    if (!base.checked) {
      base.kind = classifyDocument(base.scans);
      base.checked = true;
    }
    base.analyzed = true;
    // 調べるために開いた文書は手放す(pdf-lib の読み込みは、最初に PDF を作るときに使う)
    if (base.analysisDoc) {
      base.analysisDoc.destroy().catch(() => {});
      base.analysisDoc = null;
    }
    return true;
  }

  /**
   * 整え方から、作るページを決める。
   * @param {{partial?:boolean}} [o] partial: 調べていないページを「そのまま入れる項目」(pending: true)として組み込む(0.8 部分表示)。
   * @returns {{pages:Array<{src:number, scan:number, half:string|null, rect:number[]|null, rectPx:number[]|null, rotate:number,
   *   masks:number[][], masksPx:number[][], angle:number, matrix:number[]|null, turn?:string|null, pending?:true}>,
   *   complete:boolean}|{pages:Array, complete:false, pendingAll:true}|{error:string}}
   *   complete: 全部の元のページを調べて決めたか(部分のときは false)/ pendingAll: 構成を決めるのに全部の解析が要る
   *   (まだ調べていないページがある。冊子の並べ替えなど)/ angle: 直す傾き(度。0 なら直さない)/
   *   matrix: 傾きを直す変換(PDF の cm)/ turn: 横に置いた見開きを回した向き
   */
  plan(options, base = this.base, { partial = false } = {}) {
    const complete = base.scans.length >= base.pageCount && base.scans.every(Boolean);
    // 構成「元のまま」で、補正も無い: 元のスキャンをそのまま並べる(プレビュー用。表示への切り替えは restore() で行う)
    if (options.mode === "none" && !options.deskew && !options.trim) {
      const pages = base.scans.map((s, i) => ({
        src: i,
        scan: i,
        half: null,
        rotate: 0,
        rectPx: null,
        rect: null,
        masksPx: [],
        masks: [],
        angle: 0,
        matrix: null,
        ...(partial && !s ? { pending: true } : {}),
      }));
      return { pages, complete };
    }
    // 横に置いてスキャンした見開きは、回した画像で調べた結果を使う
    const turn = resolveTurn(options, base.scans);
    const turnDeg = turn === "cw" ? 90 : turn === "ccw" ? 270 : 0;
    const raw = turn === "none" ? base.scans : base.scans.map(s => (s?.turned ? s.turned[turn] : s));
    // 傾きを直すときは、まっすぐにした画像で調べた結果(分ける位置・余白の範囲)を使う
    const scans = options.deskew ? raw.map(s => (s?.deskewed ? { ...s.deskewed, transform: s.transform, pure: s.pure } : s)) : raw;
    // 「まだ調べていない」ページの項(元のスキャンをそのまま入れる。部分表示。0.8)
    const pendingEntry = i => ({
      src: i,
      scan: i,
      half: null,
      rotate: 0,
      rectPx: null,
      rect: null,
      masksPx: [],
      masks: [],
      angle: 0,
      matrix: null,
      pending: true,
    });
    let order;
    if (options.mode === "none") {
      // 補正だけ: 傾きをまっすぐにする(検出した角度か、指定した角度)・余白を除く
      if (options.deskew) {
        const found = base.scans.some(s => s && pageAngle(s, options));
        if (!found && !complete && !base.scans.length) {
          // まだ何も調べていない: 残りを調べてから(部分では作れない)
          return { pages: [], complete: false, pendingAll: true };
        }
        if (!found && !complete) {
          // 調べたページには直す傾きが無い(残りのページにも無いとは限らない)
          return { pages: [], complete: false, pendingAll: true };
        }
        if (!found && complete) {
          return { error: "noskew" };
        }
      }
      const rects = options.trim ? cropSingles(scans) : null;
      if (options.trim) {
        if (complete && !rects.some(Boolean)) {
          return { error: "notrim" };
        }
        if (!complete && !rects.some(Boolean)) {
          // 調べたページに余白の除けるものが無い(残りを調べてから。部分では作れない)
          return { pages: [], complete: false, pendingAll: true };
        }
        order = rects.map((r, i) => ({ scan: i, half: null, rect: r, masks: [], rotate: 0 }));
      } else {
        order = base.scans.map((s, i) => ({ scan: i, half: null, rect: null, masks: [], rotate: 0 }));
      }
    } else {
      const kind = options.mode === "booklet" ? "sheets" : "spread";
      // 冊子の並べ替えは、全部の紙の順を調べてから決める(部分では決められない)
      if (partial && !complete && options.mode === "booklet") {
        return { pages: [], complete: false, pendingAll: true };
      }
      const splits = chooseSplits(scans, kind);
      if (complete && !splits.some(Boolean)) {
        return { error: "empty" };
      }
      if (!splits.some(Boolean)) {
        // 調べたページに分けられるものが無い(残りを調べてから。部分では作れない)
        return { pages: [], complete: false, pendingAll: true };
      }
      const halves = scans.map((s, i) => (splits[i] ? halvesFor(s, splits[i]) : null));
      const rects = cropRects(scans, splits, halves, { trim: options.trim });
      if (options.mode === "booklet") {
        const r = orderBooklet(rects, options);
        if (!r.pages) {
          return { error: r.error };
        }
        order = r.pages;
      } else {
        order = orderSpread(rects, options.direction, options.reverse);
      }
    }
    return {
      complete,
      pages: order.map(o => {
        const raws = raw[o.scan];
        if (!raws) {
          // 調べていないページは、元のスキャンをそのまま入れる(部分表示の項。0.8)
          return pendingEntry(o.scan);
        }
        if (options.mode === "none") {
          // 補正だけ: 分けないページの、傾き・余白を直す
          const scanRaw = base.scans[o.scan];
          const angle = pageAngle(scanRaw, options);
          return {
            src: o.scan,
            scan: o.scan,
            half: null,
            angle,
            matrix: angle ? deskewMatrix(scanRaw.transform, scanRaw.width, scanRaw.height, angle) : null,
            rotate: 0,
            turn: null,
            rectPx: o.rect,
            rect: o.rect ? toPdfRect(scans[o.scan].transform, o.rect) : null,
            masksPx: o.masks || [],
            masks: (o.masks || []).map(m => toPdfRect(scans[o.scan].transform, m)),
          };
        }
        const phi0 = options.deskew && raws?.deskewed ? raws.skew.angle : 0;
        const resid = options.deskew ? pageResidual(raws, o, phi0) : null;
        const angle = phi0 + (resid ? resid.angle : 0);
        const turned = turnDeg && base.scans[o.scan]?.turned && o.rect ? turnDeg : 0;
        return {
          src: o.scan,
          scan: o.scan,
          half: o.half,
          angle,
          matrix: angle ? deskewMatrix(raws.transform, raws.width, raws.height, phi0, resid) : null,
          rotate: ((o.rotate || 0) + turned) % 360,
          turn: turned ? turn : null,
          rectPx: o.rect,
          rect: o.rect ? toPdfRect(scans[o.scan].transform, o.rect) : null,
          masksPx: o.masks || [],
          masks: (o.masks || []).map(m => toPdfRect(scans[o.scan].transform, m)),
        };
      }),
    };
  }

  /** いま見ているページの、元のスキャンでの番号(0始まり) */
  currentSourcePage() {
    const page = this.app.page || 1;
    if (this.isArranged) {
      return this.arranged.pages[page - 1]?.src ?? 0;
    }
    return Math.max(0, sourceIndex(this.app.pdfDocument, page));
  }

  /**
   * 整えて表示する。
   * @param {object} options 整え方
   * @param {{auto?:boolean, remember?:boolean, fromStart?:boolean, partial?:boolean}} [o] auto: 開いたときに自動で /
   *   remember: この PDF の整え方として覚える / fromStart: いま見ているページではなく、本の最初のページから表示する /
   *   partial: 全部を調べていないとき、いまのページのまわりだけ整えて表示して(0.8)、残りは表示しながら調べる(冊子の並べ替えは除く)
   * @returns {Promise<boolean>}
   */
  async arrange(options, { auto = false, remember = !auto, fromStart = false, partial = true, force = false } = {}) {
    const base = this.base;
    options = normalizeOptions(options);
    // force: ダイアログを開いたときに始めた解析が続いているとき(busyArrange でない)にも適用する
    if (!base || !options || (this.state === "busy" && this.busyArrange && !force)) {
      return false;
    }
    if (options.mode === "none" && !options.deskew && !options.trim) {
      // 元のまま表示(構成の「行わない」。補正の指定が無いもの)
      await this.restore({ remember });
      return true;
    }
    if (this.pageEditor.dirty) {
      // 開いたときの自動の整えは、その間に書き込みなどを始めていたら行わない(ボタンで知らせるだけ)
      if (auto) {
        this.setState("suggest");
        return false;
      }
      if (!(await this.pageEditor.guard("スキャンを整える"))) {
        return false;
      }
    }
    this.busyArrange = true; // 組み立て(調べる・作る・開く)に入る。ダイアログからの再適用(force)以外は受けない
    this.debugNote(auto ? "開いたときの自動の整えを始めます" : "整え方を適用します");
    const before = this.state;
    this.setState("busy", "調べています…");
    this.suggestToast?.();
    this.suggestToast = null;
    this.busyToast?.();
    this.busyToast = auto ? this.toast.show("スキャンを整えています…", { duration: 0 }) : null;
    try {
      // 0.6.7: 保存しておいた整えの結果(計画と出来上がりの PDF)で済むときは、もう調べ直さない
      const fromCache = await this.cachedArrange(options, base, { auto, remember, fromStart });
      if (fromCache !== null) {
        return fromCache;
      }
      if (base.finishJob) {
        // 先ほどの整え(残りのページを調べて組み直すところ)をやめてから、新しい整え方で進める
        // (調べた結果を、異なる整え方に混ぜないため)
        base.cancel = true;
        await base.finishJob.catch(() => {});
        if (!this.alive(base)) {
          return false;
        }
      }
      // 0.8: 全部のページを調べるのを待たず、いまのページのまわりだけ整えて表示を始める
      // (冊子の並べ替えは、紙の順が全部分からないと決められないので除く)
      if (partial && !base.analyzed && options.mode !== "booklet") {
        base.key ||= await this.ensureKey(base);
        const current = this.analysisOrder(base)[0];
        try {
          await this.analyzePage(base, current);
        } catch (e) {
          console.warn("[製本ビューア] ページを調べられなかったため、全部を調べてから整えます", e);
        }
        if (!this.alive(base)) {
          return false;
        }
        const plan = this.plan(options, base, { partial: true });
        if (
          plan.error === undefined &&
          plan.complete === false &&
          plan.pages?.length &&
          plan.pages.some(p => !p.pending)
        ) {
          // 近いページで整えた表示に切り替えて(保存はしない)、残りは表示しながら調べる
          const ok = await this.presentPartial(base, options, plan.pages, { fromStart });
          if (!ok) {
            return false;
          }
          await this.finishPartial(options, base, { fromStart, remember });
          return true;
        }
        // 部分の計画が作れないときは、いつもの道(全部調べてから整える)へ進む
      }
      if (!base.analyzed) {
        const ok = await this.analyzeAll(base, (done, total) => {
          const text = `スキャンを調べています(${done}/${total})…`;
          this.setState("busy", text);
          this.busyToast?.update?.(text);
        });
        if (!ok) {
          return false;
        }
      }
      base.key ||= await this.ensureKey(base);
      const plan = this.plan(options, base);
      if (plan.error) {
        this.toast.show(PLAN_ERRORS[plan.error] || PLAN_ERRORS.mapping, { kind: "error", duration: 9000 });
        this.setState(before === "busy" ? "suggest" : before);
        return false;
      }
      this.setState("busy", "PDF を作っています…");
      this.busyToast?.update?.("PDF を作っています…");
      const id = await arrangedId(this.plannedSeed(base, options));
      // 調べるのに読み込んだ pdf-lib の文書があれば、作るのに使う(読み直さずに済む。作ると中身が変わるので、使うのは1回だけ)
      const pdf = base.source?.pdf || null;
      base.source = null;
      const bytes = await buildArrangedPdf(base.plain, plan.pages, { id, pdf });
      if (!this.alive(base)) {
        return false;
      }
      return await this.presentArranged(base, options, plan.pages, bytes, { auto, remember, fromStart });
    } catch (e) {
      console.error("[製本ビューア] スキャンを整えられませんでした", e);
      this.toast.show(`スキャンを整えられませんでした(${e?.message || e})`, { kind: "error", duration: 9000 });
      if (this.alive(base) && this.state === "busy") {
        this.setState(this.isArranged ? "arranged" : base.kind ? "suggest" : "none");
      }
      return false;
    } finally {
      this.busyArrange = false;
      this.busyToast?.();
      this.busyToast = null;
    }
  }

  /** 整えた PDF の ID の種(0.6.7)。0.8 からは、元の PDF・整え方・元のページ数で決める(解析の進み具合で変わらない) */
  plannedSeed(base, options) {
    return `${base.key}|${SCAN_CACHE_SCHEMA}|${signature(options)}|${base.pageCount}`;
  }

  /**
   * 部分の計画(0.8)で、いったん表示する。保存はしない(完成版を出したときに保存する)。
   * @returns {Promise<boolean>} 開けたら true
   */
  async presentPartial(base, options, pages, { fromStart = false } = {}) {
    this.debugNote(`部分表示に切り替えます(解析できている ${pages.filter(p => !p.pending).length} ページ)`);
    this.setState("busy", "PDF を作っています…");
    this.busyToast?.update?.("PDF を作っています…");
    try {
      const id = await arrangedId(this.plannedSeed(base, options));
      // 調べるのに読み込んだ pdf-lib の文書があれば、作るのに使う(読み直さずに済む。作ると中身が変わるので、使うのは1回だけ)
      const pdf = base.source?.pdf || null;
      base.source = null;
      const bytes = await buildArrangedPdf(base.plain, pages, { id, pdf });
      if (!this.alive(base)) {
        return false;
      }
      return await this.presentArranged(base, options, pages, bytes, { auto: true, remember: false, fromStart, partial: true });
    } catch (e) {
      console.warn("[製本ビューア] まわりのページだけでは整えられなかったため、全部を調べてから整えます", e);
      return false;
    }
  }

  /**
   * 部分表示(0.8)のあと、残りのページを調べ、完成版を作り直して開く(表示しながら・裏で)。
   * その間に元に戻す・別の整え方を選んだときは、組み直さずにやめる(結果を混ぜないため)。
   */
  async finishPartial(options, base, { fromStart = false, remember = true } = {}) {
    const job = (async () => {
      this.debugNote("残りのページを、表示しながら裏で調べます");
      const note = this.toast.show("残りのページも調べています…", { duration: 0 });
      try {
        let ok = false;
        try {
          // 調べる進みを聞き手(ダイアログ・ボタン)に知らせる(状態は部分表示のまま)
          ok = await this.analyzeAll(base, () => this.emit());
        } finally {
          note?.();
        }
        if (!ok || !this.alive(base)) {
          return; // やめた(ほかの PDF を開いた・調べるのをやめた)
        }
        if (!this.isArranged || this.arranged?.options !== options || !this.arranged?.partial) {
          return; // その間に元に戻した、または別の整え方を選んだ
        }
        const plan = this.plan(options, base);
        if (plan.error) {
          console.warn(`[製本ビューア] 残りのページを調べたところ、この整え方は使えませんでした(${plan.error})`);
          return;
        }
        this.debugNote("全ページの解析が終わりました。組み直します");
        if (this.pageEditor.dirty) {
          // 開いたままで編集が始まっていたら、開き直さない(いまの表示のまま。結果だけ保存しておく)
          try {
            await putScanPlan(scanPlanKey(base.key, signature(options)), plan.pages, base.pageCount, true);
          } catch (e) {
            console.warn("[製本ビューア] 整えた結果を保存しておけませんでした", e);
          }
          if (remember) {
            base.choice = options;
            await storeChoice(base.key, options);
          }
          this.toast.show("全部のページを調べ終えました。もう一度「整え方…」を選ぶと、全部のページで整えて表示します", {
            duration: 9000,
          });
          return;
        }
        // 前に開いた文書のページの描画が終わってから、開き直す(PDF.js とのデータの受け渡しが途切れないように)
        try {
          await this.app.pdfViewer?.pagesPromise;
        } catch {
          // 描画の待ち合わせができないときは、そのまま進む
        }
        const id = await arrangedId(this.plannedSeed(base, options));
        const bytes = await buildArrangedPdf(base.plain, plan.pages, { id });
        if (!this.alive(base) || !this.isArranged || this.arranged?.options !== options) {
          return;
        }
        base.source = null;
        await this.presentArranged(base, options, plan.pages, bytes, { auto: true, remember, fromStart, partial: false });
      } catch (e) {
        console.warn("[製本ビューア] 残りのページを調べて組み直すところでエラー", e);
      } finally {
        if (base.finishJob === job) {
          base.finishJob = null;
        }
      }
    })();
    base.finishJob = job;
    job.catch(() => {});
    await job;
    if (base.finishJob === job) {
      base.finishJob = null;
    }
  }

  /**
   * 保存しておいた整えの結果で開く(0.6.7)。
   * 使えたら true / 使えなかった(保存が無い・中身が合わない)ときは null(いつもの道で調べ直す)
   * @returns {Promise<boolean|null>}
   */
  async cachedArrange(options, base, { auto = false, remember = false, fromStart = false } = {}) {
    try {
      if (!(await this.ensureKey(base))) {
        return null;
      }
      const sig = signature(options);
      const rec = await getScanPlan(scanPlanKey(base.key, sig));
      const pages = validCachedPages(rec?.pages, base.pageCount);
      if (!rec || !pages || rec.complete === false) {
        if (rec) {
          // 中身が変わっていた(スキャンの判定の版が新しくなった・計画が壊れている・部分の計画)ので捨てる
          await deleteScanPlan(scanPlanKey(base.key, sig));
        }
        return null;
      }
      // 出来上がりの PDF も保存しておいてあるときだけ、組み直しも飛ばせる
      const id = await arrangedId(this.plannedSeed(base, options));
      const bytes = await getScanCache(id);
      if (!bytes) {
        return null;
      }
      if (!this.alive(base)) {
        return null;
      }
      // 組み直しに使う pdf-lib の文書はもう要らない(開いた文書の記憶(元に戻す)には使わない)
      base.source = null;
      const text = "保存しておいた整えを開いています…";
      this.setState("busy", text);
      this.busyToast?.update?.(text);
      let opened = false;
      try {
        opened = await this.presentArranged(base, options, pages, bytes, { auto, remember, fromStart, fromCache: true });
      } catch {
        opened = false;
      }
      if (opened) {
        return true;
      }
      // できた PDF が壊れていたりすると起こる。保存しておいたものを捨てて、いつもの道で作り直す
      await deleteScanPlan(scanPlanKey(base.key, sig));
      await deleteScanCache(id);
      return null;
    } catch (e) {
      console.warn("[製本ビューア] 保存しておいた整えが使えないため、調べ直します", e);
      return null;
    }
  }

  /**
   * 整えた文書の表示への切り替えと、結果の保存(0.6.7)。
   * arrange() の後半。保存しておいてある計画で開くとき(cachedArrange())にも使う。
   * partial: 部分の計画(0.8)での表示 — 保存と「整え方として覚える」はせず、完成版を出したときにする
   * @param {Array<{src:number, rect:number[]|null, rotate:number, ...}>} pages 作るページ(順に)
   * @param {Uint8Array} bytes できた PDF
   * @returns {Promise<boolean>} 開けたら true。開けなければ false
   */
  async presentArranged(base, options, pages, bytes, { auto = false, remember = false, fromStart = false, fromCache = false, partial = false } = {}) {
    const sig = signature(options);
    const fileName = `${sanitizeFileName(base.baseName)}${fileNameSuffix(options) || ""}.pdf`;
    // いま見ているページに当たるページから表示する
    const viewing = !fromStart && (this.isArranged || this.app.pdfDocument === base.doc) ? this.currentSourcePage() : -1;
    const target = Math.max(1, pages.findIndex(p => p.src === viewing) + 1);
    this.arranged = { options, pages, fileName, key: `${base.key}#scan:${sig}`, doc: null, auto, size: bytes.length, partial };
    // 1ページ目でも指定する(PDF.js が前回見ていた位置に戻さないように。0.4.1)
    this.app.initialBookmark = `page=${target}`;
    // 0.5: 読む向きに合わせて、ビューアの綴じ方向を変える(右から左に読むなら右綴じ。設定は変えない)。
    // ページを分けない整え方(0.8「元のまま」)では、ページの並びが変わらないので変えない
    if (this.book && options.mode !== "none" && this.book.direction !== options.direction) {
      this.directionOverridden = true;
      this.directionChanging = true;
      try {
        this.book.setDirection(options.direction);
      } finally {
        this.directionChanging = false;
      }
    }
    // 見開きを分けたとき: 1ページ目が見開きの片側なら、元のスキャンと同じ組み合わせ(1-2、3-4…)で並ぶ「見開き」で表示する
    // (製本表示では1ページ目が表紙として単独になり、組み合わせが1つずれるため)。冊子は製本表示のまま
    if (this.book) {
      if (options.mode === "spread" && pages[0]?.half) {
        if (this.book.mode === "book") {
          this.modeBefore ??= "book";
          this.book.mode = "spread";
        }
      } else {
        this.restoreViewMode();
      }
    }
    const opened = await this.openDocument({
      data: bytes,
      filename: fileName,
      seihon: { current: base.current, arranged: { baseId: base.id, fileName, mode: options.mode }, key: this.arranged.key },
    });
    if (!opened) {
      // 開けなかった(エラーの表示は main.js が出す)
      this.arranged = null;
      this.setState("none");
      return false;
    }
    // 0.6.7: 保存しておく(次に開くときは、調べ直さない・作り直さない)。
    // 部分の計画(0.8)の表示は保存しない(完成版を出したときに保存する)
    try {
      if (!partial) {
        await putScanPlan(scanPlanKey(base.key, sig), pages, base.pageCount, true);
        if (!fromCache) {
          await putScanCache(await arrangedId(this.plannedSeed(base, options)), bytes, base.key);
        }
      }
    } catch (e) {
      console.warn("[製本ビューア] 整えた結果を保存しておけませんでした", e);
    }
    if (remember) {
      base.choice = options;
      await storeChoice(base.key, options);
    }
    return true;
  }

  afterArrangedLoaded(doc) {
    if (!this.arranged) {
      return;
    }
    this.arranged.doc = doc;
    this.setState("arranged");
    const { options, auto, partial } = this.arranged;
    const skewed = this.arranged.pages.filter(p => p.angle).length;
    if (partial) {
      // 0.8: 部分表示の途中(残りのページを調べて、すぐ組み直して開き直す)
      this.toast.show("近くのページだけ整えて表示しています(残りのページも調べています。終わりしだい、全部のページで整えます)", {
        duration: auto ? 9000 : 5000,
        actions: [
          { label: "元に戻す", onClick: () => this.restore({ remember: true }) },
          { label: "整え方…", onClick: () => this.openDialog?.() },
        ],
      });
      return;
    }
    const what =
      options.mode === "none"
        ? options.deskew
          ? `傾きをまっすぐにして表示しています(${skewed}ページ)${options.trim ? "(余白も除きました)" : ""}`
          : "余白を除いて表示しています"
        : options.turn !== "none" && this.arranged.pages.some(p => p.turn)
          ? `横に置いてスキャンした見開きを、回して1ページずつに分けて表示しています${options.trim ? "(余白も除きました)" : ""}${options.deskew && skewed ? "(傾きも直しました)" : ""}`
          : (options.mode === "booklet"
              ? "冊子を、表紙から順に並べ替えて表示しています"
              : options.trim
                ? "見開きを1ページずつに分け、余白を除いて表示しています"
                : "見開きを1ページずつに分けて表示しています") + (options.deskew && skewed ? `(傾きも直しました)` : "");
    this.toast.show(`${what}(画質は元のまま)`, {
      duration: auto ? 9000 : 5000,
      actions: [
        { label: "元に戻す", onClick: () => this.restore({ remember: true }) },
        { label: "整え方…", onClick: () => this.openDialog?.() },
      ],
    });
  }

  /**
   * 元のスキャンに戻す。
   * @param {{remember?:boolean}} [o] remember: この PDF では整えないことを覚える
   */
  async restore({ remember = false } = {}) {
    const base = this.base;
    if (!base) {
      return;
    }
    if (remember && base.key) {
      base.choice = normalizeOptions({ mode: "none" });
      await storeChoice(base.key, base.choice);
    }
    if (!this.isArranged) {
      this.setState(base.kind ? "suggest" : "none");
      return;
    }
    if (this.pageEditor.dirty && !(await this.pageEditor.guard("元のスキャンに戻す"))) {
      return;
    }
    if (!base.bytes) {
      // 元のデータがまだ取得していない(保存しておいた整えで開いていたときなど)
      try {
        base.bytes = await base.doc.getData();
      } catch (e) {
        console.warn("[製本ビューア] 元の PDF を読み込めなかったため、戻せません", e);
        this.setState(base.kind ? "suggest" : "none");
        return;
      }
    }
    const viewing = this.currentSourcePage();
    this.app.initialBookmark = viewing > 0 ? `page=${viewing + 1}` : null;
    this.restoreViewMode();
    this.arranged = null;
    this.setState("busy", "元に戻しています…");
    // PDF.js は渡したデータを Worker に移すので、写しを渡す(元のデータは、また整えるときに使う)
    const opened = await this.openDocument({
      data: base.bytes.slice(),
      filename: base.fileName,
      seihon: { current: { ...base.current, restoredFrom: base.id }, key: base.key },
    });
    if (!opened && this.alive(base) && this.state === "busy") {
      this.setState("none");
    }
  }

  afterOriginalLoaded(doc) {
    const base = this.base;
    if (!this.alive(base)) {
      return;
    }
    base.doc = doc;
    this.setState(base.kind ? "suggest" : "none");
    this.toast.show("元のスキャンを表示しています", { duration: 3500 });
  }

  /**
   * 整えたときに「見開き」にした表示モードを、元に戻す(その後で使う人が変えていなければ)。
   * 次に開く文書の初めの表示モードとして使われるよう、文書を開く前に呼ぶ。
   */
  restoreViewMode() {
    if (this.book && this.modeBefore && this.book.mode === "spread") {
      this.book.mode = this.modeBefore;
    }
    this.modeBefore = null;
  }

  /** 使う人がほかの PDF を開く前(main.js から呼ぶ) */
  beforeUserOpen() {
    this.restoreViewMode();
  }

  /** 綴じ方向を変えたとき: 整えて表示していれば、新しい向きで並べ直す */
  async onDirectionChanged(direction) {
    if (this.directionChanging || !this.isArranged || this.state === "busy" || this.arranged.options.mode === "none" || this.arranged.options.direction === direction) {
      return;
    }
    const ok = await this.arrange({ ...this.arranged.options, direction }, { remember: true });
    if (ok && direction === "rtl" && this.arranged?.options.mode === "spread" && !this.arranged.options.reverse) {
      // 0.4.1: 右綴じの本を、横書きの本と同じ向きにめくってスキャンしたものは、最後のページから始まる
      this.toast.show("右綴じの順に並べ直しました。最後のページから始まってしまうときは、ツールバーの「分割表示」→「ページの順を逆にする」を押してください", {
        duration: 9000,
        action: { label: "ページの順を逆にする", onClick: () => this.arrange({ ...this.arranged.options, reverse: true }, { remember: true, fromStart: true }) },
      });
    }
  }

  /** 整えた PDF を保存する(保存先を選ぶ) */
  async saveArranged() {
    if (!this.isArranged) {
      return;
    }
    const data = await this.app.pdfDocument.getData();
    const res = await saveBlobAs(new Blob([data], { type: "application/pdf" }), this.arranged.fileName);
    if (res.ok) {
      this.toast.show("整えた PDF を保存しました(画質は元のまま)", {
        duration: 6000,
        action: res.id ? { label: "フォルダを開く", onClick: () => chrome.downloads.show(res.id) } : undefined,
      });
    } else if (!res.canceled) {
      this.toast.show(`保存できませんでした(${res.error || "不明なエラー"})`, { kind: "error", duration: 8000 });
    }
  }

  /** 元の PDF を保存する(整えて表示しているとき) */
  async saveOriginal() {
    const base = this.base;
    if (!base?.bytes) {
      return;
    }
    const res = await saveBlobAs(new Blob([base.bytes], { type: "application/pdf" }), base.fileName);
    if (!res.ok && !res.canceled) {
      this.toast.show(`保存できませんでした(${res.error || "不明なエラー"})`, { kind: "error", duration: 8000 });
    }
  }

  /**
   * 整え方を選ぶ画面のために調べているのを、やめる(ダイアログを閉じたとき)。
   * 部分表示のあとに裏で続けている(0.8)・自動で整えている最中の調べるのはやめない
   * (整えた表示に必要な調べるうので、ダイアログの開閉に関係なく続ける)
   */
  cancelAnalysis() {
    if (this.base && this.state === "busy" && !this.arranged) {
      this.base.cancel = true;
      this.debugNote("解析をやめます");
    }
  }

  /**
   * 整え方を選ぶ画面のために、全部のページを調べる(まだなら)。
   * @returns {Promise<boolean>}
   */
  async ensureAnalyzed(onProgress) {
    const base = this.base;
    if (!base) {
      return false;
    }
    if (base.analyzed) {
      return true;
    }
    if (this.isArranged && !this.arranged?.partial) {
      // 整えた PDF(完成版)の表示中は、元のスキャンを調べ終えている(部分表示の途中は、まだ調べているページがある)
      return true;
    }
    // 部分表示(0.8)中は、状態を変えずに裏で調べを続ける(表示が「整えています…」に変わらないように)
    const trackState = this.state !== "arranged";
    if (trackState) {
      this.setState("busy", "調べています…");
    }
    let ok;
    try {
      ok = await this.analyzeAll(base, (done, total) => {
        if (trackState) {
          this.setState("busy", `スキャンを調べています(${done}/${total})…`);
        }
        onProgress?.(done, total);
      });
      if (ok) {
        await this.ensureKey(base);
      }
      return ok;
    } finally {
      if (trackState && this.alive(base) && this.state === "busy") {
        this.setState(this.isArranged ? "arranged" : base.kind ? "suggest" : "none");
      }
    }
  }
}
