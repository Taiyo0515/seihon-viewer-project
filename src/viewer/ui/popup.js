/**
 * ポップアップメニューとポップオーバー(Chrome 標準ビューアのメニューに似せた見た目)。
 *
 * PopupMenu: 項目の一覧。キーボード操作(↑↓ Home End Enter Esc)に対応。
 * Popover:   任意の中身(注釈の色・太さなど)を出す吹き出し。
 */

import { createIcon } from "../icons.js";

const layer = () => document.getElementById("shPopupLayer");
let openPopup = null;

/** いま開いているメニュー・吹き出しを閉じる */
export function closeOpenPopup() {
  openPopup?.close();
}

function positionNear(el, anchor, align) {
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  el.style.visibility = "hidden";
  el.style.left = "0px";
  el.style.top = "0px";
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = align === "start" ? r.left : align === "center" ? r.left + r.width / 2 - w / 2 : r.right - w;
  left = Math.max(8, Math.min(left, vw - w - 8));
  let top = r.bottom + 4;
  if (top + h > vh - 8) {
    top = Math.max(8, r.top - h - 4);
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.maxHeight = `${vh - 16}px`;
  el.style.visibility = "";
}

class BasePopup {
  constructor({ anchor, align = "end", className = "", onClose = null }) {
    this.anchor = anchor;
    this.align = align;
    this.onClose = onClose;
    this.el = document.createElement("div");
    this.el.className = `sh-popup ${className}`.trim();
    this.el.hidden = true;
    this._onDocPointer = e => {
      if (!this.el.contains(e.target) && !this.anchor.contains(e.target)) {
        this.close();
      }
    };
    this._onKey = e => this.onKeyDown(e);
    this._onResize = () => this.close();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    if (this.isOpen) {
      return;
    }
    if (openPopup && openPopup !== this) {
      openPopup.close();
    }
    this.render();
    layer().append(this.el);
    this.el.hidden = false;
    positionNear(this.el, this.anchor, this.align);
    this.anchor.setAttribute("aria-expanded", "true");
    this.anchor.classList.add("sh-active");
    openPopup = this;
    // 開いたクリックで閉じないよう、次の周回から監視
    setTimeout(() => {
      document.addEventListener("pointerdown", this._onDocPointer, true);
    });
    document.addEventListener("keydown", this._onKey, true);
    window.addEventListener("resize", this._onResize);
    window.addEventListener("blur", this._onResize);
    this.afterOpen();
  }

  close() {
    if (!this.isOpen) {
      return;
    }
    this.el.hidden = true;
    this.el.remove();
    this.anchor.setAttribute("aria-expanded", "false");
    this.anchor.classList.remove("sh-active");
    document.removeEventListener("pointerdown", this._onDocPointer, true);
    document.removeEventListener("keydown", this._onKey, true);
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("blur", this._onResize);
    if (openPopup === this) {
      openPopup = null;
    }
    this.onClose?.();
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  render() {}
  afterOpen() {}

  onKeyDown(e) {
    if (e.key === "Escape") {
      // 吹き出しの外で文字を入力中(注釈のテキスト入力など)の Esc は横取りしない
      const active = document.activeElement;
      if (active && !this.el.contains(active) && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.close();
      this.anchor.focus();
    }
  }
}

/**
 * items: [
 *   { label, icon?, checked?, radio?, disabled?, shortcut?, hint?, onSelect },
 *   { separator: true },
 *   { header: "見出し" },
 * ]
 * items に関数を渡すと、開くたびに呼んで最新の状態で作り直す。
 */
export class PopupMenu extends BasePopup {
  constructor(options) {
    super({ ...options, className: `sh-menu ${options.className || ""}` });
    this.items = options.items;
    this.el.setAttribute("role", "menu");
  }

  render() {
    const items = typeof this.items === "function" ? this.items() : this.items;
    this.el.textContent = "";
    this.buttons = [];
    const hasChecks = items.some(it => "checked" in it);
    for (const item of items) {
      if (item.separator) {
        const hr = document.createElement("div");
        hr.className = "sh-menu-sep";
        hr.setAttribute("role", "separator");
        this.el.append(hr);
        continue;
      }
      if (item.header) {
        const h = document.createElement("div");
        h.className = "sh-menu-header";
        h.textContent = item.header;
        this.el.append(h);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sh-menu-item";
      btn.tabIndex = -1;
      btn.disabled = !!item.disabled;
      if ("checked" in item) {
        btn.setAttribute("role", item.radio ? "menuitemradio" : "menuitemcheckbox");
        btn.setAttribute("aria-checked", item.checked ? "true" : "false");
      } else {
        btn.setAttribute("role", "menuitem");
      }
      if (hasChecks) {
        const check = document.createElement("span");
        check.className = "sh-menu-check";
        if (item.checked) {
          check.append(createIcon("check"));
        }
        btn.append(check);
      }
      if (item.icon) {
        const ic = document.createElement("span");
        ic.className = "sh-menu-icon";
        ic.append(createIcon(item.icon));
        btn.append(ic);
      }
      const label = document.createElement("span");
      label.className = "sh-menu-label";
      label.textContent = item.label;
      btn.append(label);
      if (item.shortcut) {
        const sc = document.createElement("span");
        sc.className = "sh-menu-shortcut";
        sc.textContent = item.shortcut;
        btn.append(sc);
      }
      if (item.hint) {
        btn.title = item.hint;
      }
      btn.addEventListener("click", () => {
        this.close();
        item.onSelect?.();
      });
      this.el.append(btn);
      this.buttons.push(btn);
    }
  }

  afterOpen() {
    const first = this.buttons.find(b => !b.disabled);
    first?.focus({ preventScroll: true });
  }

  onKeyDown(e) {
    const enabled = this.buttons.filter(b => !b.disabled);
    const idx = enabled.indexOf(document.activeElement);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        enabled[(idx + 1) % enabled.length]?.focus();
        return;
      case "ArrowUp":
        e.preventDefault();
        enabled[(idx - 1 + enabled.length) % enabled.length]?.focus();
        return;
      case "Home":
        e.preventDefault();
        enabled[0]?.focus();
        return;
      case "End":
        e.preventDefault();
        enabled.at(-1)?.focus();
        return;
      case "Tab":
        this.close();
        return;
    }
    super.onKeyDown(e);
  }
}

/** 任意の中身を出す吹き出し。build(container) で中身を作る */
export class Popover extends BasePopup {
  constructor(options) {
    super({ ...options, className: `sh-popover ${options.className || ""}` });
    this.build = options.build;
    this.el.setAttribute("role", "dialog");
    if (options.label) {
      this.el.setAttribute("aria-label", options.label);
    }
    this.closeOnOutside = options.closeOnOutside !== false;
    if (!this.closeOnOutside) {
      this._onDocPointer = () => {};
    }
  }

  render() {
    this.el.textContent = "";
    this.build(this.el, this);
  }
}

/**
 * 右クリックの位置に出すメニュー。
 * @param {Array<object>} items PopupMenu と同じ形式
 * @param {number} x 画面上の位置
 * @param {number} y
 */
export function openContextMenu(items, x, y) {
  const anchor = document.createElement("div");
  anchor.className = "sh-context-anchor";
  anchor.style.left = `${Math.round(x)}px`;
  anchor.style.top = `${Math.round(y)}px`;
  layer().append(anchor);
  const menu = new PopupMenu({
    anchor,
    align: "start",
    className: "sh-context-menu",
    items,
    onClose: () => anchor.remove(),
  });
  menu.open();
  return menu;
}

