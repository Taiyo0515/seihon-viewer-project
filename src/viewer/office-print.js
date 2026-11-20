/** Office の内容から安全な印刷用ページを作る。外部画像やマクロは実行しない。 */
import { attr, children, descendants, first, readOfficePackage } from "./office-package.js";

const BASE_CSS = `
@page { size:A4; margin:16mm }
* { box-sizing:border-box }
html { color-scheme:light; background:white; color:#151515 }
body { margin:16px; font:11pt/1.45 "Yu Gothic", sans-serif; overflow-wrap:anywhere }
p { margin:0 0 .4em; white-space:pre-wrap }
table { border-collapse:collapse; margin:.4em 0; max-width:100% }
td, th { border:1px solid #999; padding:.18em .4em; vertical-align:top; white-space:pre-wrap }
img { max-width:100%; height:auto }
.sheet + .sheet { break-before:page }
.sheet table { table-layout:fixed; width:100% }
.slide { width:min(100%, var(--slide-width)); container-type:inline-size; position:relative; overflow:hidden; margin:0 auto 8px; background:white; aspect-ratio:var(--slide-ratio) }
.slide > * { position:absolute; overflow:hidden; white-space:pre-wrap }
.slide p { margin:0 }
@media print {
  html,body { margin:0 }
  * { print-color-adjust:exact; -webkit-print-color-adjust:exact }
  .slide { width:var(--slide-width); height:var(--slide-height); break-after:page; margin:0 }
  .slide:last-child { break-after:auto }
}`;

const finite = (value, fallback = 0) => value != null && Number.isFinite(Number(value)) ? Number(value) : fallback;
const color = value => /^[a-f\d]{6}$/i.test(value || "") ? "#" + value : "";

