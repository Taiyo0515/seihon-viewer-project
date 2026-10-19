/**
 * 元の場所のコピー(ツールバーのタイトルの右のボタン)。
 *
 * - Web の PDF: リンク(URL)をコピー / 表示中のページへのリンク(#page=N)をコピー
 * - パソコン内の PDF(file://): ファイルの場所 / フォルダの場所 / ファイル名をコピー
 * - 強制ダウンロード対策(第3層)で開いた PDF: 上に加えて、ダウンロード元のリンク・ページのリンク、フォルダを開く
 * - 「ファイルを開く」・ドラッグ&ドロップで開いた PDF: ファイル名だけ
 *   (ブラウザの決まりで、選んだファイルの場所はページには知らされない)
 */

import { PopupMenu } from "./popup.js";

/**
 * file:// の URL を、パソコン上の場所の書き方にする。
 *   file:///C:/Users/me/x.pdf → C:\Users\me\x.pdf(Windows)
 *   file://server/share/x.pdf → \\server\share\x.pdf(Windows のネットワーク上の場所)
 *   file:///home/me/x.pdf     → /home/me/x.pdf(Mac・Linux)
 */
export function filePathFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  if (u.protocol !== "file:") {
    return "";
  }
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {}
  if (u.host) {
    return `\\\\${u.host}${path.replace(/\//g, "\\")}`;
  }
  if (/^\/[A-Za-z]:(\/|$)/.test(path)) {
    return path.slice(1).replace(/\//g, "\\");
  }
  return path;
}

/** パソコン上の場所から、フォルダの場所とファイル名に分ける */
export function splitPath(path) {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (i < 0) {
    return { folder: "", name: path };
  }
  let folder = path.slice(0, i);
  // 「C:\」や「/」のような一番上のフォルダは、区切りを残す
  if (!folder || /^[A-Za-z]:$/.test(folder)) {
    folder = path.slice(0, i + 1);
  }
  return { folder, name: path.slice(i + 1) };
}

function stripHash(url) {
  const i = url.indexOf("#");
  return i >= 0 ? url.slice(0, i) : url;
}

function shorten(text, max = 64) {
  return text.length > max ? `${text.slice(0, max / 2 - 1)}…${text.slice(-(max / 2 - 1))}` : text;
}

export class SourceMenu {
  /**
   * @param {object} o
   * @param {object} o.app
   * @param {HTMLElement} o.button
   * @param {() => {kind:string|null, url:string|null, name:string|null}} o.getCurrent 開いている文書の出どころ
   * @param {() => number|null} o.getDownloadId 強制ダウンロード対策(第3層)で開いたときのダウンロードID
   * @param {object} o.toast
   */
  constructor({ app, button, getCurrent, getDownloadId, toast }) {
    this.app = app;
    this.button = button;
    this.getCurrent = getCurrent;
    this.getDownloadId = getDownloadId;
    this.toast = toast;
    /** ダウンロード元(第3層で開いたとき) */
    this.download = null;
    this.menu = new PopupMenu({ anchor: button, align: "start", items: () => this.items() });
    button.addEventListener("click", () => this.open());
    this.update();
  }

  /** 開いている文書に合わせて、ボタンの説明を変える */
  update() {
    const current = this.getCurrent();
    const kind = this.kindOf(current);
    const title =
      kind === "web"
        ? "元のリンクをコピー"
        : kind === "local"
          ? "ファイル・フォルダの場所をコピー"
          : kind === "picked"
            ? "ファイル名をコピー(選んで開いたファイルは、場所が分かりません)"
            : "元の場所をコピー";
    this.button.title = title;
    this.button.setAttribute("aria-label", title);
    this.button.disabled = !kind;
  }

  kindOf(current) {
    if (current.kind === "url" && /^https?:/i.test(current.url || "")) {
      return "web";
    }
    if (current.kind === "url" && /^file:/i.test(current.url || "")) {
      return "local";
    }
    if (current.kind === "file" || (current.kind === "data" && current.name)) {
      return "picked";
    }
    return null;
  }

