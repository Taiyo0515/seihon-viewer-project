/**
 * サムネイル(サイドバー)のページの選択と、選んだページの操作。
 *
 * - サムネイルの上にマウスを置くと、左上に丸(選択)、右上に ✕(このページを削除)が出る。
 * - 見出しの「選択」を押すと選択の状態になり、各サムネイルの左上に丸が出る。押すとチェックが付き、
 *   選んだページをまとめて削除・役割(表紙・帯など)の指定・AI用コピー・収集への追加ができる。
 *   選択の状態では、サムネイルを押すとページへ移動せずに選択/解除する(Shift+クリックで範囲)。
 * - 選択の状態でなくても、Ctrl(Mac は ⌘)+クリックで1ページずつ、Shift+クリックで範囲で選べる。
 * - Delete キーで、選んだページ(選んでいなければフォーカスのあるページ)を削除する。
 * - 削除の直後は「元に戻す」を出す。
 */

import { hydrateIcons, setIcon } from "../icons.js";

export class ThumbSelection {
  /**
   * @param {object} app
   * @param {object} o
   * @param {(pages:number[]) => void} o.onCopy
   * @param {(pages:number[]) => void} o.onCollect
   * @param {(pages:number[]) => Promise<boolean>} [o.onDelete]
   * @param {(pages:number[], anchor:HTMLElement) => void} [o.onRoles]
   * @param {object} [o.editor] PageEditor(「元に戻す」の表示)
   */
  constructor(app, { onCopy, onCollect, onDelete = null, onRoles = null, editor = null }) {
    this.app = app;
    this.onDelete = onDelete;
    this.onRoles = onRoles;
    this.editor = editor;
    this.selected = new Set();
    this.anchor = null;
    this.selectMode = false;
    this.manager = document.getElementById("viewsManager");
    this.view = document.getElementById("thumbnailsView");
    this.content = document.getElementById("viewsManagerContent") || this.view.parentElement;
    this.bar = document.getElementById("shThumbSelectBar");
    this.barText = document.getElementById("shThumbSelectText");
    this.header = document.getElementById("shThumbHeader");
    this.headerTitle = document.getElementById("shThumbHeaderTitle");
    this.modeButton = document.getElementById("shThumbSelectMode");
    this.modeText = document.getElementById("shThumbSelectModeText");
    this.allButton = document.getElementById("shThumbSelectAll");
    this.undoBar = document.getElementById("shThumbUndoBar");
    this.undoText = document.getElementById("shThumbUndoText");

    document.getElementById("shThumbSelectCopy").addEventListener("click", () => onCopy(this.pages()));
    document.getElementById("shThumbSelectCollect").addEventListener("click", () => onCollect(this.pages()));
    document.getElementById("shThumbSelectClear").addEventListener("click", () => this.clear());
    document.getElementById("shThumbSelectDelete").addEventListener("click", () => this.deletePages(this.pages()));
    const rolesButton = document.getElementById("shThumbSelectRoles");
    rolesButton.addEventListener("click", () => this.onRoles?.(this.pages(), rolesButton));
    this.modeButton.addEventListener("click", () => this.setSelectMode(!this.selectMode));
    document.getElementById("shThumbSelectDone").addEventListener("click", () => this.setSelectMode(false));
    this.allButton.addEventListener("click", () => {
      const count = this.pageCount();
      if (this.selected.size >= count) {
        this.clear();
      } else {
        this.selectRange(1, count);
      }
    });
    document.getElementById("shThumbUndo").addEventListener("click", () => this.editor?.undoDelete());

    // PDF.js のクリック処理(ページ移動)より先に受け取る
    this.content.addEventListener("click", e => this.onClick(e), true);
    // PDF.js のサムネイルのドラッグ(ページの並べ替え)は使わない(取り消せないため)
    this.content.addEventListener(
      "pointerdown",
      e => {
        if (e.target.closest?.("#thumbnailsView")) {
          e.stopPropagation();
        }
      },
      true
    );
    this.content.addEventListener("keydown", e => this.onKeyDown(e), true);

    // 新しい文書を開いたら選択を解除する
    app.eventBus.on("pagesinit", () => {
      this.setSelectMode(false);
      this.clear();
      this.updateHeader();
    });
    app.eventBus.on("pagesloaded", () => this.updateHeader());
    // ページを削除・元に戻すと番号が変わるので、選択は解除する
    app.eventBus.on("pagesedited", ({ type }) => {
      if (type !== "copy" && type !== "cancelCopy" && type !== "cleanSavedData") {
        this.selected.clear();
        this.anchor = null;
        this.apply();
        this.updateHeader();
      }
    });
    // サムネイルの一覧か、しおりなどか
    app.eventBus.on("sidebarviewchanged", ({ view }) => this.onViewChanged(view));
    editor?.onChange(() => this.updateUndo());
    // PDF.js がサムネイルを作り直したときも、選択の表示と操作ボタンを付け直す
    new MutationObserver(() => this.apply()).observe(this.view, { childList: true });
    hydrateIcons(this.header);
    this.onViewChanged(app.viewsManager?.visibleView ?? 0);
    this.updateHeader();
    this.updateUndo();
  }

