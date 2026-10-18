/**
 * 速度ログ。
 *
 * 計測は常に軽く行い(時刻を数個記録するだけ)、表示と保存は
 * 詳細設定の「速度ログ」がオンのときだけ行う。
 * 時刻はすべて「ページの読み込み開始(リンクをクリックした時点)」からの経過ミリ秒。
 * 自動切り替えで開いた場合は、元のPDFへの通信とリダイレクトの時間も含む。
 */

const STORAGE_KEY = "perfLogs";
const MAX_LOGS = 50;

export class PerfLog {
  constructor(app, bootState) {
    this.app = app;
    this.marks = bootState.marks; // [[名前, ms], ...]
    /** 時刻の起点(1つ目の文書はページの読み込み開始 = 0。2つ目以降は、その文書を開き始めた時点) */
    this.origin = 0;
    this.enabled = false;
    this.done = false;
    this.panel = document.getElementById("shPerfPanel");
    this.info = {};
    const bus = app.eventBus;
    bus.on("documentinit", () => this.mark("文書の初期化"));
    bus.on("pagesinit", () => this.mark("ページ構成の確定"));
    bus.on("pagerendered", ({ pageNumber, isDetailView }) => {
      if (!this.done && !isDetailView) {
        this.done = true;
        this.mark(`最初のページ表示(${pageNumber}ページ目)`);
        this.finish();
      }
    });
  }

  mark(name) {
    this.marks.push([name, performance.now() - this.origin]);
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.panel.hidden = true;
    } else if (this.done) {
      this.render();
    }
  }

  /** 新しい文書を開くたびに呼ぶ */
  startDocument(label) {
    this.done = false;
    if (this.marks.length > 1 && this.marks.some(([n]) => n.startsWith("最初のページ表示"))) {
      // 2つ目以降の文書は、開く操作の時点から測り直す
      this.marks.length = 0;
      this.origin = performance.now();
    }
    this.info = { label, startedAt: performance.now() };
    this.mark("PDFの読み込み開始");
  }

  async finish() {
    const pdf = this.app.pdfDocument;
    let size = null;
    try {
      size = (await pdf?.getDownloadInfo())?.length ?? null;
    } catch {}
    this.info.pages = pdf?.numPages ?? null;
    this.info.bytes = size;
    if (!this.enabled) {
      return;
    }
    this.render();
    this.save();
  }

  summary() {
    const first = this.marks.find(([n]) => n.startsWith("最初のページ表示"));
    return {
      date: new Date().toISOString(),
      label: this.info.label || "",
      pages: this.info.pages,
      bytes: this.info.bytes,
      firstPageMs: first ? Math.round(first[1]) : null,
      marks: this.marks.map(([n, t]) => [n, Math.round(t)]),
    };
  }

  render() {
    const s = this.summary();
    this.panel.textContent = "";
    const head = document.createElement("div");
    head.className = "sh-perf-head";
    head.textContent = `速度ログ: 最初のページまで ${s.firstPageMs ?? "-"} ms`;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "閉じる";
    close.addEventListener("click", () => (this.panel.hidden = true));
    head.append(close);
    const table = document.createElement("table");
    let prev = 0;
    for (const [name, t] of s.marks) {
      const tr = document.createElement("tr");
      const a = document.createElement("td");
      a.textContent = name;
      const b = document.createElement("td");
      b.textContent = `${t} ms`;
      const c = document.createElement("td");
      c.textContent = `+${t - prev}`;
      prev = t;
      tr.append(a, b, c);
      table.append(tr);
    }
    const foot = document.createElement("div");
    foot.className = "sh-perf-foot";
    const size = !s.bytes
      ? "サイズ不明"
      : s.bytes >= 1048576
        ? `${(s.bytes / 1048576).toFixed(1)} MB`
        : `${Math.max(1, Math.round(s.bytes / 1024))} KB`;
    foot.textContent = `${s.pages ?? "?"} ページ / ${size}`;
    this.panel.append(head, table, foot);
    this.panel.hidden = false;
    console.table(s.marks.map(([name, ms]) => ({ 段階: name, 経過ms: ms })));
  }

  async save() {
    try {
      const { [STORAGE_KEY]: logs = [] } = await chrome.storage.local.get(STORAGE_KEY);
      logs.unshift(this.summary());
      logs.length = Math.min(logs.length, MAX_LOGS);
      await chrome.storage.local.set({ [STORAGE_KEY]: logs });
    } catch (e) {
      console.warn("[製本ビューア] 速度ログを保存できませんでした", e);
    }
  }
}
