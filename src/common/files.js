/**
 * ファイルの保存まわりの共通処理: ファイル名、日時の書式、ZIP の作成、ダウンロード。
 */

/** ファイル名に使えない文字を置き換え、長すぎる名前を切り詰める */
export function sanitizeFileName(name, fallback = "document") {
  let s = String(name || "")
    .normalize("NFC")
    // Windows で使えない文字と制御文字
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    // 先頭・末尾のドットと空白は Chrome が拒否する
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (!s) {
    s = fallback;
  }
  // 拡張子を除いた部分を最大 100 文字に(Windows のパス長の上限対策)
  if (s.length > 100) {
    s = s.slice(0, 100).trim();
  }
  return s;
}

/** 英数字だけのファイル名(日本語を扱えない環境のための予備) */
export function asciiFileName(name) {
  const m = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(String(name));
  let base = (m[1] || "")
    .replace(/ビューアの設定/g, "-viewer-settings")
    .replace(/編集済み/g, "edited")
    .replace(/抜粋/g, "excerpt")
    .replace(/面付け/g, "imposed")
    .replace(/製本/g, "seihon")
    .replace(/ほか/g, "etc")
    .replace(/帯/g, "obi")
    .replace(/付属/g, "extras")
    .replace(/コピー/g, "copy")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.\s]+|[_.\s]+$/g, "");
  if (!base) {
    base = "document";
  }
  return `${base}${m[2] || ""}`;
}

