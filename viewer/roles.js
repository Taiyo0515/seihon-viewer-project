/**
 * ページ役割(カバーの表紙・カバーの裏表紙・表紙・裏表紙・帯・表紙の折り返し・裏表紙の折り返し・しおり)。
 *
 * 0.2 で名前を変えた(保存してある役割の id は 0.1 までと同じなので、付けた役割はそのまま引き継がれる):
 *   cover   表紙     → カバーの表紙(本の最初のページ)
 *   back    裏表紙   → カバーの裏表紙(本の最後のページ)
 *   obiFront 帯表紙  → 表紙
 *   obiBack 帯裏表紙 → 裏表紙
 *   obi     帯       → 帯(製本用PDF出力の画面で、複数のページを選べる)
 * 0.2 で追加: flapFront 表紙の折り返し / flapBack 裏表紙の折り返し / bookmark しおり
 * カバー以外の役割のページは「付属」として、本体とは別に出力する(使い道は設定で変えられる)。
 *
 * - 1ページに付けられる役割は1つ。同じ役割を複数のページに付けられる(表紙の候補が2枚ある場合など)。
 * - PDF ごとに保存し、同じ PDF を再び開くと復元する。PDF は URL ではなく内容の指紋で見分ける。
 * - サムネイルに役割のバッジを出す。
 * - 役割は元の PDF のページ番号で保存する。ページを削除した後も、役割はそのページに付いたまま
 *   (表示上のページ番号との対応は page-map.js)。
 */

import { deleteRoles, getRoles, onDataChanged, putRoles } from "../common/db.js";
import { sourceIndex, viewPageCount, viewPageNumber } from "./page-map.js";

export const ROLES = Object.freeze([
  { id: "cover", label: "カバーの表紙", short: "カバー表" },
  { id: "back", label: "カバーの裏表紙", short: "カバー裏" },
  { id: "obiFront", label: "表紙", short: "表紙" },
  { id: "obiBack", label: "裏表紙", short: "裏表紙" },
  { id: "obi", label: "帯", short: "帯" },
  { id: "flapFront", label: "表紙の折り返し", short: "表折返" },
  { id: "flapBack", label: "裏表紙の折り返し", short: "裏折返" },
  { id: "bookmark", label: "しおり", short: "しおり" },
]);

export const ROLE_LABEL = Object.freeze(Object.fromEntries(ROLES.map(r => [r.id, r.label])));
export const ROLE_SHORT = Object.freeze(Object.fromEntries(ROLES.map(r => [r.id, r.short])));

export class PageRoles {
  /**
   * @param {object} o
   * @param {object} o.app
   * @param {object} o.docSource
   * @param {object} o.toast
   */
  constructor({ app, docSource, toast }) {
    this.app = app;
    this.docSource = docSource;
    this.toast = toast;
    /** 元の PDF の 0始まりのページ番号 → 役割 */
    this.map = new Map();
    /** 表示中の PDF の指紋(保存のキー) */
    this.key = null;
    /** map が表している文書 */
    this.doc = null;
    /** 保存済みの役割を読み込み終えた文書 */
    this.loadedDoc = null;
    this.listeners = new Set();
    /**
     * 読み込み・変更・保存を1つずつ順に行うための列。
     * 保存の通知で読み直す処理が、後から行った変更を古い内容で上書きしないようにする。
     */
    this.queue = Promise.resolve();
    this.thumbs = document.getElementById("thumbnailsView");
    app.eventBus.on("documentloaded", () => this.load());
    app.eventBus.on("pagesinit", () => {
      if (this.app.pdfDocument !== this.doc) {
        this.resetFor(this.app.pdfDocument);
      }
    });
    onDataChanged(({ kind }) => {
      if (kind === "roles" && this.key) {
        this.reload();
      }
    });
    // サムネイルが作り直されたらバッジを付け直す
    new MutationObserver(() => this.applyBadges()).observe(this.thumbs, { childList: true });
    // ページを削除・元に戻したら、表示上のページ番号が変わるので知らせ直す
    app.eventBus.on("pagesedited", ({ type }) => {
      if (type !== "copy" && type !== "cancelCopy" && type !== "cleanSavedData") {
        this.emit();
      }
    });
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.applyBadges();
    for (const fn of this.listeners) {
      fn(this.map);
    }
  }

