/**
 * 0.4: 電子書籍・コミックを開く準備(ビューアの画面で動く)。
 *
 *  - ファイルの種類を見分ける(拡張子と中身。KFX・DRM 付きは表示できないと分かる)
 *  - コミック(CBZ・CBR・CB7)と、画像だけでできた EPUB は、画像をそのまま並べた PDF にしてビューアで表示する
 *    (製本表示・見開き・右綴じ・印刷・ページ役割など、PDF と同じ機能が使える)
 *  - 文字の EPUB・MOBI・AZW・AZW3 は、電子書籍リーダーの画面(reader/reader.html)で表示する
 */

import { unzipSync, strFromU8 } from "../../lib/fflate/fflate.js";
import { mobiHasDrm, readHead, sniffFormat, unsupportedMessage } from "../../common/ebook-formats.js";
import { naturalCompare, pickImageNames } from "./comic-names.js";

const LOG = "[製本ビューア]";

/** 表示できないことが分かったときのエラー(画面に説明を出す) */
export class EbookUnsupportedError extends Error {
  constructor({ title, message }) {
    super(message);
    this.name = "EbookUnsupportedError";
    this.title = title;
  }
}

// ---------------------------------------------------------------------------
// 種類を見分ける
// ---------------------------------------------------------------------------

/**
 * ファイルの種類と、表示のしかたを決める。
 * @param {Blob} blob
 * @param {string} name ファイル名
 * @returns {Promise<{format:string|null, route:"pdf"|"comic"|"reader"|null, bytes?:Uint8Array, listing?:object, epubImages?:object}>}
 */
export async function inspectEbook(blob, name) {
  const head = await readHead(blob, 256 * 1024);
  let format = sniffFormat(head, name);
  if (format === "pdf") {
    return { format, route: "pdf" };
  }
  if (format === "kfx") {
    throw new EbookUnsupportedError(unsupportedMessage("kfx"));
  }
  if (format === "mobi") {
    if (mobiHasDrm(head)) {
      throw new EbookUnsupportedError(unsupportedMessage("mobi", { drm: true }));
    }
    return { format, route: "reader" };
  }
  if (format === "fb2") {
    return { format, route: "reader" };
  }
  if (format === "cbr" || format === "cb7") {
    return { format, route: "comic" };
  }
  if (format === "epub" || format === "zip" || format === "cbz") {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const listing = listZip(bytes);
    if (listing.names.includes("META-INF/container.xml") || format === "epub") {
      if (listing.names.includes("META-INF/rights.xml") || hasEncryptedContent(listing)) {
        throw new EbookUnsupportedError(unsupportedMessage("epub", { drm: true }));
      }
      const epubImages = analyzeEpub(listing);
      return { format: "epub", route: epubImages ? "comic" : "reader", bytes, listing, epubImages };
    }
    if (format === "zip" && !pickImageNames(listing.names).length) {
      return { format: null, route: null };
    }
    return { format: "cbz", route: "comic", bytes, listing };
  }
  return { format: null, route: null };
}

/** EPUB の encryption.xml に、フォント以外の暗号化(DRM)があるか */
function hasEncryptedContent(listing) {
  const xml = listing.texts["META-INF/encryption.xml"];
  if (!xml) {
    return false;
  }
  const doc = parseXml(xml);
  if (!doc) {
    return false;
  }
  const methods = [...doc.getElementsByTagNameNS("*", "EncryptionMethod")].map(m => m.getAttribute("Algorithm") || "");
  // フォントの難読化(IDPF・Adobe)は DRM ではない
  return methods.some(a => !/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/.test(a));
}

// ---------------------------------------------------------------------------
// ZIP の中身
// ---------------------------------------------------------------------------

const TEXT_NAME = /\.(xml|opf|ncx|x?html?|xht|svg)$/i;
const MAX_TEXT = 4 * 1024 * 1024;

/** ZIP の中のファイル名の一覧と、小さな文書ファイル(XML・XHTML)の中身 */
export function listZip(bytes) {
  const names = [];
  const files = unzipSync(bytes, {
    filter: f => {
      names.push(f.name);
      return TEXT_NAME.test(f.name) && f.originalSize <= MAX_TEXT;
    },
  });
  const texts = {};
  for (const [n, data] of Object.entries(files)) {
    texts[n] = strFromU8(data);
  }
  return { names, texts };
}