  async open() {
    if (this.menu.isOpen) {
      this.menu.close();
      return;
    }
    const id = this.getDownloadId();
    if (id !== null && id !== undefined && this.download?.id !== id) {
      try {
        const [item] = await chrome.downloads.search({ id });
        this.download = item ? { id, url: item.finalUrl || item.url || "", referrer: item.referrer || "" } : { id, url: "", referrer: "" };
      } catch {
        this.download = { id, url: "", referrer: "" };
      }
    }
    this.menu.open();
  }

  items() {
    const current = this.getCurrent();
    const kind = this.kindOf(current);
    const items = [];
    if (kind === "web") {
      const url = current.url;
      items.push({ header: shorten(stripHash(url)) });
      items.push({ label: "リンクをコピー", icon: "link", hint: url, onSelect: () => this.copy(url, "リンク") });
      const page = this.app.pdfDocument ? this.app.page : 0;
      if (page > 1) {
        const pageUrl = `${stripHash(url)}#page=${page}`;
        items.push({
          label: `このページ(${page}ページ目)へのリンクをコピー`,
          icon: "link",
          hint: pageUrl,
          onSelect: () => this.copy(pageUrl, `${page}ページ目へのリンク`),
        });
      }
    } else if (kind === "local") {
      const path = filePathFromUrl(current.url);
      const { folder, name } = splitPath(path);
      items.push({ header: shorten(path) });
      items.push({ label: "ファイルの場所をコピー", icon: "file-pdf", hint: path, onSelect: () => this.copy(path, "ファイルの場所") });
      items.push({ label: "フォルダの場所をコピー", icon: "folder-open", hint: folder, onSelect: () => this.copy(folder, "フォルダの場所") });
      items.push({ label: "ファイル名をコピー", icon: "copy", hint: name, onSelect: () => this.copy(name, "ファイル名") });
      items.push({ separator: true });
      items.push({ label: "file:// のリンクをコピー", icon: "link", hint: current.url, onSelect: () => this.copy(stripHash(current.url), "リンク") });
      const dl = this.download && this.download.id === this.getDownloadId() ? this.download : null;
      if (dl) {
        items.push({ separator: true });
        if (/^https?:/i.test(dl.url)) {
          items.push({ label: "ダウンロード元のリンクをコピー", icon: "link", hint: dl.url, onSelect: () => this.copy(dl.url, "ダウンロード元のリンク") });
        }
        if (/^https?:/i.test(dl.referrer)) {
          items.push({
            label: "ダウンロードしたページのリンクをコピー",
            icon: "link",
            hint: dl.referrer,
            onSelect: () => this.copy(dl.referrer, "ダウンロードしたページのリンク"),
          });
        }
        items.push({ label: "保存されたフォルダを開く", icon: "folder-open", onSelect: () => chrome.downloads.show(dl.id) });
      }
    } else if (kind === "picked") {
      const name = current.name || this.app._docFilename || "";
      items.push({ header: shorten(name) });
      items.push({ label: "ファイル名をコピー", icon: "copy", hint: name, onSelect: () => this.copy(name, "ファイル名") });
      items.push({
        label: "場所は分かりません(ファイルを選んで開いたため)",
        icon: "info",
        disabled: true,
        hint: "「ファイルを開く」やドラッグ&ドロップで開いたファイルは、ブラウザの決まりで場所が分かりません。エクスプローラーなどでファイルをダブルクリックして開くと、場所をコピーできます。",
      });
    } else {
      items.push({ label: "コピーできる元の場所がありません", icon: "info", disabled: true });
    }
    return items;
  }

  async copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.show(`${what}をコピーしました: ${shorten(text, 80)}`, { duration: 4000 });
    } catch (e) {
      this.toast.show(`コピーできませんでした: ${e?.message || e}`, { kind: "error" });
    }
  }
}