  /** 処理を列の最後に加え、前の処理が終わってから行う */
  serial(fn) {
    const run = this.queue.then(() => fn());
    this.queue = run.catch(() => {});
    return run;
  }

  /** 別の文書に切り替わったので、表示中の役割を空にする */
  resetFor(doc) {
    this.doc = doc;
    this.loadedDoc = null;
    this.key = null;
    this.map.clear();
    this.emit();
  }

  /** 文書を開いたら、保存されている役割を読み込む(指紋の計算を待つ) */
  load() {
    const doc = this.app.pdfDocument;
    if (doc !== this.doc) {
      this.resetFor(doc);
    }
    if (!doc) {
      return Promise.resolve();
    }
    return this.serial(async () => {
      try {
        await this.ensureLoaded(doc);
      } catch (e) {
        console.warn("[製本ビューア] ページ役割を読み込めませんでした", e);
      }
    });
  }

  /**
   * この文書の保存済みの役割を読み込んだ状態にする(列の中で呼ぶ)。
   * 「文書を開いた」の知らせより先に役割を付けられたときも、保存済みの役割を先に読み込んでから付け加える。
   * @returns {Promise<boolean>} 文書が切り替わっていたら false
   */
  async ensureLoaded(doc) {
    if (doc !== this.app.pdfDocument) {
      return false;
    }
    if (this.loadedDoc === doc && this.key) {
      return true;
    }
    if (doc !== this.doc) {
      this.resetFor(doc);
    }
    const key = await this.docSource.key(doc);
    if (doc !== this.app.pdfDocument) {
      return false;
    }
    this.key = key;
    await this.readStored();
    if (doc !== this.app.pdfDocument) {
      return false;
    }
    this.loadedDoc = doc;
    return true;
  }

  /** 表示中の文書の保存済みの役割を読み込み終えるのを待つ */
  whenLoaded() {
    const doc = this.app.pdfDocument;
    if (!doc) {
      return Promise.resolve(false);
    }
    return this.serial(() => this.ensureLoaded(doc));
  }

  /** 保存されている役割を読み直す(ほかの画面で変えられたときなど) */
  reload() {
    return this.serial(() => this.readStored());
  }

  async readStored() {
    const key = this.key;
    const rec = key ? await getRoles(key) : null;
    if (!key || key !== this.key) {
      return;
    }
    this.map.clear();
    const n = this.app.pdfDocument?.numPages || 0;
    for (const [index, role] of Object.entries(rec?.roles || {})) {
      const i = Number(index);
      if (Number.isInteger(i) && i >= 0 && i < n && ROLE_LABEL[role]) {
        this.map.set(i, role);
      }
    }
    this.emit();
  }

  /** 表示上のページ(1始まり)の役割。無ければ null */
  get(pageNumber) {
    return this.map.get(sourceIndex(this.app.pdfDocument, pageNumber)) || null;
  }

  /**
   * 表示上のページ番号(0始まり)→ 役割。削除したページの役割は含めない。
   * 製本用PDF出力の計画は、表示しているページの並びで立てる。
   */
  viewMap() {
    const doc = this.app.pdfDocument;
    const out = new Map();
    for (const [index, role] of this.map) {
      const n = viewPageNumber(doc, index);
      if (n > 0) {
        out.set(n - 1, role);
      }
    }
    return out;
  }

  /** 役割の付いたページ(表示上のページ番号、1始まり、昇順)。削除したページは含めない */
  pages(roleId) {
    return [...this.viewMap().entries()]
      .filter(([, r]) => r === roleId)
      .map(([i]) => i + 1)
      .sort((a, b) => a - b);
  }

  /** 表示しているページのうち、役割の付いたページの数 */
  get size() {
    return this.viewMap().size;
  }

