/**
 * ページのコピーと書き出し(0.1 までの「AI用コピー」。0.2 で「コピー」に改名)。
 *
 * - コピー(1ページ・既定): ページを画像にしてクリップボードへ。チャット欄や文書にそのまま貼り付けられる。
 *   書き込みに失敗したら解像度を下げて再挑戦し、それでも駄目なら画像ファイルとして保存して知らせる。
 * - コピー(複数ページ・既定): 1つの PDF にして「PDF としてコピー」(ファイルとしてクリップボードへ)。
 * - PDF としてコピー / 画像としてコピー: ファイルを保存し、クリップボードに入れる(file-clipboard.js)。
 * - 保存: PDF(元の文字・図・画像のまま。OCR の文字も残る)/ 画像 / 画像の ZIP。
 * - 画像の画質は設定 imageQuality(既定は最高画質 = 元の画質。image-export.js)。
 */

import { createZip, sanitizeFileName, saveBlob, timestampForFileName } from "../common/files.js";
import { copyFilesToClipboard, revealInFolder } from "./file-clipboard.js";
import { pageImageFile, renderPagePng } from "./image-export.js";
import { editedDocumentBytes, extractPagesToPdf, loadPdfFromBytes } from "./page-export.js";
import { sourceIndex, viewPageCount } from "./page-map.js";

const PNG_RETRY_SHRINKS = [1, 0.7, 0.45];

export class PageCopy {
  /**
   * @param {object} o
   * @param {object} o.app PDFViewerApplication
   * @param {object} o.toast
   * @param {object} o.docSource
   * @param {() => object} o.getSettings
   */
  constructor({ app, toast, docSource, getSettings }) {
    this.app = app;
    this.toast = toast;
    this.docSource = docSource;
    this.getSettings = getSettings;
    this.busy = false;
  }

  get rotation() {
    return this.app.pdfViewer?.pagesRotation || 0;
  }

