/**
 * 0.4: ビューアで開こうとしたファイルが電子書籍・コミックなら、それに合った方法で開く。
 *
 *  - コミック(CBZ・CBR・CB7)・画像だけの EPUB … 画像をそのまま並べた PDF にして、このビューアで表示する
 *  - 文字の EPUB・MOBI・AZW・AZW3 … 電子書籍リーダーの画面(reader/reader.html)に切り替える
 *  - KFX・DRM 付き … 表示できない理由を画面に出す
 *
 * PDF を開くときは何もしない(いままでどおり PDF.js が開く)。
 */

import { putHandoff } from "../../common/handoff.js";
import { looksLikeEbookName, readHead, sniffFormat } from "../../common/ebook-formats.js";
import { saveBlobAs, sanitizeFileName } from "../../common/files.js";
import { EbookUnsupportedError, buildComicPdf, inspectEbook } from "./ebook-open.js";

const LOG = "[製本ビューア]";

/** 電子書籍リーダーの画面の URL */
export function readerUrl({ handoff = null, src = null } = {}) {
  const base = chrome.runtime.getURL("reader/reader.html");
  const params = new URLSearchParams();
  if (handoff) {
    params.set("h", handoff);
  }
  if (src) {
    params.set("src", src);
  }
  const q = params.toString();
  return q ? `${base}?${q}` : base;
}

export class EbookRouter {
  /**
   * @param {object} o
   * @param {object} o.app PDFViewerApplication
   * @param {object} o.toast
   * @param {object} o.errorPanel
   * @param {object} o.toolbar
   * @param {object} o.book BookLayout
   * @param {object} o.emptyState
   * @param {() => object} o.getSettings
   * @param {() => object} o.getCurrent
   * @param {(args:object) => Promise<boolean>} o.openDocument main.js の app.open(args.seihon で出どころを渡す)
   * @param {() => void} o.openFilePicker
   */
  constructor({ app, toast, errorPanel, toolbar, book, emptyState, getSettings, getCurrent, openDocument, openFilePicker }) {
    Object.assign(this, { app, toast, errorPanel, toolbar, book, emptyState, getSettings, getCurrent, openDocument, openFilePicker });
    /** いま表示しているコミックの元のファイル({blob, name, url, info, result}) */
    this.source = null;
    /** コミックの綴じ方向に合わせて、綴じ方向を一時的に変えたか(次に PDF を開くとき設定に戻す) */
    this.directionOverridden = false;
    this.busy = null;
  }

  /**
   * 開く前に呼ぶ。電子書籍・コミックならここで開き、true / false(開けたか)を返す。
   * PDF(または分からないもの)なら null を返す(呼ぶ側が PDF.js で開く)。
   */
  async intercept(args) {
    if (!args || args.data || typeof args.url !== "string") {
      this.restoreDirection();
      return null;
    }
    const url = args.url;
    const isBlob = url.startsWith("blob:");
    let name = isBlob ? args.originalUrl || "" : url;
    try {
      name = decodeURIComponent(name);
    } catch {}
    if (!isBlob && !looksLikeEbookName(url)) {
      this.restoreDirection();
      return null;
    }
    let blob;
    try {
      if (isBlob) {
        blob = await (await fetch(url)).blob();
        const head = await readHead(blob, 4096);
        if (sniffFormat(head, name) === "pdf") {
          this.restoreDirection();
          return null;
        }
      } else {
        this.showLoading(`${fileLabel(name)} を読み込んでいます…`);
        const res = await fetch(url, { credentials: /^https?:/i.test(url) ? "include" : "same-origin" });
        if (!res.ok) {
          throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        }
        blob = await res.blob();
      }
    } catch (e) {
      this.hideLoading();
      if (!isBlob) {
        this.showError({
          title: "ファイルを読み込めませんでした",
          message: e.status ? `サーバーからファイルを取得できませんでした(HTTP ${e.status})。` : "ファイルを読み込めませんでした。ネットワークやファイルの場所を確かめてください。",
          details: `URL: ${url}\n内容: ${e.message || e}`,
        });
        return false;
      }
      return null;
    }
    return this.openBlob(blob, { name, url: isBlob ? null : url });
  }

