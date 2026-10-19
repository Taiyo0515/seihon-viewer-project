/**
 * 0.4: 電子書籍・コミックのファイルの種類を見分ける(ファイル名の拡張子と、ファイルの先頭の中身から)。
 *
 * 種類
 *   pdf   … PDF
 *   epub  … EPUB(ZIP の中に mimetype = application/epub+zip、または META-INF/container.xml)
 *   cbz   … コミック(画像を ZIP にまとめたもの。.cbz / 画像だけの .zip)
 *   cbr   … コミック(画像を RAR にまとめたもの。.cbr / .rar)
 *   cb7   … コミック(画像を 7z にまとめたもの。.cb7 / .7z)
 *   mobi  … Kindle の MOBI・AZW・AZW3(KF8)(先頭 60 バイト目に BOOKMOBI)
 *   kfx   … Kindle の KFX(先頭が CONT、または DRMION。表示できない)
 *   fb2   … FictionBook(おまけ)
 *   null  … 分からない
 */

/** 開くときに受け付ける拡張子(ファイルを選ぶ画面の候補) */
export const EBOOK_EXTENSIONS = [
  ".epub",
  ".mobi",
  ".azw",
  ".azw3",
  ".kfx",
  ".prc",
  ".cbz",
  ".cbr",
  ".cb7",
  ".fb2",
];

/** ファイルを選ぶ画面の accept 属性(PDF と電子書籍・コミック) */
export const OPEN_ACCEPT = [
  "application/pdf",
  ".pdf",
  "application/epub+zip",
  ...EBOOK_EXTENSIONS,
  ".zip",
  ".rar",
  ".7z",
].join(",");

/** 種類ごとの表示名 */
export const FORMAT_LABELS = Object.freeze({
  pdf: "PDF",
  epub: "EPUB",
  cbz: "コミック(CBZ)",
  cbr: "コミック(CBR)",
  cb7: "コミック(CB7)",
  mobi: "Kindle(MOBI / AZW / AZW3)",
  kfx: "Kindle(KFX)",
  fb2: "FictionBook(FB2)",
});

const EXT_FORMATS = {
  pdf: "pdf",
  epub: "epub",
  cbz: "cbz",
  cbr: "cbr",
  cb7: "cb7",
  mobi: "mobi",
  azw: "mobi",
  azw3: "mobi",
  prc: "mobi",
  kfx: "kfx",
  "kfx-zip": "kfx",
  fb2: "fb2",
  zip: "cbz",
  rar: "cbr",
  "7z": "cb7",
};

