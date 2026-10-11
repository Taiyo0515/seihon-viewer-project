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

/** 出力ファイル名に付ける日時(例: 20261006_2130) */
export function timestampForFileName(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}`;
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

/**
 * Blob をダウンロードフォルダに保存する。
 * 同じ名前のファイルがあるときは Chrome が「名前 (1).pdf」のように連番を付ける(上書きしない)。
 * @returns {Promise<number>} ダウンロードID
 */
export async function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  try {
    let id;
    try {
      id = await chrome.downloads.download({ url, filename: fileName, conflictAction: "uniquify" });
    } catch (e) {
      // 日本語のファイル名を扱えない環境(文字コードの設定が UTF-8 でない Linux など)では、英数字だけの名前で保存する
      if (!/filename/i.test(e?.message || "")) {
        throw e;
      }
      id = await chrome.downloads.download({ url, filename: asciiFileName(fileName), conflictAction: "uniquify" });
    }
    // 保存が終わったら一時URLを解放する
    const onChanged = delta => {
      if (delta.id === id && delta.state && delta.state.current !== "in_progress") {
        chrome.downloads.onChanged.removeListener(onChanged);
        URL.revokeObjectURL(url);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    return id;
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/**
 * Blob を、保存先を選ぶ画面を出して保存する(「名前を付けて保存」)。
 * 保存先とファイル名は使う人が選ぶ。同じ名前のファイルが保存先にあるときは、
 * Chrome が最初から「名前 (1).pdf」のような別の名前を出す(そのまま保存しても上書きしない)。
 * @returns {Promise<{ok:boolean, id?:number, filename?:string, canceled?:boolean, error?:string}>}
 *   保存が終わるまで待つ。保存先を選ぶ画面でやめたら canceled
 */
export async function saveBlobAs(blob, fileName) {
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
  return new Promise(resolve => {
    let finished = false;
    const finish = result => {
      if (finished) {
        return;
      }
      finished = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      chrome.downloads.onErased.removeListener(onErased);
      URL.revokeObjectURL(url);
      resolve({ id, ...result });
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
