import { saveBlobAs } from "../common/files.js";

export function decodeDocument(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let encoding = "utf-8", bom = false;
  if (bytes[0] === 255 && bytes[1] === 254) { encoding = "utf-16le"; bom = true; }
  else if (bytes[0] === 254 && bytes[1] === 255) { encoding = "utf-16be"; bom = true; }
  else if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) { bom = true; }
  try { return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding, bom }; }
  catch {
    if (!bom) {
      try { return { text: new TextDecoder("shift_jis", { fatal: true }).decode(bytes), encoding: "shift_jis", bom }; }
      catch { /* Report unsupported input below. */ }
    }
    throw new Error("文字コードを読み取れません。UTF-8、BOM付きUTF-16、Shift_JISに対応しています。");
  }
}

let sjisMap;
function getSjisMap() {
  if (sjisMap) { return sjisMap; }
  const map = new Map(), decoder = new TextDecoder("shift_jis", { fatal: true });
  function remember(bytes) {
    try {
      const char = decoder.decode(Uint8Array.from(bytes));
      if (!map.has(char)) { map.set(char, bytes); }
    } catch { /* Undefined byte sequence. */ }
  }
  for (let i = 0; i < 256; i++) { remember([i]); }
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead > 0x9f && lead < 0xe0) { continue; }
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail !== 0x7f) { remember([lead, trail]); }
    }
  }
  sjisMap = map;
  return map;
}

export function encodeDocument(text, { encoding = "utf-8", bom = false } = {}) {
  if (encoding === "utf-8") {
    const bytes = new TextEncoder().encode(text);
    if (!bom) { return bytes; }
    const out = new Uint8Array(bytes.length + 3);
    out.set([239, 187, 191]); out.set(bytes, 3);
    return out;
  }
  if (encoding === "shift_jis") {
    const map = getSjisMap(), bytes = [];
    for (const char of text) {
      const entry = map.get(char);
      if (!entry) { throw new Error("Shift_JISで保存できない文字があります（" + char + "）。"); }
      bytes.push(...entry);
    }
    return Uint8Array.from(bytes);
  }
  if (encoding !== "utf-16le" && encoding !== "utf-16be") { throw new Error("未対応の文字コードです"); }
  const offset = bom ? 2 : 0, little = encoding === "utf-16le";
  const out = new Uint8Array(offset + text.length * 2), view = new DataView(out.buffer);
  if (bom) { view.setUint16(0, 0xfeff, little); }
  for (let i = 0; i < text.length; i++) { view.setUint16(offset + i * 2, text.charCodeAt(i), little); }
  return out;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) { node.className = className; }
  if (text !== undefined) { node.textContent = text; }
  return node;
}

function button(label, handler) {
  const node = el("button", "", label);
  node.type = "button";
  node.onclick = handler;
  return node;
}

function styles() {
  if (document.getElementById("document-formats-style")) { return; }
  const link = el("link");
  link.rel = "stylesheet";
  link.id = "document-formats-style";
  link.href = new URL("./document-formats.css", import.meta.url).href;
  document.head.append(link);
}

function appendRuby(parent, source) {
  const pattern = /(?:[｜|]([^\r\n｜|《》]+)|([\p{Script=Han}々〆ヵヶ]+))《([^\r\n《》]+)》/gu;
  let pos = 0;
  for (const m of source.matchAll(pattern)) {
    const ruby = el("ruby");
    ruby.append(m[1] || m[2], el("rt", "", m[3]));
    parent.append(source.slice(pos, m.index), ruby);
    pos = m.index + m[0].length;
  }
  parent.append(source.slice(pos));
}

export function renderText(container, source, { aozora = false } = {}) {
  styles();
  const content = el("div", aozora ? "df-text df-aozora" : "df-text");
  if (aozora) {
    // Paired emphasis and the common retrospective annotation ［＃「文字」に傍点］.
    const paired = /［＃傍点］([\s\S]*?)［＃傍点終わり］|［＃「([^」\r\n]+)」に傍点］/gu;
    let pos = 0;
    for (const m of source.matchAll(paired)) {
      const before = source.slice(pos, m.index);
      if (m[2] && !before.endsWith(m[2])) { continue; }
      appendRuby(content, m[2] ? before.slice(0, -m[2].length) : before);
      const em = el("span", "df-emphasis");
      appendRuby(em, m[1] ?? m[2]);
      content.append(em);
      pos = m.index + m[0].length;
    }
    appendRuby(content, source.slice(pos));
  } else { content.textContent = source; }
  container.replaceChildren(content);
}

