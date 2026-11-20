/** PDF から新しい Office 文書を組み立てる。 */
import { pageImageFile } from "./image-export.js";
import { A, P, R, W, X, columnName, escapeXml, readOfficePackage, relationships, writeOfficePackage } from "./office-package.js";

const EMU = 12700; // 1 pt

async function pagePicture(doc, number) {
  return pageImageFile(doc, number, number - 1, {
    settings: { imageQuality: "standard" }, format: "png", keepOriginal: false,
  });
}

async function textLines(page) {
  const content = await page.getTextContent();
  const lines = [];
  let line = "";
  const finish = () => { lines.push(line); line = ""; };
  for (const item of content.items) {
    if (item.str === undefined) { continue; }
    line += item.str;
    if (item.hasEOL) { finish(); }
  }
  if (line) { finish(); }
  return lines;
}

function wordPicture(id, cx, cy) {
  return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="ページ${id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="ページ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="img${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

async function wordDocument(doc, { mode, progress }) {
  const parts = {}, rels = [], paragraphs = [];
  for (let n = 1; n <= doc.numPages; n++) {
    progress(n, doc.numPages);
    const page = await doc.getPage(n);
    const lines = mode === "appearance" ? [] : await textLines(page);
    const pageStart = n > 1 ? "<w:pPr><w:pageBreakBefore/></w:pPr>" : "";
    if (lines.some(line => line.trim())) {
      for (const [i, line] of lines.entries()) {
        paragraphs.push(`<w:p>${i === 0 ? pageStart : ""}<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`);
      }
    } else {
      const image = await pagePicture(doc, n);
      const maxWidth = 480 * EMU, maxHeight = 700 * EMU;
      const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
      parts[`word/media/page${n}.png`] = image.blob;
      rels.push(["img" + n, "image", `media/page${n}.png`]);
      const picture = wordPicture(n, Math.round(image.width * scale), Math.round(image.height * scale));
      paragraphs.push(`<w:p>${pageStart}<w:r>${picture}</w:r></w:p>`);
    }
    page.cleanup();
  }
  parts["word/document.xml"] = `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="960" w:bottom="960" w:left="960" w:right="960"/></w:sectPr></w:body></w:document>`;
  parts["word/_rels/document.xml.rels"] = relationships(rels);
  return writeOfficePackage("wordprocessingml.document", "word/document.xml", parts, { "word/document.xml": "wordprocessingml.document.main" }, { png: "image/png" });
}

function sheetCells(items, viewport) {
  const words = items.filter(item => item.str?.trim()).map(item => {
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    return { x, y, width: item.width, height: Math.max(1, item.height), text: item.str };
  }).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const word of words) {
    let row = rows.at(-1);
    if (!row || Math.abs(row.y - word.y) > Math.max(1, word.height * 0.4)) {
      row = { y: word.y, items: [] };
      rows.push(row);
    }
    row.items.push(word);
  }
  const columns = [];
  const cells = rows.map(row => {
    const groups = [];
    for (const item of row.items.sort((a, b) => a.x - b.x)) {
      const prev = groups.at(-1);
      const gap = item.x - (prev?.end ?? 0);
      if (prev && gap < item.height * 1.1) {
        prev.text += (gap > item.height * 0.23 ? " " : "") + item.text;
        prev.end = item.x + item.width;
      } else {
        const group = { x: item.x, end: item.x + item.width, text: item.text, tolerance: item.height * 0.7 };
        groups.push(group);
        columns.push(group);
      }
    }
    return groups;
  });
  let col = -1, anchor = -Infinity;
  for (const group of columns.sort((a, b) => a.x - b.x)) {
    if (group.x - anchor > group.tolerance) { col++; anchor = group.x; }
    group.col = col;
  }
  return cells.map(row => {
    const merged = new Map();
    for (const cell of row) { merged.set(cell.col, [merged.get(cell.col), cell.text].filter(Boolean).join(" ")); }
    return merged;
  });
}