  /**
   * 役割を付ける/外す。
   * @param {number[]} pageNumbers 表示上のページ番号(1始まり)
   * @param {string|null} roleId null で外す
   * @param {{quiet?:boolean}} [opts] quiet: 知らせを出さない
   */
  set(pageNumbers, roleId, opts = {}) {
    const doc = this.app.pdfDocument;
    const count = viewPageCount(doc);
    const valid = [...new Set(pageNumbers)].filter(n => Number.isInteger(n) && n >= 1 && n <= count);
    if (!doc || !valid.length) {
      return Promise.resolve();
    }
    // 表示上のページ番号は、削除・元に戻すで変わるので、いまの時点で元のページ番号にしておく
    const items = valid.map(n => ({ n, index: sourceIndex(doc, n) }));
    return this.serial(() => this.setNow(doc, items, roleId, opts));
  }

  /**
   * いくつかのページの役割をまとめて変える(製本用PDF出力の画面から)。
   * @param {Array<{pages:number[], role:string|null}>} changes 表示上のページ番号
   */
  setMany(changes, opts = {}) {
    const doc = this.app.pdfDocument;
    if (!doc) {
      return Promise.resolve();
    }
    const list = changes.map(c => ({ role: c.role, items: c.pages.map(n => ({ n, index: sourceIndex(doc, n) })) }));
    return this.serial(async () => {
      for (const c of list) {
        if (c.items.length) {
          await this.setNow(doc, c.items, c.role, { ...opts, quiet: true });
        }
      }
    });
  }

  async setNow(doc, items, roleId, { quiet = false } = {}) {
    try {
      if (!(await this.ensureLoaded(doc))) {
        return;
      }
    } catch (e) {
      this.toast.show(`ページ役割を保存できませんでした: ${e.message || e}`, { kind: "error" });
      return;
    }
    const key = this.key;
    for (const { index } of items) {
      if (roleId) {
        this.map.set(index, roleId);
      } else {
        this.map.delete(index);
      }
    }
    this.emit();
    try {
      if (this.map.size) {
        await putRoles({
          pdfKey: key,
          name: this.docSource.displayName(),
          pages: doc.numPages,
          roles: Object.fromEntries([...this.map.entries()].map(([i, r]) => [String(i), r])),
        });
      } else {
        await deleteRoles(key);
      }
    } catch (e) {
      this.toast.show(`ページ役割を保存できませんでした: ${e.message || e}`, { kind: "error" });
      return;
    }
    if (quiet) {
      return;
    }
    const what = items.length === 1 ? `${items[0].n}ページ目` : `${items.length}ページ`;
    this.toast.show(roleId ? `${what}を「${ROLE_LABEL[roleId]}」にしました` : `${what}の役割を外しました`, { duration: 2500 });
  }

  /**
   * 編集した PDF を保存したとき、その PDF(内容が違うので指紋も違う)にも役割を写す。
   * 保存した PDF を開き直したときにも、表紙・帯などの役割が残るようにする。
   * @param {string} newKey 保存した PDF の指紋
   * @param {string} name 保存した PDF の名前
   * @param {number} pageCount 保存した PDF のページ数(= 表示しているページ数)
   */
  async copyToSaved(newKey, name, pageCount) {
    const view = this.viewMap();
    if (!view.size || !newKey || newKey === this.key) {
      return;
    }
    await putRoles({
      pdfKey: newKey,
      name,
      pages: pageCount,
      roles: Object.fromEntries([...view.entries()].map(([i, r]) => [String(i), r])),
    });
  }

  /** すべての役割を外す */
  clear() {
    return this.serial(async () => {
      const doc = this.app.pdfDocument;
      if (!doc || !(await this.ensureLoaded(doc))) {
        return;
      }
      this.map.clear();
      this.emit();
      await deleteRoles(this.key);
    });
  }

  /** サムネイルに役割のバッジを付ける */
  applyBadges() {
    const doc = this.app.pdfDocument;
    for (const thumb of this.thumbs.querySelectorAll(".thumbnail[page-number]")) {
      const n = Number(thumb.getAttribute("page-number"));
      const role = (doc && this.map.get(sourceIndex(doc, n))) || null;
      let badge = thumb.querySelector(":scope > .sh-role-badge");
      if (!role) {
        badge?.remove();
        continue;
      }
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "sh-role-badge";
        thumb.prepend(badge);
      }
      badge.dataset.role = role;
      badge.textContent = ROLE_SHORT[role];
      badge.title = `ページ役割: ${ROLE_LABEL[role]}`;
    }
  }
}