// Each unchanged field retains its original quotes, spacing and record separator.
export function parseTable(source, delimiter) {
  const rows = [];
  let fields = [], i = 0;
  do {
    const start = i;
    let value = "";
    if (source[i] === '"') {
      i++;
      while (true) {
        const end = source.indexOf('"', i);
        if (end < 0) { throw new Error("行 " + (rows.length + 1) + " の引用符が閉じていません"); }
        value += source.slice(i, end);
        i = end + 1;
        if (source[i] !== '"') { break; }
        value += '"'; i++;
      }
      if (i < source.length && source[i] !== delimiter && !/[\r\n]/.test(source[i])) {
        throw new Error("行 " + (rows.length + 1) + " の区切りを確認してください");
      }
    } else {
      while (i < source.length && source[i] !== delimiter && !/[\r\n]/.test(source[i])) { i++; }
      value = source.slice(start, i);
    }
    fields.push({ value, raw: source.slice(start, i) });
    if (source[i] === delimiter) { i++; continue; }
    const sep = source.startsWith("\r\n", i) ? "\r\n" : (source[i] || "");
    rows.push({ fields, sep });
    fields = [];
    i += sep.length;
    if (i === source.length) { break; }
  } while (i <= source.length);
  return rows;
}

function quote(value, delimiter) {
  return value.includes(delimiter) || /["\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
}

export function renderTable(container, source, { delimiter = ",", editable = false, onChange } = {}) {
  styles();
  const rows = parseTable(source, delimiter);
  const toolbar = el("div", "df-toolbar"), search = el("input");
  search.type = "search"; search.placeholder = "セルを検索"; search.setAttribute("aria-label", "セルを検索");
  const scroll = el("div", "df-scroll"), table = el("table", "df-table"), status = el("span");
  const info = el("span"), limit = 100;
  let page = 0, anchor = [0, 0], end = [0, 0], found = -1;
  const bounds = () => [Math.min(anchor[0], end[0]), Math.max(anchor[0], end[0]), Math.min(anchor[1], end[1]), Math.max(anchor[1], end[1])];
  function select() {
    const [r1,r2,c1,c2] = bounds();
    for (const cell of table.querySelectorAll("td")) {
      const {r,c} = cell.dataset;
      cell.classList.toggle("df-selected", r >= r1 && r <= r2 && c >= c1 && c <= c2);
    }
  }
  function draw() {
    const body = el("tbody");
    for (let r = page * limit; r < Math.min(rows.length, (page+1)*limit); r++) {
      const tr = el("tr"), header = el("th", "", r+1);
      header.scope = "row"; tr.append(header);
      rows[r].fields.forEach((field,c) => {
        const td = el("td", "", field.value);
        td.dataset.r = r; td.dataset.c = c;
        td.contentEditable = editable ? "plaintext-only" : "false"; td.tabIndex = 0;
        tr.append(td);
      });
      body.append(tr);
    }
    table.replaceChildren(body);
    select();
    prev.disabled = page === 0; next.disabled = (page+1)*limit >= rows.length;
    info.textContent = (page*limit+1) + "–" + Math.min(rows.length,(page+1)*limit) + " / " + rows.length + " 行";
  }
  function copyText() {
    const [r1,r2,c1,c2] = bounds();
    return rows.slice(r1,r2+1).map(({fields}) => Array.from({length:c2-c1+1}, (_, n) => quote(fields[c1+n]?.value || "", "\t")).join("\t")).join("\r\n");
  }
  table.addEventListener("pointerdown", e => {
    const td = e.target.closest("td");
    if (!td) { return; }
    end = [Number(td.dataset.r), Number(td.dataset.c)];
    if (!e.shiftKey) { anchor = end; } else { e.preventDefault(); }
    select();
  });
  table.addEventListener("focusin", e => {
    if (e.target.matches("td")) { anchor = end = [Number(e.target.dataset.r), Number(e.target.dataset.c)]; select(); }
  });
  table.addEventListener("input", e => {
    const td = e.target.closest("td");
    if (!td || !editable) { return; }
    const field = rows[td.dataset.r].fields[td.dataset.c];
    field.value = td.innerText; field.raw = quote(field.value,delimiter);
    onChange?.(rows.map(row => row.fields.map(f => f.raw).join(delimiter) + row.sep).join(""));
  });
  table.addEventListener("copy", e => {
    if (anchor[0] === end[0] && anchor[1] === end[1] && !window.getSelection().isCollapsed) { return; }
    e.clipboardData.setData("text/plain",copyText()); e.preventDefault();
  });
  let matches = [];
  function findNext(reset) {
    if (reset) {
      matches = []; found = -1;
      const q = search.value.toLocaleLowerCase();
      if (!q) { status.textContent = ""; return; }
      rows.forEach(({fields},r) => fields.forEach(({value},c) => { if (value.toLocaleLowerCase().includes(q)) { matches.push([r,c]); } }));
    }
    if (!matches.length) { status.textContent = "一致するセルがありません"; return; }
    found = (found + 1) % matches.length;
    anchor = end = matches[found]; page = Math.floor(end[0]/limit);
    draw();
    table.querySelector('[data-r="'+end[0]+'"][data-c="'+end[1]+'"]').scrollIntoView({block:"nearest",inline:"nearest"});
    status.textContent = (found+1) + " / " + matches.length + " 件";
  }
  search.oninput = () => findNext(true);
  search.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); findNext(false); } };
  const prev = button("前の100行", () => { page--; draw(); });
  const next = button("次の100行", () => { page++; draw(); });
  const copy = button("選択範囲をコピー", async () => {
    try { await navigator.clipboard.writeText(copyText()); status.textContent = "コピーしました"; }
    catch { status.textContent = "コピーできませんでした"; }
  });
  status.setAttribute("role","status");
  toolbar.append(search,button("次の一致", () => findNext(false)),copy,prev,info,next,status);
  scroll.append(table);
  container.replaceChildren(toolbar,el("small","df-hint","範囲の先頭を選び、Shiftを押しながら末尾をクリック"),scroll);
  draw();
}

