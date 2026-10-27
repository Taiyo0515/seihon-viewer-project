/**
 * 0.4: PDF をほかの形式に変換する(表示しているページを、表示している順に)。
 *
 *   images … 画像の ZIP(ページごとに 1 枚の画像)
 *   cbz    … コミックの CBZ(画像の ZIP に ComicInfo.xml を加えたもの。右綴じなら漫画の向き)
 *   epub   … EPUB(固定レイアウト。ページごとに 1 枚の画像。目次は PDF のしおりから)
 *   text   … テキスト(.txt。PDF の文字を取り出す。スキャンの PDF は OCR の文字があるときだけ)
 *
 * 画像の作り方
 *   - スキャンのページ(1枚の JPEG だけのページ)は、元の解像度・元の JPEG そのままで(keepOriginal)。それ以外は指定の dpi で描く
 *     (共通の画像化の入口 image-export.js。PNG は劣化なし、JPEG は小さい)
 *
 * MOBI・AZW3・KFX には変換できない(Amazon の形式の書き出しは、公開されている部品が無いため)。
 * Kindle で読むときは EPUB を「Send to Kindle」で送ると Kindle の形式に変換される(固定レイアウトは対象外のことがある)。
 */

import { createZip } from "../../common/files.js";
import { pageImageFile } from "../image-export.js";
import { sourceIndex, viewPageCount } from "../page-map.js";

export const CONVERT_FORMATS = Object.freeze({
  images: { label: "画像(ZIP)", ext: "zip", suffix: "_画像" },
  cbz: { label: "コミック(CBZ)", ext: "cbz", suffix: "" },
  epub: { label: "EPUB(固定レイアウト)", ext: "epub", suffix: "" },
  text: { label: "テキスト(.txt)", ext: "txt", suffix: "" },
});

const enc = new TextEncoder();
const xmlEscape = s =>
  String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

/** 画像の拡張子と MIME */
const MIME = { jpg: "image/jpeg", png: "image/png" };

/**
 * 1ページを画像にする(共通の入口 image-export.js へ。スキャンのページは元の解像度で、それ以外は指定の dpi で描く)。
 * @returns {Promise<{blob:Blob, width:number, height:number, ext:"jpg"|"png", original:boolean}>}
 */
async function pageImage(doc, pageNumber, { dpi, imageType, keepOriginal, rotation }) {
  return pageImageFile(doc, pageNumber, sourceIndex(doc, pageNumber), {
    // 変換は、詳細設定の画質とは別に、この画面で選んだ dpi・形式・元画像の使い方で描く
    settings: { imageQuality: "custom", imageDpi: dpi, scanOriginal: true },
    rotation,
    keepOriginal: !!keepOriginal,
    format: imageType === "jpeg" ? "jpeg" : "png",
  });
}

/** PDF のしおり(目次)を、表示上のページ番号の木にする */
async function outlineToc(doc) {
  let outline = null;
  try {
    outline = await doc.getOutline();
  } catch {
    return [];
  }
  const count = viewPageCount(doc);
  const pageOf = async dest => {
    try {
      let d = dest;
      if (typeof d === "string") {
        d = await doc.getDestination(d);
      }
      if (!Array.isArray(d) || !d[0]) {
        return -1;
      }
      const index = typeof d[0] === "object" ? await doc.getPageIndex(d[0]) : Number(d[0]);
      // 削除したページを除いた、表示上のページ番号(1始まり)
      for (let n = 1; n <= count; n++) {
        if (sourceIndex(doc, n) === index) {
          return n;
        }
      }
      return -1;
    } catch {
      return -1;
    }
  };
  const walk = async items => {
    const out = [];
    for (const item of items || []) {
      const page = await pageOf(item.dest);
      const children = await walk(item.items);
      if (page > 0 || children.length) {
        out.push({ label: item.title || "", page: page > 0 ? page : children[0].page, children });
      }
    }
    return out;
  };
  return walk(outline);
}

/** 文書の題名(無ければファイル名) */
async function documentTitle(doc, fallback) {
  try {
    const meta = await doc.getMetadata();
    const t = String(meta?.info?.Title || "").trim();
    if (t) {
      return t;
    }
  } catch {}
  return fallback;
}

/**
 * 変換する。
 * @param {object} doc PDF.js の文書
 * @param {"images"|"cbz"|"epub"|"text"} format
 * @param {object} o
 * @param {string} o.baseName ファイル名(拡張子なし)
 * @param {"ltr"|"rtl"} o.direction 綴じ方向(CBZ・EPUB の読む向き)
 * @param {number} o.dpi 描くときの解像度
 * @param {"png"|"jpeg"} o.imageType 描いたページの画像の形式
 * @param {boolean} o.keepOriginal スキャンのページは元の JPEG を取り出す
 * @param {number} o.rotation 表示の回転
 * @param {boolean} [o.pageMarks] テキストにページの区切りを入れる
 * @param {(done:number,total:number) => void} [o.onProgress]
 * @param {() => boolean} [o.isCanceled]
 * @returns {Promise<{blob:Blob, fileName:string, pages:number, originals:number, emptyText?:boolean}>}
 */
