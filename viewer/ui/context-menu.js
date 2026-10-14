/**
 * ビューア内の右クリックメニュー(ページとサムネイル)。
 *
 * - ページの上: 「コピー」(0.1 までの「AI用にコピー」)「画像/PDF で保存」「収集に追加/外す」など。
 *   文字を選んでいるときは「選択した文字をコピー」(通常の文字のコピー)も出す。リンクの上ではリンクの操作も出す。
 * - サムネイルの上: 同じ操作。複数選択中は、選んだページ全部が対象。
 * - Shift を押しながら右クリックすると、Chrome の通常のメニューを出す。
 *   入力欄(フォーム)や注釈の文字入力の上でも、通常のメニュー(貼り付けなど)を出す。
 */

import { ROLES, ROLE_LABEL } from "../roles.js";
import { openContextMenu } from "./popup.js";

export function shortcutLabel(spec) {
  const isMac = /Mac/i.test(navigator.platform);
  return isMac ? spec.replace(/Ctrl\+/g, "⌘").replace(/Shift\+/g, "⇧").replace(/Alt\+/g, "⌥") : spec;
}

export class ViewerContextMenu {
  /**
   * @param {object} o
   * @param {object} o.app
   * @param {object} o.pageCopy ページのコピー・書き出し
   * @param {object} o.collection
   * @param {object} o.collectPanel
   * @param {object} o.thumbSelection
   * @param {object} o.docSource
   * @param {object} o.roles PageRoles
   * @param {object} o.rolesPanel
   * @param {object} [o.pageEditor] ページの削除
   * @param {() => object} o.getSettings
   */
  constructor(o) {
    Object.assign(this, o);
    document.getElementById("viewerContainer").addEventListener("contextmenu", e => this.onPage(e));
    document.getElementById("thumbnailsView").addEventListener("contextmenu", e => this.onThumb(e));
  }

  useNativeMenu(e) {
    if (e.shiftKey) {
      return true;
    }
    const t = e.target;
    return !!t.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  }

  async inCollection(pageNumber) {
    const key = await this.docSource.keyIfReady();
    return key ? this.collection.hasCurrentPage(key, pageNumber) : false;
  }

  /** 1ページ分の項目 */
  async pageItems(pageNumber) {
    const s = this.getSettings();
    const collected = await this.inCollection(pageNumber);
    const copyHint =
      s.aiCopySingle === "file-pdf"
        ? "このページを PDF で保存します(詳細設定で変更できます)"
        : s.aiCopySingle === "file-png"
          ? "このページを画像で保存します(詳細設定で変更できます)"
          : "このページを画像にしてクリップボードに入れます。チャット欄や文書に貼り付けられます";
    return [
      {
        label: "コピー",
        icon: "copy",
        shortcut: shortcutLabel(s.aiCopyShortcut),
        hint: copyHint,
        onSelect: () => this.pageCopy.copySinglePage(pageNumber),
      },
      { label: "画像として保存", icon: "file-png", onSelect: () => this.pageCopy.savePageImage(pageNumber) },
      { separator: true },
      collected
        ? { label: "収集から外す", icon: "collect-remove", onSelect: () => this.collection.removeCurrentPage(pageNumber) }
        : { label: "収集に追加", icon: "collect", onSelect: () => this.collection.addCurrentPages([pageNumber]) },
      {
        label: this.collection.count ? `収集を表示(${this.collection.count}ページ)` : "収集を表示",
        icon: "list-alt",
        onSelect: () => this.collectPanel.open(),
      },
      { separator: true },
      {
        label: `ページ役割: ${ROLE_LABEL[this.roles.get(pageNumber)] || "なし"}`,
        icon: "label",
        shortcut: "▸",
        onSelect: () => this.openRoleMenu([pageNumber]),
      },
      ...(this.pageEditor
        ? [
            { separator: true },
            {
              label: "このページを削除",
              icon: "delete",
              disabled: (this.app.pdfViewer?.pagesCount || 0) <= 1,
              onSelect: () => this.pageEditor.deletePages([pageNumber]),
            },
          ]
        : []),
    ];
  }

  /** ページ役割を選ぶメニューを、ボタンの下に開く(サイドバーの選択のバーから) */
  openRoleMenuAt(pages, anchor) {
    const r = anchor.getBoundingClientRect();
    this.lastPoint = { x: Math.round(r.left), y: Math.round(r.top) };
    this.openRoleMenu(pages);
  }