function inlineImage(pkg, doc, part, urls) {
  if (!Object.hasOwn(pkg.files, part)) { return null; }
  const ext = part.split(".").pop().toLowerCase();
  const type = { jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", bmp: "bmp", webp: "webp" }[ext];
  if (!type) { return null; }
  if (!urls.has(part)) {
    urls.set(part, URL.createObjectURL(new Blob([pkg.files[part]], { type: "image/" + type })));
  }
  const img = doc.createElement("img");
  img.src = urls.get(part);
  return img;
}

function wordParts(pkg, doc, urls) {
  const part = "word/document.xml", xml = pkg.xml(part), rels = pkg.rels(part);
  const body = first(xml, "body");
  const flag = node => node && !["false", "0", "off"].includes(attr(node, "val"));
  const walk = (source, parent) => {
    for (const el of source.children) {
      const kind = el.localName;
      if (kind === "p") {
        const p = doc.createElement("p"), props = children(el, "pPr")[0];
        const style = attr(first(props, "pStyle"), "val") || "";
        if (/^(Title|Heading\d|見出し)/i.test(style)) { p.style.fontWeight = "bold"; p.style.fontSize = "1.35em"; }
        const alignment = attr(first(props, "jc"), "val");
        if (["center", "right", "left", "both"].includes(alignment)) { p.style.textAlign = alignment === "both" ? "justify" : alignment; }
        if (flag(first(props, "pageBreakBefore"))) { p.style.breakBefore = "page"; }
        walk(el, p);
        if (!p.hasChildNodes()) { p.append(doc.createElement("br")); }
        parent.append(p);
      } else if (kind === "r") {
        const span = doc.createElement("span"), props = children(el, "rPr")[0];
        if (flag(first(props, "b"))) { span.style.fontWeight = "bold"; }
        if (flag(first(props, "i"))) { span.style.fontStyle = "italic"; }
        if (flag(first(props, "u"))) { span.style.textDecoration = "underline"; }
        const size = finite(attr(first(props, "sz"), "val")) / 2;
        if (size > 0) { span.style.fontSize = Math.min(size, 400) + "pt"; }
        span.style.color = color(attr(first(props, "color"), "val"));
        walk(el, span);
        parent.append(span);
      } else if (kind === "t") {
        parent.append(doc.createTextNode(el.textContent));
      } else if (kind === "tab") {
        parent.append(doc.createTextNode("\t"));
      } else if (kind === "br" || kind === "cr") {
        const br = doc.createElement("br");
        if (attr(el, "type") === "page") { br.style.breakAfter = "page"; }
        parent.append(br);
      } else if (kind === "drawing") {
        const image = inlineImage(pkg, doc, rels.get(attr(first(el, "blip"), "embed")), urls);
        if (image) {
          const width = finite(attr(first(el, "extent"), "cx")) / 12700;
          if (width > 0) { image.style.width = width + "pt"; }
          parent.append(image);
        }
      } else if (kind === "tbl" || kind === "tr" || kind === "tc") {
        const tableEl = doc.createElement(({ tbl: "table", tr: "tr", tc: "td" })[kind]);
        if (kind === "tc") {
          tableEl.colSpan = Math.max(1, finite(attr(first(children(el, "tcPr")[0], "gridSpan"), "val"), 1));
        }
        walk(el, tableEl);
        parent.append(tableEl);
      } else if (["hyperlink", "sdt", "sdtContent", "ins", "smartTag", "fldSimple"].includes(kind)) {
        walk(el, parent);
      }
    }
  };
  walk(body, doc.body);
  const sect = descendants(body, "sectPr").at(-1);
  const sz = first(sect, "pgSz"), margins = first(sect, "pgMar");
  const width = finite(attr(sz, "w"), 11906) / 20, height = finite(attr(sz, "h"), 16838) / 20;
  const margin = ["top","right","bottom","left"].map(edge => Math.max(0, finite(attr(margins, edge), 960) / 20) + "pt").join(" ");
  return `@page { size:${width}pt ${height}pt; margin:${margin} }`;
}

function sheetParts(pkg, doc) {
  const path = "xl/workbook.xml", book = pkg.xml(path), rels = pkg.rels(path);
  const shared = descendants(pkg.xml("xl/sharedStrings.xml", false), "si").map(si => descendants(si, "t").map(t => t.textContent).join(""));
  const styled = pkg.xml("xl/styles.xml", false);
  const formats = new Map(descendants(styled, "numFmt").map(n => [+attr(n, "numFmtId"), attr(n, "formatCode")]));
  const xfs = children(first(styled, "cellXfs"), "xf");
  const epoch1904 = ["1", "true"].includes(attr(first(book, "workbookPr"), "date1904"));
  function value(cell) {
    const v = first(cell, "v")?.textContent ?? "";
    switch (attr(cell, "t")) {
      case "s": return shared[+v] ?? "";
      case "inlineStr": return descendants(cell, "t").map(t => t.textContent).join("");
      case "b": return v === "1" ? "TRUE" : "FALSE";
      case "str": case "e": case "d": return v;
      default: {
        if (!v || !Number.isFinite(+v)) { return v || (first(cell, "f") ? "=" + first(cell, "f").textContent : ""); }
        const id = +attr(xfs[+attr(cell, "s") || 0], "numFmtId");
        const fmt = formats.get(id) || "";
        if ([9, 10].includes(id) || fmt.includes("%")) { return Number((+v * 100).toFixed(8)) + "%"; }
        if ([14,15,16,17,22].includes(id) || /[dy]{2,}/i.test(fmt.replace(/"[^"]*"/g, ""))) {
          const date = new Date((+v - (epoch1904 ? 24107 : 25569)) * 86400000);
          if (Number.isFinite(date.getTime())) { return date.toISOString().replace("T", " ").slice(0, +v % 1 ? 19 : 10); }
        }
        return v;
      }
    }
  }
  for (const sheet of descendants(book, "sheet")) {
    if (["hidden", "veryHidden"].includes(attr(sheet, "state"))) { continue; }
    const sheetPath = rels.get(attr(sheet, "id"));
    if (!sheetPath || !sheetPath.includes("/worksheets/")) { continue; }
    const xml = pkg.xml(sheetPath);
    const keys = new Set(), rows = [];
    for (const row of descendants(first(xml, "sheetData"), "row")) {
      if (attr(row, "hidden") === "1") { continue; }
      const cells = new Map();
      for (const cell of children(row, "c")) {
        const key = /^([A-Z]+)\d+$/.exec(attr(cell, "r"))?.[1], text = value(cell);
        if (key && text) { keys.add(key); cells.set(key, text); }
      }
      if (cells.size) { rows.push(cells); }
    }
    const cols = [...keys].sort((a, b) => a.length - b.length || a.localeCompare(b));
    // 横に長い表は印刷範囲からはみ出さないように、列を分けて続きを出す。
    for (let start = 0; start < Math.max(1, cols.length); start += 8) {
      const slice = cols.slice(start, start + 8);
      const section = doc.createElement("section");
      section.className = "sheet";
      const h = doc.createElement("h2");
      h.textContent = (attr(sheet, "name") || "シート") + (cols.length > 8 ? `（${slice[0]}〜${slice.at(-1)} 列）` : "");
      section.append(h);
      const table = doc.createElement("table");
      for (const cells of rows) {
        const tr = table.insertRow();
        for (const key of slice) { tr.insertCell().textContent = cells.get(key) || ""; }
      }
      section.append(table);
      doc.body.append(section);
    }
  }
  return "@page { size:A4 landscape; margin:12mm }";
}

function slideParts(pkg, doc, urls) {
  const part = "ppt/presentation.xml", pres = pkg.xml(part), rels = pkg.rels(part);
  const size = first(pres, "sldSz"), width = finite(attr(size, "cx"), 12192000), height = finite(attr(size, "cy"), 6858000);
  if (width <= 0 || height <= 0) { throw new Error("スライドの大きさを読み取れませんでした。"); }
  const transform = (shape, layout) => {
    const own = first(children(shape, "spPr")[0], "xfrm");
    if (own) { return own; }
    const ph = first(shape, "ph");
    if (!ph) { return null; }
    const match = descendants(layout, "sp").find(el => {
      const p = first(el, "ph");
      return p && (attr(ph, "idx") ? attr(ph, "idx") === attr(p, "idx") : attr(ph, "type") === attr(p, "type"));
    });
    return first(children(match, "spPr")[0], "xfrm");
  };
  for (const s of descendants(pres, "sldId")) {
    const path = rels.get(s.getAttributeNS(s.lookupNamespaceURI("r"), "id") || s.getAttribute("r:id"));
    const xml = pkg.xml(path), links = pkg.rels(path);
    const layoutPath = [...links.values()].find(v => v?.includes("/slideLayouts/"));
    const layout = layoutPath ? pkg.xml(layoutPath, false) : null;
    const slide = doc.createElement("section");
    slide.className = "slide";
    slide.style.backgroundColor = color(attr(first(first(xml, "bg"), "srgbClr"), "val"));
    const tree = first(xml, "spTree");
    for (const shape of tree?.children || []) {
      if (!["sp", "pic", "graphicFrame"].includes(shape.localName)) { continue; }
      let el;
      if (shape.localName === "pic") {
        el = inlineImage(pkg, doc, links.get(attr(first(shape, "blip"), "embed")), urls);
        if (!el) { continue; }
      } else {
        el = doc.createElement("div");
        el.style.backgroundColor = color(attr(first(children(children(shape, "spPr")[0], "solidFill")[0], "srgbClr"), "val"));
        const tbl = first(shape, "tbl");
        if (tbl) {
          const table = doc.createElement("table");
          for (const row of children(tbl, "tr")) {
            const tr = table.insertRow();
            for (const cell of children(row, "tc")) { tr.insertCell().textContent = descendants(cell, "t").map(t => t.textContent).join(""); }
          }
          el.append(table);
        } else {
          for (const p of descendants(first(shape, "txBody"), "p")) {
            const line = doc.createElement("p"), align = attr(first(p, "pPr"), "algn");
            if (align) { line.style.textAlign = ({ l: "left", ctr: "center", r: "right", just: "justify" })[align] || "left"; }
            for (const run of p.children) {
              if (run.localName === "br") { line.append(doc.createElement("br")); continue; }
              const txt = first(run, "t");
              if (!txt) { continue; }
              const span = doc.createElement("span"), prop = first(run, "rPr");
              span.textContent = txt.textContent;
              span.style.fontWeight = attr(prop, "b") === "1" ? "bold" : "normal";
              span.style.fontStyle = attr(prop, "i") === "1" ? "italic" : "normal";
              span.style.color = color(attr(first(prop, "srgbClr"), "val"));
              const fontSize = finite(attr(prop, "sz"), 1800) / 100;
              span.style.fontSize = fontSize * 12700 / width * 100 + "cqw";
              line.append(span);
            }
            el.append(line);
          }
        }
      }
      const xfrm = transform(shape, layout) || children(shape, "xfrm")[0];
      const off = first(xfrm, "off"), ext = first(xfrm, "ext");
      const x = finite(attr(off, "x")), y = finite(attr(off, "y"));
      Object.assign(el.style, {
        left: x / width * 100 + "%", top: y / height * 100 + "%",
        width: finite(attr(ext, "cx"), width) / width * 100 + "%",
        height: finite(attr(ext, "cy"), height) / height * 100 + "%",
        transform: "rotate(" + finite(attr(xfrm, "rot")) / 60000 + "deg)",
      });
      slide.append(el);
    }
    doc.body.append(slide);
  }
  const w = width / 914400, h = height / 914400;
  return `:root { --slide-width:${w}in; --slide-height:${h}in; --slide-ratio:${w}/${h} } @page { size:${w}in ${h}in; margin:0 }`;
}

export async function renderForPrint(file, format, doc, urls) {
  doc.documentElement.lang = "ja";
  doc.title = file.name.replace(/\.[^.]+$/, "");
  const style = doc.createElement("style");
  style.textContent = BASE_CSS;
  doc.head.append(style);
  if (format === "txt") {
    const text = doc.createElement("p");
    text.textContent = await file.text();
    doc.body.append(text);
  } else if (format === "html") {
    const source = doc.createElement("template");
    source.innerHTML = await file.text();
    const allowed = new Set("p div section article h1 h2 h3 h4 h5 h6 ul ol li blockquote strong b em i u code pre table thead tbody tfoot tr th td br hr sub sup ruby rt figure figcaption".split(" "));
    const skip = new Set("script style title head template noscript iframe object svg math link base meta".split(" "));
    const copy = (from, into) => {
      for (const node of from.childNodes) {
        if (node.nodeType === 3) { into.append(doc.createTextNode(node.textContent)); continue; }
        if (node.nodeType !== 1 || skip.has(node.localName)) { continue; }
        if (node.localName === "img") {
          const data = node.getAttribute("src") || "";
          if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(data)) {
            const img = doc.createElement("img"); img.src = data; into.append(img);
          } else if (node.alt) { into.append(doc.createTextNode(node.alt)); }
        } else if (allowed.has(node.localName)) {
          const el = doc.createElement(node.localName);
          if (node.localName === "td" || node.localName === "th") {
            el.colSpan = Math.min(100, node.colSpan); el.rowSpan = Math.min(100, node.rowSpan);
          }
          copy(node, el); into.append(el);
        } else { copy(node, into); }
      }
    };
    copy(source.content, doc.body);
  } else {
    const pkg = await readOfficePackage(file);
    if (format === "docx") { style.textContent += wordParts(pkg, doc, urls); }
    if (format === "xlsx") { style.textContent += sheetParts(pkg, doc); }
    if (format === "pptx") { style.textContent += slideParts(pkg, doc, urls); }
  }
  if (!doc.body.textContent.trim() && !doc.body.querySelector("img, .slide, table")) { throw new Error("変換できる内容が見つかりませんでした。"); }
  await Promise.all(Array.from(doc.images, image => image.decode()));
}

