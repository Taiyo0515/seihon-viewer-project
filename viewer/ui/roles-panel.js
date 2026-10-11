/**
 * ページ役割のパネル(画面右側)。役割ごとのページ一覧を出し、解除・追加ができる。
 */

import { hydrateIcons } from "../icons.js";
import { ROLES } from "../roles.js";

export class RolesPanel {
  /**
   * @param {object} o
   * @param {object} o.app
   * @param {object} o.roles PageRoles
   * @param {(open:boolean) => void} o.onToggle
   * @param {() => void} o.onOpenBookbinding 「製本用PDF出力」を開く
   */
  constructor({ app, roles, onToggle, onOpenBookbinding }) {
    this.app = app;
    this.roles = roles;
    this.onToggle = onToggle;
    this.outer = document.getElementById("outerContainer");
    this.panel = document.getElementById("shRolesPanel");
    this.body = document.getElementById("shRolesBody");
    this.status = document.getElementById("shRolesStatus");
    document.getElementById("shRolesClose").addEventListener("click", () => this.close());
    document.getElementById("shRolesOutput").addEventListener("click", () => onOpenBookbinding());
    this.panel.addEventListener("keydown", e => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        this.close();
      }
    });
    roles.onChange(() => this.render());
    app.eventBus.on("pagechanging", () => this.updateCurrentPage());
  }

  get isOpen() {
    return !this.panel.hidden;
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    if (this.isOpen) {
      return;
    }
    this.onToggle?.(true);
    this.panel.hidden = false;
    this.outer.classList.add("sh-roles-open");
    this.render();
    window.dispatchEvent(new Event("resize"));
  }

  close() {
    if (!this.isOpen) {
      return;
    }
    this.panel.hidden = true;
    this.outer.classList.remove("sh-roles-open");
    this.onToggle?.(false);
    window.dispatchEvent(new Event("resize"));
  }

  updateCurrentPage() {
    if (!this.isOpen) {
      return;
    }
    for (const b of this.body.querySelectorAll(".sh-role-add")) {
      b.textContent = `${this.app.page}ページ目を追加`;
    }
  }

  render() {
    if (!this.isOpen) {
      return;
    }
    const hasDoc = !!this.app.pdfDocument;
    this.status.textContent = !hasDoc
      ? "PDF を開くと設定できます。"
      : this.roles.key
        ? "この PDF の内容で見分けて保存しています。同じ PDF を開くと復元されます。"
        : "PDF の読み込みが終わると、保存されている役割を読み込みます…";
    this.body.textContent = "";
    for (const role of ROLES) {
      const section = document.createElement("section");
      section.className = "sh-role-section";
      const head = document.createElement("div");
      head.className = "sh-role-head";
      const dot = document.createElement("span");
      dot.className = "sh-role-dot";
      dot.dataset.role = role.id;
      const title = document.createElement("h3");
      title.textContent = role.label;
      const add = document.createElement("button");
      add.type = "button";
      add.className = "sh-btn sh-btn-small sh-btn-text sh-role-add";
      add.textContent = `${this.app.page || 1}ページ目を追加`;
      add.disabled = !hasDoc;
      add.title = `表示中のページを「${role.label}」にします`;
      add.addEventListener("click", () => this.roles.set([this.app.page], role.id));
      head.append(dot, title, add);
      const list = document.createElement("div");
      list.className = "sh-role-pages";
      const pages = this.roles.pages(role.id);
      if (!pages.length) {
        const none = document.createElement("span");
        none.className = "sh-role-none";
        none.textContent = "なし";
        list.append(none);
      }
      for (const n of pages) {
        const chip = document.createElement("span");
        chip.className = "sh-role-chip";
        const go = document.createElement("button");
        go.type = "button";
        go.className = "sh-role-chip-go";
        go.textContent = `${n}ページ目`;
        go.title = "このページへ移動";
        go.addEventListener("click", () => {
          this.app.page = n;
        });
        const del = document.createElement("button");
        del.type = "button";
        del.className = "sh-role-chip-del";
        del.dataset.icon = "close";
        del.title = "役割を外す";
        del.setAttribute("aria-label", `${n}ページ目の「${role.label}」を外す`);
        del.addEventListener("click", () => this.roles.set([n], null));
        chip.append(go, del);
        list.append(chip);
      }
      section.append(head, list);
      this.body.append(section);
    }
    hydrateIcons(this.body);
  }
}