function parseXml(text, type = "application/xml") {
  const doc = new DOMParser().parseFromString(text, type);
  if (doc.getElementsByTagName("parsererror").length) {
    // XHTML として読めないものは HTML として読む
    if (type !== "text/html") {
      const html = new DOMParser().parseFromString(text, "text/html");
      return html;
    }
    return null;
  }
  return doc;
}

/** パスの組み立て(base のフォルダからの相対パス) */
function resolvePath(base, href) {
  let path = href.split("#", 1)[0].split("?", 1)[0];
  try {
    path = decodeURIComponent(path);
  } catch {}
  if (!path) {
    return base;
  }
  if (path.startsWith("/")) {
    return path.slice(1);
  }
  const parts = base.split("/");
  parts.pop();
  for (const seg of path.split("/")) {
    if (seg === "..") {
      parts.pop();
    } else if (seg !== "." && seg !== "") {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

// ---------------------------------------------------------------------------
// EPUB: 画像だけでできた本か(漫画・写真集・スキャンした本の EPUB)
// ---------------------------------------------------------------------------

/**
 * EPUB の目録(OPF)を読み、どのページも画像1枚だけなら、その画像の並びを返す。文字のある本なら null。
 * @returns {{names:Array<string|null>, title:string, direction:"ltr"|"rtl"|null, toc:Array, fixedLayout:boolean}|null}
 */
export function analyzeEpub(listing) {
  try {
    const container = parseXml(listing.texts["META-INF/container.xml"] || "");
    const opfPath = container?.getElementsByTagNameNS("*", "rootfile")[0]?.getAttribute("full-path");
    if (!opfPath || !listing.texts[opfPath]) {
      return null;
    }
    const opf = parseXml(listing.texts[opfPath]);
    const manifest = new Map();
    for (const item of opf.getElementsByTagNameNS("*", "item")) {
      manifest.set(item.getAttribute("id"), {
        href: resolvePath(opfPath, item.getAttribute("href") || ""),
        type: (item.getAttribute("media-type") || "").toLowerCase(),
        props: item.getAttribute("properties") || "",
      });
    }
    const spineEl = opf.getElementsByTagNameNS("*", "spine")[0];
    const ppd = spineEl?.getAttribute("page-progression-direction");
    const metas = [...opf.getElementsByTagNameNS("*", "meta")];
    const layout = metas.find(m => m.getAttribute("property") === "rendition:layout")?.textContent?.trim();
    const title = opf.getElementsByTagNameNS("*", "title")[0]?.textContent?.trim() || "";
    const spine = [...(spineEl?.getElementsByTagNameNS("*", "itemref") || [])]
      .map(r => manifest.get(r.getAttribute("idref")))
      .filter(Boolean);
    if (!spine.length) {
      return null;
    }
    const names = [];
    let images = 0;
    for (const item of spine) {
      if (item.type.startsWith("image/")) {
        names.push(item.href);
        images++;
        continue;
      }
      const text = listing.texts[item.href];
      if (text === undefined) {
        return null;
      }
      const doc = parseXml(text, item.type.includes("svg") ? "image/svg+xml" : "application/xhtml+xml");
      if (!doc) {
        return null;
      }
      const root = doc.body || doc.documentElement;
      const srcs = [];
      for (const img of root.getElementsByTagName("img")) {
        srcs.push(img.getAttribute("src") || "");
      }
      for (const img of root.getElementsByTagNameNS("*", "image")) {
        srcs.push(img.getAttributeNS("http://www.w3.org/1999/xlink", "href") || img.getAttribute("href") || "");
      }
      // 文字(空白・改行を除く)。画像の説明(alt)は文字に数えない
      const words = (root.textContent || "").replace(/[\s　​]/g, "");
      if (words.length > 0 || srcs.length > 1) {
        return null; // 文字のあるページ・画像が2枚以上のページ: リーダーで表示する
      }
      if (!srcs.length) {
        names.push(null); // 白紙のページ
        continue;
      }
      const path = resolvePath(item.href, srcs[0]);
      if (!listing.names.includes(path)) {
        return null;
      }
      names.push(path);
      images++;
    }
    if (images === 0 || names.filter(n => n === null).length > images) {
      return null;
    }
    const toc = readEpubToc(listing, opfPath, opf, manifest, spine);
    return {
      names,
      title,
      direction: ppd === "rtl" ? "rtl" : ppd === "ltr" ? "ltr" : null,
      toc,
      fixedLayout: layout === "pre-paginated",
    };
  } catch (e) {
    console.warn(LOG, "EPUB の目録を読めませんでした", e);
    return null;
  }
}

/** EPUB の目次(nav または NCX)を、ページ番号(spine の順番)の木にする */
function readEpubToc(listing, opfPath, opf, manifest, spine) {
  const indexOf = path => spine.findIndex(s => s.href === path);
  const navItem = [...manifest.values()].find(m => /\bnav\b/.test(m.props));
  const out = [];
  if (navItem && listing.texts[navItem.href]) {
    const doc = parseXml(listing.texts[navItem.href], "application/xhtml+xml");
    const navs = [...doc.getElementsByTagName("nav")];
    const nav = navs.find(n => /\btoc\b/.test(n.getAttributeNS("http://www.idpf.org/2007/ops", "type") || n.getAttribute("epub:type") || "")) || navs[0];
    const walk = ol => {
      const items = [];
      for (const li of ol?.children || []) {
        if (li.localName !== "li") {
          continue;
        }
        const a = [...li.children].find(c => c.localName === "a" || c.localName === "span");
        const href = a?.getAttribute("href");
        const index = href ? indexOf(resolvePath(navItem.href, href)) : -1;
        const sub = [...li.children].find(c => c.localName === "ol");
        const children = sub ? walk(sub) : [];
        if (index >= 0 || children.length) {
          items.push({ label: a?.textContent?.trim() || "", index: index >= 0 ? index : children[0].index, children });
        }
      }
      return items;
    };
    out.push(...walk([...(nav?.children || [])].find(c => c.localName === "ol")));
  }
  if (!out.length) {
    const ncxId = opf.getElementsByTagNameNS("*", "spine")[0]?.getAttribute("toc");
    const ncx = ncxId && manifest.get(ncxId);
    if (ncx && listing.texts[ncx.href]) {
      const doc = parseXml(listing.texts[ncx.href]);
      const walk = parent => {
        const items = [];
        for (const np of parent.children) {
          if (np.localName !== "navPoint") {
            continue;
          }
          const label = np.getElementsByTagNameNS("*", "text")[0]?.textContent?.trim() || "";
          const src = [...np.children].find(c => c.localName === "content")?.getAttribute("src") || "";
          const index = indexOf(resolvePath(ncx.href, src));
          const children = walk(np);
          if (index >= 0 || children.length) {
            items.push({ label, index: index >= 0 ? index : children[0].index, children });
          }
        }
        return items;
      };
      const map = doc.getElementsByTagNameNS("*", "navMap")[0];
      if (map) {
        out.push(...walk(map));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// コミック(CBZ・CBR・CB7)
// ---------------------------------------------------------------------------

/** ComicInfo.xml から、題名と読む向き */
function readComicInfo(text) {
  if (!text) {
    return {};
  }
  const doc = parseXml(text);
  const get = tag => doc?.getElementsByTagName(tag)[0]?.textContent?.trim() || "";
  const manga = get("Manga");
  return {
    title: get("Title") || [get("Series"), get("Number")].filter(Boolean).join(" "),
    direction: /RightToLeft/i.test(manga) ? "rtl" : /^no$/i.test(manga) ? "ltr" : null,
  };
}

/** CBR・CB7 の中身を取り出す(同梱の libarchive を使う。画面とは別の Worker で動く) */
async function extractArchive(blob, onStatus) {
  const { Archive } = await import("../../lib/libarchive/libarchive.js");
  Archive.init({ workerUrl: chrome.runtime.getURL("lib/libarchive/worker-bundle.js") });
  const archive = await Archive.open(blob instanceof File ? blob : new File([blob], "comic"));
  try {
    if ((await archive.hasEncryptedData()) === true) {
      throw new EbookUnsupportedError({
        title: "パスワード付きの書庫は開けません",
        message: "この書庫(RAR・7z)にはパスワードがかかっています。パスワードを外したファイルを開いてください。",
      });
    }
    onStatus?.("書庫から画像を取り出しています…");
    const tree = await archive.extractFiles();
    const out = [];
    const walk = (node, prefix) => {
      for (const [key, value] of Object.entries(node)) {
        if (value instanceof File || value instanceof Blob) {
          out.push({ name: prefix + key, file: value });
        } else if (value && typeof value === "object") {
          walk(value, `${prefix}${key}/`);
        }
      }
    };
    walk(tree, "");
    return out;
  } finally {
    archive.close?.().catch?.(() => {});
  }
}

let worker = null;
let seq = 0;
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./convert-worker.js", import.meta.url), { type: "module" });
  }
  return worker;
}

/** Worker で PDF を作る */
function runWorker(message, transfer, onProgress) {
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const onMessage = ({ data }) => {
      if (data.id !== id) {
        return;
      }
      if (data.type === "progress") {
        onProgress?.(data.done, data.total);
        return;
      }
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      if (data.type === "done") {
        resolve({ ...data, bytes: new Uint8Array(data.bytes) });
      } else {
        reject(new Error(data.message || "PDF を作れませんでした"));
      }
    };
    const onError = e => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      worker = null;
      w.terminate();
      reject(new Error(e.message || "PDF を作る処理が止まりました"));
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    w.postMessage({ id, ...message }, transfer);
  });
}

/**
 * コミック・画像だけの EPUB から、画像を並べた PDF を作る。
 * @param {Blob} blob
 * @param {object} info inspectEbook の結果
 * @param {object} o
 * @param {string} o.baseName ファイル名(拡張子なし)
 * @param {"auto"|"rtl"|"ltr"} o.direction 読む向きの設定("auto": 本の情報に従い、無ければ fallback)
 * @param {"ltr"|"rtl"} o.fallback 本の情報が無いときの向き
 * @param {boolean} o.splitSpreads 見開きの画像を2ページに分ける
 * @param {(text:string) => void} [o.onStatus]
 * @returns {Promise<{bytes:Uint8Array, title:string, direction:"ltr"|"rtl", pages:number, images:number, skipped:string[], split:number, padded:number}>}
 */
export async function buildComicPdf(blob, info, { baseName, direction = "auto", fallback = "rtl", splitSpreads = true, onStatus = null }) {
  const status = text => onStatus?.(text);
  let meta = {};
  let toc = null;
  let message;
  let transfer;
  let count;
  if (info.format === "epub") {
    const e = info.epubImages;
    meta = { title: e.title, direction: e.direction };
    toc = e.toc;
    count = e.names.length;
    message = { type: "build-zip", zip: info.bytes.buffer, names: e.names.filter(Boolean), blanks: e.names };
    transfer = [info.bytes.buffer];
  } else if (info.format === "cbz") {
    const names = pickImageNames(info.listing.names);
    const infoName = info.listing.names.find(n => /(^|\/)comicinfo\.xml$/i.test(n));
    meta = readComicInfo(infoName ? info.listing.texts[infoName] : "");
    if (!names.length) {
      throw new EbookUnsupportedError({ title: "画像が見つかりません", message: "この書庫には、ページにできる画像(JPEG・PNG・WebP など)が入っていません。" });
    }
    count = names.length;
    message = { type: "build-zip", zip: info.bytes.buffer, names };
    transfer = [info.bytes.buffer];
  } else {
    status("書庫を開いています…");
    const files = await extractArchive(blob, status);
    const names = pickImageNames(files.map(f => f.name));
    const infoFile = files.find(f => /(^|\/)comicinfo\.xml$/i.test(f.name));
    meta = readComicInfo(infoFile ? await infoFile.file.text() : "");
    if (!names.length) {
      throw new EbookUnsupportedError({ title: "画像が見つかりません", message: "この書庫には、ページにできる画像(JPEG・PNG・WebP など)が入っていません。" });
    }
    const byName = new Map(files.map(f => [f.name, f.file]));
    const images = [];
    for (const n of names) {
      images.push({ name: n, bytes: await byName.get(n).arrayBuffer() });
    }
    count = names.length;
    message = { type: "build-images", images };
    transfer = images.map(i => i.bytes);
  }
  const dir = direction === "auto" ? meta.direction || fallback : direction;
  const title = meta.title || baseName;
  status(`画像を PDF にまとめています(0 / ${count})…`);
  if (message.blanks) {
    // 白紙のページ(画像の無いページ)の位置
    message.order = message.blanks;
    delete message.blanks;
  }
  const result = await runWorker(
    { ...message, options: { title, direction: dir, splitSpreads, toc } },
    transfer,
    (done, total) => status(`画像を PDF にまとめています(${done} / ${total})…`)
  );
  return { bytes: result.bytes, title, direction: dir, pages: result.pages, images: count, skipped: result.skipped, split: result.split, padded: result.padded || 0 };
}

export { naturalCompare };
