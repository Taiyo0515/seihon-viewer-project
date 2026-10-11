/**
 * ページの削除(PDF の編集)と、保存していない変更の管理。
 *
 * - 削除は PDF.js のページ整理の機能(pagesMapper)で行う。本文の表示・サムネイル・検索・印刷は PDF.js が組み替える。
 *   「元に戻す」(直前の削除だけ)も PDF.js の機能を使う。
 * - 保存は、保存先を選ぶ画面を出して新しいファイルとして保存する。元のファイルを勝手に上書きしない。
 * - 保存していない変更(ページの削除・書き込み・フォームの入力)があるときは、
 *   タブを閉じる・別の PDF を開く・Chrome 標準ビューアに切り替える前に確認する。
 *
 * PDF.js 6.4.299 のページ整理は、書き込み(注釈の編集)と組み合わせたときに次の不具合があるため、ここで補う
 * (PDF.js の配布物は改変しない):
 *  1. 削除したページの書き込みが、別のページに移る → 削除の前に、そのページの書き込みを消しておく
 *  2. 削除を確定するとき、ページ番号を取り違えて別のページの書き込みを消す(deletePage) → 何もしないようにする
 *  3. 削除を元に戻したとき、戻したページの書き込み用の層が登録されず、書き込めなくなる → 登録し直す
 *  4. 書き込みの「元に戻す」で、削除したページの書き込みが復活する → 復活したら消す
 */

import { baseName, saveBlobAs, sanitizeFileName } from "../common/files.js";
import { computePdfKey, editedDocumentBytes, extractPagesToPdf, loadPdfFromBytes } from "./page-export.js";
import { isRearranged, mappingSignature, sourceOrder, viewPageCount } from "./page-map.js";
import { choiceDialog, confirmDialog } from "./ui/dialog.js";

/** PDF.js が書き込みを保存するときのキーの先頭(フォームの入力内容と区別する) */
const EDITOR_PREFIX = "pdfjs_internal_editor_";

