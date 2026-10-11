/**
 * 表示モード(製本表示・通常の見開き・単ページ)と綴じ方向の制御。
 *
 * PDF.js 標準の見開き機能を使う。
 *  - 製本表示   = PDF.js の「偶数ページから見開き」(1)(2,3)(4,5)…
 *  - 通常の見開き = PDF.js の「奇数ページから見開き」(1,2)(3,4)…
 *  - 単ページ   = 見開きなし(Chrome 標準と同じ縦1列)
 *
 * PDF.js は見開きの中でページを中央寄せにするため、単独で並ぶページ
 * (製本表示の表紙・偶数ページ数のときの裏表紙など)の隣に「空き枠」を入れて、
 * 本と同じ位置(左綴じなら表紙は右側)に来るようにしている。
 * 右綴じは見開きの中の並びを逆にする(CSS の direction: rtl)。
 */

export const VIEW_MODES = Object.freeze({
  book: { label: "製本表示", detail: "表紙は単独、2ページ目以降は見開き", spreadMode: 2, icon: "view-book" },
  spread: { label: "見開き", detail: "1-2、3-4…と2ページずつ", spreadMode: 1, icon: "view-spread" },
  single: { label: "単ページ", detail: "1ページずつ縦に並べる(Chrome標準と同じ)", spreadMode: 0, icon: "view-single" },
});

const SCROLL_VERTICAL = 0;
const SCROLL_PAGE = 3;

/**
 * 見開き表示では、PDF.js は「同じだけ見えているページ」のうち番号の小さい方(見開きの左)を現在のページにする。
 * そのため、ページ番号を入れたりサムネイル・しおりを押したりして見開きの右のページへ移動すると、
 * ツールバーの番号が1つ前に戻ってしまう。同じだけ見えているときは、今のページを優先するようにする
 * (スクロールして見えなくなれば、これまでどおり見えているページに変わる)。
 */
function preferCurrentPageInSpreads(viewer) {
  const original = viewer?._getVisiblePages;
  if (typeof original !== "function" || original.seihonPatched) {
    return;
  }
  const patched = function (...args) {
    const visible = original.apply(this, args);
    try {
      const views = visible?.views;
      if (this._spreadMode !== 0 && views?.length > 1) {
        const i = views.findIndex(v => v.id === this._currentPageNumber);
        if (i > 0 && Math.abs(views[i].percent - views[0].percent) <= 0.001) {
          const reordered = views.slice();
          reordered.unshift(...reordered.splice(i, 1));
          return { ...visible, views: reordered };
        }
      }
    } catch {
      // 並べ替えに失敗しても、PDF.js の結果をそのまま使えば表示には困らない
    }
    return visible;
  };
  patched.seihonPatched = true;
  viewer._getVisiblePages = patched;
}

const PRESET_SCALES = new Set(["auto", "page-fit", "page-width", "page-height"]);

/**
 * 「幅に合わせる」「ページに合わせる」「自動」を、いちばん幅の広い見開き(単ページの表示では、いちばん幅の広いページ)に合わせる。
 *
 * PDF.js は見開きでも「いま表示しているページの幅 × 2」に合わせるため、
 * ページの幅がそろっていない PDF(スキャンした本など)や、表紙だけ大きさが違う PDF では、
 * 幅に合わせても見開きが画面からはみ出し、横にずれて見えた。
 * ここでは全部の見開き(単独のページは隣の空き枠を含めた幅)のうち、いちばん広いものが収まる倍率にする。
 * 高さも、いちばん高いページが収まるようにする(「ページに合わせる」)。
 *
 * PDF.js の倍率の計算は「いまのページの幅・高さ」を1回だけ読むので、その1回だけ、
 * いちばん広い見開きの半分の幅(と、いちばん高いページの高さ)を返すようにして計算させる。
 */
function fitWidestSpread(viewer) {
  if (!viewer || viewer.seihonFitPatched) {
    return;
  }
  const proto = Object.getPrototypeOf(viewer);
  const desc = Object.getOwnPropertyDescriptor(proto, "currentScaleValue");
  if (!desc?.get || !desc?.set) {
    return;
  }
  viewer.seihonFitPatched = true;
  Object.defineProperty(viewer, "currentScaleValue", {
    configurable: true,
    enumerable: false,
    get() {
      return desc.get.call(this);
    },
    set(value) {
      const restore = PRESET_SCALES.has(value) ? shimCurrentPageSize(this) : null;
      try {
        desc.set.call(this, value);
      } finally {
        restore?.();
      }
    },
  });
}