  get size() {
    return this.selected.size;
  }

  has(n) {
    return this.selected.has(n);
  }

  /** 選択中のページ(昇順) */
  pages() {
    return [...this.selected].sort((a, b) => a - b);
  }

  pageCount() {
    return this.app.pdfViewer?.pagesCount || 0;
  }

  toggle(n) {
    if (this.selected.has(n)) {
      this.selected.delete(n);
    } else {
      this.selected.add(n);
    }
    this.apply();
  }

  /** 1ページを選択状態にする(右クリックしたページなど) */
  select(n, { add = false } = {}) {
    if (!add) {
      this.selected.clear();
    }
    this.selected.add(n);
    this.anchor = n;
    this.apply();
  }

  selectRange(from, to) {
    const [a, b] = from <= to ? [from, to] : [to, from];
    const count = this.pageCount();
    for (let n = Math.max(1, a); n <= Math.min(b, count); n++) {
      this.selected.add(n);
    }
    this.apply();
  }

  clear() {
    this.selected.clear();
    this.apply();
  }

  /** 選択の状態にする/やめる */
  setSelectMode(on) {
    on = !!on && !!this.app.pdfDocument;
    if (this.selectMode === on) {
      this.updateHeader();
      return;
    }
    this.selectMode = on;
    if (!on) {
      this.selected.clear();
    }
    this.apply();
    this.updateHeader();
  }

  onViewChanged(view) {
    // 0 = 閉じている(そのときは、開いたときに出る一覧で判断する)、1 = サムネイル
    const active = view ? view : this.app.viewsManager?.active;
    const thumbs = (active ?? 1) === 1;
    this.manager.classList.toggle("sh-view-thumbs", thumbs);
    if (!thumbs && this.selectMode) {
      this.setSelectMode(false);
    }
  }

  // -------------------------------------------------------------------------
  // 操作
  // -------------------------------------------------------------------------

