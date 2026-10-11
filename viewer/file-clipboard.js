/**
 * ファイルをクリップボードに入れる(「PDF としてコピー」「画像としてコピー」)。
 *
 * ブラウザの決まりで、拡張機能だけではクリップボードにファイルを入れられない
 * (入れられるのは文字と、画像1枚だけ)。そこで、
 *  1. ファイルをダウンロードフォルダの中の「製本ビューア_コピー」フォルダに保存し、
 *  2. 補助プログラム(拡張機能のフォルダの helper。Windows・Mac・Linux 用)が入っていれば、
 *     保存したファイルの場所を渡して、クリップボードに入れてもらう(貼り付けると、ファイルとして貼り付く)。
 *  3. 補助プログラムが無いとき(または使えないとき)は、保存したファイルの場所(パス)を、
 *     文字としてクリップボードに入れる(ファイルを選ぶ画面の「ファイル名」欄に貼り付けて使える)。
 *
 * 補助プログラムとのやりとりには Chrome の「ネイティブ メッセージング」を使う。
 * そのための権限(nativeMessaging)は、詳細設定で補助プログラムを使うと決めたときだけ求める(任意の権限)。
 * 補助プログラムは、この拡張機能からの依頼しか受け付けない(登録ファイルの allowed_origins)。
 */

import { COPY_FOLDER, parentFolderOf, saveBlobAndWait } from "../common/files.js";

export const HELPER_HOST = "com.seihon_viewer.clipboard";
export const HELPER_PERMISSION = { permissions: ["nativeMessaging"] };

/** 補助プログラムを使う権限があるか */
export async function helperPermitted() {
  try {
    return !!(await chrome.permissions.contains(HELPER_PERMISSION));
  } catch {
    return false;
  }
}

/**
 * 補助プログラムの状態。
 * @returns {Promise<{available:boolean, reason?:"permission"|"reload"|"not-installed"|"error", os?:string, version?:number, error?:string}>}
 */
export async function helperStatus() {
  if (!(await helperPermitted())) {
    return { available: false, reason: "permission" };
  }
  if (typeof chrome.runtime.sendNativeMessage !== "function") {
    // 権限を許可した直後は、開いていたページを開き直すまで使えないことがある
    return { available: false, reason: "reload" };
  }
  try {
    const res = await chrome.runtime.sendNativeMessage(HELPER_HOST, { type: "ping" });
    if (res?.ok) {
      return { available: true, os: res.os, version: res.version };
    }
    return { available: false, reason: "error", error: res?.error || "応答がありません" };
  } catch (e) {
    const message = e?.message || String(e);
    return { available: false, reason: /not found|forbidden/i.test(message) ? "not-installed" : "error", error: message };
  }
}

/**
 * 保存したファイルを、補助プログラムでクリップボードに入れる。
 * @param {string[]} paths パソコン上のファイルの場所
 * @returns {Promise<{ok:boolean, error?:string, reason?:string}>}
 */
export async function putFilesOnClipboard(paths) {
  const status = await helperStatus();
  if (!status.available) {
    return { ok: false, reason: status.reason, error: status.error };
  }
  try {
    const res = await chrome.runtime.sendNativeMessage(HELPER_HOST, { type: "copy-files", paths });
    return res?.ok ? { ok: true, count: res.count } : { ok: false, reason: "error", error: res?.error || "コピーできませんでした" };
  } catch (e) {
    return { ok: false, reason: "error", error: e?.message || String(e) };
  }
}

/**
 * ファイルを保存して、クリップボードに入れる(入れられなければ、場所を文字でクリップボードに入れる)。
 * @param {Array<{blob:Blob, name:string}>} files
 * @param {object} o
 * @param {string|null} [o.folder] 複数のファイルをまとめるフォルダの名前(「製本ビューア_コピー」の中に作る)
 * @param {(done:number, total:number) => void} [o.onProgress]
 * @returns {Promise<{mode:"files"|"path"|"saved", paths:string[], ids:number[], text?:string, reason?:string, error?:string}>}
 *   mode: files = ファイルとしてクリップボードに入れた / path = 場所を文字でクリップボードに入れた /
 *         saved = 保存はしたが、クリップボードには入れられなかった(このタブが前面に無かったなど)
 */
export async function copyFilesToClipboard(files, { folder = null, onProgress = null } = {}) {
  const dir = folder ? `${COPY_FOLDER}/${folder}` : COPY_FOLDER;
  const saved = [];
  for (const f of files) {
    saved.push(await saveBlobAndWait(f.blob, `${dir}/${f.name}`));
    onProgress?.(saved.length, files.length);
  }
  const paths = saved.map(s => s.path);
  const ids = saved.map(s => s.id);
  const result = await putFilesOnClipboard(paths);
  if (result.ok) {
    return { mode: "files", paths, ids };
  }
  // 補助プログラムが無い: 場所(パス)を文字でクリップボードに入れる
  const text = files.length > 1 ? parentFolderOf(paths[0]) : paths[0];
  try {
    await navigator.clipboard.writeText(text);
    return { mode: "path", paths, ids, text, reason: result.reason, error: result.error };
  } catch (e) {
    return { mode: "saved", paths, ids, text, reason: result.reason, error: e?.message || String(e) };
  }
}