/**
 * 倍率を計算するときの「いまのページの幅・高さ」の読み出しを1回だけ差し替える。
 * 見開き: いちばん広い見開きの半分の幅と、いちばん高いページの高さ / 単ページ: いちばん幅の広いページの幅
 */
function shimCurrentPageSize(viewer) {
  if (!viewer.pdfDocument || viewer.scrollMode !== SCROLL_VERTICAL || viewer.isInPresentationMode) {
    return null;
  }
  const pages = viewer._pages || [];
  const current = pages[viewer.currentPageNumber - 1];
  if (!current || !(current.scale > 0)) {
    return null;
  }
  // 倍率 1 のときの幅・高さ
  const w = pv => (pv?.width || 0) / (pv?.scale || 1);
  const h = pv => (pv?.height || 0) / (pv?.scale || 1);
  const once = (prop, value) => {
    Object.defineProperty(current, prop, {
      configurable: true,
      get() {
        delete current[prop];
        return value;
      },
    });
  };
  const restore = () => {
    // 読まれなかった(倍率の計算をしなかった)ときも、元に戻す
    for (const prop of ["width", "height"]) {
      if (Object.prototype.hasOwnProperty.call(current, prop)) {
        delete current[prop];
      }
    }
  };
  if (viewer.spreadMode === 0) {
    // 単ページ: Chrome 標準ビューアと同じく、いちばん幅の広いページに合わせる(高さは今のページのまま)
    const widest = Math.max(...pages.map(w));
    if (!(widest > 0) || Math.abs(widest - w(current)) < 0.5) {
      return null;
    }
    once("width", widest * current.scale);
    return restore;
  }
  const parity = viewer.spreadMode - 1; // PDF.js の見開きの区切り方と同じ
  let widest = 0;
  let tallest = 0;
  let group = [];
  const flush = () => {
    if (!group.length) {
      return;
    }
    let width = group.reduce((sum, pv) => sum + w(pv), 0);
    if (group.length === 1) {
      // 単独のページの隣には、隣のページと同じ大きさの空き枠を入れている(製本表示)
      const i = pages.indexOf(group[0]);
      width += w(pages[i === 0 ? 1 : i - 1] || group[0]);
    }
    widest = Math.max(widest, width);
    group = [];
  };
  for (let i = 0; i < pages.length; i++) {
    if (group.length && i % 2 === parity) {
      flush();
    }
    group.push(pages[i]);
    tallest = Math.max(tallest, h(pages[i]));
  }
  flush();
  if (!(widest > 0) || !(tallest > 0)) {
    return null;
  }
  once("width", (widest / 2) * current.scale);
  once("height", tallest * current.scale);
  return restore;
}

export class BookLayout {
  constructor(app) {
    this.app = app;
    preferCurrentPageInSpreads(app.pdfViewer);
    fitWidestSpread(app.pdfViewer);
    this.mode = "book";
    this.direction = "ltr";
    this.listeners = new Set();
    this.viewerEl = document.getElementById("viewer");
    this._scheduled = false;

    // PDF.js が見開きの DOM を組み直したら空き枠を付け直す
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(this.viewerEl, { childList: true });

    const bus = app.eventBus;
    bus.on("pagesinit", () => this.schedule());
    bus.on("rotationchanging", () => this.schedule());
    bus.on("spreadmodechanged", ({ mode }) => {
      // ⋮ メニュー以外(PDF.js 内部など)から変わった場合もモード表示を合わせる
      const entry = Object.entries(VIEW_MODES).find(([, v]) => v.spreadMode === mode);
      if (entry && entry[0] !== this.mode && !(entry[0] === "single" && this.mode === "single")) {
        this.mode = entry[0];
        this.emit();
      }
      this.schedule();
    });
    bus.on("scrollmodechanged", () => this.schedule());
    // 全部のページの大きさが分かったら・回転したら、「幅に合わせる」などの倍率を計算し直す
    // (PDF.js が中で計算し直すときは、いまのページだけで計算するため)
    bus.on("pagesloaded", () => {
      // 空き枠の大きさは隣のページに合わせているが、最初は全部のページが1ページ目の大きさで並ぶため、
      // 全部のページの大きさが分かったところで付け直す
      this.schedule();
      this.refit();
    });
    bus.on("rotationchanging", () => setTimeout(() => this.refit(), 0));
  }

