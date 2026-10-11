/**
 * AI用コピーと、ページの書き出し(PNG / PDF / PNG群の ZIP)。
 *
 * - 1ページ(既定): 高解像度の PNG をクリップボードへ。AI のチャット欄にそのまま貼り付けられる。
 *   書き込みに失敗したら解像度を下げて再挑戦し、それでも駄目なら PNG ファイルとして保存して知らせる。
 * - 複数ページ(既定): 1つの PDF として保存(元のテキスト・ベクターのまま。再エンコードしない)。
 * - 詳細設定で、PDF / PNG のファイル保存、PNG 群の ZIP に切り替えられる。
 */

import { createZip, sanitizeFileName, saveBlob, timestampForFileName } from "../common/files.js";
import { editedDocumentBytes, extractPagesToPdf, loadPdfFromBytes, renderPagePng } from "./page-export.js";
import { sourceIndex, viewPageCount } from "./page-map.js";

const PNG_RETRY_SHRINKS = [1, 0.7, 0.45];

export class AiCopy {
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

  // -------------------------------------------------------------------------
  // 入口
  // -------------------------------------------------------------------------

  /** 開いている PDF のページを AI 用にコピーする(1ページ / 複数ページで動きが変わる) */
  copyPages(pageNumbers) {
    const list = [...new Set(pageNumbers)].filter(n => n >= 1 && n <= viewPageCount(this.app.pdfDocument));
    if (!this.app.pdfDocument || !list.length) {
      return Promise.resolve();
    }
    if (list.length === 1) {
      return this.copySinglePage(list[0]);
    }
    const pages = list.map(n => ({ source: "current", pageIndex: n - 1, name: this.docSource.baseName() }));
    return this.saveMultiple(pages, this.getSettings().aiCopyMulti);
  }

  /** 1ページを、設定どおりの形式で AI 用にコピー/保存する */
  copySinglePage(pageNumber) {
    const mode = this.getSettings().aiCopySingle;
    if (mode === "file-pdf") {
      return this.savePagePdf(pageNumber);
    }
    if (mode === "file-png") {
      return this.savePagePng(pageNumber);
    }
    return this.copyPagePngToClipboard(pageNumber);
  }

  /** 複数ページ(収集したページなど)を、設定どおりの形式で保存する */
  saveMultiple(pages, format) {
    return format === "zip" ? this.savePngZip(pages) : this.savePdf(pages);
  }

  // -------------------------------------------------------------------------
  // クリップボード
  // -------------------------------------------------------------------------

