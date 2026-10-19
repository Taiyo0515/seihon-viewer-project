/**
 * 製本ビューアのURLの組み立てと解析。
 *
 * ビューアのURLは次の形です。
 *   chrome-extension://<ID>/viewer/viewer.html?src=<PDFのURL>#<PDF.jsのハッシュ>
 *
 * - 通信の書き換え(declarativeNetRequest)でリダイレクトするときは、
 *   URLをエンコードできないため <PDFのURL> がそのまま入ります(生の形)。
 * - ビューアは起動直後にこれを「エンコード済みの形」に書き換えます
 *   (PDFのURL内の & や = がビューア側の引数と混ざらないようにするため)。
 * - どちらの形でも parseViewerSrc で同じPDFのURLが得られます。
 */

export const VIEWER_PATH = "viewer/viewer.html";

/** ビューアのページURL(引数なし) */
export function viewerBaseUrl() {
  return chrome.runtime.getURL(VIEWER_PATH);
}

/**
 * PDFのURLから、それを開くビューアのURLを作る。
 * PDFのURLの # 以降(#page=3 など)はビューアのハッシュとして引き継ぐ。
 */
export function viewerUrlFor(pdfUrl, { downloadId = null } = {}) {
  let url = String(pdfUrl);
  let hash = "";
  const i = url.indexOf("#");
  if (i >= 0) {
    hash = url.slice(i);
    url = url.slice(0, i);
  }
  const extra = Number.isInteger(downloadId) ? `&dl=${downloadId}` : "";
  return `${viewerBaseUrl()}?src=${encodeURIComponent(url)}${extra}${hash}`;
}

/**
 * location.search(先頭の ? を含む)から、開くべきPDFのURLを取り出す。
 * エンコード済み・生の形の両方に対応する。見つからなければ null。
 */
export function parseViewerSrc(search) {
  if (typeof search !== "string" || !search.startsWith("?src=")) {
    return null;
  }
  const raw = search.slice(5);
  if (!raw) {
    return null;
  }
  // 生の形: "https://..." のように最初の "/" より前に ":" がある
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return raw;
  }
  // エンコード済みの形: PDF の URL の中の & は %26 になっているので、最初の & より後はビューアの引数
  try {
    return decodeURIComponent(raw.split("&", 1)[0]);
  } catch {
    return null;
  }
}

/**
 * ビューアの追加の引数(エンコード済みの形のときだけ): dl = 強制ダウンロード対策(第3層)で開いたダウンロードのID
 * @returns {{downloadId:number|null}}
 */
export function parseViewerExtras(search) {
  const out = { downloadId: null };
  if (typeof search !== "string" || !search.startsWith("?src=")) {
    return out;
  }
  const raw = search.slice(5);
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return out;
  }
  const params = new URLSearchParams(raw.slice(raw.split("&", 1)[0].length));
  const dl = Number(params.get("dl"));
  if (Number.isInteger(dl) && dl >= 0 && params.has("dl")) {
    out.downloadId = dl;
  }
  return out;
}

/** パソコン内のファイルのパス(Windows / Mac / Linux)を file:// の URL にする */
export function fileUrlFromPath(path) {
  let p = String(path).replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(p)) {
    p = `/${p}`; // C:/Users/... → /C:/Users/...
  } else if (p.startsWith("//")) {
    // ネットワーク上の共有フォルダ(\\server\share\...)
    return `file:${p.split("/").map((seg, i) => (i < 2 ? seg : encodeURIComponent(seg))).join("/")}`;
  }
  const encoded = p
    .split("/")
    .map(seg => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/");
  return `file://${encoded}`;
}

/** URLが製本ビューア自身のページかどうか */
export function isViewerUrl(url) {
  return typeof url === "string" && url.startsWith(viewerBaseUrl());
}

/** URLの見た目からPDFらしいか(パスが .pdf で終わる)を判定する */
export function looksLikePdfUrl(url) {
  try {
    const u = new URL(url);
    if (!/^(https?|file):$/.test(u.protocol)) {
      return false;
    }
    return /\.pdf$/i.test(decodeURIComponent(u.pathname).replace(/;.*$/, ""));
  } catch {
    return false;
  }
}

/** URLからファイル名らしき部分を取り出す(表示用) */
export function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || u.hostname || "document.pdf";
    return decodeURIComponent(last);
  } catch {
    return "document.pdf";
  }
}