// SVG stays in an image document, including during PNG export. Never attach
// nodes from the source document to the extension page.
export function renderSvg(container, source, { name = "図" } = {}) {
  const svgNS = "http://www.w3.org/2000/svg";
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = doc.documentElement;
  if (root.namespaceURI !== svgNS || root.localName !== "svg" || doc.querySelector("parsererror")) {
    throw new Error("SVGの構文を確認してください");
  }
  styles();
  const uri = node => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(node));
  const img = el("img"), stage = el("div","df-svg-stage"), scroll = el("div","df-svg-scroll");
  const region = el("div","df-region"), controls = el("div","df-toolbar"), status = el("span");
  let zoom = 1, anchor, pointer = null, selection;
  status.setAttribute("role","status"); region.hidden = true;
  img.alt = "SVGプレビュー"; img.draggable = false;
  const size = el("span");
  function resize() {
    stage.style.width = (zoom * 100) + "%";
    size.textContent = Math.round(zoom*100) + "%";
  }
  function point(e) {
    const bounds = img.getBoundingClientRect();
    const clamp = n => Math.max(0, Math.min(1, n));
    return { x: clamp((e.clientX-bounds.left)/bounds.width), y: clamp((e.clientY-bounds.top)/bounds.height) };
  }
  function update(e) {
    const p = point(e);
    selection = { x:Math.min(p.x,anchor.x), y:Math.min(p.y,anchor.y), w:Math.abs(p.x-anchor.x), h:Math.abs(p.y-anchor.y) };
    Object.assign(region.style,{left:selection.x*100+"%",top:selection.y*100+"%",width:selection.w*100+"%",height:selection.h*100+"%"});
  }
  stage.onpointerdown = e => {
    if (e.button !== 0 || pointer !== null || !img.naturalWidth) { return; }
    e.preventDefault(); pointer = e.pointerId; stage.setPointerCapture(pointer);
    anchor = point(e); update(e); region.hidden = false;
  };
  stage.onpointermove = e => { if (pointer === e.pointerId) { update(e); } };
  stage.onpointercancel = () => { pointer = null; selection = null; region.hidden = true; status.textContent = ""; };
  stage.onpointerup = e => {
    if (pointer !== e.pointerId) { return; }
    update(e); pointer = null;
    if (selection.w * stage.clientWidth < 3 || selection.h * stage.clientHeight < 3) { stage.onpointercancel(); }
    else { status.textContent = "選択範囲を出力します"; }
  };
  async function png() {
    if (!img.naturalWidth) { throw new Error("SVGを読み込めません"); }
    const { x,y,w,h } = selection || { x:0,y:0,w:1,h:1 };
    const width = w * img.naturalWidth, height = h * img.naturalHeight;
    const scale = Math.min(4, 8192 / Math.max(width,height), Math.sqrt(16000000 / (width*height)));
    const canvas = el("canvas");
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const frame = document.createElementNS(svgNS,"svg"), inner = root.cloneNode(true);
    frame.setAttribute("viewBox",[x*img.naturalWidth,y*img.naturalHeight,width,height].join(" "));
    frame.setAttribute("width",canvas.width); frame.setAttribute("height",canvas.height);
    frame.setAttribute("preserveAspectRatio","none");
    inner.setAttribute("width",img.naturalWidth); inner.setAttribute("height",img.naturalHeight);
    inner.setAttribute("x","0"); inner.setAttribute("y","0");
    frame.append(inner);
    const image = new Image(); image.src = uri(frame);
    await image.decode();
    canvas.getContext("2d").drawImage(image,0,0);
    return new Promise((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNGを生成できません")), "image/png"));
  }
  async function output(copy) {
    try {
      if (copy) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png":png() })]);
        status.textContent = "画像をコピーしました";
      } else {
        const result = await saveBlobAs(await png(),name.replace(/\.svg$/i,"") + (selection ? "_範囲" : "") + ".png");
        status.textContent = result.ok ? "PNGを保存しました" : result.canceled ? "" : result.error;
      }
    } catch (error) { status.textContent = "画像を出力できませんでした。" + error.message; }
  }
  const minus = button("縮小", () => { zoom = Math.max(.25,zoom/1.5); resize(); });
  const plus = button("拡大", () => { zoom = Math.min(16,zoom*1.5); resize(); });
  controls.append(minus,size,plus,button("範囲解除",() => stage.onpointercancel()),button("PNGを保存…",() => output(false)),button("画像をコピー",() => output(true)),status);
  stage.append(img,region); scroll.append(stage);
  img.onerror = () => { status.textContent = "SVGを表示できませんでした"; };
  img.src = uri(root); resize();
  container.replaceChildren(controls,el("small","df-hint","図をドラッグして範囲を指定できます"),scroll);
}
