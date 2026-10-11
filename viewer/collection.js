/**
 * ページ収集(裏で溜めておき、まとめて取り出す)。
 *
 * - 収集の内容は IndexedDB に保存するので、ブラウザを閉じても残る。複数の PDF をまたげる。
 * - 元の PDF のデータも保存する(同じ PDF は内容の指紋で見分けて1回だけ保存)。
 * - どのタブで変更しても、開いているすべてのビューアの表示が更新される。
 */

import {
  addCollectionItems,
  clearCollection,
  getCollection,
  getPdfBytes,
  onDataChanged,
  removeCollectionItems,
} from "../common/db.js";
import { baseName } from "../common/files.js";
import { sourceIndex, viewPageCount } from "./page-map.js";

export class Collection {
  /**
   * @param {object} o
   * @param {object} o.app
   * @param {object} o.docSource
   * @param {object} o.aiCopy
   * @param {object} o.toast
   * @param {() => object} o.getSettings
   * @param {() => void} o.onShowPanel 「収集を表示」が押されたとき
   */
  constructor({ app, docSource, aiCopy, toast, getSettings, onShowPanel }) {
    this.app = app;
    this.docSource = docSource;
    this.aiCopy = aiCopy;
    this.toast = toast;
    this.getSettings = getSettings;
    this.onShowPanel = onShowPanel;
    this.items = [];
    this.listeners = new Set();
    this.ready = this.refresh();
    onDataChanged(({ kind }) => {
      if (kind === "collection") {
        this.refresh();
      }
    });
  }

