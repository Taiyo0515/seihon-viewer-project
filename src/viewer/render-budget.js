/**
 * 描画結果のメモリ上限。
 *
 * PDF.js は表示中のページと前後数ページだけを描画し、描画済みのページを
 * 最大10ページ程度まで保持する(古いものから破棄する LRU)。
 * ただし拡大表示や巨大なスキャンページでは1ページの描画結果が数十〜百MBになるため、
 * ここでは「描画済みページの合計メモリ」にも上限を設け、超えたら
 * 画面に見えていない古いページから描画結果を捨てる(見えたときに描き直す)。
 */

const DEFAULT_BUDGET_MB = 512;

function canvasBytes(canvas) {
  return canvas ? canvas.width * canvas.height * 4 : 0;
}

export class RenderBudget {
  constructor(app, budgetMB = DEFAULT_BUDGET_MB) {
    this.app = app;
    this.budget = budgetMB * 1024 * 1024;
    /** 描画した順(古い順)のページビュー */
    this.order = new Set();
    app.eventBus.on("pagerendered", ({ source, isDetailView }) => {
      const view = isDetailView ? source?.pageView || null : source;
      if (!view || !view.div) {
        return;
      }
      this.order.delete(view);
      this.order.add(view);
      this.enforce();
    });
  }

  reset() {
    this.order.clear();
  }

  bytesOf(view) {
    return canvasBytes(view.canvas) + canvasBytes(view.detailView?.canvas);
  }

  enforce() {
    let total = 0;
    for (const view of this.order) {
      total += this.bytesOf(view);
    }
    if (total <= this.budget) {
      return;
    }
    let visible = new Set();
    try {
      visible = new Set(this.app.pdfViewer._getVisiblePages().views.map(v => v.view));
    } catch {}
    for (const view of [...this.order]) {
      if (total <= this.budget) {
        break;
      }
      if (visible.has(view)) {
        continue;
      }
      const bytes = this.bytesOf(view);
      try {
        view.reset();
      } catch {}
      this.order.delete(view);
      total -= bytes;
    }
  }
}
