/**
 * ファイルをクリップボードに入れる(「PDF としてコピー」「画像としてコピー」)。
 *
 * ブラウザの決まりで、拡張機能だけではクリップボードにファイルを入れられない
 * (入れられるのは文字と、画像1枚だけ)。そこで、
 *  - 補助プログラム(拡張機能のフォルダの helper。Windows・Mac・Linux 用)が入っていれば、
 *    ファイルのデータを補助プログラムに渡し、見えない一時フォルダ(Windows なら %TEMP%\seihon-viewer-copy)に保存して、
 *    クリップボードに入れてもらう(貼り付けると、ファイルとして貼り付く)。
 *    コピーは使い捨て: 次にコピーすると、前のコピーのファイルは消える(「ダウンロード」には何も残らない。0.4.1)。
 *    Chrome のダウンロードを通さないので、ダウンロードの一覧にも出ない。
 *  - 補助プログラムが無いとき(または使えないとき)は、Chrome のダウンロードで「ダウンロード」の「製本ビューア_コピー」に保存し、
 *    保存したファイルの場所(パス)を、文字としてクリップボードに入れる
 *    (ファイルを選ぶ画面の「ファイル名」の欄に貼り付けて使える)。このときも使い捨てで、次にコピーすると前のファイルは消す。
 *    ダウンロードの表示(ツールバーのダウンロードの印)は、保存している間だけ出さない(0.4.1)。
 *
 * 補助プログラムとのやりとりには Chrome の「ネイティブ メッセージング」を使う。
 * そのための権限(nativeMessaging)は、詳細設定で補助プログラムを使うと決めたときだけ求める(任意の権限)。
 * 補助プログラムは、この拡張機能からの依頼しか受け付けない(登録ファイルの allowed_origins)。
 */

import { COPY_FOLDER, parentFolderOf, saveBlobAndWait } from "../common/files.js";

export const HELPER_HOST = "com.seihon_viewer.clipboard";
export const HELPER_PERMISSION = { permissions: ["nativeMessaging"] };
/**
 * 補助プログラムに1回で渡すデータの大きさ。
 * Windows PowerShell 5.1 は 2MB を超える JSON を読めないため、1MB(base64 で約 1.4MB)ずつ渡す。
 */
const CHUNK_BYTES = 1024 * 1024;

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
      return { available: true, os: res.os, version: res.version || 1 };
    }
    return { available: false, reason: "error", error: res?.error || "応答がありません" };
  } catch (e) {
    const message = e?.message || String(e);
    return { available: false, reason: /not found|forbidden/i.test(message) ? "not-installed" : "error", error: message };
  }
}

