/** テキスト注釈の外観を、字形を内包したPDFフォントで保存する。本文や他の注釈は変更しない。 */

const MARKER = "SeihonFreeTextVersion";
const FONT_FAMILY = "sans-serif";
const EM = 1000;
const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
const split = text => [...segmenter.segment(text)].map(part => part.segment);
const num = value => String(Math.round(value * 10000) / 10000);
const utf16 = text => [...text].map(char => {
  let result = "";
  for (let i = 0; i < char.length; i++) { result += char.charCodeAt(i).toString(16).padStart(4, "0"); }
  return result;
}).join("").toUpperCase();

/** 元のテキストを保持し、外観だけを指定された幅で折り返す。文字を小さくして押し込まない。 */
function visualLines(text, width, measure) {
  const lines = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const char of split(paragraph)) {
      if (line && measure(line + char) > width) { lines.push(line); line = ""; }
      line += char;
    }
    lines.push(line);
  }
  return lines;
}

/** Unicode対応フォントを持つ正常な外観を巻き込まず、今回編集した注釈だけを判定する。 */
function matchesEdit(dict, edits, lib, pageIndex) {
  const { PDFName, PDFString, PDFHexString, PDFArray } = lib;
  const contents = dict.get(PDFName.of("Contents"));
  const text = contents instanceof PDFString || contents instanceof PDFHexString ? contents.decodeText() : "";
  const rect = dict.lookupMaybe(PDFName.of("Rect"), PDFArray)?.asArray().map(n => n.asNumber());
  // 抽出で参照番号が変わるため、番号だけでは識別しない。
  return edits.some(edit => edit.annotationType === 3 && !edit.deleted &&
    edit.pageIndex === pageIndex && edit.value === text && Array.isArray(edit.rect) &&
    rect?.every((n, i) => Math.abs(n - edit.rect[i]) < 0.02));
}

/** 高解像度字形をType3フォントへ内包し、検索と再編集用のUnicodeも保持する。 */
async function makeFont(pdf, graphemes, color, pixels, lib) {
  const { PDFName, PDFNumber, PDFHexString } = lib;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `${pixels}px ${FONT_FAMILY}`;
  const glyphs = new Map();
  const charProcs = {}, images = {}, widths = [], differences = [];
  const mappings = [];
  let code = 1;
  for (const text of graphemes) {
    const metrics = ctx.measureText(text);
    const advance = metrics.width / pixels * EM;
    const left = Math.floor(-metrics.actualBoundingBoxLeft) - 3;
    const top = Math.ceil(metrics.actualBoundingBoxAscent) + 3;
    const right = Math.ceil(metrics.actualBoundingBoxRight) + 3;
    const bottom = Math.ceil(metrics.actualBoundingBoxDescent) + 3;
    canvas.width = Math.max(1, right - left);
    canvas.height = Math.max(1, top + bottom);
    ctx.font = `${pixels}px ${FONT_FAMILY}`;
    ctx.fillStyle = `rgb(${color.map(v => Math.round(v * 255)).join(",")})`;
    ctx.fillText(text, -left, top);
    const hex = code.toString(16).padStart(2, "0").toUpperCase();
    const glyphName = `g${code}`;
    const data = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!data) { throw new Error("文字の外観画像を作成できませんでした"); }
    const image = await pdf.embedPng(new Uint8Array(await data.arrayBuffer()));
    const name = `i${code}`;
    images[name] = image.ref;
    const k = EM / pixels;
    const ops = `${num(advance)} 0 d0\nq\n${num(canvas.width * k)} 0 0 ${num(canvas.height * k)} ${num(left * k)} ${num(-bottom * k)} cm\n/${name} Do\nQ`;
    charProcs[glyphName] = pdf.context.register(pdf.context.flateStream(ops));
    widths.push(PDFNumber.of(advance));
    differences.push(PDFNumber.of(code), PDFName.of(glyphName));
    mappings.push(`<${hex}> <${utf16(text)}>`);
    glyphs.set(text, { code: hex, width: advance });
    code++;
  }
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /SeihonUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n${mappings.map((_, i) => i % 100 === 0 ? `${Math.min(100, mappings.length - i)} beginbfchar\n${mappings.slice(i, i + 100).join("\n")}\nendbfchar` : "").filter(Boolean).join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const ref = pdf.context.register(pdf.context.obj({
    Type: "Font", Subtype: "Type3", Name: "SeihonText", FontBBox: [-1000, -1000, 4000, 3000],
    FontMatrix: [0.001, 0, 0, 0.001, 0, 0], FirstChar: 1, LastChar: graphemes.length,
    Widths: widths, Encoding: { Type: "Encoding", Differences: differences },
    CharProcs: charProcs, Resources: { XObject: images },
    ToUnicode: pdf.context.register(pdf.context.flateStream(cmap)),
  }));
  canvas.width = canvas.height = 0;
  return { ref, glyphs };
}