  onClick(e) {
    const target = e.target;
    // PDF.js のチェックボックス(削除のときにこちらから操作する。画面には出していない)
    if (target instanceof HTMLInputElement && target.type === "checkbox") {
      return;
    }
    const thumb = target.closest?.("#thumbnailsView .thumbnail[page-number]");
    if (!thumb) {
      return;
    }
    const n = Number(thumb.getAttribute("page-number"));
    if (target.closest(".sh-thumb-del")) {
      e.preventDefault();
      e.stopPropagation();
      this.deletePages([n]);
      return;
    }
    if (target.closest(".sh-thumb-check")) {
      e.preventDefault();
      e.stopPropagation();
      if (!this.selectMode) {
        // 丸を押したら選択の状態にする
        this.setSelectMode(true);
      }
      if (e.shiftKey && this.anchor) {
        this.selectRange(this.anchor, n);
      } else {
        this.toggle(n);
      }
      this.anchor = n;
      this.updateHeader();
      return;
    }
    if (this.selectMode) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey && this.anchor) {
        this.selectRange(this.anchor, n);
      } else {
        this.toggle(n);
      }
      this.anchor = n;
      this.updateHeader();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      this.toggle(n);
      this.anchor = n;
    } else if (e.shiftKey) {
      this.selectRange(this.anchor ?? this.app.page ?? n, n);
    } else {
      if (this.selected.size) {
        this.clear();
      }
      this.anchor = n;
      return; // 普通のクリックはページ移動(PDF.js に任せる)
    }
    e.preventDefault();
    e.stopPropagation();
  }

  onKeyDown(e) {
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
      return;
    }
    if (e.key === "Escape" && (this.selected.size || this.selectMode)) {
      e.preventDefault();
      e.stopPropagation();
      if (this.selectMode) {
        this.setSelectMode(false);
      } else {
        this.clear();
      }
      return;
    }
    // 選択の状態では、Space / Enter でフォーカスのあるページを選択/解除する(ページへは移動しない)
    if (this.selectMode && (e.key === " " || e.key === "Enter") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const focused = t?.closest?.("#thumbnailsView .thumbnail[page-number]");
      if (focused) {
        e.preventDefault();
        e.stopPropagation();
        const n = Number(focused.getAttribute("page-number"));
        if (e.shiftKey && this.anchor) {
          this.selectRange(this.anchor, n);
        } else {
          this.toggle(n);
        }
        this.anchor = n;
        return;
      }
    }
    if ((e.key === "Delete" || e.key === "Backspace") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (!t?.closest?.("#thumbnailsView")) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (this.selected.size) {
        this.deletePages(this.pages());
        return;
      }
      const focused = t.closest(".thumbnail[page-number]");
      if (focused) {
        this.deletePages([Number(focused.getAttribute("page-number"))]);
      }
      return;
    }
    // PDF.js のサムネイルのコピー・切り取り・貼り付け(ページの複製)は使わない
    if ((e.ctrlKey || e.metaKey) && /^[cxv]$/i.test(e.key) && t?.closest?.("#thumbnailsView")) {
      e.stopPropagation();
    }
  }

  async deletePages(pages) {
    if (!pages.length || !this.onDelete) {
      return;
    }
    const ok = await this.onDelete(pages);
    if (ok && this.selectMode && this.pageCount() <= 1) {
      this.setSelectMode(false);
    }
  }

  // -------------------------------------------------------------------------
  // 表示
  // -------------------------------------------------------------------------

  /** サムネイルごとの丸(選択)と ✕(削除)を付け、選択の表示を合わせる */
  apply() {
    this.manager.classList.toggle("sh-select-mode", this.selectMode);
    for (const thumb of this.view.querySelectorAll(".thumbnail[page-number]")) {
      const n = Number(thumb.getAttribute("page-number"));
      const on = this.selected.has(n);
      this.ensureControls(thumb, n);
      thumb.classList.toggle("sh-thumb-selected", on);
      thumb.querySelector(".thumbnailImageContainer")?.setAttribute("aria-selected", on ? "true" : "false");
      const check = thumb.querySelector(":scope > .sh-thumb-check");
      check.setAttribute("aria-checked", on ? "true" : "false");
    }
    const count = this.selected.size;
    this.bar.hidden = count === 0;
    this.barText.textContent = `${count}ページ`;
    this.barText.title = `${count}ページを選択中`;
    const deleteButton = document.getElementById("shThumbSelectDelete");
    const all = count >= this.pageCount();
    deleteButton.disabled = all || !this.onDelete;
    deleteButton.title = all ? "すべてのページは削除できません" : "選んだページを削除 (Delete)";
    this.updateHeader();
  }

  ensureControls(thumb, n) {
    let check = thumb.querySelector(":scope > .sh-thumb-check");
    if (!check) {
      check = document.createElement("button");
      check.type = "button";
      check.className = "sh-thumb-check";
      check.tabIndex = -1;
      check.setAttribute("role", "checkbox");
      setIcon(check, "check");
      thumb.append(check);
    }
    let del = thumb.querySelector(":scope > .sh-thumb-del");
    if (!del) {
      del = document.createElement("button");
      del.type = "button";
      del.className = "sh-thumb-del";
      del.tabIndex = -1;
      setIcon(del, "close");
      thumb.append(del);
    }
    // ページ番号はページを削除すると変わるので、毎回付け直す
    check.setAttribute("aria-label", `${n}ページ目を選択`);
    check.title = `${n}ページ目を選択`;
    del.setAttribute("aria-label", `${n}ページ目を削除`);
    del.title = "このページを削除";
    del.hidden = !this.onDelete;
  }

  updateHeader() {
    const count = this.pageCount();
    const hasDoc = !!this.app.pdfDocument && count > 0;
    this.headerTitle.textContent = hasDoc ? `${count}ページ` : "";
    this.modeButton.disabled = !hasDoc;
    this.modeButton.setAttribute("aria-pressed", this.selectMode ? "true" : "false");
    this.header.classList.toggle("sh-selecting", this.selectMode);
    const n = this.selected.size;
    this.modeText.textContent = n ? `${n}ページ` : "ページを選んでください";
    this.allButton.textContent = hasDoc && n >= count ? "選択を解除" : "すべて選択";
  }

  updateUndo() {
    const pending = this.editor?.pendingDelete;
    this.undoBar.hidden = !pending;
    if (pending) {
      this.undoText.textContent = `${pending.what}を削除`;
      this.undoText.title = `${pending.what}を削除しました。「元に戻す」で戻せます`;
    }
  }
}