  /** 「幅に合わせる」「ページに合わせる」「自動」のとき、全部のページの大きさで倍率を計算し直す */
  refit() {
    const viewer = this.app.pdfViewer;
    if (!viewer?.pdfDocument) {
      return;
    }
    const value = viewer.currentScaleValue;
    if (PRESET_SCALES.has(value)) {
      viewer.currentScaleValue = value;
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      fn(this.mode, this.direction);
    }
  }

  /** 文書を開く前に呼ぶ(PDF.js の初期表示オプションに反映) */
  applyInitialOptions(mode, direction) {
    this.mode = VIEW_MODES[mode] ? mode : "book";
    this.setDirection(direction, { silent: true });
    const options = window.PDFViewerApplicationOptions;
    options.set("spreadModeOnLoad", VIEW_MODES[this.mode].spreadMode);
    options.set("scrollModeOnLoad", SCROLL_VERTICAL);
    this.emit();
  }

  /** 表示モードを切り替える */
  setMode(mode) {
    if (!VIEW_MODES[mode]) {
      return;
    }
    this.mode = mode;
    const viewer = this.app.pdfViewer;
    if (viewer && this.app.pdfDocument) {
      if (viewer.scrollMode !== SCROLL_VERTICAL && viewer.scrollMode !== SCROLL_PAGE) {
        viewer.scrollMode = SCROLL_VERTICAL;
      }
      viewer.spreadMode = VIEW_MODES[mode].spreadMode;
      // 「幅に合わせる」等の指定は見開き幅に合わせて再計算させる
      const value = viewer.currentScaleValue;
      if (value && isNaN(Number(value))) {
        viewer.currentScaleValue = value;
      }
    }
    this.schedule();
    this.emit();
  }

  /** 綴じ方向を切り替える("ltr" 左綴じ / "rtl" 右綴じ) */
  setDirection(direction, { silent = false } = {}) {
    this.direction = direction === "rtl" ? "rtl" : "ltr";
    this.viewerEl.classList.toggle("sh-binding-rtl", this.direction === "rtl");
    this.schedule();
    if (!silent) {
      this.emit();
    }
  }

  schedule() {
    if (this._scheduled) {
      return;
    }
    this._scheduled = true;
    requestAnimationFrame(() => {
      this._scheduled = false;
      this.layout();
    });
  }

  /** 単独で並ぶページの隣に空き枠を入れる */
  layout() {
    const viewer = this.app.pdfViewer;
    this.viewerEl.classList.toggle("sh-mode-book", this.mode === "book");
    for (const ph of this.viewerEl.querySelectorAll(".sh-ph")) {
      ph.remove();
    }
    if (!viewer || !this.app.pdfDocument) {
      return;
    }
    const spreadMode = viewer.spreadMode;
    if (spreadMode === 0 || viewer.scrollMode === SCROLL_PAGE) {
      return;
    }
    const spreads = this.viewerEl.querySelectorAll(":scope > .spread");
    if (!spreads.length) {
      return;
    }
    const pages = viewer._pages || [];
    const sizeOf = pageNumber => pages[pageNumber - 1]?.div;
    for (const spread of spreads) {
      const pageDivs = spread.querySelectorAll(":scope > .page");
      if (pageDivs.length !== 1) {
        continue;
      }
      const div = pageDivs[0];
      const pageNumber = Number(div.dataset.pageNumber);
      if (!pageNumber) {
        continue;
      }
      // その位置に本来あるはずのページ(大きさを合わせるため)
      // 製本表示: 1ページ目(右側)の左隣=2ページ目、偶数の最終ページ(左側)の右隣=前のページ
      // 見開き  : 奇数の最終ページ(左側)の右隣=前のページ
      const isOddPage = pageNumber % 2 === 1;
      const pageOnRight = spreadMode === 2 ? isOddPage : !isOddPage;
      const neighbor = sizeOf(pageNumber === 1 ? 2 : pageNumber - 1) || div;
      const ph = document.createElement("div");
      ph.className = "sh-ph";
      ph.setAttribute("aria-hidden", "true");
      ph.style.width = neighbor.style.width;
      ph.style.height = neighbor.style.height;
      const unit = neighbor.style.getPropertyValue("--user-unit");
      if (unit) {
        ph.style.setProperty("--user-unit", unit);
      }
      if (pageOnRight) {
        spread.prepend(ph); // 空き枠を左(右綴じでは CSS で左右が逆になる)
      } else {
        spread.append(ph);
      }
    }
  }
}
