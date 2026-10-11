/**
 * スキャンの整え(0.3): スキャンした見開きを1ページずつに分ける・余白を除く・ばらした冊子を読む順に並べ替える。
 *
 * 流れ:
 *  1. PDF を開くと、横長のページの PDF なら最初の数ページを調べる(画像1枚だけのページか、ノドがあるか)。
 *  2. 本・ノートを開いてスキャンした見開きなら(詳細設定が「自動」のとき)、全部のページを調べ、
 *     整えた PDF を作って表示する。ばらした冊子のような平らな紙なら、ツールバーのボタンで知らせる。
 *  3. 整えた PDF は、元の画像をそのまま使って表示する範囲だけを変えたもの(scan-pages.js)。元の画質のまま。
 *     「元のスキャンに戻す」で元の PDF に戻せる。PDF ごとに選んだ整え方を覚えておき、次に開いたときも同じにする。
 *  元の PDF のファイルは変えない(整えた PDF は、保存を選んだときだけ新しいファイルとして保存する)。
 */

import { saveBlobAs, sanitizeFileName } from "../../common/files.js";
import { decryptedCopy } from "../doc-source.js";
import { loadPdfFromBytes } from "../page-export.js";
import { isRearranged, sourceIndex } from "../page-map.js";
import {
  analyzeScan,
  candidateHalves,
  chooseSplits,
  classifyDocument,
  cropRects,
  halvesFor,
  orderBooklet,
  orderSpread,
  shrinkGray,
  toGray,
} from "./scan-analysis.js";
import { ScanSource, arrangedId, buildArrangedPdf } from "./scan-pages.js";

/** PDF ごとに選んだ整え方(chrome.storage.local) */
const CHOICES_KEY = "scanChoices";
const MAX_CHOICES = 300;
/** 調べるときの画像の長辺(画素) */
const ANALYSIS_LONG_SIDE = 1100;
/** プレビューに使う小さな画像の幅(画素) */
const PREVIEW_WIDTH = 240;
/** 開いたときに調べる最初のページ数 */
const QUICK_PAGES = 4;
/** これより大きな PDF は、開いたときには調べない(メニューからは整えられる) */
const AUTO_LIMIT_BYTES = 400 * 1024 * 1024;

export const MODE_SUFFIX = Object.freeze({ spread: "_分割", booklet: "_並べ替え" });

// ---------------------------------------------------------------------------
// 整え方
// ---------------------------------------------------------------------------

/**
 * 整え方を検証する。
 * @returns {{mode:"spread"|"booklet"|"none", trim:boolean, direction:"ltr"|"rtl", sheetOrder:"outer"|"inner",
 *   firstSide:"outer"|"inner", flipBacks:boolean}|null}
 */
export function normalizeOptions(o) {
  if (!o || typeof o !== "object") {
    return null;
  }
  const mode = ["spread", "booklet", "none"].includes(o.mode) ? o.mode : null;
  if (!mode) {
    return null;
  }
  return {
    mode,
    trim: typeof o.trim === "boolean" ? o.trim : mode === "spread",
    direction: o.direction === "rtl" ? "rtl" : "ltr",
    sheetOrder: o.sheetOrder === "inner" ? "inner" : "outer",
    firstSide: o.firstSide === "inner" ? "inner" : "outer",
    flipBacks: !!o.flipBacks,
  };
}

