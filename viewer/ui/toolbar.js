/**
 * Chrome 風ツールバーの基本部分:
 * タイトル、ページ番号、ズーム(− / % / +)、幅・ページに合わせる、回転、読み込み中の表示。
 *
 * 操作はすべて PDF.js の公開 API / イベントを通して行い、
 * 状態の表示は PDF.js のイベント(pagechanging, scalechanging など)で更新する。
 */

import { setIcon } from "../icons.js";

const MIN_ZOOM = 10; // %
const MAX_ZOOM = 1000; // %

export class Toolbar {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById("shToolbar");
    this.titleEl = document.getElementById("shTitle");
    this.pageInput = document.getElementById("shPageInput");
    this.pageCount = document.getElementById("shPageCount");
    this.zoomInput = document.getElementById("shZoomInput");
    this.fitButton = document.getElementById("shFit");
    /** 次に押したときに適用する合わせ方(Chrome と同じく、ボタンは「次の動作」を表示) */
    this.nextFit = "page-fit";
    this.loading = true;
    this.bind();
    this.setLoading(true);
    // 右側のボタンが増えて(「保存」など)中央のボタンに重なるときは、文字を省いて詰める
    this.endGroup = this.el.querySelector(".sh-end");
    this.centerGroup = document.getElementById("shCenter");
    new ResizeObserver(() => this.fitToWidth()).observe(this.el);
  }

  /**
   * ツールバーの右側が中央のボタン(ページ番号・倍率など)に重ならないよう、段階的に詰める。
   * 1: 「Chrome標準で開く」を記号だけに / 2: ほかの文字付きボタン(「保存」)も記号だけに /
   * 3: 書き込みのボタンを隠す / 4: 倍率の入力欄を隠す
   */
  fitToWidth() {
    const levels = ["sh-fit-1", "sh-fit-2", "sh-fit-3", "sh-fit-4"];
    this.el.classList.remove(...levels);
    for (const level of levels) {
      if (!this.endOverlapsCenter()) {
        return;
      }
      this.el.classList.add(level);
    }
  }

  endOverlapsCenter() {
    const center = this.centerGroup?.getBoundingClientRect();
    if (!center || !center.width) {
      return false;
    }
    let left = Infinity;
    for (const child of this.endGroup.children) {
      if (child.hidden || !child.offsetWidth) {
        continue;
      }
      left = Math.min(left, child.getBoundingClientRect().left);
    }
    return left !== Infinity && left < center.right + 12;
  }

  bind() {
    const { app } = this;
    const bus = app.eventBus;

    // ---- ページ番号 ----
    this.pageInput.addEventListener("pointerup", () => this.pageInput.select());
    this.pageInput.addEventListener("focus", () => this.pageInput.select());
    this.pageInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        this.commitPage();
        app.pdfViewer.focus?.();
      } else if (e.key === "Escape") {
        this.showPage();
        this.pageInput.blur();
      }
    });
    this.pageInput.addEventListener("change", () => this.commitPage());
    this.pageInput.addEventListener("blur", () => this.showPage());
    bus.on("pagechanging", () => this.showPage());
    bus.on("pagesinit", () => {
      this.showPage();
      this.showPageCount();
      this.fitToWidth();
    });
    bus.on("pagesloaded", () => this.showPageCount());
    // ページを削除・元に戻したら、ページ数と今のページ番号を出し直す(PDF.js が今のページを決め直した後で)
    bus.on("pagesedited", () =>
      setTimeout(() => {
        this.showPageCount();
        this.showPage();
      }, 0)
    );

    // ---- ズーム ----
    document.getElementById("shZoomOut").addEventListener("click", () => app.zoomOut());
    document.getElementById("shZoomIn").addEventListener("click", () => app.zoomIn());
    this.zoomInput.addEventListener("pointerup", () => this.zoomInput.select());
    this.zoomInput.addEventListener("focus", () => this.zoomInput.select());
    this.zoomInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        this.commitZoom();
        this.zoomInput.blur();
      } else if (e.key === "Escape") {
        this.showZoom();
        this.zoomInput.blur();
      }
    });
    this.zoomInput.addEventListener("blur", () => this.commitZoom());
    bus.on("scalechanging", () => this.showZoom());

    // ---- 幅・ページに合わせる ----
    this.fitButton.addEventListener("click", () => this.toggleFit());
    bus.on("scalechanging", ({ presetValue }) => {
      // 自分で合わせ方を指定したとき以外(ズーム等)は、ボタンを「ページに合わせる」に戻す
      if (presetValue === "page-fit") {
        this.setNextFit("page-width");
      } else if (presetValue === "page-width") {
        this.setNextFit("page-fit");
      } else if (!presetValue || !isNaN(Number(presetValue))) {
        this.setNextFit("page-fit");
      }
    });

    // ---- 回転(Chrome と同じく、ボタンは反時計回り) ----
    document.getElementById("shRotate").addEventListener("click", () => app.rotatePages(-90));

    // ---- タイトル ----
    bus.on("metadataloaded", () => this.updateTitle());
    bus.on("documentinit", () => this.updateTitle());

    // ---- 読み込み状態 ----
    bus.on("pagesinit", () => this.setLoading(false));
    bus.on("documenterror", () => this.setLoading(false));
  }

  setLoading(loading) {
    this.loading = loading;
    this.el.classList.toggle("sh-loading", loading);
  }

  /** 文書が開かれていない状態にする */
  reset() {
    this.pageInput.value = "";
    this.pageCount.textContent = "0";
    this.zoomInput.value = "100%";
    this.titleEl.textContent = "";
    this.titleEl.title = "";
  }

  showPage() {
    if (document.activeElement === this.pageInput) {
      return;
    }
    const n = this.app.pdfViewer?.currentPageNumber || 0;
    const label = this.app.pdfViewer?.currentPageLabel;
    this.pageInput.value = label && label !== String(n) ? label : String(n || "");
  }

  showPageCount() {
    const count = this.app.pagesCount || 0;
    this.pageCount.textContent = String(count);
    this.el.style.setProperty("--sh-page-digits", String(Math.max(2, String(count).length)));
  }

  commitPage() {
    const viewer = this.app.pdfViewer;
    const value = this.pageInput.value.trim();
    if (!viewer || !this.app.pdfDocument || !value) {
      this.showPage();
      return;
    }
    // ページラベル(i, ii, … など)で指定された場合にも対応
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1 && n <= this.app.pagesCount) {
      viewer.currentPageNumber = n;
    } else {
      viewer.currentPageLabel = value;
    }
    this.showPage();
  }

  showZoom() {
    if (document.activeElement === this.zoomInput) {
      return;
    }
    const scale = this.app.pdfViewer?.currentScale || 1;
    this.zoomInput.value = `${Math.round(scale * 100)}%`;
  }

  commitZoom() {
    const viewer = this.app.pdfViewer;
    const raw = this.zoomInput.value.replace(/[%%\s]/g, "");
    const value = Number.parseFloat(raw);
    if (viewer && this.app.pdfDocument && Number.isFinite(value)) {
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
      if (Math.round(viewer.currentScale * 100) !== Math.round(clamped)) {
        viewer.currentScaleValue = String(clamped / 100);
      }
    }
    this.showZoom();
  }

  setNextFit(fit) {
    this.nextFit = fit;
    const label = fit === "page-fit" ? "ページに合わせる" : "幅に合わせる";
    setIcon(this.fitButton, fit === "page-fit" ? "fit-page-height" : "fit-page-width");
    this.fitButton.title = `${label} (Ctrl+\\)`;
    this.fitButton.setAttribute("aria-label", label);
  }

  toggleFit() {
    const viewer = this.app.pdfViewer;
    if (!viewer || !this.app.pdfDocument) {
      return;
    }
    const fit = this.nextFit;
    if (fit === "page-fit" && this.onFitPage) {
      // いちばん大きく見えているページを真ん中にして合わせる(book-layout.js)
      this.onFitPage();
    } else {
      viewer.currentScaleValue = fit;
    }
    this.setNextFit(fit === "page-fit" ? "page-width" : "page-fit");
  }

  updateTitle() {
    const { app } = this;
    let title = "";
    try {
      title = app._docTitle || "";
    } catch {
      title = "";
    }
    const filename = (() => {
      try {
        return app._docFilename || "";
      } catch {
        return "";
      }
    })();
    const shown = (title || filename || app._title || "").trim();
    this.titleEl.textContent = shown;
    this.titleEl.title = filename && title ? `${title}\n${filename}` : shown;
  }
}