  /** 同時に2つ以上の書き出しが走らないようにする */
  async exclusive(fn) {
    if (this.busy) {
      this.toast.show("前の処理が終わるまでお待ちください");
      return undefined;
    }
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  /** 開いている PDF の表示上のページ番号(1始まり)の並び → 書き出しの指定 */
  currentPages(pageNumbers) {
    return pageNumbers.map(n => ({ source: "current", pageIndex: n - 1, name: this.docSource.baseName() }));
  }

  // -------------------------------------------------------------------------
  // 入口
  // -------------------------------------------------------------------------

  /** 開いている PDF のページをコピーする(1ページ / 複数ページで動きが変わる) */
  copyPages(pageNumbers) {
    const list = [...new Set(pageNumbers)].filter(n => n >= 1 && n <= viewPageCount(this.app.pdfDocument));
    if (!this.app.pdfDocument || !list.length) {
      return Promise.resolve();
    }
    if (list.length === 1) {
      return this.copySinglePage(list[0]);
    }
    const pages = this.currentPages(list);
    const mode = this.getSettings().aiCopyMulti;
    if (mode === "pdf-copy") {
      return this.copyPdf(pages);
    }
    if (mode === "image-copy") {
      return this.copyImages(pages);
    }
    return this.saveMultiple(pages, mode);
  }

  /** 1ページを、設定どおりの形式でコピー/保存する */
  copySinglePage(pageNumber) {
    const mode = this.getSettings().aiCopySingle;
    if (mode === "file-pdf") {
      return this.savePagePdf(pageNumber);
    }
    if (mode === "file-png") {
      return this.savePageImage(pageNumber);
    }
    return this.copyPageImageToClipboard(pageNumber);
  }

  /** 複数ページ(収集したページなど)を、ファイルに保存する */
  saveMultiple(pages, format) {
    return format === "zip" ? this.saveImageZip(pages) : this.savePdf(pages);
  }

  // -------------------------------------------------------------------------
  // 画像1枚をクリップボードへ
  // -------------------------------------------------------------------------

  /** 開いている PDF の1ページを画像にしてクリップボードへ */
  copyPageImageToClipboard(pageNumber) {
    return this.copyImageToClipboard({ doc: this.app.pdfDocument, pageNumber, rotation: this.rotation, label: `${pageNumber}ページ目` });
  }

  /**
   * ページを画像(PNG)にしてクリップボードへ入れる。
   * @param {{doc:object, pageNumber:number, rotation:number, label:string, nameBase?:string}} o
   *   nameBase: 保存に切り替えたときのファイル名の元(既定は開いている PDF の名前)
   */
  copyImageToClipboard({ doc, pageNumber, rotation = 0, label, nameBase = null }) {
    return this.exclusive(async () => {
      const settings = this.getSettings();
      const busy = this.toast.show(`${label}を画像にしています…`, { duration: 0 });
      let lastError = null;
      try {
        for (const shrink of PNG_RETRY_SHRINKS) {
          let info = null;
          try {
            // クリップボードへの書き込みは、操作の直後に始める必要があるため、
            // 画像の完成を待たずに書き込みを始め、画像は後から渡す(Promise)
            const blobPromise = renderPagePng(doc, pageNumber, { settings, rotation, shrink }).then(r => {
              info = r;
              return r.blob;
            });
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })]);
            busy();
            const note = shrink < 1 ? "(大きすぎたため解像度を下げました)" : "";
            this.toast.show(`${label}を画像(${info.width}×${info.height})でコピーしました${note}。貼り付けて使えます`, { duration: 5000 });
            return true;
          } catch (e) {
            lastError = e;
            console.warn("[製本ビューア] クリップボードへの書き込みに失敗", shrink, e);
            // 権限やフォーカスの問題は、解像度を下げても直らない
            if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
              break;
            }
          }
        }
        busy();
        // ファイル保存に切り替える
        const fileName = await this.writeImageFile(doc, pageNumber, rotation, nameBase);
        this.toast.show(
          `クリップボードに入れられなかったため、画像ファイル(${fileName})として保存しました` +
            (lastError?.message ? `(理由: ${lastError.message})` : ""),
          { kind: "error", duration: 8000 }
        );
        return false;
      } catch (e) {
        busy();
        this.toast.show(`コピーできませんでした: ${e.message || e}`, { kind: "error", duration: 8000 });
        return false;
      }
    });
  }

  // -------------------------------------------------------------------------
  // ファイル保存
  // -------------------------------------------------------------------------

  /** 1ページを画像ファイルとして保存する(最高画質で元の JPEG を取り出せるときは .jpg、それ以外は .png) */
  savePageImage(pageNumber) {
    return this.exclusive(async () => {
      const busy = this.toast.show(`${pageNumber}ページ目を画像にしています…`, { duration: 0 });
      try {
        const fileName = await this.writeImageFile(this.app.pdfDocument, pageNumber, this.rotation);
        busy();
        this.toast.show(`画像を保存しました: ${fileName}`);
      } catch (e) {
        busy();
        this.toast.show(`画像を保存できませんでした: ${e.message || e}`, { kind: "error", duration: 8000 });
      }
    });
  }

  /** 互換のため(0.1 までの名前) */
  savePagePng(pageNumber) {
    return this.savePageImage(pageNumber);
  }

  async writeImageFile(doc, pageNumber, rotation, nameBase = null) {
    const settings = this.getSettings();
    const base = sanitizeFileName(nameBase || this.docSource.baseName());
    const srcIndex = doc === this.app.pdfDocument ? sourceIndex(doc, pageNumber) : pageNumber - 1;
    let lastError = null;
    for (const shrink of PNG_RETRY_SHRINKS) {
      try {
        const file = await pageImageFile(doc, pageNumber, srcIndex, { settings, rotation, shrink });
        const fileName = `${base}_p${pageNumber}.${file.ext}`;
        await saveBlob(file.blob, fileName);
        return fileName;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }

  /** 1ページを PDF ファイルとして保存する(元のテキスト・ベクターのまま) */
  savePagePdf(pageNumber) {
    const pages = this.currentPages([pageNumber]);
    const fileName = `${sanitizeFileName(this.docSource.baseName())}_p${pageNumber}.pdf`;
    return this.savePdf(pages, fileName);
  }

  /**
   * ページを1つの PDF にする(元の文字・図・画像のまま。OCR の文字も残る)。
   * @param {Array<{source:"current"|Uint8Array, pageIndex:number, name:string}>} pages
   *   pageIndex は 0始まり。source が "current" のときは表示上のページ番号、保存済みのデータのときはその PDF のページ番号
   * @returns {Promise<Uint8Array>}
   */
  async buildPdf(pages) {
    const doc = this.app.pdfDocument;
    // 抜き出しは元の PDF のページ番号で指定する(ページを削除した後でも、表示しているページを抜き出す)
    pages = pages.map(p => (p.source === "current" ? { ...p, pageIndex: sourceIndex(doc, p.pageIndex + 1) } : p));
    // 開いている PDF のページは、書き込んだ注釈・フォームの入力内容も含める
    // (パスワードを入力して開いた PDF は、写しにもパスワードが必要になるため、新しい注釈だけを含める)
    if (doc && pages.some(p => p.source === "current") && !this.docSource.passwordDocs.has(doc)) {
      const edited = await editedDocumentBytes(doc);
      if (edited) {
        pages = pages.map(p => (p.source === "current" ? { ...p, source: edited } : p));
      }
    }
    return extractPagesToPdf(doc || null, pages);
  }

  /**
   * ページを1つの PDF にして保存する。
   * @param {Array<{source:"current"|Uint8Array, pageIndex:number, name:string}>} pages
   * @param {string} [fileName]
   */
  savePdf(pages, fileName = null) {
    return this.exclusive(async () => {
      fileName ||= this.excerptFileName(pages, "pdf");
      const busy = this.toast.show(`PDF を作成しています…(${pages.length}ページ)`, { duration: 0 });
      try {
        const bytes = await this.buildPdf(pages);
        const id = await saveBlob(new Blob([bytes], { type: "application/pdf" }), fileName);
        busy();
        this.toast.show(`${pages.length}ページを PDF で保存しました: ${fileName}`, {
          duration: 6000,
          action: { label: "フォルダを開く", onClick: () => chrome.downloads.show(id) },
        });
        return true;
      } catch (e) {
        busy();
        console.error(e);
        this.toast.show(`PDF を作成できませんでした: ${e.message || e}`, { kind: "error", duration: 8000 });
        return false;
      }
    });
  }

  /**
   * ページを画像ファイルにする(ZIP・画像としてコピー用)。
   * @returns {Promise<Array<{name:string, blob:Blob}>>}
   */
  async buildImageFiles(pages, onProgress) {
    const settings = this.getSettings();
    const opened = new Map();
    const files = [];
    const digits = Math.max(3, String(pages.length).length);
    try {
      for (let i = 0; i < pages.length; i++) {
        onProgress?.(i + 1, pages.length);
        const p = pages[i];
        let doc;
        let rotation = 0;
        let srcIndex;
        if (p.source === "current") {
          doc = this.app.pdfDocument;
          rotation = this.rotation;
          srcIndex = sourceIndex(doc, p.pageIndex + 1);
        } else {
          if (!opened.has(p.source)) {
            opened.set(p.source, loadPdfFromBytes(p.source));
          }
          doc = await opened.get(p.source);
          srcIndex = p.pageIndex;
        }
        let file = null;
        let lastError = null;
        for (const shrink of PNG_RETRY_SHRINKS) {
          try {
            file = await pageImageFile(doc, p.pageIndex + 1, srcIndex, { settings, rotation, shrink });
            break;
          } catch (e) {
            lastError = e;
          }
        }
        if (!file) {
          throw lastError || new Error("画像にできませんでした");
        }
        const num = String(i + 1).padStart(digits, "0");
        files.push({ name: `${num}_${sanitizeFileName(p.name)}_p${p.pageIndex + 1}.${file.ext}`, blob: file.blob });
      }
      return files;
    } finally {
      for (const promise of opened.values()) {
        promise.then(doc => doc.loadingTask.destroy()).catch(() => {});
      }
    }
  }

  /** ページを画像にして ZIP で保存する */
  saveImageZip(pages, fileName = null) {
    return this.exclusive(async () => {
      fileName ||= this.excerptFileName(pages, "zip");
      const busy = this.toast.show(`画像を作成しています… 0/${pages.length}`, { duration: 0 });
      try {
        const files = await this.buildImageFiles(pages, (i, n) => busy.update(`画像を作成しています… ${i}/${n}`));
        busy.update("ZIP にまとめています…");
        const zip = await createZip(files);
        const id = await saveBlob(zip, fileName);
        busy();
        this.toast.show(`${pages.length}ページを画像(ZIP)で保存しました: ${fileName}`, {
          duration: 6000,
          action: { label: "フォルダを開く", onClick: () => chrome.downloads.show(id) },
        });
        return true;
      } catch (e) {
        busy();
        console.error(e);
        this.toast.show(`画像(ZIP)を作成できませんでした: ${e.message || e}`, { kind: "error", duration: 8000 });
        return false;
      }
    });
  }

  /** 互換のため(0.1 までの名前) */
  savePngZip(pages, fileName = null) {
    return this.saveImageZip(pages, fileName);
  }

  // -------------------------------------------------------------------------
  // ファイルとしてクリップボードへ(PDF としてコピー / 画像としてコピー)
  // -------------------------------------------------------------------------

  /** ページを1つの PDF にして、クリップボードへ(ファイルとして) */
  copyPdf(pages) {
    return this.exclusive(async () => {
      const fileName = this.excerptFileName(pages, "pdf", { seconds: true });
      const busy = this.toast.show(`PDF を作成しています…(${pages.length}ページ)`, { duration: 0 });
      try {
        const bytes = await this.buildPdf(pages);
        busy.update("クリップボードに入れています…");
        const result = await copyFilesToClipboard([{ blob: new Blob([bytes], { type: "application/pdf" }), name: fileName }]);
        busy();
        this.reportCopy(result, { what: `${pages.length}ページの PDF`, fileName });
        return result.mode !== "saved";
      } catch (e) {
        busy();
        console.error(e);
        this.toast.show(`PDF としてコピーできませんでした: ${e.message || e}`, { kind: "error", duration: 8000 });
        return false;
      }
    });
  }

  /**
   * ページを画像にして、クリップボードへ。
   * 1ページなら画像そのもの(どこにでも貼り付けられる)、複数ページなら画像ファイル(設定によっては ZIP)として。
   */
  async copyImages(pages) {
    if (pages.length === 1) {
      const p = pages[0];
      if (p.source === "current") {
        return this.copyPageImageToClipboard(p.pageIndex + 1);
      }
      let doc = null;
      try {
        doc = await loadPdfFromBytes(p.source);
        return await this.copyImageToClipboard({
          doc,
          pageNumber: p.pageIndex + 1,
          rotation: 0,
          label: `「${p.name}」の ${p.pageIndex + 1}ページ目`,
          nameBase: p.name,
        });
      } finally {
        doc?.loadingTask?.destroy();
      }
    }
    return this.exclusive(async () => {
      const asZip = this.getSettings().copyImagesAs === "zip";
      const busy = this.toast.show(`画像を作成しています… 0/${pages.length}`, { duration: 0 });
      try {
        const files = await this.buildImageFiles(pages, (i, n) => busy.update(`画像を作成しています… ${i}/${n}`));
        let result;
        if (asZip) {
          busy.update("ZIP にまとめています…");
          const fileName = this.excerptFileName(pages, "zip", { seconds: true });
          const zip = await createZip(files);
          busy.update("クリップボードに入れています…");
          result = await copyFilesToClipboard([{ blob: zip, name: fileName }]);
          busy();
          this.reportCopy(result, { what: `${pages.length}ページの画像(ZIP)`, fileName });
        } else {
          busy.update("クリップボードに入れています…");
          const folder = this.excerptFileName(pages, "", { seconds: true }).replace(/\.$/, "");
          result = await copyFilesToClipboard(files, { folder });
          busy();
          this.reportCopy(result, { what: `${pages.length}ページの画像`, fileName: `${folder}(フォルダ)`, many: true });
        }
        return result.mode !== "saved";
      } catch (e) {
        busy();
        console.error(e);
        this.toast.show(`画像としてコピーできませんでした: ${e.message || e}`, { kind: "error", duration: 8000 });
        return false;
      }
    });
  }

  /** ファイルのコピーの結果を知らせる */
  reportCopy(result, { what, fileName, many = false }) {
    const openFolder = {
      label: "フォルダを開く",
      onClick: () => (result.via === "helper" ? revealInFolder(result.paths[0]) : chrome.downloads.show(result.ids[0])),
    };
    const helperInfo = {
      label: "補助プログラムについて",
      onClick: () => chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html#sec-copy") }),
    };
    if (result.mode === "files") {
      // 0.4.1: 見えない一時フォルダに置いた使い捨てのファイル(フォルダを開くボタンは出さない)
      this.toast.show(
        result.temp
          ? `${what}をクリップボードにコピーしました。フォルダやチャット欄などに貼り付けられます(Ctrl+V。次にコピーすると、このコピーは使えなくなります)`
          : `${what}をクリップボードにコピーしました。フォルダやチャット欄などに貼り付けられます(Ctrl+V)`,
        { duration: 7000, actions: result.temp ? [] : [openFolder] }
      );
    } else if (result.mode === "path") {
      const where = many ? "フォルダの場所" : "ファイルの場所";
      const why =
        result.reason === "permission" || result.reason === "not-installed"
          ? "ファイルそのものをコピーするには、補助プログラムが必要です"
          : `補助プログラムを使えませんでした${result.error ? `(${result.error})` : ""}`;
      this.toast.show(
        `${what}を保存して、${where}をクリップボードにコピーしました(${fileName})。ファイルを選ぶ画面の「ファイル名」の欄に貼り付けると選べます。${why}`,
        { duration: 12000, actions: [openFolder, helperInfo] }
      );
    } else {
      this.toast.show(`${what}を保存しました(${fileName})。クリップボードには入れられませんでした: ${result.error || ""}`, {
        kind: "error",
        duration: 10000,
        actions: [openFolder],
      });
    }
  }

  /** 「元ファイル名_抜粋_日時.pdf」(複数の PDF をまたぐときは「元ファイル名ほか_抜粋_日時.pdf」) */
  excerptFileName(pages, ext, { seconds = false } = {}) {
    const names = [...new Set(pages.map(p => p.name).filter(Boolean))];
    const base = sanitizeFileName(names[0] || this.docSource.baseName());
    const suffix = names.length > 1 ? "ほか" : "";
    return `${base}${suffix}_抜粋_${timestampForFileName(new Date(), { seconds })}.${ext}`;
  }
}