/** ファイル名(またはパス・URL)の拡張子(小文字、ドットなし)。無ければ "" */
export function extensionOf(name) {
  let s = String(name || "");
  s = s.split(/[?#]/, 1)[0];
  try {
    s = decodeURIComponent(s);
  } catch {}
  const base = s.split(/[\\/]/).pop() || "";
  const m = /\.([a-z0-9-]{1,8})$/i.exec(base);
  return m ? m[1].toLowerCase() : "";
}

/** 拡張子だけから見た種類(中身は見ない) */
export function formatFromName(name) {
  return EXT_FORMATS[extensionOf(name)] || null;
}

/** URL・ファイル名が、電子書籍・コミックらしいか(PDF は含まない) */
export function looksLikeEbookName(name) {
  const f = formatFromName(name);
  return !!f && f !== "pdf" && !["zip", "rar", "7z"].includes(extensionOf(name));
}

const ascii = (bytes, start, length) => {
  let s = "";
  for (let i = start; i < start + length && i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
};

/**
 * ファイルの先頭(64 KB 程度)から種類を見分ける。
 * @param {Uint8Array} head ファイルの先頭
 * @param {string} [name] ファイル名(ZIP の中身が EPUB かコミックかの手がかり)
 * @returns {string|null}
 */
export function sniffFormat(head, name = "") {
  if (!head || head.length < 4) {
    return null;
  }
  // PDF(先頭 1 KB 以内に %PDF-)
  const top = ascii(head, 0, 1024);
  if (top.includes("%PDF-")) {
    return "pdf";
  }
  // RAR(4 と 5)
  if (ascii(head, 0, 4) === "Rar!") {
    return "cbr";
  }
  // 7z
  if (head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf) {
    return "cb7";
  }
  // KFX(Amazon の独自形式。CONT = KFX の入れ物、DRMION = DRM 付きの KFX)
  if (ascii(head, 0, 4) === "CONT" || ascii(head, 0, 8) === "\xeaDRMION\xee") {
    return "kfx";
  }
  // MOBI / AZW / AZW3(Palm データベース、種類 BOOK・作成者 MOBI)
  if (head.length >= 68 && ascii(head, 60, 8) === "BOOKMOBI") {
    return "mobi";
  }
  if (head.length >= 68 && ascii(head, 60, 8) === "TEXtREAd") {
    return "mobi"; // 古い PalmDOC(.prc)
  }
  // ZIP
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)) {
    // EPUB は先頭のファイルが mimetype(圧縮なし)で、中身が application/epub+zip
    const first = ascii(head, 30, 8);
    if (first === "mimetype" && ascii(head, 38, 60).includes("application/epub+zip")) {
      return "epub";
    }
    // KFX を ZIP にまとめたもの(Calibre の KFX Input が作る .kfx-zip)
    if (extensionOf(name) === "kfx-zip" || extensionOf(name) === "kfx") {
      return "kfx";
    }
    const ext = formatFromName(name);
    if (ext === "epub" || ext === "fb2") {
      return ext;
    }
    // 中身の一覧を見ないと分からないもの(container.xml があれば EPUB)は、開くときに見分ける
    return extensionOf(name) === "cbz" ? "cbz" : "zip";
  }
  // FB2(XML)
  if (/<FictionBook[\s>]/.test(ascii(head, 0, 2048))) {
    return "fb2";
  }
  return null;
}

/**
 * MOBI / AZW / AZW3 に DRM(コピー防止)がかかっているか。
 * Palm データベースの最初のレコード(PalmDOC ヘッダー)の 12 バイト目が暗号化の種類(0 = なし)。
 * @param {Uint8Array} head ファイルの先頭(最初のレコードを含む。少なくとも数 KB)
 * @returns {boolean|null} 分からなければ null
 */
export function mobiHasDrm(head) {
  if (!head || head.length < 86) {
    return null;
  }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const count = view.getUint16(76);
  if (!count) {
    return null;
  }
  const record0 = view.getUint32(78);
  if (record0 + 16 > head.length) {
    return null;
  }
  const encryption = view.getUint16(record0 + 12);
  return encryption !== 0;
}

/** ファイル(Blob)の先頭を読む */
export async function readHead(blob, size = 64 * 1024) {
  return new Uint8Array(await blob.slice(0, size).arrayBuffer());
}

/**
 * 表示のしかた
 *   "pdf"     … PDF としてビューアで表示する
 *   "comic"   … 画像を PDF にまとめてビューアで表示する(cbz・cbr・cb7、画像だけの EPUB)
 *   "reader"  … 電子書籍リーダーで表示する(文字の EPUB・MOBI・AZW3・FB2)
 *   "unsupported" … 表示できない(KFX・DRM 付き)
 */
export function routeFor(format) {
  switch (format) {
    case "pdf":
      return "pdf";
    case "cbz":
    case "cbr":
    case "cb7":
    case "zip":
      return "comic";
    case "epub":
    case "mobi":
    case "fb2":
      return "reader";
    case "kfx":
      return "unsupported";
    default:
      return null;
  }
}

/** KFX・DRM 付きのときの説明 */
export function unsupportedMessage(format, { drm = false } = {}) {
  if (format === "kfx") {
    return {
      title: "KFX 形式の本は表示できません",
      message:
        "KFX は Amazon Kindle の独自形式で、仕様が公開されていないため、製本ビューアでは表示も変換もできません。" +
        "DRM(コピー防止)の無い本であれば、Kindle 以外の形式(EPUB・AZW3・MOBI)のファイルを用意すると表示できます。",
    };
  }
  if (drm) {
    return {
      title: "DRM(コピー防止)がかかった本は表示できません",
      message:
        "この本には DRM(コピー防止)がかかっています。製本ビューアは DRM を外す処理をしないため、表示も変換もできません。" +
        "購入したストアのアプリ(Kindle アプリなど)でお読みください。",
    };
  }
  return {
    title: "この種類のファイルは表示できません",
    message: "製本ビューアで表示できるのは、PDF・EPUB・MOBI・AZW・AZW3・CBZ・CBR(と CB7・FB2)です。",
  };
}