/** Blob → base64 の文字列 */
function base64Of(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("読み込めませんでした"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 補助プログラムにファイルのデータを渡して保存してもらい、クリップボードに入れてもらう。
 * @returns {Promise<{ok:boolean, paths?:string[], error?:string}>}
 */
async function saveAndCopyWithHelper(files, folder, onProgress, place = null) {
  const port = chrome.runtime.connectNative(HELPER_HOST);
  const waiting = [];
  let failure = null;
  port.onMessage.addListener(message => waiting.shift()?.resolve(message));
  port.onDisconnect.addListener(() => {
    failure = new Error(chrome.runtime.lastError?.message || "補助プログラムとのやりとりが途中で切れました");
    while (waiting.length) {
      waiting.shift().reject(failure);
    }
  });
  const request = message =>
    new Promise((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      waiting.push({ resolve, reject });
      port.postMessage(message);
    });
  try {
    const begun = await request({
      type: "begin",
      root: COPY_FOLDER,
      // 版 3 の補助プログラム: 見えない一時フォルダに保存し、前のコピーは消す(使い捨て)
      ...(place ? { place } : {}),
      folder: folder || "",
      files: files.map(f => ({ name: f.name, size: f.blob.size })),
    });
    if (!begun?.ok) {
      return { ok: false, error: begun?.error || "保存を始められませんでした" };
    }
    const total = files.reduce((sum, f) => sum + f.blob.size, 0);
    let done = 0;
    for (let i = 0; i < files.length; i++) {
      const blob = files[i].blob;
      for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
        const piece = blob.slice(offset, offset + CHUNK_BYTES);
        const res = await request({ type: "chunk", index: i, data: await base64Of(piece) });
        if (!res?.ok) {
          return { ok: false, error: res?.error || "保存できませんでした", paths: begun.paths };
        }
        done += piece.size;
        onProgress?.(done, total);
      }
    }
    const finished = await request({ type: "finish" });
    return finished?.ok ? { ok: true, paths: finished.paths || begun.paths } : { ok: false, error: finished?.error, paths: finished?.paths || null };
  } finally {
    try {
      port.disconnect();
    } catch {}
  }
}

const COPY_IDS_KEY = "copyDownloadIds";

/** 前のコピーで(Chrome のダウンロードで)保存したファイルを消す。消せないもの(すでに無い・使用中)はそのまま */
async function disposePreviousCopies() {
  let ids = [];
  try {
    ids = (await chrome.storage.local.get(COPY_IDS_KEY))[COPY_IDS_KEY] || [];
  } catch {}
  for (const id of ids) {
    try {
      const [item] = await chrome.downloads.search({ id });
      if (item?.exists && item.byExtensionId === chrome.runtime.id) {
        await chrome.downloads.removeFile(id);
      }
    } catch {}
    try {
      await chrome.downloads.erase({ id });
    } catch {}
  }
  await chrome.storage.local.set({ [COPY_IDS_KEY]: [] }).catch(() => {});
}

async function rememberCopies(ids) {
  await chrome.storage.local.set({ [COPY_IDS_KEY]: ids.filter(id => Number.isInteger(id)) }).catch(() => {});
}

/** ダウンロードの表示(ツールバーの印・吹き出し)を一時的に出さない(downloads.ui の権限があるとき) */
async function hideDownloadUi() {
  if (typeof chrome.downloads.setUiOptions !== "function") {
    return { restore: async () => {} };
  }
  try {
    await chrome.downloads.setUiOptions({ enabled: false });
  } catch {
    return { restore: async () => {} };
  }
  return {
    restore: async () => {
      try {
        await chrome.downloads.setUiOptions({ enabled: true });
      } catch {}
    },
  };
}

/** 保存済みのファイルを、補助プログラムでクリップボードに入れる */
async function copyPathsWithHelper(paths) {
  try {
    const res = await chrome.runtime.sendNativeMessage(HELPER_HOST, { type: "copy-files", paths });
    return res?.ok ? { ok: true } : { ok: false, error: res?.error || "コピーできませんでした" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 補助プログラムで、ファイルのあるフォルダを開く(エクスプローラー・Finder で見せる) */
export async function revealInFolder(path) {
  try {
    const res = await chrome.runtime.sendNativeMessage(HELPER_HOST, { type: "reveal", path });
    return !!res?.ok;
  } catch {
    return false;
  }
}

/**
 * ファイルを保存して、クリップボードに入れる(入れられなければ、場所を文字でクリップボードに入れる)。
 * @param {Array<{blob:Blob, name:string}>} files
 * @param {object} o
 * @param {string|null} [o.folder] 複数のファイルをまとめるフォルダの名前(「製本ビューア_コピー」の中に作る)
 * @param {(done:number, total:number) => void} [o.onProgress]
 * @returns {Promise<{mode:"files"|"path"|"saved", via:"helper"|"downloads", paths:string[], ids:number[], text?:string,
 *   reason?:string, error?:string, temp?:boolean}>}
 *   temp: 補助プログラムが見えない一時フォルダに置いた使い捨てのファイル(フォルダを開くボタンは出さない)
 *   mode: files = ファイルとしてクリップボードに入れた / path = 場所を文字でクリップボードに入れた /
 *         saved = 保存はしたが、クリップボードには入れられなかった(このタブが前面に無かったなど)
 *   via: helper = 補助プログラムが保存した / downloads = Chrome のダウンロードで保存した(ids はダウンロードの ID)
 */
export async function copyFilesToClipboard(files, { folder = null, onProgress = null } = {}) {
  const status = await helperStatus();
  let reason = status.reason;
  let error = status.error;
  let paths = null;
  let ids = [];
  let via = "downloads";
  if (status.available && status.version >= 2) {
    try {
      const temp = status.version >= 3;
      const res = await saveAndCopyWithHelper(files, folder, onProgress, temp ? "temp" : null);
      if (res.ok) {
        return { mode: "files", via: "helper", paths: res.paths, ids: [], temp };
      }
      reason = "error";
      error = res.error;
      if (res.paths?.length) {
        // 保存はできた(クリップボードに入れる道具が無いなど)
        paths = res.paths;
        via = "helper";
      }
    } catch (e) {
      console.warn("[製本ビューア] 補助プログラムで保存できませんでした(Chrome のダウンロードで保存します)", e);
      reason = "error";
      error = e?.message || String(e);
    }
  }
  if (!paths) {
    // Chrome のダウンロードで「製本ビューア_コピー」に保存する
    const dir = folder ? `${COPY_FOLDER}/${folder}` : COPY_FOLDER;
    const saved = [];
    // 使い捨て: 前のコピーで保存したファイルを消す。保存している間は、ダウンロードの表示を出さない
    await disposePreviousCopies();
    const ui = await hideDownloadUi();
    try {
      for (const f of files) {
        saved.push(await saveBlobAndWait(f.blob, `${dir}/${f.name}`));
        onProgress?.(saved.length, files.length);
      }
    } finally {
      await ui.restore();
      await rememberCopies(saved.map(x => x.id));
    }
    paths = saved.map(s => s.path);
    ids = saved.map(s => s.id);
    if (status.available) {
      // 古い補助プログラム(保存済みのファイルをクリップボードに入れるだけのもの)
      const res = await copyPathsWithHelper(paths);
      if (res.ok) {
        return { mode: "files", via, paths, ids };
      }
      reason = "error";
      error = res.error;
    }
  }
  // 場所(パス)を文字でクリップボードに入れる
  const text = files.length > 1 ? parentFolderOf(paths[0]) : paths[0];
  try {
    await navigator.clipboard.writeText(text);
    return { mode: "path", via, paths, ids, text, reason, error };
  } catch (e) {
    return { mode: "saved", via, paths, ids, text, reason, error: e?.message || String(e) };
  }
}
