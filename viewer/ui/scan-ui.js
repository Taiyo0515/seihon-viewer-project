/**
 * スキャンの整え(0.3)の画面: ツールバーのボタンと、整え方を選ぶダイアログ。
 */

import { normalizeOptions } from "../scan/scan-arranger.js";
import { PopupMenu } from "./popup.js";

const $ = id => document.getElementById(id);

/** ツールバーのボタン(スキャンの PDF のときだけ出る) */
export class ScanChip {
  /**
   * @param {object} o
   * @param {object} o.arranger ScanArranger
   * @param {object} o.dialog ScanDialog
   * @param {object} o.toolbar Toolbar(幅に合わせて詰めるため)
   */
  constructor({ arranger, dialog, toolbar }) {
    this.arranger = arranger;
    this.dialog = dialog;
    this.toolbar = toolbar;
    this.button = $("shScan");
    this.label = $("shScanLabel");
    this.menu = new PopupMenu({ anchor: this.button, items: () => this.items() });
    this.button.addEventListener("click", () => {
      if (this.arranger.state !== "busy") {
        this.menu.toggle();
      }
    });
    arranger.onChange(() => this.update());
    this.update();
  }

  update() {
    const a = this.arranger;
    const wasHidden = this.button.hidden;
    this.button.hidden = a.state === "none";
    let label = "";
    let title = "";
    switch (a.state) {
      case "suggest":
        label = a.kind === "sheets" ? "冊子を並べ替える" : "見開きを分ける";
        title =
          a.kind === "sheets"
            ? "2ページ分が並んだスキャンです。2つに分けて、表紙から順に並べ替えられます"
            : "スキャンした見開きです。1ページずつに分けて、余白を除いて表示できます";
        break;
      case "busy":
        label = "整えています…";
        title = a.progress || "スキャンを整えています";
        break;
      case "arranged":
        label = a.arranged?.options.mode === "booklet" ? "並べ替え表示" : "分割表示";
        title = "スキャンを整えて表示しています(画質は元のまま)。押すと、元に戻す・整え方を変える・保存ができます";
        break;
      default:
        break;
    }
    this.label.textContent = label;
    this.button.title = title;
    this.button.setAttribute("aria-label", title || label);
    this.button.classList.toggle("sh-scan-busy", a.state === "busy");
    this.button.classList.toggle("sh-pressed", a.state === "arranged");
    this.button.setAttribute("aria-busy", a.state === "busy" ? "true" : "false");
    if (wasHidden !== this.button.hidden) {
      this.toolbar?.fitToWidth();
    }
  }

  items() {
    const a = this.arranger;
    if (a.state === "arranged") {
      return [
        { label: "元のスキャンに戻す", icon: "undo", onSelect: () => a.restore({ remember: true }) },
        { label: "整え方を変える…", icon: "tune", onSelect: () => this.dialog.open() },
        ...(a.arranged?.options?.mode === "spread"
          ? [
              {
                label: a.arranged.options.reverse ? "ページの順を元に戻す" : "ページの順を逆にする",
                icon: "swap-vert",
                hint: "最後のページから始まってしまうとき(最後の見開きからスキャンしたもの)",
                onSelect: () => a.arrange({ ...a.arranged.options, reverse: !a.arranged.options.reverse }, { remember: true, fromStart: true }),
              },
            ]
          : []),
        { separator: true },
        {
          label: "整えた PDF を保存…",
          icon: "download",
          hint: "画質は元のまま(画像を作り直しません)。元のファイルは変えません",
          onSelect: () => a.saveArranged(),
        },
      ];
    }
    const spread = {
      label: "見開きを1ページずつに分ける",
      icon: "scan-split",
      hint: "本・ノートを開いてスキャンしたもの(余白も除きます)",
      onSelect: () => a.arrange(a.defaultOptions("spread")),
    };
    const booklet = {
      label: "冊子の順に並べ替える",
      icon: "scan-booklet",
      hint: "ばらした中綴じの冊子を、両面スキャンしたもの",
      onSelect: () => a.arrange(a.defaultOptions("sheets")),
    };
    return [
      ...(a.kind === "sheets" ? [booklet, spread] : [spread, booklet]),
      { label: "整え方を選ぶ…", icon: "tune", onSelect: () => this.dialog.open() },
    ];
  }
}