/** 整え方を表す文字列(整えた PDF の ID と指紋に使う。同じ整え方なら同じ) */
function signature(o) {
  return [o.mode, o.trim ? 1 : 0, o.direction, o.sheetOrder, o.firstSide, o.flipBacks ? 1 : 0].join("|");
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

const idle = (timeout = 1500) =>
  new Promise(resolve => {
    if ("requestIdleCallback" in window) {
      requestIdleCallback(() => resolve(), { timeout });
    } else {
      setTimeout(resolve, 300);
    }
  });

const PLAN_ERRORS = {
  odd: "スキャンの枚数が奇数のため、冊子の順に並べ替えられません(両面スキャンした冊子なら偶数になります)。",
  unsplit: "縦長のページなど、2つに分けられないページがあるため、冊子の順に並べ替えられません。",
  mapping: "冊子の順に並べ替えられませんでした。",
  empty: "分けられるページがありませんでした。",
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
    this.base?.analysisDoc?.destroy().catch(() => {});
    this.base = null;
    this.arranged = null;
    this.busyToast?.();
    this.busyToast = null;
    this.suggestToast?.();
    this.suggestToast = null;
    this.setState("none");
    if (!doc) {
      return;
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

  /** 開いた PDF が、スキャンした見開き・冊子の紙かを調べる */
  async detect(base) {
    await idle();
    if (!this.alive(base)) {
      return;
    }
    const settings = this.getSettings();
    if (settings.scanArrange === "off" || !(await this.mostlyLandscape(base.doc)) || !this.alive(base)) {
      return;
    }
    const info = await base.doc.getDownloadInfo().catch(() => null);
    if ((info?.length || 0) > AUTO_LIMIT_BYTES) {
      return;
    }
    base.key = await this.docSource.key(base.doc);
    base.choice = await loadChoice(base.key);
    if (!this.alive(base) || !(await this.prepareSource(base))) {
      return;
    }
    const quick = [...Array(Math.min(base.pageCount, QUICK_PAGES)).keys()];
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
    if (!base.kind) {
      return;
    }
    const choice = base.choice;
    if (choice && choice.mode !== "none") {
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

  /** 整え方の初期値 */
  defaultOptions(kind = this.base?.kind) {
    const settings = this.getSettings();
    if (kind === "sheets") {
      return normalizeOptions({ mode: "booklet", trim: false, direction: this.getDirection() });
    }
    return normalizeOptions({ mode: "spread", trim: settings.scanTrim, direction: this.getDirection() });
  }

  /** いま選ばれている(または選ぶとよい)整え方 */
  currentOptions() {
    if (this.arranged) {
      return { ...this.arranged.options };
    }
    if (this.base?.choice && this.base.choice.mode !== "none") {
      return { ...this.base.choice, direction: this.getDirection() };
    }
    return this.defaultOptions();
  }

  /** pdf-lib で元の PDF を読み込む(暗号化されていれば、パスワード無しの写しを作って読む) */
  async prepareSource(base) {
    if (base.source) {
      return true;
    }
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
   * 元のデータから別に開いた文書を使う。
   */
  async analysisDoc(base) {
    if (base.analysisDoc) {
      return base.analysisDoc;
    }
    if (!isRearranged(base.doc)) {
      return base.doc;
    }
    base.analysisDoc = await loadPdfFromBytes(base.plain || (await base.doc.getData()));
    return base.analysisDoc;
  }

  /** 1ページを調べる(0始まり) */
  async analyzePage(base, i) {
    if (base.scans[i]) {
      return base.scans[i];
    }
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
      result = await this.runAnalysis(img);
    } catch (e) {
      if (this.workerBroken && !base.retried?.has(i)) {
        // Worker が途中で止まった(画像は渡してしまった): この画面で調べ直す
        (base.retried ||= new Set()).add(i);
        return this.analyzePage(base, i);
      }
      throw e;
    }
    const { scan, preview } = result;
    scan.transform = viewport.transform.slice();
    scan.pure = !!info?.pureImage;
    base.scans[i] = scan;
    base.previews[i] = preview;
    return scan;
  }

  /**
   * 画像を調べる(Worker で。Worker が使えなければ、この画面で)。
   * @returns {Promise<{scan:object, preview:object}>}
   */
  async runAnalysis(img) {
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
            { id, gray: buffer, width: img.width, height: img.height, pxPerMm: img.pxPerMm, previewWidth: PREVIEW_WIDTH },
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
    const scan = analyzeScan(img);
    scan.candidates = candidateHalves(img, scan);
    return { scan, preview: shrinkGray(img.gray, img.width, img.height, PREVIEW_WIDTH) };
  }

  /**
   * 全部のページを調べる。
   * @param {(done:number, total:number) => void} [onProgress]
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
    for (let i = 0; i < total; i++) {
      if (!this.alive(base)) {
        return false;
      }
      if (base.cancel) {
        // 途中でやめた(整え方のダイアログを閉じた)。調べたページの結果は残す
        base.cancel = false;
        return false;
      }
      if (!base.scans[i]) {
        await this.analyzePage(base, i);
      }
      onProgress?.(i + 1, total);
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
   * @returns {{pages:Array<{src:number, rect:number[]|null, rotate:number, scan:number, half:string|null}>}|{error:string}}
   */
  plan(options, base = this.base) {
    const scans = base.scans;
    const kind = options.mode === "booklet" ? "sheets" : "spread";
    const splits = chooseSplits(scans, kind);
    if (!splits.some(Boolean)) {
      return { error: "empty" };
    }
    const halves = scans.map((s, i) => (splits[i] ? halvesFor(s, splits[i]) : null));
    const rects = cropRects(scans, splits, halves, { trim: options.trim });
    let order;
    if (options.mode === "booklet") {
      const r = orderBooklet(rects, options);
      if (!r.pages) {
        return { error: r.error };
      }
      order = r.pages;
    } else {
      order = orderSpread(rects, options.direction);
    }
    return {
      pages: order.map(o => ({
        src: o.scan,
        scan: o.scan,
        half: o.half,
        rotate: o.rotate || 0,
        rectPx: o.rect,
        rect: o.rect ? toPdfRect(scans[o.scan].transform, o.rect) : null,
        masksPx: o.masks || [],
        masks: (o.masks || []).map(m => toPdfRect(scans[o.scan].transform, m)),
      })),
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
   * @param {{auto?:boolean, remember?:boolean}} [o] auto: 開いたときに自動で / remember: この PDF の整え方として覚える
   * @returns {Promise<boolean>}
   */
  async arrange(options, { auto = false, remember = !auto } = {}) {
    const base = this.base;
    options = normalizeOptions(options);
    if (!base || !options || this.state === "busy") {
      return false;
    }
    if (options.mode === "none") {
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
    const before = this.state;
    this.setState("busy", "調べています…");
    this.suggestToast?.();
    this.suggestToast = null;
    this.busyToast?.();
    this.busyToast = auto ? this.toast.show("スキャンを整えています…", { duration: 0 }) : null;
    try {
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
      base.key ||= await this.docSource.key(base.doc);
      const plan = this.plan(options, base);
      if (plan.error) {
        this.toast.show(PLAN_ERRORS[plan.error] || PLAN_ERRORS.mapping, { kind: "error", duration: 9000 });
        this.setState(before === "busy" ? "suggest" : before);
        return false;
      }
      this.setState("busy", "PDF を作っています…");
      this.busyToast?.update?.("PDF を作っています…");
      const sig = signature(options);
      const id = await arrangedId(`${base.key}|${sig}|${plan.pages.length}`);
      // 調べるのに読み込んだ pdf-lib の文書があれば、作るのに使う(読み直さずに済む。作ると中身が変わるので、使うのは1回だけ)
      const pdf = base.source?.pdf || null;
      base.source = null;
      const bytes = await buildArrangedPdf(base.plain, plan.pages, { id, pdf });
      if (!this.alive(base)) {
        return false;
      }
      const fileName = `${sanitizeFileName(base.baseName)}${MODE_SUFFIX[options.mode]}.pdf`;
      // いま見ているページに当たるページから表示する
      const viewing = this.isArranged || this.app.pdfDocument === base.doc ? this.currentSourcePage() : 0;
      const target = Math.max(1, plan.pages.findIndex(p => p.src === viewing) + 1);
      this.arranged = { options, pages: plan.pages, fileName, key: `${base.key}#scan:${sig}`, doc: null, auto, size: bytes.length };
      this.app.initialBookmark = target > 1 ? `page=${target}` : null;
      // 見開きを分けたとき: 1ページ目が見開きの片側なら、元のスキャンと同じ組み合わせ(1-2、3-4…)で並ぶ「見開き」で表示する
      // (製本表示では1ページ目が表紙として単独になり、組み合わせが1つずれるため)。冊子は製本表示のまま
      if (this.book) {
        if (options.mode === "spread" && plan.pages[0]?.half) {
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
      if (remember) {
        base.choice = options;
        await storeChoice(base.key, options);
      }
      return true;
    } catch (e) {
      console.error("[製本ビューア] スキャンを整えられませんでした", e);
      this.toast.show(`スキャンを整えられませんでした(${e?.message || e})`, { kind: "error", duration: 9000 });
      if (this.alive(base) && this.state === "busy") {
        this.setState(this.isArranged ? "arranged" : base.kind ? "suggest" : "none");
      }
      return false;
    } finally {
      this.busyToast?.();
      this.busyToast = null;
    }
  }

  afterArrangedLoaded(doc) {
    if (!this.arranged) {
      return;
    }
    this.arranged.doc = doc;
    this.setState("arranged");
    const { options, auto } = this.arranged;
    const what =
      options.mode === "booklet"
        ? "冊子を、表紙から順に並べ替えて表示しています"
        : options.trim
          ? "見開きを1ページずつに分け、余白を除いて表示しています"
          : "見開きを1ページずつに分けて表示しています";
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
    if (!opened && this.state === "busy") {
      this.setState("none");
    }
  }

  afterOriginalLoaded(doc) {
    const base = this.base;
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
    if (!this.isArranged || this.state === "busy" || this.arranged.options.direction === direction) {
      return;
    }
    await this.arrange({ ...this.arranged.options, direction }, { remember: true });
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

  /** 整え方を選ぶ画面のために調べているのを、やめる(ダイアログを閉じたとき) */
  cancelAnalysis() {
    if (this.base && this.state === "busy" && !this.arranged) {
      this.base.cancel = true;
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
    if (this.isArranged) {
      // 整えた PDF の表示中は、元のスキャンを調べ終えている
      return true;
    }
    this.setState("busy", "調べています…");
    try {
      const ok = await this.analyzeAll(base, (done, total) => {
        this.setState("busy", `スキャンを調べています(${done}/${total})…`);
        onProgress?.(done, total);
      });
      if (ok) {
        base.key ||= await this.docSource.key(base.doc);
      }
      return ok;
    } finally {
      if (this.alive(base) && this.state === "busy") {
        this.setState(this.isArranged ? "arranged" : base.kind ? "suggest" : "none");
      }
    }
  }
}