async function spreadsheet(doc, { progress }) {
  const parts = {}, types = { "xl/workbook.xml": "spreadsheetml.sheet.main" };
  const sheets = [], rels = [], empty = [];
  let textFound = false;
  for (let n = 1; n <= doc.numPages; n++) {
    progress(n, doc.numPages);
    const page = await doc.getPage(n);
    const rows = sheetCells((await page.getTextContent()).items, page.getViewport({ scale: 1 }));
    if (rows.length) { textFound = true; } else { empty.push(n); }
    const widths = new Map();
    const lines = rows.map((row, i) => {
      const cells = Array.from(row, ([col, value]) => {
        if (col >= 16384 || i >= 1048576 || value.length > 32767) { throw new Error("Excel の行・列・セルの文字数の上限を超えています。"); }
        widths.set(col, Math.max(widths.get(col) || 8, Math.min(56, Array.from(value).length * 1.5 + 2)));
        const r = columnName(col) + (i + 1);
        // 先頭のゼロや数式らしい文字列を保ち、PDF の値を数式として実行させない。
        if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && value.replace(/[-.]/g, "").length <= 15) {
          return `<c r="${r}"><v>${value}</v></c>`;
        }
        return `<c r="${r}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
      });
      return `<row r="${i + 1}">${cells.join("")}</row>`;
    }).join("");
    const cols = [...widths].sort(([a], [b]) => a - b).map(([col, width]) => `<col min="${col + 1}" max="${col + 1}" width="${width}" customWidth="1"/>`).join("");
    const name = `worksheets/sheet${n}.xml`;
    parts["xl/" + name] = `<worksheet xmlns="${X}">${cols ? "<cols>" + cols + "</cols>" : ""}<sheetData>${lines}</sheetData></worksheet>`;
    types["xl/" + name] = "spreadsheetml.worksheet";
    rels.push(["s" + n, "worksheet", name]);
    sheets.push(`<sheet name="ページ${n}" sheetId="${n}" r:id="s${n}"/>`);
    page.cleanup();
  }
  if (!textFound) { throw new Error("抽出できる文字がありません。文字情報を含む PDF を選んでください。"); }
  parts["xl/workbook.xml"] = `<workbook xmlns="${X}" xmlns:r="${R}"><sheets>${sheets.join("")}</sheets></workbook>`;
  parts["xl/_rels/workbook.xml.rels"] = relationships(rels);
  const blob = await writeOfficePackage("spreadsheetml.sheet", "xl/workbook.xml", parts, types);
  return { blob, note: empty.length ? `文字情報を持たない ${empty.length} ページは空のシートです。` : "" };
}

async function presentation(doc, { progress }) {
  // PptxGenJS で生成した空のテンプレートのテーマ、マスター、レイアウトだけを再利用する。
  const response = await fetch(new URL("./office-slide-template.pptx", import.meta.url));
  if (!response.ok) { throw new Error("スライドのテンプレートを読み込めませんでした。"); }
  const template = await readOfficePackage(await response.blob());
  const parts = {}, types = { "ppt/presentation.xml": "presentationml.presentation.main" };
  for (const [path, bytes] of Object.entries(template.files)) {
    if (/^ppt\/(theme|slideLayouts|slideMasters)\//.test(path)) {
      parts[path] = bytes;
      if (!path.endsWith(".rels")) {
        types[path] = path.includes("/theme/") ? "theme" : path.includes("/slideLayouts/") ? "presentationml.slideLayout" : "presentationml.slideMaster";
      }
    }
  }
  const firstPage = await doc.getPage(1);
  const view = firstPage.getViewport({ scale: 1 });
  const width = Math.round(view.width * EMU), height = Math.round(view.height * EMU);
  const slides = [], rels = [["master", "slideMaster", "slideMasters/slideMaster1.xml"]];
  const tree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  for (let n = 1; n <= doc.numPages; n++) {
    progress(n, doc.numPages);
    const pic = await pagePicture(doc, n);
    const scale = Math.min(width / pic.width, height / pic.height);
    const cx = Math.round(pic.width * scale), cy = Math.round(pic.height * scale);
    const x = Math.round((width - cx) / 2), y = Math.round((height - cy) / 2);
    const picture = `<p:pic><p:nvPicPr><p:cNvPr id="2" name="ページ${n}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="pageImage"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    const path = `slides/slide${n}.xml`;
    parts["ppt/" + path] = `<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree>${tree}${picture}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    parts[`ppt/media/page${n}.png`] = pic.blob;
    parts[`ppt/slides/_rels/slide${n}.xml.rels`] = relationships([["layout", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["pageImage", "image", `../media/page${n}.png`]]);
    rels.push(["s" + n, "slide", path]);
    slides.push(`<p:sldId id="${255 + n}" r:id="s${n}"/>`);
    types["ppt/" + path] = "presentationml.slide";
  }
  parts["ppt/presentation.xml"] = `<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="master"/></p:sldMasterIdLst><p:sldIdLst>${slides.join("")}</p:sldIdLst><p:sldSz cx="${width}" cy="${height}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  parts["ppt/_rels/presentation.xml.rels"] = relationships(rels);
  return writeOfficePackage("presentationml.presentation", "ppt/presentation.xml", parts, types, { png: "image/png" });
}

export async function pdfToOffice(doc, format, { mode = "text", progress = () => {} } = {}) {
  if (format === "xlsx") { return spreadsheet(doc, { progress }); }
  if (format === "docx") { return { blob: await wordDocument(doc, { mode, progress }) }; }
  if (format === "pptx") { return { blob: await presentation(doc, { progress }) }; }
  throw new Error("変換形式を選んでください。");
}