/** 整え方を選ぶダイアログ(プレビューつき) */
export class ScanDialog {
  /**
   * @param {object} o
   * @param {object} o.arranger
   */
  constructor({ arranger }) {
    this.arranger = arranger;
    this.dialog = $("shScanDialog");
    this.preview = $("shScanPreview");
    this.message = $("shScanMessage");
    this.progress = $("shScanProgress");
    this.summary = $("shScanSummary");
    this.applyButton = $("shScanApply");
    this.trim = $("shScanTrim");
    this.firstInner = $("shScanFirstInner");
    this.flipBacks = $("shScanFlipBacks");
    this.spreadBox = $("shScanSpreadOptions");
    this.bookletBox = $("shScanBookletOptions");
    this.ready = false;
    this.renderTimer = 0;
    this.canvasCache = new Map();

    $("shScanClose").addEventListener("click", () => this.close());
    $("shScanCancel").addEventListener("click", () => this.close());
    this.applyButton.addEventListener("click", () => this.apply());
    this.dialog.addEventListener("change", e => {
      if (e.target.name === "shScanMode") {
        // 冊子にしたら余白を除かない(ばらした冊子の紙は、スキャンの範囲と紙がぴったり)、見開きなら設定の値
        const mode = e.target.value;
        this.trim.checked = mode === "spread" ? this.arranger.getSettings().scanTrim : false;
      }
      this.updateControls();
      this.schedulePreview();
    });
    this.dialog.addEventListener("close", () => {
      this.canvasCache.clear();
      this.preview.textContent = "";
      // 調べている途中で閉じたら、調べるのをやめる(整えるボタンを押したときは続ける)
      if (!this.applying) {
        this.arranger.cancelAnalysis();
      }
      this.applying = false;
    });
  }

  get isOpen() {
    return this.dialog.open;
  }

  /** 選ばれている整え方 */
  options() {
    const radio = name => this.dialog.querySelector(`input[name="${name}"]:checked`)?.value;
    return normalizeOptions({
      mode: radio("shScanMode") || "spread",
      trim: this.trim.checked,
      direction: radio("shScanDirection") || "ltr",
      sheetOrder: radio("shScanSheetOrder") || "outer",
      firstSide: this.firstInner.checked ? "inner" : "outer",
      flipBacks: this.flipBacks.checked,
      // 0.5: 「PDF の1ページ目」が本の最後のほうの見開きなら、見開きの順を逆にする
      reverse: radio("shScanFirstPage") === "last",
    });
  }

  setOptions(o) {
    const set = (name, value) => {
      const el = this.dialog.querySelector(`input[name="${name}"][value="${value}"]`);
      if (el) {
        el.checked = true;
      }
    };
    set("shScanMode", o.mode);
    set("shScanDirection", o.direction);
    set("shScanSheetOrder", o.sheetOrder);
    this.trim.checked = !!o.trim;
    this.firstInner.checked = o.firstSide === "inner";
    this.flipBacks.checked = !!o.flipBacks;
    set("shScanFirstPage", o.reverse ? "last" : "first");
  }

  updateControls() {
    const o = this.options();
    this.bookletBox.hidden = o.mode !== "booklet";
    this.spreadBox.hidden = o.mode !== "spread";
    this.trim.disabled = o.mode === "none";
    this.dialog.querySelectorAll('input[name="shScanDirection"]').forEach(el => (el.disabled = o.mode === "none"));
    this.applyButton.disabled = !this.ready;
    this.applyButton.textContent = o.mode === "none" ? "元のまま表示" : "この方法で表示";
  }

  async open() {
    const a = this.arranger;
    if (!a.base) {
      return;
    }
    let initial;
    if (a.state === "arranged" && a.arranged) {
      initial = a.arranged.options;
    } else if (a.base.choice?.mode === "none") {
      initial = { ...a.defaultOptions(), mode: "none" };
    } else {
      initial = a.currentOptions();
    }
    this.setOptions(initial);
    this.ready = a.base.analyzed;
    this.message.hidden = true;
    this.progress.textContent = "";
    this.summary.textContent = "";
    this.updateControls();
    this.preview.textContent = "";
    if (!this.dialog.open) {
      this.dialog.showModal();
    }
    if (!a.base.analyzed && !(await a.mostlyLandscape(a.base.doc))) {
      // 縦長のページの PDF(ふつうの文書): 分けられない
      this.ready = false;
      this.updateControls();
      this.showMessage("この PDF は横長のページではないため、見開きの分割・冊子の並べ替えはできません(スキャンした見開きは横長のページになります)。");
      return;
    }
    if (!a.base.analyzed) {
      this.progress.textContent = "スキャンを調べています…";
      let ok = false;
      try {
        ok = await a.ensureAnalyzed((done, total) => {
          this.progress.textContent = `スキャンを調べています(${done}/${total})…`;
        });
      } catch (e) {
        this.progress.textContent = "";
        this.showMessage(`スキャンを調べられませんでした(${e?.message || e})`);
        return;
      }
      if (!ok || !this.dialog.open) {
        return;
      }
      this.progress.textContent = "";
      // 調べた結果に合わせて、初めて選ぶときの整え方を決め直す
      if (a.state !== "arranged" && !a.base.choice && a.kind) {
        this.setOptions(a.defaultOptions());
      }
      this.ready = true;
      this.updateControls();
    }
    this.renderPreview();
  }

  close() {
    if (this.dialog.open) {
      this.dialog.close();
    }
  }

  showMessage(text) {
    this.message.textContent = text;
    this.message.hidden = !text;
  }