export class PageEditor {
  /**
   * @param {object} o
   * @param {object} o.app PDFViewerApplication
   * @param {object} o.toast
   * @param {object} o.docSource
   * @param {object} o.roles PageRoles
   */
  constructor({ app, toast, docSource, roles }) {
    this.app = app;
    this.toast = toast;
    this.docSource = docSource;
    this.roles = roles;
    this.listeners = new Set();
    this.doc = null;
    /** 最後に保存した(または開いた)ときのページの並び */
    this.savedSignature = "";
    /** 書き込み・フォームの入力を保存していない */
    this.annotDirty = false;
    /** 元に戻せる削除 {count, pages} */
    this.pendingDelete = null;
    /** 削除したページの書き込み用の層(この層に戻ってきた書き込みは消す) */
    this.deletedLayers = new Set();
    /** 今回の削除で消える層(元に戻したら、削除したページの扱いをやめる) */
    this.pendingLayers = [];
    this.saving = false;
    /** 「保存しない」を選んだ直後は、タブを離れるときの確認を出さない */
    this.leaveAllowedUntil = 0;
    this.patchedUi = new WeakSet();

    const bus = app.eventBus;
    bus.on("documentloaded", () => this.resetFor(app.pdfDocument));
    bus.on("pagesinit", () => {
      if (app.pdfDocument !== this.doc) {
        this.resetFor(app.pdfDocument);
      }
    });
    bus.on("annotationeditoruimanager", ({ uiManager }) => this.patchUiManager(uiManager));
    bus.on("pagesedited", evt => this.onPagesEdited(evt));

    // タブを閉じる・再読み込み・別のページへ移るときの確認(PDF.js の確認の判定を置き換える)
    // ブラウザの決まった確認画面(「このサイトを離れますか?」)が出る
    app._hasChanges = () => this.dirty && Date.now() > this.leaveAllowedUntil;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      fn(this);
    }
  }

  /** ページの並びを、保存した(開いた)ときから変えている */
  get structuralDirty() {
    return !!this.doc && this.doc === this.app.pdfDocument && mappingSignature(this.doc) !== this.savedSignature;
  }

  /** 保存していない変更がある */
  get dirty() {
    return this.structuralDirty || (this.annotDirty && !!this.app.pdfDocument);
  }

  get canUndoDelete() {
    return !!this.pendingDelete;
  }

  get uiManager() {
    return this.app.pdfViewer?._layerProperties?.annotationEditorUIManager || null;
  }

  // -------------------------------------------------------------------------
  // 文書ごとの準備
  // -------------------------------------------------------------------------

  resetFor(doc) {
    if (doc === this.doc) {
      return;
    }
    this.doc = doc;
    this.savedSignature = doc ? mappingSignature(doc) : "";
    this.annotDirty = false;
    this.pendingDelete = null;
    this.pendingLayers = [];
    this.deletedLayers = new Set();
    this.leaveAllowedUntil = 0;
    if (doc) {
      this.watchStorage(doc);
      this.patchUiManager(this.uiManager);
    }
    this.emit();
  }

  /**
   * 書き込み・フォームの入力の変更を見張る。
   * PDF.js の「変更あり」の印は、ページの抜き出し(AI用コピーなど)でも消えるため、保存したかどうかは自分で覚えておく。
   */
  watchStorage(doc) {
    const storage = doc.annotationStorage;
    if (!storage || storage.__seihonWatched) {
      return;
    }
    storage.__seihonWatched = true;
    const clearIfEmpty = () => {
      // 書き込みを全部消したら、保存する変更はない
      if (doc === this.doc && this.annotDirty && storage.size === 0) {
        this.annotDirty = false;
        this.emit();
      }
    };
    const onSet = () => {
      if (doc === this.doc && !this.annotDirty) {
        this.annotDirty = true;
        this.emit();
      }
    };
    // PDF.js は文書を開いた後で onSetModified / onResetModified に自分の処理を入れる(こちらが先に入れても上書きされる)。
    // どちらが先でも両方が呼ばれるよう、入れ物を「PDF.js の処理 + こちらの処理」を返す形にする
    const chain = (name, ours) => {
      let theirs = storage[name];
      Object.defineProperty(storage, name, {
        configurable: true,
        enumerable: true,
        get() {
          return () => {
            theirs?.call(storage);
            ours();
          };
        },
        set(fn) {
          theirs = fn;
        },
      });
    };
    chain("onSetModified", onSet);
    chain("onResetModified", clearIfEmpty);
    // PDF.js の「変更あり」の印がすでに消えていると、全部消しても知らせが来ないため、消すたびに確かめる
    const remove = storage.remove;
    storage.remove = function (...args) {
      const result = remove.apply(this, args);
      clearIfEmpty();
      return result;
    };
  }

  /** PDF.js の書き込みの管理部分の不具合を補う(上の説明の 2 と 4) */
  patchUiManager(ui) {
    if (!ui || this.patchedUi.has(ui)) {
      return;
    }
    this.patchedUi.add(ui);
    // 2. 削除を確定するときの deletePage は、ページ番号を取り違えるので使わない
    //    (削除したページの書き込みは、削除の前にここで消している)
    if (typeof ui.deletePage === "function") {
      ui.deletePage = () => {};
    }
    // 4. 書き込みの「元に戻す」「やり直す」で、削除したページの書き込みが戻ってきたら消す
    for (const name of ["undo", "redo"]) {
      const original = ui[name];
      if (typeof original === "function") {
        ui[name] = (...args) => {
          const result = original.apply(ui, args);
          this.sweepDeletedEditors();
          return result;
        };
      }
    }
  }

  /** 削除したページの層に属している書き込みを消す */
  sweepDeletedEditors() {
    const ui = this.uiManager;
    if (!ui || !this.deletedLayers.size) {
      return 0;
    }
    let removed = 0;
    const max = Math.max(this.doc?.numPages || 0, viewPageCount(this.doc)) + 1;
    for (let i = 0; i < max; i++) {
      for (const editor of [...ui.getEditors(i)]) {
        if (editor.parent && this.deletedLayers.has(editor.parent)) {
          try {
            editor.remove();
            removed++;
          } catch (e) {
            console.warn("[製本ビューア] 削除したページの書き込みを消せませんでした", e);
          }
        }
      }
    }
    return removed;
  }

  /** ページの書き込み(このビューアで書き込んだペン・テキストなど) */
  editorsOn(pageNumbers) {
    const ui = this.uiManager;
    if (!ui) {
      return [];
    }
    return pageNumbers.flatMap(n => [...ui.getEditors(n - 1)]);
  }

  // -------------------------------------------------------------------------
  // 削除
  // -------------------------------------------------------------------------

  /**
   * ページを削除する(表示上のページ番号)。
   * @param {number[]} pageNumbers
   * @returns {Promise<boolean>} 削除した
   */
  async deletePages(pageNumbers) {
    const app = this.app;
    const doc = app.pdfDocument;
    if (!doc || this.saving) {
      return false;
    }
    const count = viewPageCount(doc);
    const pages = [...new Set(pageNumbers)].filter(n => Number.isInteger(n) && n >= 1 && n <= count).sort((a, b) => a - b);
    if (!pages.length) {
      return false;
    }
    if (pages.length >= count) {
      this.toast.show("すべてのページは削除できません。少なくとも1ページは残してください", { kind: "error" });
      return false;
    }
    const thumbs = app.pdfThumbnailViewer;
    // 全部のページの読み込みが終わるまでは削除しない(PDF.js がページの対応を正しく保てるのは、全部のページを読み込んだ後)
    if (!app.pdfViewer?.pageViewsReady) {
      this.toast.show("ページの読み込みが終わるまでお待ちください(終わると削除できます)", { kind: "error" });
      return false;
    }
    if (!thumbs?.getThumbnail?.(0)?.checkbox) {
      this.toast.show("ページの一覧の準備ができていないため、削除できません。少し待ってからもう一度お試しください", { kind: "error" });
      return false;
    }
    const what = pages.length === 1 ? `${pages[0]}ページ目` : `${pages.length}ページ`;
    // 書き込みのあるページは、書き込みも消えることを確かめる(上の説明の 1)
    const editors = this.editorsOn(pages);
    if (editors.length) {
      const ok = await confirmDialog({
        title: "書き込みのあるページを削除します",
        message:
          `${what}には、このビューアで書き込んだもの(ペン・蛍光ペン・テキスト)があります。` +
          "ページを削除すると、その書き込みも消えます。\nページの削除は「元に戻す」で取り消せますが、書き込みは戻りません。",
        okLabel: "削除する",
        cancelLabel: "やめる",
        danger: true,
      });
      if (!ok || doc !== app.pdfDocument) {
        return false;
      }
      this.uiManager?.endCurrentEditing?.();
      for (const editor of this.editorsOn(pages)) {
        try {
          editor.remove();
        } catch (e) {
          console.warn("[製本ビューア] 書き込みを消せませんでした", e);
        }
      }
    }
    // 削除するページの書き込み用の層を覚えておく(上の説明の 4)
    const views = pages.map(n => app.pdfViewer.getPageView(n - 1));
    const layers = views.map(v => v?.annotationEditorLayer?.annotationEditorLayer).filter(Boolean);

    // PDF.js のサムネイルの選択を、削除するページだけにして、PDF.js の削除を呼ぶ
    // (選択を変えると、前の削除の「元に戻す」は PDF.js が確定する)
    for (const cb of document.querySelectorAll("#thumbnailsView > .thumbnail > input[type=checkbox]")) {
      if (cb.checked) {
        cb.click();
      }
    }
    for (const n of pages) {
      const cb = thumbs.getThumbnail(n - 1)?.checkbox;
      if (cb && !cb.checked) {
        cb.click();
      }
    }
    this.pendingLayers = layers;
    this.deleteRequest = { pages, what };
    try {
      app.eventBus.dispatch("editingaction", { source: this, name: "deletePage" });
    } catch (e) {
      console.error("[製本ビューア] ページを削除できませんでした", e);
    }
    const done = !!this.pendingDelete && this.deleteRequest === null;
    if (!done) {
      // 削除されなかった(PDF.js の条件に合わなかった)
      this.deleteRequest = null;
      this.pendingLayers = [];
      for (const cb of document.querySelectorAll("#thumbnailsView > .thumbnail > input[type=checkbox]")) {
        if (cb.checked) {
          cb.click();
        }
      }
      this.toast.show("ページを削除できませんでした", { kind: "error" });
      return false;
    }
    // サイドバーを閉じているときは「元に戻す」が見えないので、知らせに付ける
    if (!document.getElementById("outerContainer")?.classList.contains("viewsManagerOpen")) {
      const pending = this.pendingDelete;
      this.toast.show(`${what}を削除しました`, {
        duration: 8000,
        action: {
          label: "元に戻す",
          // この削除がまだ元に戻せるときだけ(後で別のページを削除していたら、そちらを戻さない)
          onClick: () => {
            if (this.pendingDelete === pending) {
              this.undoDelete();
            } else {
              this.toast.show("この削除は、もう元に戻せません");
            }
          },
        },
      });
    }
    return true;
  }

  /** 直前の削除を元に戻す */
  undoDelete() {
    if (!this.pendingDelete) {
      return false;
    }
    document.getElementById("viewsManagerStatusUndoButton")?.click();
    return true;
  }

  /** 直前の削除を確定する(元に戻せなくなる。削除したページの後始末をする) */
  finalizeDelete() {
    if (!this.pendingDelete) {
      return;
    }
    document.getElementById("viewsManagerStatusUndoCloseButton")?.click();
  }

  onPagesEdited({ type }) {
    if (type === "delete" || type === "cut") {
      const request = this.deleteRequest;
      this.deleteRequest = null;
      for (const layer of this.pendingLayers) {
        this.deletedLayers.add(layer);
      }
      this.pendingDelete = { what: request?.what || "ページ", pages: request?.pages || [], layers: this.pendingLayers };
      this.pendingLayers = [];
      this.afterRearrange();
      this.emit();
      return;
    }
    if (type === "cancelDelete") {
      // 戻ってきたページの層は、削除したページの扱いをやめる
      for (const layer of this.pendingDelete?.layers || []) {
        this.deletedLayers.delete(layer);
      }
      this.pendingDelete = null;
      this.repairEditorLayers();
      this.afterRearrange();
      this.emit();
      return;
    }
    if (type === "cleanSavedData") {
      this.pendingDelete = null;
      this.emit();
      return;
    }
    if (type === "move" || type === "paste") {
      this.afterRearrange();
      this.emit();
    }
  }

  /** ページの並びが変わった後の表示の作り直し */
  afterRearrange() {
    const app = this.app;
    const viewer = app.pdfViewer;
    const doc = app.pdfDocument;
    if (!viewer || !doc) {
      return;
    }
    // PDF.js の「ページ番号 → ページ」の控えを、いまの並びに合わせ直す。
    // 削除を元に戻したとき、戻ったページの控えが別のページのままになり、印刷・検索・AI用コピーなどが
    // 別のページの中身を使ってしまうため(画面のページは正しく見えていても起きる)
    for (let i = 0; i < viewer.pagesCount; i++) {
      const view = viewer.getPageView(i);
      if (view?.pdfPage) {
        view.pdfPage.pageNumber = view.id; // 控えも書き換わる
      }
    }
    // PDF.js はページを組み替えるとき、見開きの枠を作り直さないので、見開きの枠を作り直す
    if (viewer.spreadMode !== 0 && viewer.scrollMode !== 3) {
      try {
        viewer._updateSpreadMode?.();
      } catch (e) {
        console.warn("[製本ビューア] 見開きを組み直せませんでした", e);
      }
    }
    // ページラベル(i, ii など)は、並びを変えると合わなくなるので、元の並びのときだけ使う
    if (isRearranged(doc)) {
      if (viewer._pageLabels) {
        viewer.setPageLabels(null);
        app.pdfThumbnailViewer?.setPageLabels(null);
      }
    } else {
      doc
        .getPageLabels()
        .then(labels => {
          if (labels && doc === app.pdfDocument && !isRearranged(doc)) {
            viewer.setPageLabels(labels);
            app.pdfThumbnailViewer?.setPageLabels(labels);
          }
        })
        .catch(() => {});
    }
    // 「幅に合わせる」などの倍率は、見開きの組み合わせが変わると変わるので計算し直す
    setTimeout(() => {
      if (doc !== app.pdfDocument) {
        return;
      }
      const value = viewer.currentScaleValue;
      if (value && isNaN(Number(value))) {
        viewer.currentScaleValue = value;
      }
      app.eventBus.dispatch("seihonpagecountchanged", { source: this });
    }, 0);
  }

  /** 上の説明の 3: 削除を元に戻した後、各ページの書き込み用の層を登録し直す */
  repairEditorLayers() {
    const ui = this.uiManager;
    const viewer = this.app.pdfViewer;
    if (!ui || !viewer) {
      return;
    }
    for (let i = 0; i < viewer.pagesCount; i++) {
      const view = viewer.getPageView(i);
      const layer = view?.annotationEditorLayer?.annotationEditorLayer;
      if (layer) {
        layer.pageIndex = view.id - 1;
        try {
          ui.addLayer(layer);
        } catch (e) {
          console.warn("[製本ビューア] 書き込み用の層を登録し直せませんでした", e);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 保存
  // -------------------------------------------------------------------------

  /** 保存するファイルの名前の候補(元の名前に「_編集済み」を付ける。元のファイルを上書きしにくくする) */
  suggestedName() {
    return `${sanitizeFileName(this.docSource.baseName())}_編集済み.pdf`;
  }

  /**
   * 編集した内容を反映した PDF のデータを作る。
   * - ページの並びを変えていなければ、PDF.js の保存と同じ(元の PDF に書き込み・フォームの入力を追記)
   * - 並びを変えていれば、表示しているページだけを表示の順に抜き出す(書き込み・フォームの入力も含める)
   */
  async buildEditedBytes(doc) {
    const storage = doc.annotationStorage;
    const hasEdits = (storage?.size || 0) > 0;
    if (!isRearranged(doc)) {
      if (hasEdits) {
        const bytes = await editedDocumentBytes(doc);
        if (bytes?.length) {
          return bytes;
        }
      }
      return doc.getData();
    }
    const pages = sourceOrder(doc).map(pageIndex => ({ source: "current", pageIndex }));
    const passwordDoc = this.docSource.passwordDocs.has(doc);
    const hasFormValues = hasEdits && [...storage].some(([key]) => !String(key).startsWith(EDITOR_PREFIX));
    if (hasFormValues && !passwordDoc) {
      // フォームの入力内容はページの抜き出しでは引き継がれないので、
      // いったん入力内容と書き込みを反映した PDF を作り、そこから抜き出す
      const edited = await editedDocumentBytes(doc);
      if (edited?.length) {
        const temp = await loadPdfFromBytes(edited);
        try {
          return await extractPagesToPdf(temp, pages);
        } finally {
          temp.loadingTask?.destroy();
        }
      }
    }
    if (hasFormValues && passwordDoc) {
      this.toast.show("パスワード付きの PDF のため、フォームの入力内容は保存されません(書き込みとページの削除は保存されます)", {
        kind: "error",
        duration: 8000,
      });
    }
    // 書き込み(新しい注釈)は、PDF.js の抜き出しがページの並びに合わせて含める
    return extractPagesToPdf(doc, pages);
  }

  /**
   * 編集した内容を、保存先を選んで保存する。
   * @returns {Promise<boolean>} 保存した
   */
  async save() {
    const app = this.app;
    const doc = app.pdfDocument;
    if (!doc) {
      return false;
    }
    if (this.saving) {
      this.toast.show("保存しています。終わるまでお待ちください");
      return false;
    }
    this.saving = true;
    this.emit();
    const busy = this.toast.show("保存する PDF を作っています…", { duration: 0 });
    let bytes;
    try {
      // 「元に戻す」の記録を確定して、削除したページの後始末をしてから作る
      this.finalizeDelete();
      this.uiManager?.endCurrentEditing?.();
      this.sweepDeletedEditors();
      bytes = await this.buildEditedBytes(doc);
      if (!bytes?.length) {
        throw new Error("PDF を作れませんでした");
      }
    } catch (e) {
      busy();
      this.saving = false;
      this.emit();
      console.error(e);
      this.toast.show(`保存する PDF を作れませんでした: ${e.message || e}`, { kind: "error", duration: 10000 });
      return false;
    }
    busy();
    // 保存するまでの間に変更されたら、その変更は「保存していない」ままにする
    const signature = mappingSignature(doc);
    const annotVersion = this.annotDirty;
    let result;
    try {
      result = await saveBlobAs(new Blob([bytes], { type: "application/pdf" }), this.suggestedName());
    } catch (e) {
      result = { ok: false, error: e.message || String(e) };
    } finally {
      this.saving = false;
    }
    if (!result.ok) {
      this.emit();
      if (result.canceled) {
        this.toast.show("保存をやめました(編集した内容はそのまま残っています)");
      } else {
        this.toast.show(`保存できませんでした: ${result.error || "不明なエラー"}`, { kind: "error", duration: 10000 });
      }
      return false;
    }
    if (doc === app.pdfDocument) {
      this.savedSignature = signature;
      if (annotVersion && mappingSignature(doc) === signature) {
        this.annotDirty = false;
        // PDF.js の「変更あり」の印も消しておく(消さないと、保存した後の書き込みで知らせが来ず、
        // 「保存していない変更」に気づけない)
        try {
          doc.annotationStorage?.resetModified?.();
        } catch {}
      }
      this.emit();
    }
    const savedName = baseName(result.filename || "") ? `${baseName(result.filename)}.pdf` : this.suggestedName();
    this.toast.show(`保存しました: ${savedName}`, {
      duration: 7000,
      action: result.id !== undefined ? { label: "フォルダを開く", onClick: () => chrome.downloads.show(result.id) } : undefined,
    });
    // 保存した PDF を開き直したときにも、カバー・表紙・帯などの役割が残るようにする
    computePdfKey(bytes)
      .then(key => this.roles.copyToSaved(key, savedName, viewPageCount(doc)))
      .catch(e => console.warn("[製本ビューア] 保存した PDF にページ役割を写せませんでした", e));
    return true;
  }

  // -------------------------------------------------------------------------
  // 保存していない変更の確認
  // -------------------------------------------------------------------------

  /**
   * 文書を閉じる操作(別の PDF を開く・Chrome 標準ビューアに切り替える)の前に呼ぶ。
   * 保存していない変更があれば「保存しますか?」と聞く。
   * @param {string} action 何をしようとしているか(例: 「別の PDF を開く」)
   * @returns {Promise<boolean>} 続けてよい
   */
  async guard(action) {
    if (!this.dirty) {
      return true;
    }
    const choice = await choiceDialog({
      title: "変更を保存しますか?",
      message:
        `この PDF には、保存していない変更(${this.describeChanges()})があります。\n` +
        `${action}前に保存しますか? 保存しないと、変更は失われます。`,
      buttons: [
        { id: "cancel", label: "キャンセル" },
        { id: "discard", label: "保存しない", kind: "danger" },
        { id: "save", label: "保存する…", kind: "primary" },
      ],
      defaultId: "save",
    });
    if (choice === "save") {
      return this.save();
    }
    if (choice === "discard") {
      this.allowLeave();
      return true;
    }
    return false;
  }

  /** このあとのページ移動で、ブラウザの「このサイトを離れますか?」を出さない(少しの間だけ) */
  allowLeave() {
    this.leaveAllowedUntil = Date.now() + 5000;
  }

  describeChanges() {
    const parts = [];
    if (this.structuralDirty) {
      const doc = this.doc;
      const removed = (doc?.numPages || 0) - viewPageCount(doc);
      parts.push(removed > 0 ? `${removed}ページの削除` : "ページの並びの変更");
    }
    if (this.annotDirty) {
      parts.push("書き込み・フォームの入力");
    }
    return parts.join("と") || "編集";
  }
}