  /** PDF として開けなかったとき: 中身が電子書籍・コミックなら開く(違えば null) */
  async retryAsEbook(url, originalUrl) {
    let blob;
    try {
      const res = await fetch(url, { credentials: /^https?:/i.test(url) ? "include" : "same-origin" });
      if (!res.ok) {
        return null;
      }
      blob = await res.blob();
    } catch {
      return null;
    }
    let name = url.startsWith("blob:") ? originalUrl || "" : url;
    try {
      name = decodeURIComponent(name);
    } catch {}
    const format = sniffFormat(await readHead(blob, 4096), name);
    if (!format || format === "pdf") {
      return null;
    }
    return this.openBlob(blob, { name, url: url.startsWith("blob:") ? null : url });
  }

  /**
   * 電子書籍・コミックのファイルを開く。PDF なら null。
   * @param {Blob} blob
   * @param {{name:string, url:string|null}} o
   */
  async openBlob(blob, { name, url }) {
    let info;
    try {
      this.showLoading(`${fileLabel(name)} を調べています…`);
      info = await inspectEbook(blob, name);
    } catch (e) {
      this.hideLoading();
      if (e instanceof EbookUnsupportedError) {
        this.showError({ title: e.title, message: e.message, details: `ファイル: ${name}` });
        return false;
      }
      console.error(LOG, e);
      this.showError({ title: "ファイルを開けませんでした", message: `ファイルを読めませんでした(${e.message || e})。壊れている可能性があります。`, details: `ファイル: ${name}` });
      return false;
    }
    if (info.route === "pdf" || !info.route) {
      this.hideLoading();
      if (!info.route) {
        this.showError({
          title: "このファイルは開けません",
          message: "PDF・EPUB・MOBI・AZW・AZW3・CBZ・CBR(と CB7・FB2)のどれでもないため、開けませんでした。",
          details: `ファイル: ${name}`,
        });
        return false;
      }
      this.restoreDirection();
      return null;
    }
    if (info.route === "reader") {
      return this.openInReader(blob, { name, url, format: info.format });
    }
    return this.openComic(blob, info, { name, url });
  }

  /** 電子書籍リーダーの画面に切り替える */
  async openInReader(blob, { name, url, format }) {
    try {
      this.showLoading(`${fileLabel(name)} を電子書籍リーダーで開きます…`);
      const id = await putHandoff(blob, { name: baseFileName(name), url: url || "", format });
      location.href = readerUrl({ handoff: id });
      return true;
    } catch (e) {
      this.hideLoading();
      console.error(LOG, e);
      this.showError({ title: "電子書籍リーダーを開けませんでした", message: String(e.message || e), details: `ファイル: ${name}` });
      return false;
    }
  }

  /** コミック・画像だけの EPUB を PDF にして表示する */
  async openComic(blob, info, { name, url, direction = null }) {
    const settings = this.getSettings();
    const base = baseFileName(name).replace(/\.[a-z0-9-]{1,8}$/i, "") || "comic";
    const started = performance.now();
    try {
      const result = await buildComicPdf(blob, info, {
        baseName: base,
        direction: direction || settings.comicDirection || "auto",
        fallback: settings.comicDirection === "ltr" ? "ltr" : "rtl",
        splitSpreads: settings.comicSplitSpreads !== false,
        onStatus: text => this.showLoading(text),
      });
      this.hideLoading();
      const fileName = `${sanitizeFileName(base)}.pdf`;
      const current = {
        kind: url ? "url" : "file",
        url: url || null,
        name: baseFileName(name),
        converted: {
          format: info.format,
          sourceName: baseFileName(name),
          fileName,
          title: result.title,
          direction: result.direction,
          images: result.images,
          pages: result.pages,
          split: result.split,
          skipped: result.skipped,
        },
      };
      this.source = { blob, name, url, info: { format: info.format }, result };
      // 本の綴じ方向に合わせる(設定は変えない。次に PDF を開くときに設定の向きに戻す)
      if (this.book.direction !== result.direction) {
        this.book.setDirection(result.direction);
        this.directionOverridden = true;
      }
      const opened = await this.openDocument({ data: result.bytes, filename: fileName, seihon: { current } });
      if (opened) {
        const secs = ((performance.now() - started) / 1000).toFixed(1);
        const notes = [];
        if (result.split) {
          notes.push(`見開きの画像 ${result.split} 枚を2ページずつに分けました`);
        }
        if (result.padded) {
          notes.push(`見開きがずれないよう、白紙のページを ${result.padded} 枚入れました`);
        }
        if (result.skipped.length) {
          notes.push(`読めなかった画像 ${result.skipped.length} 枚は除きました`);
        }
        this.toast.show(
          `${labelOf(info.format)}を PDF にして表示しました(${result.images} 枚・${secs} 秒、画質は元のまま)。${notes.join("。")}${notes.length ? "。" : ""}ダウンロードボタンで PDF として保存できます`,
          { duration: 7000 }
        );
      }
      return opened;
    } catch (e) {
      this.hideLoading();
      if (e instanceof EbookUnsupportedError) {
        this.showError({ title: e.title, message: e.message, details: `ファイル: ${name}` });
        return false;
      }
      console.error(LOG, "コミックを PDF にできませんでした", e);
      this.showError({
        title: "コミックを表示できませんでした",
        message: `画像を PDF にまとめられませんでした(${e.message || e})。`,
        details: `ファイル: ${name}`,
      });
      return false;
    }
  }

