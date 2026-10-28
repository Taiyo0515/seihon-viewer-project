/**
 * スキャンの整え(0.3)の画面: ツールバーのボタンと、整え方を選ぶダイアログ。
 */

import { normalizeOptions, skewSummary } from "../scan/scan-arranger.js";
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
        label = a.kind === "sheets" ? "冊子を並べ替える" : a.kind === "trim" ? "余白を除く" : a.kind === "skewed" ? "傾きを直す" : "見開きを分ける";
        title =
          a.kind === "turned"
            ? "見開きを横に置いてスキャンしたものです。回して、1ページずつに分けて表示できます"
            : a.kind === "sheets"
            ? "2ページ分が並んだスキャンです。2つに分けて、表紙から順に並べ替えられます"
            : a.kind === "trim"
            ? "紙が背景の中に小さく写っています(写真など)。余白を除いて表示できます"
            : a.kind === "skewed"
              ? "傾いたスキャンです。まっすぐにして表示できます(画質は元のままです)"
              : "スキャンした見開きです。1ページずつに分けて、余白を除いて表示できます";
        break;
      case "busy":
        label = "整えています…";
        title = a.progress || "スキャンを整えています";
        break;
      case "arranged": {
        const m = a.arranged?.options;
        label =
          m.mode === "booklet"
            ? "並べ替え表示"
            : m.mode === "spread"
              ? "分割表示"
              : m.deskew
                ? "傾き補正表示"
                : m.trim
                  ? "余白を除いた表示"
                  : "分割表示";
        title =
          m.mode === "none" && !m.deskew && !m.trim
            ? "元のまま表示しています(選んだ整え方の保存があります)。押すと、整え方を変える・保存ができます"
            : "スキャンを整えて表示しています(画質は元のまま)。押すと、元に戻す・整え方を変える・保存ができます";
        break;
      }
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
    const straighten = {
      label: "傾きをまっすぐにする",
      icon: "scan-split",
      hint: "文字の行がまっすぐになるよう、ページごとに回します(分けたり並べ替えたりしません)",
      onSelect: () => a.arrange(a.defaultOptions("skewed")),
    };
    const spread = {
      label: "見開きを1ページずつに分ける",
      icon: "scan-split",
      hint: a.kind === "turned" ? "見開きを横に置いてスキャンしたもの(回して、余白も除きます)" : "本・ノートを開いてスキャンしたもの(余白も除きます)",
      onSelect: () => a.arrange(a.defaultOptions(a.kind === "turned" ? "turned" : "spread")),
    };
    const booklet = {
      label: "冊子の順に並べ替える",
      icon: "scan-booklet",
      hint: "ばらした中綴じの冊子を、両面スキャンしたもの",
      onSelect: () => a.arrange(a.defaultOptions("sheets")),
    };
    const trim = {
      label: "余白を除いて表示",
      icon: "scan-split",
      hint: "写真など、紙の周りに余白(背景)があるもの。紙の外の余白を取り除いて表示します",
      onSelect: () => a.arrange(a.defaultOptions("trim")),
    };
    return [
      ...(a.kind === "trim"
        ? [trim]
        : a.kind === "skewed"
        ? [straighten]
        : a.kind === "turned"
          ? [spread, straighten]
          : a.kind === "sheets"
            ? [booklet, spread, straighten]
            : [spread, booklet, straighten]),
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
    this.deskew = $("shScanDeskew");
    this.angle = $("shScanAngle");
    this.skewInfo = $("shScanSkewInfo");
    this.landscape = true;
    /** 縦長の PDF でも、見開きとして分けられるか(横に置いてスキャンした見開き。調べる前は、分かるまで選べるままにする) */
    this.canSplit = true;
    this.spreadBox = $("shScanSpreadOptions");
    this.bookletBox = $("shScanBookletOptions");
    this.ready = false;
    this.renderTimer = 0;
    this.progressTimer = 0;
    this.applying = false;
    this.canvasCache = new Map();
    // 0.8: 調べる進みに合わせて(全部そろう前の部分のプレビュー)、プレビューを作り直す
    this.unsubscribe = arranger.onChange(() => this.onArrangerChanged());

    $("shScanClose").addEventListener("click", () => this.close());
    $("shScanCancel").addEventListener("click", () => this.close());
    this.applyButton.addEventListener("click", () => this.apply());
    this.dialog.addEventListener("change", e => {
      if (e.target.name === "shScanMode" && e.target.value === "booklet") {
        // 冊子の紙はスキャンした範囲と紙がぴったりなので、余白を除く指定をしない
        this.trim.checked = false;
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
      deskew: this.deskew.checked,
      turn: this.landscape ? "none" : radio("shScanTurn") || "auto",
      angle: this.angle.value.trim() === "" ? null : Number(this.angle.value),
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
    set("shScanTurn", !o.turn || o.turn === "none" ? "auto" : o.turn);
    this.deskew.checked = !!o.deskew;
    this.angle.value = o.angle === null || o.angle === undefined ? "" : String(o.angle);
  }

  updateControls() {
    const o = this.options();
    this.bookletBox.hidden = o.mode !== "booklet";
    this.spreadBox.hidden = o.mode !== "spread";
    // 0.8: 補正(余白・傾き)は、ページの構成と独立に選ぶ。冊子の紙はスキャンした範囲と紙がぴったりなので、余白を除く指定はできない
    this.trim.disabled = o.mode === "booklet";
    if (o.mode === "booklet") {
      this.trim.checked = false;
    }
    // 傾きの角度は、「ページの分割・並べ替えを行わない」で傾きをまっすぐにするとき、指定できる
    $("shScanStraightenOptions").hidden = !(o.mode === "none" && o.deskew);
    $("shScanDirectionRow").hidden = o.mode === "none";
    this.dialog.querySelectorAll('input[name="shScanDirection"]').forEach(el => (el.disabled = o.mode === "none"));
    // 縦長のページの PDF は、分けたり並べ替えたりできない(横に置いてスキャンした見開きは、見開きとして分けられる)
    $("shScanPortraitNote").hidden = this.landscape || this.canSplit;
    $("shScanTurnRow").hidden = this.landscape || !this.canSplit || o.mode !== "spread";
    for (const [v, ok] of [
      ["spread", this.landscape || this.canSplit],
      ["booklet", this.landscape],
    ]) {
      const el = this.dialog.querySelector(`input[name="shScanMode"][value="${v}"]`);
      if (el) {
        el.disabled = !ok;
      }
    }
    this.applyButton.textContent = o.mode === "none" && !o.trim && !o.deskew ? "元のまま表示" : "この方法で表示";
  }

  async open() {
    const a = this.arranger;
    if (!a.base) {
      return;
    }
    if (a.state === "busy" && !this.dialog.open) {
      // 整えて(作って)いる最中に開くと、結果が入れ違いになることがある。終わるまで待ってもらう
      a.toast.show("スキャンを整えています。終わってから選んでください", { duration: 3000 });
      return;
    }
    let initial;
    if (a.state === "arranged" && a.arranged) {
      initial = a.arranged.options;
    } else if (a.base.choice?.mode === "none" && !a.base.choice.trim && !a.base.choice.deskew) {
      initial = { ...a.defaultOptions(), mode: "none" };
    } else {
      initial = a.currentOptions();
    }
    this.landscape = await a.isLandscape();
    this.canSplit = this.landscape || !a.base.analyzed || a.base.scans.some(s => s?.turned);
    if (!this.landscape && initial.mode === "booklet") {
      initial = a.defaultOptions("skewed");
    }
    if (!this.landscape && initial.mode === "spread" && initial.turn === "none") {
      initial = { ...initial, turn: "auto" };
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
    if (!a.base.analyzed) {
      // 0.8: 全部そろうのを待たせない。いまのページのまわりから調べて、調べた分でプレビューを作る
      // (まだ調べていないページは、プレビューでは「元のまま」として出ます)
      this.progress.textContent = "スキャンを調べています…(いまのページのまわりから)";
      a
        .ensureAnalyzed((done, total) => {
          if (this.dialog.open) {
            this.progress.textContent = `スキャンを調べています(${done}/${total})…`;
          }
        })
        .then(ok => {
          if (!ok || !this.dialog.open) {
            return;
          }
          this.afterAnalysisAtOpen();
          this.renderPreview();
        })
        .catch(e => {
          if (this.dialog.open) {
            this.progress.textContent = "";
            this.showMessage(`スキャンを調べられませんでした(${e?.message || e})`);
          }
        });
    }
    this.renderPreview();
  }

  /** ダイアログを開いてからの解析が終わったときの処理(縦長の回しの確かめと、初めの整え方の決め直し) */
  async afterAnalysisAtOpen() {
    const a = this.arranger;
    const base = a.base;
    this.progress.textContent = "";
    // 縦長の PDF: 回して分けられるページがあったか
    if (!this.landscape) {
      this.canSplit = base.scans.some(s => s?.turned);
      if (this.canSplit && base.scans.filter(s => s?.turned).length * 2 >= base.scans.length) {
        base.turnable = true;
        // ノドが見つからなかったページも、横に置いた見開きとして調べ直す(真ん中で分ける)
        this.progress.textContent = "スキャンを調べています…";
        try {
          await a.forceTurned(base);
        } catch {
          // 調べ直せなかったときも、分けられるページだけのままで進む
        }
        if (!this.dialog.open) {
          return;
        }
        this.progress.textContent = "";
      }
    }
    // 調べた結果に合わせて、初めて選ぶときの整え方を決め直す
    if (a.state !== "arranged" && !base.choice && a.kind) {
      this.setOptions(a.defaultOptions());
    } else if (!this.landscape && !base.choice && a.state !== "arranged") {
      this.setOptions(a.defaultOptions(base.turnable ? "turned" : "skewed"));
    } else if (!this.canSplit && !this.landscape && this.options().mode === "spread") {
      this.setOptions(a.defaultOptions("skewed"));
    }
    this.ready = true;
    this.updateControls();
    this.renderPreview();
  }

  /** 調べる進みに合わせて、プレビューを作り直す(0.8) */
  onArrangerChanged() {
    if (!this.dialog.open || this.applying) {
      return;
    }
    clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => {
      if (this.dialog.open) {
        this.renderPreview();
      }
    }, 120);
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
  canvasFor(scanIndex, turn = null) {
    const cacheKey = turn ? `${scanIndex}:${turn}` : scanIndex;
    if (this.canvasCache.has(cacheKey)) {
      return this.canvasCache.get(cacheKey);
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
    let canvas = c;
    if (turn) {
      // 横に置いたページ: 90° 回した画像にする
      canvas = document.createElement("canvas");
      canvas.width = c.height;
      canvas.height = c.width;
      const t = canvas.getContext("2d");
      if (turn === "cw") {
        t.translate(c.height, 0);
        t.rotate(Math.PI / 2);
      } else {
        t.translate(0, c.width);
        t.rotate(-Math.PI / 2);
      }
      t.drawImage(c, 0, 0);
    }
    const entry = { canvas, scale: p.scale };
    this.canvasCache.set(cacheKey, entry);
    return entry;
  }

  renderPreview() {
    if (!this.dialog.open || !this.arranger.base) {
      return;
    }
    const a = this.arranger;
    const base = a.base;
    const o = this.options();
    this.preview.textContent = "";
    this.showMessage("");
    // 検出した傾きのまとめ(調べたページまで)
    const sum = skewSummary(base.scans);
    this.skewInfo.hidden = o.mode === "none" && !o.deskew;
    this.skewInfo.textContent = sum.skewed
      ? `傾きを検出したページ: 調べた${sum.pages}ページ中 ${sum.skewed}ページ(中央値 約 ${Math.abs(sum.median)}°)`
      : "傾きは見つかりませんでした(0.2° 未満、または文字・線が少なくて調べられないページです)";
    // 冊子の並べ替えは、全部の紙の順が調そろってから決められる
    if (o.mode === "booklet" && !this.ready) {
      this.summary.textContent = "冊子の並べ替えは、全部のページを調べてから決まります(いま見ているページから順に調べています)。";
      this.applyButton.disabled = true;
      return;
    }
    // 0.8: 調べていないページは「まだ調べていない」項として入る(そのままの表示。部分のプレビュー)
    const plan = a.plan(o, base, { partial: true });
    if (plan.error) {
      this.showMessage(
        {
          odd: "スキャンの枚数が奇数のため、冊子の順に並べ替えられません(両面スキャンした冊子なら偶数になります)。",
          unsplit: "縦長のページなど、2つに分けられないページがあるため、冊子の順に並べ替えられません。",
          empty: "分けられるページが見つかりませんでした(横長のスキャンではないようです)。",
          noskew: "傾いているページが見つかりませんでした。上の「傾きの角度」を指定すると、全部のページをその角度だけ回せます。",
          notrim: "余白を除けるページが見つかりませんでした(紙がページいっぱいに写っているものなど)。",
        }[plan.error] || "この方法では整えられません。"
      );
      this.applyButton.disabled = true;
      this.summary.textContent = "";
      return;
    }
    const pages = plan.pages || [];
    const real = pages.filter(p => !p.pending);
    if (!real.length) {
      // まだ、まわりのページが調べ終わっていない
      this.summary.textContent = "";
      this.showMessage("いまのページのまわりをまだ調べていません(調べ終わると、まもなくプレビューが出ます)。");
      this.applyButton.disabled = true;
      return;
    }
    const pendingCount = pages.length - real.length;
    if (o.mode === "none" && !o.trim && !o.deskew) {
      this.summary.textContent = `元のスキャン ${base.pageCount}ページをそのまま表示します。`;
    } else {
      const sized = pages.filter(p => !p.pending && p.rectPx);
      const s0 = sized[0] && base.scans[sized[0].scan];
      const size = s0
        ? `(1ページの大きさ 約 ${Math.round((sized[0].rectPx[2] - sized[0].rectPx[0]) / s0.pxPerMm)} × ${Math.round(
            (sized[0].rectPx[3] - sized[0].rectPx[1]) / s0.pxPerMm
          )} mm)`
        : "";
      if (o.mode === "none") {
        // 補正だけ(0.8: 傾きを直す・余白を除く。ページの数・順は変わらない)
        if (o.deskew) {
          const n = pages.filter(p => p.angle).length;
          this.summary.textContent = `元のスキャン ${base.pageCount}ページのうち ${n}ページの傾きを直します(ページの数・順は変わりません)${o.trim ? "。余白も除きます" : ""}${size ? ` ${size}` : ""}`;
        } else if (o.trim) {
          this.summary.textContent = `元のスキャン ${base.pageCount}ページの余白を除いて表示します(ページの数・順は変わりません)${size ? ` ${size}` : ""}`;
        }
      } else {
        // 分けたり並べ替えたりする整え方
        this.summary.textContent = `元のスキャン ${base.pageCount}ページ → ${pages.length}ページ${size}`;
      }
      if (!plan.complete) {
        this.summary.textContent += ` まだ調べていない ${pendingCount}ページは、いまは元のまま入ります(調べ終わったら、全部のページで組み直して表示します)。`;
      }
    }
    this.applyButton.disabled = false;
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
      const src = this.canvasFor(p.scan, p.turn);
      const canvas = document.createElement("canvas");
      const H = 112;
      if (p.pending) {
        // 0.8: まだ調べていないページは、「元のまま入る」ことを示すだけの表示
        fig.classList.add("sh-scan-pending");
      }
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
        if (p.angle) {
          // 0.6: 傾きを直す(画像の中心のまわりに回してから、範囲を切り出す)
          ctx.save();
          const k = W / rw;
          const cx = src.canvas.width / 2;
          const cy = src.canvas.height / 2;
          ctx.scale(k, k);
          ctx.translate(-rect[0], -rect[1]);
          ctx.translate(cx, cy);
          ctx.rotate((p.angle * Math.PI) / 180);
          ctx.translate(-cx, -cy);
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(src.canvas, 0, 0);
          ctx.restore();
        } else {
          ctx.drawImage(src.canvas, rect[0], rect[1], rw, rh, 0, 0, W, H);
        }
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
      cap.textContent = p.pending
        ? `${n}: 元の ${p.scan + 1}ページ(調べています…)`
        : o.mode === "booklet" && n === 1
          ? "1 表紙"
          : o.mode === "booklet" && n === pages.length
            ? `${n} 裏表紙`
            : String(n);
      fig.title = p.pending
        ? `元の ${p.scan + 1}ページ(まだ調べていません。元のスキャンをそのまま表示します)`
        : p.half
          ? `元の ${p.scan + 1}ページの${p.half === "L" ? "左" : "右"}半分${p.rotate === 180 ? "(上下を直す)" : ""}`
          : `元の ${p.scan + 1}ページ`;
      fig.append(canvas, cap);
      this.preview.append(fig);
    });
  }

  async apply() {
    const o = this.options();
    this.applying = true;
    this.close();
    if (o.mode === "none" && !o.trim && !o.deskew) {
      // 元のまま表示(補正も指定していない)
      await this.arranger.restore({ remember: true });
      return;
    }
    // 0.5: 「PDF の1ページ目」(順を逆にするか)を変えたときは、本の最初のページから表示する
    const before = this.arranger.arranged?.options;
    const fromStart = !before || before.reverse !== o.reverse || before.mode !== o.mode;
    // force: ダイアログを開いたときに始めた解析が続いていても、その分で整えられる(0.8)
    await this.arranger.arrange(o, { remember: true, fromStart, force: true });
  }
}
