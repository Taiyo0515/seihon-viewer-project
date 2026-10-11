/**
 * ページ収集のパネル(画面右側)と、ツールバーの件数バッジ。
 *
 * 一覧・並べ替え(ドラッグ、または ↑↓ ボタン)・削除・全消去・範囲指定での追加・書き出しができる。
 */

import { clearCollection, getPdfBytes, removeCollectionItems, reorderCollection, setCollectionThumb, storageUsage } from "../../common/db.js";
import { formatBytes } from "../../common/files.js";
import { hydrateIcons } from "../icons.js";
import { loadPdfFromBytes } from "../page-export.js";
import { parsePageRanges } from "../collection.js";
import { confirmDialog } from "./dialog.js";

const THUMB_WIDTH = 56; // CSS px

export class CollectPanel {
  /**
   * @param {object} o
   * @param {object} o.app
   * @param {object} o.collection
   * @param {object} o.docSource
   * @param {object} o.toast
   * @param {() => object} o.getSettings
   * @param {(open:boolean) => void} o.onToggle パネルの開閉時(他のパネルを閉じるため)
   */
  constructor({ app, collection, docSource, toast, getSettings, onToggle }) {
    this.app = app;
    this.collection = collection;
    this.docSource = docSource;
    this.toast = toast;
    this.getSettings = getSettings;
    this.onToggle = onToggle;
    this.outer = document.getElementById("outerContainer");
    this.panel = document.getElementById("shCollectPanel");
    this.button = document.getElementById("shCollect");
    this.badge = document.getElementById("shCollectBadge");
    this.list = document.getElementById("shCollectList");
    this.empty = document.getElementById("shCollectEmpty");
    this.countEl = document.getElementById("shCollectCount");
    this.usageEl = document.getElementById("shCollectUsage");
    this.rangeInput = document.getElementById("shCollectRange");
    this.rangeError = document.getElementById("shCollectRangeError");
    /** pdfKey -> Promise<PDFDocumentProxy>(サムネイル作成用。パネルを閉じたら破棄) */
    this.thumbDocs = new Map();
    this.thumbUrls = new Map();
    this.thumbQueue = Promise.resolve();
    this.observer = new IntersectionObserver(entries => this.onVisible(entries), {
      root: this.list,
      rootMargin: "200px 0px",
    });
    this.bind();
    collection.onChange(() => this.update());
    this.update();
  }

  get isOpen() {
    return !this.panel.hidden;
  }

