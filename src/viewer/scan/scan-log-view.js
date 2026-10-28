/**
 * 0.8.2: スキャンの整えの処理の様子を表示する(開発者向け)。
 * 詳細設定の「スキャンの処理の表示」がオンのときだけ、ビューアの右下に小さな枠を出して、
 * いま調べているページ・判定の結果・部分表示の進みを知らせる。
 * 中身は、スキャンの整え(ScanArranger)が debugNote() で書いた記録と、そのときの状態。
 */

import { onSettingsChanged } from "../../common/settings.js";

const KIND_TEXT = {
  spread: "見開きのスキャン",
  booklet: "ばらした冊子のスキャン",
  turned: "横に置いてスキャンした見開き",
  skewed: "傾いたスキャン",
  trim: "紙が余白の中に写っているもの",
};

export class ScanLogView {
  /**
   * @param {object} o
   * @param {object} o.arranger ScanArranger(onChange・debugLog・state・progress・arranged を持つ)
   * @param {() => object} o.getSettings
   */
  constructor({ arranger, getSettings }) {
    this.arranger = arranger;
    this.getSettings = getSettings;
    this.lineCount = 12;
    this.el = document.createElement("div");
    this.el.className = "sh-scan-log";
    document.body.appendChild(this.el);
    this.off = arranger.onChange(() => this.render());
    this.offSettings = onSettingsChanged(() => this.render());
    this.render();
  }

  /** 画面に描き直す(表示の切り替えもここで行う) */
  render() {
    const a = this.arranger;
    const shown = !!this.getSettings().scanDebugShow;
    this.el.hidden = !shown;
    if (!shown) {
      return;
    }
    const base = a.base;
    const done = base?.scans ? base.scans.filter(Boolean).length : 0;
    const total = base?.pageCount || 0;
    const kind = base?.kind ? `｜${KIND_TEXT[base.kind] || base.kind}` : "";
    const head = document.createElement("div");
    head.className = "sh-scan-log-head";
    head.textContent = `状態: ${this.stateText()}｜解析 ${done}/${total} ページ${kind}`;
    const list = document.createElement("div");
    list.className = "sh-scan-log-list";
    for (const item of (a.debugLog || []).slice(-this.lineCount)) {
      const line = document.createElement("div");
      line.className = "sh-scan-log-line";
      line.textContent = `${item.at} ${item.text}`;
      list.appendChild(line);
    }
    this.el.replaceChildren(head, list);
  }

  /** 状態の説明(1行) */
  stateText() {
    const a = this.arranger;
    const progress = a.progress ? ` - ${a.progress}` : "";
    switch (a.state) {
      case "none":
        return "何もしていません";
      case "suggest":
        return "整え方を待っています(ボタンからどうぞ)";
      case "busy":
        return `整えています${progress}`;
      case "arranged":
        return (a.arranged?.partial ? "部分表示しています" : "整えて表示しています") + progress;
      default:
        return `${a.state}${progress}`;
    }
  }
}