  copyPagePngToClipboard(pageNumber) {
    return this.exclusive(async () => {
      const doc = this.app.pdfDocument;
      const settings = this.getSettings();
      const busy = this.toast.show(`${pageNumber}ページ目を画像にしています…`, { duration: 0 });
      let lastError = null;
      try {
        for (const shrink of PNG_RETRY_SHRINKS) {
          let info = null;
          try {
            // クリップボードへの書き込みは、ユーザーの操作の直後に始める必要があるため、
            // 画像の完成を待たずに書き込みを始め、画像は後から渡す(Promise)
            const blobPromise = renderPagePng(doc, pageNumber, { settings, rotation: this.rotation, shrink }).then(r => {
              info = r;
              return r.blob;
            });
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })]);
            busy();
            const note = shrink < 1 ? "(大きすぎたため解像度を下げました)" : "";
            this.toast.show(
              `${pageNumber}ページ目を PNG 画像(${info.width}×${info.height})でコピーしました${note}。AI のチャット欄に貼り付けられます`,
              { duration: 5000 }
            );
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
        const fileName = await this.writePngFile(pageNumber);
        this.toast.show(
          `クリップボードに入れられなかったため、PNG ファイル(${fileName})として保存しました` +
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

  /** 1ページを PNG ファイルとして保存する */
  savePagePng(pageNumber) {
    return this.exclusive(async () => {
      const busy = this.toast.show(`${pageNumber}ページ目を PNG にしています…`, { duration: 0 });
      try {
        const fileName = await this.writePngFile(pageNumber);
        busy();
        this.toast.show(`PNG で保存しました: ${fileName}`);
      } catch (e) {
        busy();
        this.toast.show(`PNG を保存できませんでした: ${e.message || e}`, { kind: "error", duration: 8000 });
      }
    });
  }

  async writePngFile(pageNumber) {
    const settings = this.getSettings();
    const base = sanitizeFileName(this.docSource.baseName());
    let lastError = null;
    for (const shrink of PNG_RETRY_SHRINKS) {
      try {
        const { blob } = await renderPagePng(this.app.pdfDocument, pageNumber, {
          settings,
          rotation: this.rotation,
          shrink,
        });
        const fileName = `${base}_p${pageNumber}.png`;
        await saveBlob(blob, fileName);
        return fileName;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }

  /** 1ページを PDF ファイルとして保存する(元のテキスト・ベクターのまま) */
  savePagePdf(pageNumber) {
    const pages = [{ source: "current", pageIndex: pageNumber - 1, name: this.docSource.baseName() }];
    const fileName = `${sanitizeFileName(this.docSource.baseName())}_p${pageNumber}.pdf`;
    return this.savePdf(pages, fileName);
  }

  /**
   * ページを1つの PDF にして保存する。
   * @param {Array<{source:"current"|Uint8Array, pageIndex:number, name:string}>} pages
   *   pageIndex は 0始まり。source が "current" のときは表示上のページ番号、保存済みのデータのときはその PDF のページ番号
   * @param {string} [fileName]
   */
  savePdf(pages, fileName = null) {
    return this.exclusive(async () => {
      fileName ||= this.excerptFileName(pages, "pdf");
      const busy = this.toast.show(`PDF を作成しています…(${pages.length}ページ)`, { duration: 0 });
      try {
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
        const bytes = await extractPagesToPdf(doc || null, pages);
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

  /** ページを PNG にして ZIP で保存する */
  savePngZip(pages, fileName = null) {
    return this.exclusive(async () => {
      fileName ||= this.excerptFileName(pages, "zip");
      const settings = this.getSettings();
      const busy = this.toast.show(`PNG を作成しています… 0/${pages.length}`, { duration: 0 });
      const opened = new Map();
      try {
        const files = [];
        for (let i = 0; i < pages.length; i++) {
          busy.update(`PNG を作成しています… ${i + 1}/${pages.length}`);
          const p = pages[i];
          let doc;
          let rotation = 0;
          if (p.source === "current") {
            doc = this.app.pdfDocument;
            rotation = this.rotation;
          } else {
            if (!opened.has(p.source)) {
              opened.set(p.source, loadPdfFromBytes(p.source));
            }
            doc = await opened.get(p.source);
          }
          const { blob } = await renderPagePng(doc, p.pageIndex + 1, { settings, rotation });
          const num = String(i + 1).padStart(String(pages.length).length < 3 ? 3 : String(pages.length).length, "0");
          files.push({ name: `${num}_${sanitizeFileName(p.name)}_p${p.pageIndex + 1}.png`, blob });
        }
        busy.update("ZIP にまとめています…");
        const zip = await createZip(files);
        const id = await saveBlob(zip, fileName);
        busy();
        this.toast.show(`${pages.length}ページを PNG(ZIP)で保存しました: ${fileName}`, {
          duration: 6000,
          action: { label: "フォルダを開く", onClick: () => chrome.downloads.show(id) },
        });
        return true;
      } catch (e) {
        busy();
        console.error(e);
        this.toast.show(`PNG(ZIP)を作成できませんでした: ${e.message || e}`, { kind: "error", duration: 8000 });
        return false;
      } finally {
        for (const promise of opened.values()) {
          promise.then(doc => doc.loadingTask.destroy()).catch(() => {});
        }
      }
    });
  }

  /** 「元ファイル名_抜粋_日時.pdf」(複数の PDF をまたぐときは「元ファイル名ほか_抜粋_日時.pdf」) */
  excerptFileName(pages, ext) {
    const names = [...new Set(pages.map(p => p.name).filter(Boolean))];
    const base = sanitizeFileName(names[0] || this.docSource.baseName());
    const suffix = names.length > 1 ? "ほか" : "";
    return `${base}${suffix}_抜粋_${timestampForFileName()}.${ext}`;
  }
}