/**
 * FreeText注釈だけの外観を補う。forceは利用者の壊れた既存PDFを修復する明示的経路用。
 * annotationsは保存直前のPDF.jsの値。修復済み注釈は再保存しても字形を作り直さない。
 * @returns {Promise<Uint8Array>} 対象が無ければ元のバイト列をそのまま返す。
 */
export async function repairFreeTextAnnotations(bytes, { annotations = [], force = false, onReport = null } = {}) {
  if (!force && !annotations.some(item => item.annotationType === 3 && !item.deleted)) { return bytes; }
  const lib = await import("../lib/pdf-lib.esm.min.js");
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFString, PDFHexString } = lib;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const edits = annotations;
  const targets = [];
  for (const [pageIndex, page] of pdf.getPages().entries()) {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) { continue; }
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const dict = pdf.context.lookup(ref);
      if (!(dict instanceof PDFDict) || dict.get(PDFName.of("Subtype")) !== PDFName.of("FreeText")) { continue; }
      if (!force && !matchesEdit(dict, edits, lib, pageIndex)) { continue; }
      const raw = dict.get(PDFName.of("Contents"));
      const text = raw instanceof PDFString || raw instanceof PDFHexString ? raw.decodeText() : "";
      if (!text.trim()) { continue; }
      const da = dict.get(PDFName.of("DA"));
      const appearance = da instanceof PDFString || da instanceof PDFHexString ? da.decodeText() : "";
      const size = /\/[^\s]+\s+([\d.]+)\s+Tf/.exec(appearance);
      const fontSize = Number(size?.[1]);
      if (!(fontSize > 0 && fontSize <= 1000)) { throw new Error("文字注釈の大きさを確認できませんでした"); }
      const rectValue = dict.lookup(PDFName.of("Rect"), PDFArray);
      const rect = rectValue.asArray().map(n => n.asNumber());
      if (rect.length !== 4 || !rect.every(Number.isFinite)) { throw new Error("文字注釈の位置を確認できませんでした"); }
      const rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(appearance);
      const gray = /([\d.]+)\s+g(?:\s|$)/.exec(appearance);
      const color = rgb ? rgb.slice(1).map(Number) : Array(3).fill(Number(gray?.[1] || 0));
      const rotation = ((dict.lookupMaybe(PDFName.of("Rotate"), PDFNumber)?.asNumber() || 0) % 360 + 360) % 360;
      if (![0, 90, 180, 270].includes(rotation)) { throw new Error("文字注釈の回転を確認できませんでした"); }
      targets.push({ dict, text, fontSize, rect, color, rotation, pageBox: page.getCropBox() });
    }
  }
  if (!targets.length) { return bytes; }
  const pixels = Math.min(2048, Math.max(192, Math.ceil(Math.max(...targets.map(t => t.fontSize)) * 600 / 72)));
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = `${pixels}px ${FONT_FAMILY}`;
  const fontGroups = new Map();
  for (const target of targets) {
    const key = target.color.join("|");
    if (!fontGroups.has(key)) { fontGroups.set(key, { color: target.color, chars: new Set(), fonts: [] }); }
    for (const char of split(target.text.replace(/\r\n?|\n/g, ""))) { fontGroups.get(key).chars.add(char); }
  }
  for (const group of fontGroups.values()) {
    const chars = [...group.chars];
    for (let i = 0; i < chars.length; i += 255) { group.fonts.push(await makeFont(pdf, chars.slice(i, i + 255), group.color, pixels, lib)); }
  }
  for (const target of targets) {
    const { dict, text, fontSize, color, rotation } = target;
    const fonts = fontGroups.get(color.join("|")).fonts;
    const resources = {};
    fonts.forEach((font, i) => { resources[`ShFT${i}`] = font.ref; });
    const old = target.rect;
    const { pageBox } = target;
    const oldWidth = Math.min(old[2] - old[0], pageBox.width);
    const oldHeight = Math.min(old[3] - old[1], pageBox.height);
    const lineWidth = rotation % 180 ? oldHeight : oldWidth;
    const lines = visualLines(text, Math.max(fontSize, lineWidth - fontSize * 0.04), line => ctx.measureText(line).width / pixels * fontSize);
    const neededHeight = fontSize * 1.35 * lines.length;
    const width = rotation % 180 ? Math.max(oldWidth, neededHeight) : oldWidth;
    const height = rotation % 180 ? oldHeight : Math.max(oldHeight, neededHeight);
    if (width > pageBox.width + 0.01 || height > pageBox.height + 0.01) {
      throw new Error("文字注釈がページ内に収まりません。文字の枠を広げるか、複数の注釈に分けてください");
    }
    const left = Math.min(Math.max(old[0], pageBox.x), pageBox.x + pageBox.width - width);
    const top = Math.min(Math.max(old[3], pageBox.y + height), pageBox.y + pageBox.height);
    const rect = [left, top - height, left + width, top];
    const textHeight = rotation % 180 ? width : height;
    const transform = rotation === 90 ? [0, 1, -1, 0, width, 0] : rotation === 180 ? [-1, 0, 0, -1, width, height] : rotation === 270 ? [0, -1, 1, 0, 0, height] : [1, 0, 0, 1, 0, 0];
    const buffer = ["q", `${transform.map(num).join(" ")} cm`, "BT", `${color.map(num).join(" ")} rg`];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      let prefix = "";
      for (const char of split(line)) {
        const fontIndex = fonts.findIndex(font => font.glyphs.has(char));
        const x = ctx.measureText(prefix).width / pixels * fontSize;
        const y = textHeight - fontSize - fontSize * 1.35 * lineIndex;
        buffer.push(`/ShFT${fontIndex} ${num(fontSize)} Tf`, `1 0 0 1 ${num(x)} ${num(y)} Tm`, `<${fonts[fontIndex].glyphs.get(char).code}> Tj`);
        prefix += char;
      }
    }
    buffer.push("ET", "Q");
    const stream = pdf.context.flateStream(buffer.join("\n"), {
      Type: "XObject", Subtype: "Form", FormType: 1, BBox: [0, 0, width, height],
      Matrix: [1, 0, 0, 1, 0, 0], Resources: { Font: resources },
    });
    dict.set(PDFName.of("AP"), pdf.context.obj({ N: pdf.context.register(stream) }));
    dict.set(PDFName.of("Rect"), pdf.context.obj(rect));
    dict.set(PDFName.of("DA"), PDFString.of(`/ShFT0 ${num(fontSize)} Tf ${color.map(num).join(" ")} rg`));
    dict.set(PDFName.of("DR"), pdf.context.obj({ Font: resources }));
    dict.set(PDFName.of("Border"), pdf.context.obj([0, 0, 0]));
    dict.set(PDFName.of("BS"), pdf.context.obj({ Type: "Border", W: 0 }));
    dict.delete(PDFName.of("RC"));
    dict.set(PDFName.of(MARKER), PDFNumber.of(1));
  }
  onReport?.({ repaired: targets.length, fonts: [...fontGroups.values()].reduce((n, group) => n + group.fonts.length, 0) });
  return await pdf.save({ useObjectStreams: true });
}