  bind() {
    this.button.addEventListener("click", () => this.toggle());
    document.getElementById("shCollectClose").addEventListener("click", () => this.close());
    document.getElementById("shCollectAddRange").addEventListener("click", () => this.addRange());
    this.rangeInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.addRange();
      }
    });
    this.rangeInput.addEventListener("input", () => (this.rangeError.hidden = true));
    document.getElementById("shCollectAddAll").addEventListener("click", () => {
      const n = this.app.pagesCount || 0;
      if (n) {
        this.collection.addCurrentPages(Array.from({ length: n }, (_, i) => i + 1));
      }
    });
    document.getElementById("shCollectExportPdf").addEventListener("click", () => this.collection.exportAll("pdf"));
    document.getElementById("shCollectExportZip").addEventListener("click", () => this.collection.exportAll("zip"));
    document.getElementById("shCollectClear").addEventListener("click", async () => {
      if (!this.collection.count) {
        return;
      }
      const ok = await confirmDialog({
        title: "収集を空にしますか?",
        message: `収集した ${this.collection.count} ページをすべて消します。元に戻せません。`,
        okLabel: "すべて消す",
        cancelLabel: "やめる",
        danger: true,
      });
      if (ok) {
        await clearCollection();
        this.toast.show("収集を空にしました");
      }
    });
    this.panel.addEventListener("keydown", e => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        this.close();
        this.button.focus();
      }
    });

    // ---- ドラッグで並べ替え ----
    this.list.addEventListener("dragstart", e => {
      const li = e.target.closest("li[data-id]");
      if (!li) {
        return;
      }
      this.dragging = li;
      li.classList.add("sh-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", li.dataset.id);
    });
    this.list.addEventListener("dragover", e => {
      if (!this.dragging) {
        return;
      }
      e.preventDefault();
      const li = e.target.closest("li[data-id]");
      if (!li || li === this.dragging) {
        return;
      }
      const r = li.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      li.parentNode.insertBefore(this.dragging, after ? li.nextSibling : li);
    });
    this.list.addEventListener("drop", e => {
      if (this.dragging) {
        e.preventDefault();
      }
    });
    this.list.addEventListener("dragend", () => {
      if (!this.dragging) {
        return;
      }
      this.dragging.classList.remove("sh-dragging");
      this.dragging = null;
      const ids = [...this.list.querySelectorAll("li[data-id]")].map(li => Number(li.dataset.id));
      reorderCollection(ids);
    });
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
    this.outer.classList.add("sh-collect-open");
    this.button.classList.add("sh-pressed");
    this.button.setAttribute("aria-expanded", "true");
    this.update();
    window.dispatchEvent(new Event("resize"));
  }

  close() {
    if (!this.isOpen) {
      return;
    }
    this.panel.hidden = true;
    this.outer.classList.remove("sh-collect-open");
    this.button.classList.remove("sh-pressed");
    this.button.setAttribute("aria-expanded", "false");
    this.onToggle?.(false);
    // サムネイル用に開いた文書を閉じる
    for (const promise of this.thumbDocs.values()) {
      promise.then(doc => doc.loadingTask.destroy()).catch(() => {});
    }
    this.thumbDocs.clear();
    window.dispatchEvent(new Event("resize"));
  }

  addRange() {
    const n = this.app.pagesCount || 0;
    if (!this.app.pdfDocument || !n) {
      return;
    }
    const { pages, error } = parsePageRanges(this.rangeInput.value, n);
    if (error) {
      this.rangeError.textContent = error;
      this.rangeError.hidden = false;
      return;
    }
    this.rangeError.hidden = true;
    this.collection.addCurrentPages(pages).then(added => {
      if (added) {
        this.rangeInput.value = "";
      }
    });
  }

  /** バッジと一覧を最新にする */
  update() {
    const count = this.collection.count;
    this.badge.textContent = count > 999 ? "999+" : String(count);
    this.badge.hidden = count === 0;
    this.button.title = count ? `ページ収集(${count}ページ)` : "ページ収集";
    this.button.setAttribute("aria-label", this.button.title);
    const hasDoc = !!this.app.pdfDocument;
    for (const id of ["shCollectAddRange", "shCollectAddAll"]) {
      document.getElementById(id).disabled = !hasDoc;
    }
    this.rangeInput.disabled = !hasDoc;
    if (!this.isOpen) {
      return;
    }
    this.countEl.textContent = count ? `${count}ページ` : "";
    this.empty.hidden = count > 0;
    for (const id of ["shCollectExportPdf", "shCollectExportZip", "shCollectClear"]) {
      document.getElementById(id).disabled = count === 0;
    }
    this.renderList();
    this.updateUsage();
  }

  async updateUsage() {
    try {
      const usage = await storageUsage();
      const limit = this.getSettings().collectLimitMB * 1024 * 1024;
      this.usageEl.textContent = `保存容量 ${formatBytes(usage.total)} / 上限 ${formatBytes(limit)}`;
      this.usageEl.classList.toggle("sh-over", usage.total > limit);
    } catch {
      this.usageEl.textContent = "";
    }
  }

  renderList() {
    const items = this.collection.items;
    this.observer.disconnect();
    // 使わなくなったサムネイルの URL を解放する
    const live = new Set(items.map(i => i.id));
    for (const [id, url] of this.thumbUrls) {
      if (!live.has(id)) {
        URL.revokeObjectURL(url);
        this.thumbUrls.delete(id);
      }
    }
    this.list.textContent = "";
    items.forEach((item, index) => {
      const li = document.createElement("li");
      li.dataset.id = String(item.id);
      li.draggable = true;

      const handle = document.createElement("span");
      handle.className = "sh-collect-handle";
      handle.dataset.icon = "drag";
      handle.title = "ドラッグで並べ替え";

      const thumb = document.createElement("div");
      thumb.className = "sh-collect-thumb";
      const img = document.createElement("img");
      img.alt = "";
      if (item.thumb) {
        img.src = this.thumbUrl(item);
      } else {
        thumb.dataset.pending = "1";
      }
      thumb.append(img);

      const text = document.createElement("div");
      text.className = "sh-collect-text";
      const page = document.createElement("div");
      page.className = "sh-collect-page";
      page.textContent = `${index + 1}. ${item.pageIndex + 1}ページ目${item.label ? `(${item.label})` : ""}`;
      const name = document.createElement("div");
      name.className = "sh-collect-name";
      name.textContent = item.name || "(名前なし)";
      name.title = item.name || "";
      text.append(page, name);

      const buttons = document.createElement("div");
      buttons.className = "sh-collect-buttons";
      const mk = (icon, label, onClick, disabled = false) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "sh-icon-btn sh-small";
        b.dataset.icon = icon;
        b.title = label;
        b.setAttribute("aria-label", `${label}(${index + 1}番目)`);
        b.disabled = disabled;
        b.addEventListener("click", onClick);
        return b;
      };
      buttons.append(
        mk("arrow-up", "上へ", () => this.move(index, -1), index === 0),
        mk("arrow-down", "下へ", () => this.move(index, 1), index === items.length - 1),
        mk("delete", "収集から外す", () => removeCollectionItems([item.id]))
      );
      li.append(handle, thumb, text, buttons);
      this.list.append(li);
      if (!item.thumb) {
        this.observer.observe(li);
      }
    });
    hydrateIcons(this.list);
  }

  move(index, delta) {
    const ids = this.collection.items.map(i => i.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) {
      return;
    }
    [ids[index], ids[j]] = [ids[j], ids[index]];
    reorderCollection(ids);
  }

  thumbUrl(item) {
    let url = this.thumbUrls.get(item.id);
    if (!url) {
      url = URL.createObjectURL(item.thumb);
      this.thumbUrls.set(item.id, url);
    }
    return url;
  }

  // ---- サムネイル(見えたものから順に作る) ----
  onVisible(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }
      this.observer.unobserve(entry.target);
      const id = Number(entry.target.dataset.id);
      const item = this.collection.items.find(i => i.id === id);
      if (item && !item.thumb) {
        this.thumbQueue = this.thumbQueue.then(() => this.makeThumb(item, entry.target)).catch(() => {});
      }
    }
  }

  async makeThumb(item, li) {
    if (!this.isOpen || !li.isConnected) {
      return;
    }
    let doc = null;
    const currentKey = await this.docSource.keyIfReady();
    if (currentKey && currentKey === item.pdfKey) {
      doc = this.app.pdfDocument;
    } else {
      if (!this.thumbDocs.has(item.pdfKey)) {
        this.thumbDocs.set(
          item.pdfKey,
          getPdfBytes(item.pdfKey).then(bytes => {
            if (!bytes) {
              throw new Error("元の PDF がありません");
            }
            return loadPdfFromBytes(bytes);
          })
        );
      }
      doc = await this.thumbDocs.get(item.pdfKey);
    }
    const page = await doc.getPage(item.pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: (THUMB_WIDTH * ratio) / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport, background: "#ffffff" }).promise;
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    canvas.width = canvas.height = 0;
    if (!blob) {
      return;
    }
    item.thumb = blob;
    await setCollectionThumb(item.id, blob);
    const img = li.querySelector("img");
    if (img) {
      img.src = this.thumbUrl(item);
      img.parentElement.removeAttribute("data-pending");
    }
  }
}