export async function convertPdf(doc, format, o) {
  const total = viewPageCount(doc);
  const spec = CONVERT_FORMATS[format];
  const fileName = `${o.baseName}${spec.suffix}.${spec.ext}`;
  if (format === "text") {
    return { ...(await toText(doc, total, o)), fileName };
  }
  const digits = String(total).length < 3 ? 3 : String(total).length;
  const images = [];
  let originals = 0;
  for (let n = 1; n <= total; n++) {
    if (o.isCanceled?.()) {
      throw Object.assign(new Error("やめました"), { canceled: true });
    }
    const img = await pageImage(doc, n, o);
    if (img.original) {
      originals++;
    }
    images.push({ ...img, name: `${String(n).padStart(digits, "0")}.${img.ext}` });
    o.onProgress?.(n, total);
  }
  const title = await documentTitle(doc, o.baseName);
  let blob;
  if (format === "images") {
    blob = await createZip(images.map(i => ({ name: i.name, blob: i.blob })));
  } else if (format === "cbz") {
    const info = comicInfo({ title, pages: images.length, direction: o.direction });
    const zip = await createZip([...images.map(i => ({ name: i.name, blob: i.blob })), { name: "ComicInfo.xml", blob: new Blob([info]) }]);
    // ZIP の種類にすると、Chrome が保存するときに拡張子を .zip に変えてしまうため、種類は付けない
    blob = new Blob([zip], { type: "application/octet-stream" });
  } else {
    const toc = await outlineToc(doc);
    blob = await buildFixedEpub({ title, images, toc, direction: o.direction });
  }
  return { blob, fileName, pages: total, originals };
}

function comicInfo({ title, pages, direction }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Title>${xmlEscape(title)}</Title>
  <PageCount>${pages}</PageCount>
  <Manga>${direction === "rtl" ? "YesAndRightToLeft" : "No"}</Manga>
  <Notes>製本ビューアで PDF から作成</Notes>
</ComicInfo>
`;
}

/** 固定レイアウトの EPUB 3 を作る(ページごとに 1 枚の画像) */
async function buildFixedEpub({ title, images, toc, direction }) {
  const uuid = crypto.randomUUID();
  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const files = [];
  const text = (name, s) => files.push({ name, blob: new Blob([enc.encode(s)]) });
  text("mimetype", "application/epub+zip");
  text(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`
  );
  const manifest = [];
  const spine = [];
  const first = images[0];
  images.forEach((img, i) => {
    const id = String(i + 1).padStart(4, "0");
    const imgPath = `images/p${id}.${img.ext}`;
    const pagePath = `pages/p${id}.xhtml`;
    files.push({ name: `OEBPS/${imgPath}`, blob: img.blob });
    text(
      `OEBPS/${pagePath}`,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=${img.width}, height=${img.height}"/>
<title>${xmlEscape(title)} ${i + 1}</title>
<style>html,body{margin:0;padding:0;width:100%;height:100%}svg{display:block;width:100%;height:100%}</style>
</head>
<body>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="100%" height="100%" viewBox="0 0 ${img.width} ${img.height}" preserveAspectRatio="xMidYMid meet">
<image width="${img.width}" height="${img.height}" xlink:href="../${imgPath}"/>
</svg>
</body>
</html>
`
    );
    manifest.push(`<item id="img${id}" href="${imgPath}" media-type="${MIME[img.ext]}"${i === 0 ? ' properties="cover-image"' : ""}/>`);
    manifest.push(`<item id="p${id}" href="${pagePath}" media-type="application/xhtml+xml" properties="svg"/>`);
    spine.push(`<itemref idref="p${id}"/>`);
  });
  const navItems = items =>
    `<ol>${items
      .map(t => `<li><a href="pages/p${String(t.page).padStart(4, "0")}.xhtml">${xmlEscape(t.label || "(無題)")}</a>${t.children?.length ? navItems(t.children) : ""}</li>`)
      .join("")}</ol>`;
  const tocItems = toc.length ? toc : [{ label: title, page: 1, children: [] }];
  text(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="UTF-8"/><title>目次</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>目次</h1>${navItems(tocItems)}</nav>
</body>
</html>
`
  );
  text(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
<dc:title>${xmlEscape(title)}</dc:title>
<dc:language>ja</dc:language>
<meta property="dcterms:modified">${modified}</meta>
<meta property="rendition:layout">pre-paginated</meta>
<meta property="rendition:orientation">auto</meta>
<meta property="rendition:spread">landscape</meta>
<meta name="cover" content="img0001"/>
<meta name="original-resolution" content="${first.width}x${first.height}"/>
<meta name="book-type" content="comic"/>
<meta name="fixed-layout" content="true"/>
<meta name="primary-writing-mode" content="${direction === "rtl" ? "horizontal-rl" : "horizontal-lr"}"/>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifest.join("\n")}
</manifest>
<spine page-progression-direction="${direction === "rtl" ? "rtl" : "ltr"}">
${spine.join("\n")}
</spine>
</package>
`
  );
  const zip = await createZip(files);
  return new Blob([zip], { type: "application/epub+zip" });
}

/** PDF の文字を取り出す */
async function toText(doc, total, o) {
  const parts = [];
  let chars = 0;
  for (let n = 1; n <= total; n++) {
    if (o.isCanceled?.()) {
      throw Object.assign(new Error("やめました"), { canceled: true });
    }
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let s = "";
    for (const item of content.items) {
      if (typeof item.str !== "string") {
        continue;
      }
      s += item.str;
      if (item.hasEOL) {
        s += "\n";
      }
    }
    s = s.replace(/[ \t]+\n/g, "\n").trim();
    chars += s.replace(/\s/g, "").length;
    parts.push(o.pageMarks ? `［${n}ページ］\n${s}` : s);
    page.cleanup();
    o.onProgress?.(n, total);
  }
  const body = parts.join(o.pageMarks ? "\n\n" : "\n\f\n");
  // メモ帳などで文字化けしないよう、先頭に BOM を付けた UTF-8 にする
  const blob = new Blob(["﻿", body.replace(/\r?\n/g, "\r\n"), "\r\n"], { type: "text/plain;charset=utf-8" });
  return { blob, pages: total, originals: 0, emptyText: chars === 0 };
}
