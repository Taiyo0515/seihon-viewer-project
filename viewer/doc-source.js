/**
 * ビューアで開いている文書の「出どころ」の管理:
 *  - ファイル名(書き出すファイルの名前に使う)
 *  - 内容の指紋(同じ PDF かどうかの判定。URL には頼らない)
 *  - 収集のための保存(同じ PDF は1回だけ保存する)
 */

import { hasPdf, putPdf, storageUsage } from "../common/db.js";
import { baseName, formatBytes } from "../common/files.js";
import { blankPdfBytes, computePdfKey } from "./page-export.js";
import { confirmDialog } from "./ui/dialog.js";

export class DocSource {
  /**
   * @param {object} app PDFViewerApplication
   * @param {object} o
   * @param {() => {kind:string,url:string|null,name:string|null}} o.getCurrent 開いている文書の出どころ
   * @param {() => object} o.getSettings
   */
  constructor(app, { getCurrent, getSettings }) {
    this.app = app;
    this.getCurrent = getCurrent;
    this.getSettings = getSettings;
    /** @type {WeakMap<object, Promise<string>>} 文書 → 指紋 */
    this.keys = new WeakMap();
    /** パスワードを入力して開いた文書 */
    this.passwordDocs = new WeakSet();
    this.loadingNeedsPassword = false;
    /** 次に開く文書の指紋(内容から計算せずに決めておくもの。整えたスキャンの PDF など) */
    this.nextKey = null;

    // パスワード入力画面が出たかどうかを記録する(パスワード付きの PDF は、復号した写しを保存するため)
    const prompt = app.passwordPrompt;
    if (prompt?.open) {
      const open = prompt.open.bind(prompt);
      prompt.open = (...args) => {
        this.loadingNeedsPassword = true;
        return open(...args);
      };
    }
    app.eventBus.on("documentloaded", () => {
      if (this.loadingNeedsPassword && app.pdfDocument) {
        this.passwordDocs.add(app.pdfDocument);
      }
      this.loadingNeedsPassword = false;
      // ほかの部品(ページ役割など)より先に、決めておいた指紋を登録する
      if (this.nextKey && app.pdfDocument) {
        this.keys.set(app.pdfDocument, Promise.resolve(this.nextKey));
      }
      this.nextKey = null;
    });
  }

  /**
   * 次に開く文書の指紋を、先に決めておく(0.3: 整えたスキャンの PDF)。
   * 整えた PDF は、同じ元の PDF・同じ整え方なら同じ指紋にして、ページ役割などを次に開いたときも使えるようにする。
   */
  presetNextKey(key) {
    this.nextKey = key || null;
  }

  /** 新しい文書を開き始めるときに呼ぶ */
  resetForOpen() {
    this.loadingNeedsPassword = false;
    this.nextKey = null;
  }

  /** 書き出すファイルの名前の元(拡張子なし) */
  baseName() {
    const current = this.getCurrent();
    let name = "";
    if (current.arranged?.fileName) {
      // 整えたスキャンの PDF(元の名前_分割.pdf など)
      name = current.arranged.fileName;
    } else if (current.converted?.fileName) {
      // 0.4: コミック・画像の EPUB を PDF にしたもの(元の名前.pdf)
      name = current.converted.fileName;
    } else if (current.kind === "file" && current.name) {
      name = current.name;
    } else {
      name = this.app._docFilename || "";
    }
    try {
      name = decodeURIComponent(name);
    } catch {}
    return baseName(name) || "document";
  }

  /** 表示用の名前(拡張子つき) */
  displayName() {
    return `${this.baseName()}.pdf`;
  }

  /** 開いている文書の指紋(同じ文書なら2回目からはすぐ返る) */
  key(doc = this.app.pdfDocument) {
    if (!doc) {
      return Promise.resolve(null);
    }
    let promise = this.keys.get(doc);
    if (!promise) {
      promise = doc.getData().then(bytes => computePdfKey(bytes));
      this.keys.set(doc, promise);
      promise.catch(() => this.keys.delete(doc));
    }
    return promise;
  }

  /** 指紋がもう計算済みなら返す(まだなら null)。メニューの表示切り替え用 */
  async keyIfReady(doc = this.app.pdfDocument) {
    const promise = doc && this.keys.get(doc);
    if (!promise) {
      return null;
    }
    const timeout = new Promise(r => setTimeout(() => r(null), 30));
    return Promise.race([promise.catch(() => null), timeout]);
  }

  /**
   * 収集のために、開いている PDF を保存する(保存済みなら何もしない)。
   * 保存上限を超える場合は確認する。
   * @returns {Promise<string|null>} 指紋。やめた場合は null
   */
  async ensureStored() {
    const doc = this.app.pdfDocument;
    if (!doc) {
      return null;
    }
    const key = await this.key(doc);
    const current = this.getCurrent();
    const name = this.displayName();
    const url = current.kind === "url" ? current.url : "";
    if (await hasPdf(key)) {
      await putPdf({ key, name, url });
      return key;
    }
    let bytes = await doc.getData();
    let decrypted = false;
    if (this.passwordDocs.has(doc)) {
      // パスワード付きの PDF は、書き出しのたびにパスワードを聞かずに済むよう、パスワード無しの写しを保存する
      const copy = await decryptedCopy(doc);
      if (copy?.length) {
        bytes = copy;
        decrypted = true;
      }
    }
    const limitBytes = this.getSettings().collectLimitMB * 1024 * 1024;
    const usage = await storageUsage();
    if (usage.total + bytes.length > limitBytes) {
      const ok = await confirmDialog({
        title: "収集の保存上限を超えます",
        message:
          `収集には元の PDF も保存します。このPDF(${formatBytes(bytes.length)})を加えると、` +
          `保存容量が上限(${formatBytes(limitBytes)})を超えます(現在 ${formatBytes(usage.total)})。\n` +
          "追加してよいですか? 上限は詳細設定で変えられます。不要になった収集は書き出したあと消すと空きます。",
        okLabel: "追加する",
        cancelLabel: "やめる",
      });
      if (!ok) {
        return null;
      }
    }
    await putPdf({ key, name, url, size: bytes.length, pages: doc.numPages, bytes, decrypted });
    return key;
  }
}

/**
 * パスワード付きの PDF から、パスワード無しの写しを作る。
 * PDF.js のページ抽出は、1つの文書だけから抜き出すと元の暗号化をそのまま引き継ぐため、
 * いったん空白の1ページを足して「結合」として書き出し(暗号化されない)、その1ページを除いて書き出し直す。
 */
export async function decryptedCopy(doc) {
  const merged = await doc.extractPages([{ document: null }, { document: blankPdfBytes() }]);
  if (!merged?.length) {
    return null;
  }
  return doc.extractPages([{ document: merged, excludePages: [doc.numPages] }]);
}