/** 「.pdf」などの拡張子を除いたファイル名 */
export function baseName(name) {
  const s = String(name || "").replace(/[?#].*$/, "");
  const last = s.split(/[\\/]/).pop() || s;
  return last.replace(/\.(pdf|png|zip)$/i, "");
}

/** 出力ファイル名に付ける日時(例: 20261006_2130。seconds なら 20261006_213045) */
export function timestampForFileName(date = new Date(), { seconds = false } = {}) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const base = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}`;
  return seconds ? `${base}${p(date.getSeconds())}` : base;
}

/** バイト数を読みやすく(例: 1.2 MB) */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "-";
  }
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ---------------------------------------------------------------------------
// ZIP(無圧縮。PNG はもともと圧縮済みなので、圧縮しても小さくならない)
// ---------------------------------------------------------------------------

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * ZIP ファイルを作る。
 * @param {Array<{name:string, blob:Blob}>} files
 * @returns {Promise<Blob>}
 */
export async function createZip(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime(new Date());
  for (const file of files) {
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const name = encoder.encode(file.name);
    const crc = crc32(data);
    const size = data.length;
    if (offset + size > 0xfffffff0) {
      throw new Error("ZIP が大きすぎます(4GB まで)");
    }
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // 展開に必要なバージョン
    local.setUint16(6, 0x0800, true); // ファイル名は UTF-8
    local.setUint16(8, 0, true); // 無圧縮
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, day, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint16(30, 0, true);
    entry.setUint16(32, 0, true);
    entry.setUint16(34, 0, true);
    entry.setUint16(36, 0, true);
    entry.setUint32(38, 0, true);
    entry.setUint32(42, offset, true);
    central.push(entry.buffer, name);
    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((sum, p) => sum + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

// ---------------------------------------------------------------------------
// ダウンロード(保存)
// ---------------------------------------------------------------------------

/** コピー(「PDF としてコピー」など)のためにファイルを保存するフォルダ(ダウンロードフォルダの中) */
export const COPY_FOLDER = "製本ビューア_コピー";

/**
 * ダウンロードが終わるまで待つ。
 * @returns {Promise<{ok:boolean, filename?:string, canceled?:boolean, error?:string}>}
 */
export function waitForDownload(id, url = null) {
  return new Promise(resolve => {
    let finished = false;
    const finish = result => {
      if (finished) {
        return;
      }
      finished = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      chrome.downloads.onErased.removeListener(onErased);
      if (url) {
        URL.revokeObjectURL(url);
      }
      resolve(result);
    };
    const check = async () => {
      const [item] = await chrome.downloads.search({ id }).catch(() => []);
      if (!item) {
        finish({ ok: false, canceled: true });
      } else if (item.state === "complete") {
        finish({ ok: true, filename: item.filename });
      } else if (item.state === "interrupted") {
        finish({ ok: false, canceled: item.error === "USER_CANCELED", error: item.error });
      }
    };
    const onChanged = delta => {
      if (delta.id === id && (delta.state || delta.error)) {
        check();
      }
    };
    const onErased = erasedId => {
      if (erasedId === id) {
        finish({ ok: false, canceled: true });
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.onErased.addListener(onErased);
    // すでに終わっていた場合
    check();
  });
}

/**
 * Blob をダウンロードフォルダの中に、保存先を聞かずに保存し、保存が終わるまで待つ(コピー用)。
 * 同じ名前のファイルがあるときは「名前 (1).pdf」のようにする(上書きしない)。
 * @param {Blob} blob
 * @param {string} relPath ダウンロードフォルダからの場所(例: "製本ビューア_コピー/本_抜粋.pdf")
 * @returns {Promise<{id:number, path:string}>} path は保存したファイルのパソコン上の場所
 */
export async function saveBlobAndWait(blob, relPath) {
  const url = URL.createObjectURL(blob);
  let id;
  try {
    try {
      id = await chrome.downloads.download({ url, filename: relPath, conflictAction: "uniquify", saveAs: false });
    } catch (e) {
      // 日本語のファイル名を扱えない環境では、英数字だけの名前で保存する
      if (!/filename/i.test(e?.message || "")) {
        throw e;
      }
      const ascii = relPath.split("/").map(asciiFileName).join("/");
      id = await chrome.downloads.download({ url, filename: ascii, conflictAction: "uniquify", saveAs: false });
    }
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  const result = await waitForDownload(id, url);
  if (!result.ok) {
    throw new Error(result.error ? `保存できませんでした(${result.error})` : "保存できませんでした");
  }
  return { id, path: result.filename };
}

/** パソコン上のファイルの場所から、フォルダの場所を作る(Windows の「\」と Mac・Linux の「/」の両方に対応) */
export function parentFolderOf(path) {
  const s = String(path || "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  if (i < 0) {
    return s;
  }
  if (i === 0) {
    return s[0];
  }
  // 「C:\」のようなドライブの直下は、区切りを残す
  return /^[A-Za-z]:$/.test(s.slice(0, i)) ? s.slice(0, i + 1) : s.slice(0, i);
}

/** 保存先を選ぶ画面で選べるファイルの種類(拡張子から) */
const SAVE_TYPES = {
  pdf: ["PDF", "application/pdf"],
  zip: ["ZIP", "application/zip"],
  cbz: ["コミック(CBZ)", "application/vnd.comicbook+zip"],
  cbr: ["コミック(CBR)", "application/vnd.comicbook-rar"],
  cb7: ["コミック(CB7)", "application/x-cb7"],
  epub: ["EPUB", "application/epub+zip"],
  txt: ["テキスト", "text/plain"],
  png: ["PNG 画像", "image/png"],
  jpg: ["JPEG 画像", "image/jpeg"],
  json: ["JSON", "application/json"],
};

/**
 * 0.4.2: 保存先を選ぶ画面を出す前に、クリックを待つ関数(画面ごとに設定する)。
 * Chrome は、クリックなどの直後(約5秒以内)でないと保存先を選ぶ画面を出せない。
 * 保存する PDF を作るのに時間がかかったときは、通知の「保存先を選ぶ」ボタンを押してもらう。
 * @type {null | ((fileName:string) => Promise<boolean>)}
 */
let askSaveGesture = null;

/** @param {null | ((fileName:string) => Promise<boolean>)} fn 押されたら true、やめたら false を返す */
export function setSaveGestureAsker(fn) {
  askSaveGesture = fn;
}

/** 保存先を選ぶ画面(File System Access)を出す。使えないときは null */
async function pickSaveFile(fileName) {
  if (typeof window === "undefined" || typeof window.showSaveFilePicker !== "function") {
    return null;
  }
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    if (!askSaveGesture) {
      return null;
    }
    if (!(await askSaveGesture(fileName))) {
      return { canceled: true };
    }
  }
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] || "").toLowerCase();
  const type = SAVE_TYPES[ext];
  const opts = { suggestedName: fileName, id: "seihon-save", startIn: "downloads" };
  if (type) {
    opts.types = [{ description: type[0], accept: { [type[1]]: [`.${ext}`] } }];
  }
  try {
    return { handle: await window.showSaveFilePicker(opts) };
  } catch (e) {
    if (e?.name === "AbortError") {
      return { canceled: true };
    }
    // クリックの直後でない・使えない場所など: ダウンロードの仕組みで保存する
    console.warn("[製本ビューア] 保存先を選ぶ画面を出せませんでした。ダウンロードで保存します", e);
    return null;
  }
}

/**
 * Blob を、保存先を選ぶ画面を出して保存する(「名前を付けて保存」)。
 * 保存先とファイル名は使う人が選ぶ。
 *
 * 0.4.2: Chrome の「名前を付けて保存」の画面(File System Access)で選んだファイルに直接書き込む。
 * ダウンロードの仕組み(chrome.downloads)は、ほかの拡張機能がファイル名を決める機能を使っていると、
 * 指定した名前が無視されて「e0116df8-….pdf」のような名前になる Chrome の不具合があるため使わない
 * (保存先を選ぶ画面が使えないときだけ、予備として使う)。
 * すでにあるファイルを選んだときは、Chrome(OS)が「置き換えますか」と確かめる(確かめずに上書きはしない)。
 * @returns {Promise<{ok:boolean, id?:number, filename?:string, canceled?:boolean, error?:string}>}
 *   保存が終わるまで待つ。保存先を選ぶ画面でやめたら canceled。
 *   id はダウンロードの仕組みで保存したときだけ(「フォルダを開く」に使う)
 */
export async function saveBlobAs(blob, fileName) {
  const picked = await pickSaveFile(fileName);
  if (picked?.canceled) {
    return { ok: false, canceled: true };
  }
  if (picked?.handle) {
    let writable;
    try {
      writable = await picked.handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true, filename: picked.handle.name };
    } catch (e) {
      // 書き込みの途中で失敗したら、書きかけの内容は捨てる(元のファイルは変わらない)
      await writable?.abort?.().catch(() => {});
      return { ok: false, error: e?.message || String(e) };
    }
  }
  return saveBlobAsDownload(blob, fileName);
}

/** ダウンロードの仕組みで、保存先を選ぶ画面を出して保存する(予備) */
async function saveBlobAsDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  let id;
  try {
    try {
      id = await chrome.downloads.download({ url, filename: fileName, saveAs: true, conflictAction: "uniquify" });
    } catch (e) {
      if (!/filename/i.test(e?.message || "")) {
        throw e;
      }
      id = await chrome.downloads.download({ url, filename: asciiFileName(fileName), saveAs: true, conflictAction: "uniquify" });
    }
  } catch (e) {
    URL.revokeObjectURL(url);
    // 保存先を選ぶ画面でやめると、環境によってはここでエラーになる
    if (/cancel/i.test(e?.message || "")) {
      return { ok: false, canceled: true };
    }
    return { ok: false, error: e?.message || String(e) };
  }
  if (id === undefined || id === null) {
    URL.revokeObjectURL(url);
    return { ok: false, canceled: true };
  }
  return { id, ...(await waitForDownload(id, url)) };
}

// ---------------------------------------------------------------------------
// 0.4.2: ダウンロードフォルダへの保存(保存先を聞かない保存)
// ---------------------------------------------------------------------------
// ほかの拡張機能(ダウンロード管理など)がファイル名を決める機能を使っていると、Chrome は
// 指定した名前を無視して「e0116df8-….pdf」のような名前で保存する(Chrome の不具合)。
// そうなったら、その名前で保存されたファイル(いま作ったもの)を消し、保存先を選ぶ画面で保存し直す。
// 一度そうなったことは覚えておき、しばらくは最初から保存先を選ぶ画面を使う。

const NAME_BROKEN_KEY = "downloadNameBrokenAt";
/** この期間がすぎたら、もう一度ダウンロードフォルダへの保存を試す(ほかの拡張機能を外したときのため) */
const NAME_BROKEN_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const GUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\s\(\d+\))?(\.[a-z0-9]+)?$/i;

/** 保存されたファイルの名前が、Chrome の不具合で GUID になったか */
export function isGuidRenamed(requested, savedPath) {
  const saved = String(savedPath || "").split(/[\\/]/).pop();
  const want = String(requested || "").split("/").pop();
  return GUID_NAME.test(saved) && !GUID_NAME.test(want);
}

async function downloadNamesBroken() {
  try {
    const { [NAME_BROKEN_KEY]: at = 0 } = await chrome.storage.local.get(NAME_BROKEN_KEY);
    return at > 0 && Date.now() - at < NAME_BROKEN_RECHECK_MS;
  } catch {
    return false;
  }
}

async function markDownloadNamesBroken() {
  try {
    await chrome.storage.local.set({ [NAME_BROKEN_KEY]: Date.now() });
  } catch {}
}

/** 間違った名前で保存されたファイル(製本ビューアがいま保存したもの)を消す */
async function discardMisnamed(id) {
  await chrome.downloads.removeFile(id).catch(() => {});
  await chrome.downloads.erase({ id }).catch(() => {});
}

/** ダウンロードフォルダに保存して、終わるまで待つ */
async function saveToDownloads(blob, fileName) {
  try {
    const { id, path } = await saveBlobAndWait(blob, fileName);
    return { ok: true, id, filename: path };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 保存先のフォルダを選ぶ画面を出す(複数のファイルをまとめて保存するとき)。使えないときは null */
async function pickSaveFolder(label) {
  if (typeof window === "undefined" || typeof window.showDirectoryPicker !== "function") {
    return null;
  }
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    if (!askSaveGesture) {
      return null;
    }
    if (!(await askSaveGesture(label))) {
      return { canceled: true };
    }
  }
  try {
    return { dir: await window.showDirectoryPicker({ id: "seihon-save-folder", mode: "readwrite", startIn: "downloads" }) };
  } catch (e) {
    if (e?.name === "AbortError") {
      return { canceled: true };
    }
    console.warn("[製本ビューア] 保存先のフォルダを選ぶ画面を出せませんでした", e);
    return null;
  }
}

/** フォルダの中で、まだ使われていない名前(あれば「名前 (1).pdf」のようにする。上書きしない) */
async function uniqueNameIn(dir, fileName) {
  const m = /^(.*?)(\.[^.]+)?$/.exec(fileName);
  for (let n = 0; n < 1000; n++) {
    const name = n ? `${m[1]} (${n})${m[2] || ""}` : fileName;
    try {
      await dir.getFileHandle(name);
    } catch (e) {
      if (e?.name === "NotFoundError") {
        return name;
      }
      throw e;
    }
  }
  throw new Error("同じ名前のファイルが多すぎます");
}

/**
 * ファイルをダウンロードフォルダに保存する(保存先は聞かない)。
 * Chrome がファイル名を無視して保存したときは、保存先を選ぶ画面で保存し直す。
 * 同じ名前のファイルがあるときは「名前 (1).pdf」のようにする(上書きしない)。
 * @param {Array<{blob:Blob, fileName:string}>} files
 * @returns {Promise<{ok:boolean, canceled?:boolean, error?:string, saved:Array<{fileName:string, id?:number}>, picked?:boolean}>}
 *   saved の fileName は実際に保存した名前。id はダウンロードフォルダに保存したときだけ(「フォルダを開く」に使う)
 */
export async function saveFiles(files) {
  const saved = [];
  let rest = files;
  if (!(await downloadNamesBroken())) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const r = await saveToDownloads(f.blob, f.fileName);
      if (!r.ok) {
        return { ok: false, error: r.error, saved };
      }
      if (isGuidRenamed(f.fileName, r.filename)) {
        console.warn("[製本ビューア] Chrome がファイル名を無視して保存しました(ほかの拡張機能の影響)。保存先を選んで保存し直します", r.filename);
        await discardMisnamed(r.id);
        await markDownloadNamesBroken();
        rest = files.slice(i);
        break;
      }
      saved.push({ fileName: String(r.filename || f.fileName).split(/[\\/]/).pop(), id: r.id });
      rest = files.slice(i + 1);
    }
    if (!rest.length) {
      return { ok: true, saved };
    }
  }
  // 保存先を選ぶ画面で保存する
  if (rest.length > 1) {
    const picked = await pickSaveFolder(`${rest.length} 個のファイル`);
    if (picked?.canceled) {
      return { ok: false, canceled: true, saved };
    }
    if (picked?.dir) {
      for (const f of rest) {
        let writable;
        try {
          const name = await uniqueNameIn(picked.dir, f.fileName);
          const handle = await picked.dir.getFileHandle(name, { create: true });
          writable = await handle.createWritable();
          await writable.write(f.blob);
          await writable.close();
          saved.push({ fileName: name });
        } catch (e) {
          await writable?.abort?.().catch(() => {});
          return { ok: false, error: e?.message || String(e), saved };
        }
      }
      return { ok: true, saved, picked: true };
    }
  }
  for (const f of rest) {
    const r = await saveBlobAs(f.blob, f.fileName);
    if (!r.ok) {
      return { ok: false, canceled: r.canceled, error: r.error, saved };
    }
    saved.push({ fileName: String(r.filename || f.fileName).split(/[\\/]/).pop(), id: r.id });
  }
  return { ok: true, saved, picked: true };
}

/** 1つのファイルをダウンロードフォルダに保存する(saveFiles と同じ。戻り値は1つ分) */
export async function saveFile(blob, fileName) {
  const r = await saveFiles([{ blob, fileName }]);
  return { ok: r.ok, canceled: r.canceled, error: r.error, picked: r.picked, ...(r.saved[0] || {}) };
}