  /** 綴じ方向を変えたとき: 見開きの画像を分けていれば、新しい向きで作り直す(右綴じは右半分が先) */
  async onDirectionChanged(direction) {
    const cur = this.getCurrent();
    if (!cur.converted || !this.source || !cur.converted.split) {
      return;
    }
    if (cur.converted.direction === direction) {
      return;
    }
    const { blob, name, url } = this.source;
    const page = this.app.pdfViewer?.currentPageNumber || 1;
    const info = await inspectEbook(blob, name);
    this.app.initialBookmark = page > 1 ? `page=${page}` : null;
    await this.openComic(blob, info, { name, url, direction });
  }

  /** 元のファイル(CBZ など)を保存する */
  async saveSource() {
    if (!this.source) {
      return;
    }
    // 種類(MIME)を付けると Chrome が拡張子を変えることがあるため、種類なしで保存する
    const blob = new Blob([this.source.blob], { type: "application/octet-stream" });
    const res = await saveBlobAs(blob, sanitizeFileName(baseFileName(this.source.name)));
    if (res.ok) {
      this.toast.show("元のファイルを保存しました");
    } else if (!res.canceled) {
      this.toast.show(`保存できませんでした(${res.error || "不明なエラー"})`, { kind: "error" });
    }
  }

  /** 綴じ方向を設定の向きに戻す(コミックのあとに PDF を開くとき) */
  restoreDirection() {
    if (this.directionOverridden) {
      this.directionOverridden = false;
      const dir = this.getSettings().bindingDirection;
      if (this.book.direction !== dir) {
        this.book.setDirection(dir);
      }
    }
    this.source = null;
  }

  showLoading(text) {
    this.errorPanel.hide();
    this.emptyState.hide();
    this.toolbar.setLoading(true);
    if (this.busy) {
      this.busy.update(text);
    } else {
      this.busy = this.toast.show(text, { duration: 0 });
    }
  }

  hideLoading() {
    this.busy?.();
    this.busy = null;
    this.toolbar.setLoading(false);
  }

  showError({ title, message, details = "" }) {
    this.toolbar.setLoading(false);
    this.errorPanel.show({
      title,
      message,
      details,
      buttons: [{ label: "ほかのファイルを選んで開く", primary: true, onClick: () => this.openFilePicker() }],
    });
  }
}

function baseFileName(name) {
  const s = String(name || "").split(/[?#]/, 1)[0];
  return s.split(/[\\/]/).pop() || s;
}

function fileLabel(name) {
  const n = baseFileName(name);
  return n.length > 40 ? `${n.slice(0, 37)}…` : n || "ファイル";
}

function labelOf(format) {
  return { cbz: "コミック(CBZ)", cbr: "コミック(CBR)", cb7: "コミック(CB7)", epub: "画像の EPUB" }[format] || "コミック";
}