  /** ページ役割を選ぶメニュー(右クリックメニューから開く) */
  openRoleMenu(pages) {
    if (!pages.length) {
      return;
    }
    const { x, y } = this.lastPoint || { x: 100, y: 100 };
    const current = pages.map(n => this.roles.get(n));
    const all = id => current.every(r => r === id);
    const items = [
      { header: pages.length === 1 ? `${pages[0]}ページ目の役割` : `選んだ${pages.length}ページの役割` },
      // 0.5: 詳細設定で隠した項目は出さない(選んだページに付いていれば出す)
      ...ROLES.filter(r => r.visible || current.includes(r.id)).map(r => ({
        label: r.label,
        checked: all(r.id),
        radio: true,
        onSelect: () => this.roles.set(pages, r.id),
      })),
      { separator: true },
      { label: "役割を外す", disabled: current.every(r => !r), onSelect: () => this.roles.set(pages, null) },
      { label: "ページ役割の一覧を開く", onSelect: () => this.rolesPanel.open() },
    ];
    openContextMenu(items, x, y);
  }

  async onPage(e) {
    if (!this.app.pdfDocument || this.useNativeMenu(e)) {
      return;
    }
    const pageEl = e.target.closest?.(".page[data-page-number]");
    if (!pageEl) {
      return; // ページの外(余白)は通常のメニュー
    }
    e.preventDefault();
    const { clientX: x, clientY: y } = e;
    this.lastPoint = { x, y };
    const pageNumber = Number(pageEl.dataset.pageNumber);
    const selection = window.getSelection();
    const text = selection && !selection.isCollapsed ? selection.toString() : "";
    const link = e.target.closest?.("a[href]");
    const items = [];
    if (text.trim()) {
      items.push(
        { label: "選択した文字をコピー", icon: "text-cursor", shortcut: shortcutLabel("Ctrl+C"), onSelect: () => this.copyText(text) },
        { separator: true }
      );
    }
    if (link && /^(https?|mailto):/i.test(link.href)) {
      items.push(
        { label: "リンクを新しいタブで開く", onSelect: () => window.open(link.href, "_blank", "noopener,noreferrer") },
        { label: "リンクのアドレスをコピー", onSelect: () => this.copyText(link.href) },
        { separator: true }
      );
    }
    items.push(...(await this.pageItems(pageNumber)));
    items.push(
      { separator: true },
      { label: "Chrome のメニューを出すには Shift+右クリック", icon: "info", disabled: true }
    );
    openContextMenu(items, x, y);
  }

  async onThumb(e) {
    const thumb = e.target.closest?.(".thumbnail[page-number]");
    if (!thumb || !this.app.pdfDocument || e.shiftKey) {
      return;
    }
    e.preventDefault();
    const { clientX: x, clientY: y } = e;
    this.lastPoint = { x, y };
    const pageNumber = Number(thumb.getAttribute("page-number"));
    const sel = this.thumbSelection;
    let items;
    if (sel.size > 1 && sel.has(pageNumber)) {
      const pages = sel.pages();
      const multi = { "pdf-copy": "PDF", "image-copy": "画像", pdf: "PDF で保存", zip: "画像の ZIP で保存" }[this.getSettings().aiCopyMulti] || "PDF";
      items = [
        {
          label: `選んだ${pages.length}ページをコピー(${multi})`,
          icon: "copy",
          shortcut: shortcutLabel(this.getSettings().aiCopyShortcut),
          onSelect: () => this.pageCopy.copyPages(pages),
        },
        {
          label: `選んだ${pages.length}ページを PDF としてコピー`,
          icon: "file-pdf",
          onSelect: () => this.pageCopy.copyPdf(this.pageCopy.currentPages(pages)),
        },
        {
          label: `選んだ${pages.length}ページを画像としてコピー`,
          icon: "file-png",
          onSelect: () => this.pageCopy.copyImages(this.pageCopy.currentPages(pages)),
        },
        { label: `選んだ${pages.length}ページを収集に追加`, icon: "collect", onSelect: () => this.collection.addCurrentPages(pages) },
        { label: `選んだ${pages.length}ページに役割を付ける`, icon: "label", shortcut: "▸", onSelect: () => this.openRoleMenu(pages) },
        ...(this.pageEditor
          ? [
              {
                label: `選んだ${pages.length}ページを削除`,
                icon: "delete",
                disabled: pages.length >= (this.app.pdfViewer?.pagesCount || 0),
                onSelect: () => this.pageEditor.deletePages(pages),
              },
            ]
          : []),
        { separator: true },
        { label: "選択を解除", icon: "select-off", onSelect: () => sel.clear() },
      ];
    } else {
      items = await this.pageItems(pageNumber);
      items.push(
        { separator: true },
        { label: "まとめて選ぶには、サイドバーの「選択」か Ctrl+クリック", icon: "info", disabled: true }
      );
    }
    openContextMenu(items, x, y);
  }

  async copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      document.execCommand("copy");
    }
  }
}