  schedulePreview() {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.renderPreview(), 60);
  }

  /** スキャン1枚分の小さな画像(キャンバス) */
  canvasFor(scanIndex) {
    if (this.canvasCache.has(scanIndex)) {
      return this.canvasCache.get(scanIndex);
    }
    const p = this.arranger.base.previews[scanIndex];
    if (!p) {
      return null;
    }
    const c = document.createElement("canvas");
    c.width = p.width;
    c.height = p.height;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(p.width, p.height);
    for (let i = 0, j = 0; i < p.data.length; i++, j += 4) {
      const v = p.data[i];
      img.data[j] = v;
      img.data[j + 1] = v;
      img.data[j + 2] = v;
      img.data[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const entry = { canvas: c, scale: p.scale };
    this.canvasCache.set(scanIndex, entry);
    return entry;
  }

  renderPreview() {
    if (!this.ready || !this.dialog.open) {
      return;
    }
    const a = this.arranger;
    const base = a.base;
    const o = this.options();
    this.preview.textContent = "";
    this.showMessage("");
    let pages;
    if (o.mode === "none") {
      pages = base.scans.map((s, i) => ({ scan: i, rectPx: null, rotate: 0 }));
      this.summary.textContent = `元のスキャン ${base.pageCount}ページをそのまま表示します。`;
    } else {
      const plan = a.plan(o);
      if (plan.error) {
        this.showMessage(
          {
            odd: "スキャンの枚数が奇数のため、冊子の順に並べ替えられません(両面スキャンした冊子なら偶数になります)。",
            unsplit: "縦長のページなど、2つに分けられないページがあるため、冊子の順に並べ替えられません。",
            empty: "分けられるページが見つかりませんでした(横長のスキャンではないようです)。",
          }[plan.error] || "この方法では整えられません。"
        );
        this.applyButton.disabled = true;
        this.summary.textContent = "";
        return;
      }
      pages = plan.pages;
      const split = pages.filter(p => p.rectPx);
      const s0 = split[0] && base.scans[split[0].scan];
      const size = s0 ? `(1ページの大きさ 約 ${Math.round((split[0].rectPx[2] - split[0].rectPx[0]) / s0.pxPerMm)} × ${Math.round((split[0].rectPx[3] - split[0].rectPx[1]) / s0.pxPerMm)} mm)` : "";
      this.summary.textContent = `元のスキャン ${base.pageCount}ページ → ${pages.length}ページ${size}`;
      this.applyButton.disabled = false;
    }
    const limit = 24;
    const shown = pages.length > limit ? [...pages.slice(0, limit - 2), null, pages[pages.length - 1]] : pages;
    shown.forEach((p, k) => {
      const index = p ? pages.indexOf(p) : -1;
      const fig = document.createElement("figure");
      fig.className = "sh-scan-thumb";
      if (!p) {
        fig.classList.add("sh-scan-more");
        fig.textContent = `…(${pages.length - limit + 1}ページ)…`;
        this.preview.append(fig);
        return;
      }
      const src = this.canvasFor(p.scan);
      const canvas = document.createElement("canvas");
      const H = 112;
      if (src) {
        const s = src.scale;
        const rect = p.rectPx ? p.rectPx.map(v => v * s) : [0, 0, src.canvas.width, src.canvas.height];
        const rw = Math.max(1, rect[2] - rect[0]);
        const rh = Math.max(1, rect[3] - rect[1]);
        const W = Math.max(8, Math.round((H * rw) / rh));
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, W, H);
        ctx.save();
        if (p.rotate === 180) {
          ctx.translate(W, H);
          ctx.rotate(Math.PI);
        }
        ctx.drawImage(src.canvas, rect[0], rect[1], rw, rh, 0, 0, W, H);
        // 白く覆う範囲(スキャンで入った本の縁など)
        ctx.fillStyle = "#ffffff";
        for (const m of p.masksPx || []) {
          const k = W / rw;
          ctx.fillRect((m[0] * s - rect[0]) * k, (m[1] * s - rect[1]) * k, (m[2] - m[0]) * s * k, (m[3] - m[1]) * s * k);
        }
        ctx.restore();
      } else {
        canvas.width = 80;
        canvas.height = H;
      }
      const cap = document.createElement("figcaption");
      const n = index + 1;
      cap.textContent = o.mode === "booklet" && n === 1 ? "1 表紙" : o.mode === "booklet" && n === pages.length ? `${n} 裏表紙` : String(n);
      fig.title = p.half ? `元の ${p.scan + 1}ページの${p.half === "L" ? "左" : "右"}半分${p.rotate === 180 ? "(上下を直す)" : ""}` : `元の ${p.scan + 1}ページ`;
      fig.append(canvas, cap);
      this.preview.append(fig);
    });
  }

  async apply() {
    const o = this.options();
    this.applying = true;
    this.close();
    if (o.mode === "none") {
      await this.arranger.restore({ remember: true });
      return;
    }
    // 0.5: 「PDF の1ページ目」(順を逆にするか)を変えたときは、本の最初のページから表示する
    const before = this.arranger.arranged?.options;
    const fromStart = !before || before.reverse !== o.reverse || before.mode !== o.mode;
    await this.arranger.arrange(o, { remember: true, fromStart });
  }
}