  async refresh() {
    try {
      this.items = await getCollection();
    } catch (e) {
      console.error("[製本ビューア] 収集を読み込めませんでした", e);
      this.items = [];
    }
    for (const fn of this.listeners) {
      fn(this.items);
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get count() {
    return this.items.length;
  }

  /** 指定の PDF のページが収集済みか */
  has(pdfKey, pageIndex) {
    return this.items.some(i => i.pdfKey === pdfKey && i.pageIndex === pageIndex);
  }

  pageLabel(pageNumber) {
    const label = this.app.pdfViewer?.getPageView?.(pageNumber - 1)?.pageLabel;
    return label && label !== String(pageNumber) ? label : "";
  }

  /** 開いている PDF の表示上のページ(1始まり)が収集済みか */
  hasCurrentPage(pdfKey, pageNumber) {
    return this.has(pdfKey, sourceIndex(this.app.pdfDocument, pageNumber));
  }

  /**
   * 開いている PDF のページを収集に追加する。
   * 収集には元の PDF のデータを保存するので、ページは元の PDF のページ番号で記録する
   * (ページを削除した後でも、表示しているページそのものが収集される)。
   * @param {number[]} pageNumbers 表示上のページ番号(1始まり)
   */
  async addCurrentPages(pageNumbers) {
    const doc = this.app.pdfDocument;
    const count = viewPageCount(doc);
    const unique = [...new Set(pageNumbers)].filter(n => n >= 1 && n <= count);
    if (!doc || !unique.length) {
      return false;
    }
    // 表示上のページ番号は削除・元に戻すで変わるので、先に元のページ番号にしておく
    const sourceOf = new Map(unique.map(n => [n, sourceIndex(doc, n)]));
    // 大きな PDF は指紋の計算と保存に少し時間がかかるので、その間は表示を出す
    let busy = null;
    const timer = setTimeout(() => {
      busy = this.toast.show("収集に追加しています…", { duration: 0 });
    }, 300);
    const stopBusy = () => {
      clearTimeout(timer);
      busy?.();
      busy = null;
    };
    try {
      const key = await this.docSource.ensureStored();
      if (!key) {
        stopBusy();
        return false;
      }
      await this.ready;
      await this.refresh();
      const existing = new Set(this.items.filter(i => i.pdfKey === key).map(i => i.pageIndex));
      const toAdd = unique.filter(n => !existing.has(sourceOf.get(n)));
      const skipped = unique.length - toAdd.length;
      if (toAdd.length) {
        await addCollectionItems(
          key,
          this.docSource.displayName(),
          toAdd.map(n => ({ pageIndex: sourceOf.get(n), label: this.pageLabel(n) }))
        );
        await this.refresh();
      }
      stopBusy();
      let message;
      if (!toAdd.length) {
        message = unique.length === 1 ? `${unique[0]}ページ目はすでに収集にあります` : "選んだページはすべて収集済みです";
      } else {
        const what = toAdd.length === 1 ? `${toAdd[0]}ページ目` : `${toAdd.length}ページ`;
        message = `${what}を収集に追加しました(収集: 全${this.count}ページ)`;
        if (skipped) {
          message += `。${skipped}ページはすでに収集済みのため追加していません`;
        }
      }
      this.toast.show(message, { action: { label: "収集を表示", onClick: () => this.onShowPanel() } });
      return toAdd.length > 0;
    } catch (e) {
      stopBusy();
      console.error(e);
      this.toast.show(`収集に追加できませんでした: ${e.message || e}`, { kind: "error", duration: 8000 });
      return false;
    }
  }

  /** 開いている PDF のページ(表示上のページ番号)を収集から外す */
  async removeCurrentPage(pageNumber) {
    const key = await this.docSource.key();
    const index = sourceIndex(this.app.pdfDocument, pageNumber);
    const ids = this.items.filter(i => i.pdfKey === key && i.pageIndex === index).map(i => i.id);
    if (ids.length) {
      await removeCollectionItems(ids);
      this.toast.show(`${pageNumber}ページ目を収集から外しました`);
    }
  }

  /**
   * 収集したページを書き出す。
   * @param {"pdf"|"zip"} format
   */
  async exportAll(format) {
    await this.ready;
    await this.refresh();
    const items = this.items;
    if (!items.length) {
      this.toast.show("収集したページがありません");
      return false;
    }
    const bytesByKey = new Map();
    const missing = [];
    for (const item of items) {
      if (bytesByKey.has(item.pdfKey)) {
        continue;
      }
      const bytes = await getPdfBytes(item.pdfKey);
      if (bytes) {
        bytesByKey.set(item.pdfKey, bytes);
      } else {
        missing.push(item.name);
      }
    }
    const pages = items
      .filter(i => bytesByKey.has(i.pdfKey))
      .map(i => ({ source: bytesByKey.get(i.pdfKey), pageIndex: i.pageIndex, name: baseName(i.name) }));
    if (missing.length) {
      this.toast.show(`元の PDF のデータが見つからないページを除いて書き出します(${[...new Set(missing)].join("、")})`, {
        kind: "error",
        duration: 8000,
      });
    }
    if (!pages.length) {
      return false;
    }
    const ok = await this.aiCopy.saveMultiple(pages, format);
    if (ok && this.getSettings().collectClearAfterExport) {
      await clearCollection();
      this.toast.show("書き出したので、収集を空にしました(詳細設定で変更できます)");
    }
    return ok;
  }
}

/**
 * 「3-7, 10」のようなページ範囲の指定を読み取る。
 * 全角数字・「、」「〜」なども受け付ける。「5-」は5ページ目から最後まで、「-3」は最初から3ページ目まで。
 * @returns {{pages:number[], error:string|null}}
 */
export function parsePageRanges(text, numPages) {
  const s = String(text || "")
    .normalize("NFKC")
    .replace(/[〜~ー－–—]/g, "-")
    .replace(/[、,;]/g, " ")
    .replace(/\s*-\s*/g, "-")
    .trim();
  if (!s) {
    return { pages: [], error: "ページを指定してください(例: 3-7, 10)" };
  }
  const pages = [];
  const seen = new Set();
  for (const token of s.split(/\s+/)) {
    const m = token.match(/^(\d*)\s*-\s*(\d*)$/);
    let from;
    let to;
    if (/^\d+$/.test(token)) {
      from = to = Number(token);
    } else if (m && (m[1] || m[2])) {
      from = m[1] ? Number(m[1]) : 1;
      to = m[2] ? Number(m[2]) : numPages;
    } else {
      return { pages: [], error: `「${token}」を読み取れません(例: 3-7, 10)` };
    }
    if (from < 1 || to < 1 || from > numPages || to > numPages) {
      return { pages: [], error: `ページは 1〜${numPages} の範囲で指定してください(「${token}」)` };
    }
    const step = from <= to ? 1 : -1;
    for (let n = from; step > 0 ? n <= to : n >= to; n += step) {
      if (!seen.has(n)) {
        seen.add(n);
        pages.push(n);
      }
    }
  }
  return { pages, error: null };
}
