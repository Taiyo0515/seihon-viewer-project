/**
 * 製本ビューア 電子書籍リーダー(0.4)。
 *
 * EPUB・MOBI・AZW・AZW3(と FB2)を表示する。本の表示は同梱の foliate-js(MIT License)を使う。
 *  - 縦書き・右綴じ(右から左へめくる)・目次・検索・文字の大きさ・背景の色・読んだ位置の記憶
 *  - 「PDF に保存」: 本を紙の大きさに並べ直して Chrome の印刷画面を開く(送信先「PDF に保存」で、文字の PDF になる)
 *  - PDF・コミック(CBZ・CBR)・画像だけの EPUB は、製本ビューアの画面に渡して開く
 *
 * 安全のため: 本の中のスクリプトは実行しない(拡張機能のページの決まり(CSP)で止まる。念のため読み込む前にも取り除く)。
 * 本のファイルはこの画面の中だけで読み、外部には送らない。
 */

import "../lib/foliate/view.js";
import { getHandoff, putHandoff } from "../common/handoff.js";
import { FORMAT_LABELS, OPEN_ACCEPT } from "../common/ebook-formats.js";
import { formatBytes, saveBlobAs, sanitizeFileName } from "../common/files.js";
import { loadSettings } from "../common/settings.js";
import { applyThemePreference, readCachedThemePreference } from "../viewer/theme.js";
import { hydrateIcons, setIcon } from "../viewer/icons.js";
import { EbookUnsupportedError, inspectEbook } from "../viewer/ebook/ebook-open.js";
import { printBook } from "./print-book.js";

const LOG = "[製本ビューア]";
const $ = id => document.getElementById(id);

applyThemePreference(readCachedThemePreference());
hydrateIcons(document);
loadSettings()
  .then(s => applyThemePreference(s.theme))
  .catch(() => {});

// ---------------------------------------------------------------------------
// 表示の好み(この拡張機能の中に保存。外部には送らない)
// ---------------------------------------------------------------------------
const PREFS_KEY = "readerPrefs";
const POS_KEY = "readerPositions";
const MAX_POSITIONS = 300;
const DEFAULT_PREFS = { columns: 2, fontScale: 100, theme: "light" };
let prefs = { ...DEFAULT_PREFS };

async function loadPrefs() {
  try {
    const { [PREFS_KEY]: p } = await chrome.storage.local.get(PREFS_KEY);
    prefs = { ...DEFAULT_PREFS, ...(p && typeof p === "object" ? p : {}) };
  } catch {}
  prefs.fontScale = Math.min(250, Math.max(60, Number(prefs.fontScale) || 100));
  prefs.columns = prefs.columns === 1 ? 1 : 2;
  if (!["light", "sepia", "dark"].includes(prefs.theme)) {
    prefs.theme = "light";
  }
}

function savePrefs() {
  chrome.storage.local.set({ [PREFS_KEY]: prefs }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------
function toast(message, { kind = "info", duration = 4000 } = {}) {
  const el = document.createElement("div");
  el.className = `rd-toast${kind === "error" ? " rd-error" : ""}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.textContent = message;
  $("rdToastHost").append(el);
  requestAnimationFrame(() => el.classList.add("rd-show"));
  const dismiss = () => {
    el.classList.remove("rd-show");
    setTimeout(() => el.remove(), 250);
  };
  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
  return dismiss;
}

function showLoading(text) {
  $("rdLoadingText").textContent = text;
  $("rdLoading").hidden = false;
}

function hideLoading() {
  $("rdLoading").hidden = true;
}

function showError({ title, message, details = "" }) {
  hideLoading();
  $("rdEmpty").hidden = true;
  $("rdErrorTitle").textContent = title || "本を表示できませんでした";
  $("rdErrorMessage").textContent = message || "";
  $("rdErrorDetails").textContent = details;
  $("rdErrorDetails").hidden = !details;
  $("rdError").hidden = false;
  document.body.classList.add("rd-empty");
}

// ---------------------------------------------------------------------------
// 本の状態
// ---------------------------------------------------------------------------
const state = {
  view: null,
  book: null,
  file: null,
  name: "",
  url: "",
  format: "",
  key: null,
  vertical: false,
  fixed: false,
  lastSave: 0,
  saveTimer: 0,
  tocLinks: [],
  searching: null,
};

const label = x => {
  if (!x) {
    return "";
  }
  if (typeof x === "string") {
    return x;
  }
  if (Array.isArray(x)) {
    return x.map(label).filter(Boolean).join("、");
  }
  if (typeof x === "object") {
    if (x.name) {
      return label(x.name);
    }
    const keys = Object.keys(x);
    return x.ja || x.und || (keys.length ? x[keys[0]] : "");
  }
  return String(x);
};

/** 本の見分け(読んだ位置の記憶に使う。ファイルの中身から作る) */
async function bookKey(blob) {
  const head = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
  const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - 65536)).arrayBuffer());
  const all = new Uint8Array(head.length + tail.length + 8);
  all.set(head);
  all.set(tail, head.length);
  new DataView(all.buffer).setFloat64(head.length + tail.length, blob.size);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return [...hash.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function loadPosition(key) {
  try {
    const { [POS_KEY]: all } = await chrome.storage.local.get(POS_KEY);
    return all?.[key] || null;
  } catch {
    return null;
  }
}

async function storePosition(key, value) {
  try {
    const { [POS_KEY]: all = {} } = await chrome.storage.local.get(POS_KEY);
    all[key] = { ...value, time: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > MAX_POSITIONS) {
      keys.sort((a, b) => (all[a].time || 0) - (all[b].time || 0));
      for (const k of keys.slice(0, keys.length - MAX_POSITIONS)) {
        delete all[k];
      }
    }
    await chrome.storage.local.set({ [POS_KEY]: all });
  } catch {}
}

// ---------------------------------------------------------------------------
// 本の見た目(本の中に差し込むスタイル)
// ---------------------------------------------------------------------------
const THEMES = {
  light: null,
  sepia: { bg: "#f6efe0", fg: "#3a2e1f", link: "#7a4b12" },
  dark: { bg: "#1b1b1c", fg: "#d8d8d8", link: "#8ab4f8" },
};

function bookCss() {
  const t = THEMES[prefs.theme];
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html { font-size: ${prefs.fontScale}% !important; ${t ? `color-scheme: ${prefs.theme === "dark" ? "dark" : "light"};` : ""} }
    ${t ? `html, body { background: ${t.bg} !important; color: ${t.fg} !important; }
    a:link, a:visited { color: ${t.link} !important; }` : ""}
    p, li, blockquote, dd { hanging-punctuation: allow-end last; widows: 2; }
    pre { white-space: pre-wrap !important; }
    img, svg, video { max-inline-size: 100%; }
    aside[epub|type~="footnote"], aside[epub|type~="endnote"], aside[epub|type~="rearnote"] { display: none; }
  `;
}

function applyLook() {
  document.body.dataset.bookTheme = prefs.theme;
  $("rdFontSize").textContent = `${prefs.fontScale}%`;
  const r = state.view?.renderer;
  if (!r) {
    return;
  }
  r.setStyles?.(bookCss());
  if (!state.fixed) {
    // 縦書きの本は 1 ページ分の高さを画面いっぱいにする(横書きは 1 段の幅を読みやすい長さにする)
    r.setAttribute("max-column-count", String(prefs.columns));
    r.setAttribute("max-inline-size", state.vertical ? "1600px" : "760px");
    r.setAttribute("gap", "6%");
    r.setAttribute("margin", "40px");
  }
  updateColumnsButton();
}

function updateColumnsButton() {
  const btn = $("rdColumns");
  btn.disabled = state.fixed || state.vertical;
  const two = prefs.columns === 2;
  setIcon(btn, two ? "view-spread" : "view-single");
  btn.title = state.vertical
    ? "縦書きの本は、画面いっぱいに 1 ページで表示します"
    : state.fixed
      ? "固定レイアウトの本は、本の指定どおりに並べます"
      : two
        ? "見開き(画面が広いとき2ページ並べる)。押すと単ページ"
        : "単ページ。押すと見開き(画面が広いとき2ページ並べる)";
  btn.setAttribute("aria-pressed", String(two));
}

// ---------------------------------------------------------------------------
// 開く
// ---------------------------------------------------------------------------

/** 製本ビューア(PDF の画面)で開く */
async function openInViewer(blob, name, url) {
  const id = await putHandoff(blob, { name, url: url || "" });
  location.href = `${chrome.runtime.getURL("viewer/viewer.html")}?h=${id}`;
}

async function openBlob(blob, { name = "", url = "" } = {}) {
  $("rdEmpty").hidden = true;
  $("rdError").hidden = true;
  showLoading(`${name || "本"} を開いています…`);
  let info;
  try {
    info = await inspectEbook(blob, name);
  } catch (e) {
    if (e instanceof EbookUnsupportedError) {
      showError({ title: e.title, message: e.message, details: `ファイル: ${name}` });
    } else {
      showError({ message: `ファイルを読めませんでした(${e.message || e})。`, details: `ファイル: ${name}` });
    }
    return;
  }
  if (info.route === "pdf" || info.route === "comic") {
    showLoading(info.route === "pdf" ? "PDF を製本ビューアで開きます…" : "コミックを製本ビューアで開きます…");
    await openInViewer(blob, name, url);
    return;
  }
  if (info.route !== "reader") {
    showError({
      title: "このファイルは開けません",
      message: "EPUB・MOBI・AZW・AZW3(と FB2)の本を表示できます。PDF・コミック(CBZ・CBR)は製本ビューアの画面で開きます。",
      details: `ファイル: ${name}`,
    });
    return;
  }
  await openBook(blob, { name, url, format: info.format });
}

async function openBook(blob, { name, url, format }) {
  closeBook();
  state.file = blob;
  state.name = name;
  state.url = url;
  state.format = format;
  const view = document.createElement("foliate-view");
  state.view = view;
  $("rdView").append(view);
  try {
    const file = new File([blob], name || `book.${format === "mobi" ? "mobi" : format}`, { type: blob.type || "" });
    await view.open(file);
  } catch (e) {
    console.error(LOG, e);
    closeBook();
    showError({ message: `本を読めませんでした(${e.message || e})。ファイルが壊れているか、対応していない作りの本です。`, details: `ファイル: ${name}` });
    return;
  }
  const { book } = view;
  state.book = book;
  state.fixed = view.isFixedLayout;
  // 本の中のスクリプトは使わない(念のため、読み込む前に取り除く)
  book.transformTarget?.addEventListener("data", ({ detail }) => {
    if (!/html|xml/.test(detail.type || "")) {
      return;
    }
    detail.data = Promise.resolve(detail.data)
      .then(data => (typeof data === "string" ? stripScripts(data) : data))
      .catch(e => {
        console.warn(LOG, `読み込めない部分がありました: ${detail.name}`, e);
        return "";
      });
  });
  view.addEventListener("load", onSectionLoad);
  view.addEventListener("relocate", onRelocate);
  view.addEventListener("external-link", e => {
    // 外部のリンクは新しいタブで開く(本の中では開かない)
    e.preventDefault();
    const href = e.detail.href_ || e.detail.a?.href;
    if (/^https?:/i.test(href || "")) {
      window.open(href, "_blank", "noopener");
    }
  });

  const title = label(book.metadata?.title) || name || "無題";
  document.title = `${title} - 電子書籍リーダー`;
  $("rdTitle").textContent = title;
  $("rdTitle").title = name ? `${title}\n${name}` : title;
  $("rdFormat").textContent = formatLabel(format, name);
  $("rdFormat").hidden = false;
  document.body.classList.remove("rd-empty");
  updateDirectionButtons();
  buildToc(book.toc || []);
  buildInfo(book);
  applyLook();

  // 前回読んだ位置から
  state.key = await bookKey(blob).catch(() => null);
  const saved = state.key ? await loadPosition(state.key) : null;
  try {
    if (saved?.cfi) {
      await view.init({ lastLocation: saved.cfi });
      toast("前回読んだところから表示しています", { duration: 2500 });
    } else {
      await view.renderer.next();
    }
  } catch (e) {
    console.warn(LOG, e);
    await view.renderer.next().catch(() => {});
  }
  hideLoading();
  view.focus?.();
}

function closeBook() {
  state.searching = null;
  if (state.view) {
    try {
      state.view.close();
    } catch {}
    state.view.remove();
  }
  state.view = null;
  state.book = null;
  $("rdTocList").textContent = "";
  $("rdSearchResults").textContent = "";
}

function formatLabel(format, name) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name || "") || [])[1]?.toUpperCase();
  if (format === "mobi" && ext) {
    return `Kindle(${ext})`;
  }
  return FORMAT_LABELS[format] || ext || "";
}

/** スクリプト・イベント属性・javascript: の URL を取り除く */
function stripScripts(text) {
  return text
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

function onSectionLoad({ detail: { doc } }) {
  doc.addEventListener("keydown", onKeydown);
  // 縦書きかどうか(縦書きの本は 1 ページの高さを画面いっぱいに使う)
  try {
    const wm = doc.defaultView.getComputedStyle(doc.body).writingMode;
    const vertical = /^vertical/.test(wm);
    if (vertical !== state.vertical) {
      state.vertical = vertical;
      applyLook();
    }
  } catch {}
}

function onRelocate({ detail }) {
  const { fraction = 0, tocItem, pageItem, cfi } = detail;
  const percent = Math.round(fraction * 1000) / 10;
  $("rdPercent").textContent = `${percent}%`;
  const slider = $("rdProgress");
  if (document.activeElement !== slider) {
    slider.value = String(fraction);
  }
  const chapter = tocItem?.label?.trim() || "";
  $("rdChapter").textContent = pageItem?.label ? `${chapter}(p.${pageItem.label})` : chapter;
  if (tocItem?.href) {
    for (const a of state.tocLinks) {
      if (a.dataset.href === tocItem.href) {
        a.setAttribute("aria-current", "true");
      } else {
        a.removeAttribute("aria-current");
      }
    }
  }
  // 読んだ位置を覚える(少し待ってから)
  if (state.key && cfi) {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => storePosition(state.key, { cfi, fraction, title: $("rdTitle").textContent }), 800);
  }
}

// ---------------------------------------------------------------------------
// 目次・本の情報・検索
// ---------------------------------------------------------------------------
function buildToc(toc) {
  const host = $("rdTocList");
  host.textContent = "";
  state.tocLinks = [];
  const make = items => {
    const ol = document.createElement("ol");
    for (const item of items) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = label(item.label).trim() || "(無題)";
      a.dataset.href = item.href || "";
      a.addEventListener("click", e => {
        e.preventDefault();
        if (item.href) {
          state.view?.goTo(item.href).catch(err => console.warn(LOG, err));
        }
      });
      state.tocLinks.push(a);
      li.append(a);
      if (item.subitems?.length) {
        li.append(make(item.subitems));
      }
      ol.append(li);
    }
    return ol;
  };
  if (toc.length) {
    host.append(make(toc));
  } else {
    const p = document.createElement("p");
    p.className = "rd-note";
    p.textContent = "この本には目次がありません。";
    host.append(p);
  }
}

function buildInfo(book) {
  const m = book.metadata || {};
  const rows = [
    ["題名", label(m.title)],
    ["著者", label(m.author)],
    ["出版社", label(m.publisher)],
    ["発行日", label(m.published)],
    ["言語", label(m.language)],
    ["形式", formatLabel(state.format, state.name)],
    ["ファイル", state.name],
    ["大きさ", formatBytes(state.file?.size || 0)],
    ["綴じ方向", book.dir === "rtl" ? "右綴じ(右から左へめくる)" : "左綴じ(左から右へめくる)"],
    ["レイアウト", state.fixed ? "固定レイアウト" : "リフロー(文字の大きさで並びが変わる)"],
  ].filter(([, v]) => v);
  const dl = $("rdInfoList");
  dl.textContent = "";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  const img = $("rdCover");
  img.hidden = true;
  Promise.resolve(book.getCover?.())
    .then(blob => {
      if (blob) {
        img.src = URL.createObjectURL(blob);
        img.hidden = false;
      }
    })
    .catch(() => {});
}

function showSide(tab) {
  const side = $("rdSide");
  if (tab === null) {
    side.hidden = true;
    $("rdToc").setAttribute("aria-expanded", "false");
    return;
  }
  side.hidden = false;
  $("rdToc").setAttribute("aria-expanded", "true");
  for (const b of $("rdSideTabs").querySelectorAll("button")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  }
  for (const p of side.querySelectorAll(".rd-side-panel")) {
    p.hidden = p.dataset.panel !== tab;
  }
  if (tab === "search") {
    $("rdSearchInput").focus();
  }
}

async function runSearch(query) {
  const view = state.view;
  const list = $("rdSearchResults");
  list.textContent = "";
  view?.clearSearch?.();
  if (!view || !query.trim()) {
    $("rdSearchStatus").textContent = "";
    return;
  }
  const token = {};
  state.searching = token;
  let count = 0;
  $("rdSearchStatus").textContent = "検索しています…";
  try {
    for await (const result of view.search({ query: query.trim() })) {
      if (state.searching !== token) {
        return;
      }
      if (result === "done") {
        break;
      }
      if (result.progress !== undefined && !result.subitems) {
        $("rdSearchStatus").textContent = `検索しています… ${Math.round(result.progress * 100)}%`;
        continue;
      }
      if (result.subitems) {
        const head = document.createElement("li");
        head.className = "rd-res-head";
        head.textContent = result.label || "";
        list.append(head);
        for (const item of result.subitems) {
          const li = document.createElement("li");
          const b = document.createElement("button");
          b.type = "button";
          const { pre = "", match = "", post = "" } = item.excerpt || {};
          const mark = document.createElement("mark");
          mark.textContent = match;
          b.append(document.createTextNode(pre), mark, document.createTextNode(post));
          b.addEventListener("click", () => view.goTo(item.cfi));
          li.append(b);
          list.append(li);
          count++;
        }
      }
    }
    $("rdSearchStatus").textContent = count ? `${count} 件見つかりました` : "見つかりませんでした";
  } catch (e) {
    console.warn(LOG, e);
    $("rdSearchStatus").textContent = "検索できませんでした";
  }
}

// ---------------------------------------------------------------------------
// めくる・操作
// ---------------------------------------------------------------------------
function updateDirectionButtons() {
  const rtl = state.book?.dir === "rtl";
  $("rdPrev").title = rtl ? "左へ(次のページ)" : "左へ(前のページ)";
  $("rdNext").title = rtl ? "右へ(前のページ)" : "右へ(次のページ)";
}

const goLeft = () => state.view?.goLeft();
const goRight = () => state.view?.goRight();

function onKeydown(e) {
  if (!state.view) {
    return;
  }
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    showSide("search");
    return;
  }
  if (ctrl && (e.key === "p" || e.key === "P")) {
    e.preventDefault();
    openPrintDialog();
    return;
  }
  if (ctrl || e.altKey) {
    return;
  }
  switch (e.key) {
    case "ArrowLeft":
      e.preventDefault();
      goLeft();
      break;
    case "ArrowRight":
      e.preventDefault();
      goRight();
      break;
    case "PageDown":
    case " ":
      e.preventDefault();
      if (e.shiftKey) {
        state.view.prev();
      } else {
        state.view.next();
      }
      break;
    case "PageUp":
      e.preventDefault();
      state.view.prev();
      break;
    case "Home":
      e.preventDefault();
      state.view.goToFraction(0);
      break;
    case "End":
      e.preventDefault();
      state.view.goToFraction(1);
      break;
  }
}

// ---------------------------------------------------------------------------
// PDF に保存(印刷)
// ---------------------------------------------------------------------------
function openPrintDialog() {
  if (!state.book) {
    return;
  }
  const d = $("rdPrintDialog");
  try {
    const p = JSON.parse(localStorage.getItem("seihon.readerPrint") || "{}");
    if (p.paper) $("rdPaper").value = p.paper;
    if (p.font) $("rdPrintFont").value = p.font;
    if (p.margin) $("rdPrintMargin").value = p.margin;
    if (typeof p.breaks === "boolean") $("rdPrintBreak").checked = p.breaks;
  } catch {}
  $("rdPrintNote").textContent = state.fixed
    ? "固定レイアウトの本です。1 ページずつ紙の大きさに合わせて並べます(文字の大きさ・余白の指定は使いません)。"
    : state.vertical
      ? "縦書きの本は、縦書きのまま右から左へページが進む形で並べます。"
      : "";
  $("rdPrintStatus").textContent = "";
  $("rdPrintGo").disabled = false;
  d.showModal();
}

async function runPrint() {
  const opts = {
    paper: $("rdPaper").value,
    fontPt: Number($("rdPrintFont").value),
    marginMm: Number($("rdPrintMargin").value),
    breaks: $("rdPrintBreak").checked,
  };
  try {
    localStorage.setItem("seihon.readerPrint", JSON.stringify({ paper: opts.paper, font: String(opts.fontPt), margin: String(opts.marginMm), breaks: opts.breaks }));
  } catch {}
  $("rdPrintGo").disabled = true;
  try {
    await printBook(state.book, {
      ...opts,
      title: $("rdTitle").textContent,
      fixed: state.fixed,
      vertical: state.vertical,
      onStatus: text => {
        $("rdPrintStatus").textContent = text;
      },
      beforePrint: () => $("rdPrintDialog").close(),
    });
  } catch (e) {
    console.error(LOG, e);
    $("rdPrintStatus").textContent = `印刷の準備ができませんでした(${e.message || e})`;
    $("rdPrintGo").disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 画面の部品のつなぎ
// ---------------------------------------------------------------------------
function chooseFile() {
  $("rdFileInput").click();
}

$("rdFileInput").accept = OPEN_ACCEPT;
$("rdFileInput").addEventListener("change", e => {
  const f = e.target.files?.[0];
  e.target.value = "";
  if (f) {
    openBlob(f, { name: f.name });
  }
});
$("rdOpen").addEventListener("click", chooseFile);
$("rdErrorOpen").addEventListener("click", chooseFile);
$("rdPrev").addEventListener("click", goLeft);
$("rdNext").addEventListener("click", goRight);
$("rdEdgeLeft").addEventListener("click", goLeft);
$("rdEdgeRight").addEventListener("click", goRight);
$("rdToc").addEventListener("click", () => showSide($("rdSide").hidden ? "toc" : null));
$("rdSearchBtn").addEventListener("click", () => showSide("search"));
for (const b of $("rdSideTabs").querySelectorAll("button")) {
  b.addEventListener("click", () => showSide(b.dataset.tab));
}
$("rdSearchForm").addEventListener("submit", e => {
  e.preventDefault();
  runSearch($("rdSearchInput").value);
});
$("rdColumns").addEventListener("click", () => {
  prefs.columns = prefs.columns === 2 ? 1 : 2;
  savePrefs();
  applyLook();
  toast(prefs.columns === 2 ? "見開き(画面が広いとき 2 ページ並べる)" : "単ページ", { duration: 1500 });
});
const setFont = delta => {
  prefs.fontScale = Math.min(250, Math.max(60, prefs.fontScale + delta));
  savePrefs();
  applyLook();
};
$("rdFontMinus").addEventListener("click", () => setFont(-10));
$("rdFontPlus").addEventListener("click", () => setFont(10));
const THEME_ORDER = ["light", "sepia", "dark"];
const THEME_LABEL = { light: "白", sepia: "セピア", dark: "黒" };
function setTheme(theme) {
  prefs.theme = theme;
  savePrefs();
  applyLook();
  toast(`背景: ${THEME_LABEL[theme]}`, { duration: 1500 });
}
$("rdTheme").addEventListener("click", () => setTheme(THEME_ORDER[(THEME_ORDER.indexOf(prefs.theme) + 1) % 3]));
$("rdProgress").addEventListener("change", e => state.view?.goToFraction(parseFloat(e.target.value)));
$("rdPrint").addEventListener("click", openPrintDialog);
$("rdPrintCancel").addEventListener("click", () => $("rdPrintDialog").close());
$("rdPrintGo").addEventListener("click", runPrint);

// その他のメニュー
const menu = $("rdMenu");
$("rdMore").addEventListener("click", e => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
});
document.addEventListener("click", e => {
  if (!menu.hidden && !menu.contains(e.target)) {
    menu.hidden = true;
  }
});
menu.addEventListener("click", async e => {
  const act = e.target.closest("button")?.dataset.act;
  if (!act) {
    return;
  }
  menu.hidden = true;
  switch (act) {
    case "open":
      chooseFile();
      break;
    case "print":
      openPrintDialog();
      break;
    case "save-source": {
      if (!state.file) {
        break;
      }
      const res = await saveBlobAs(new Blob([state.file], { type: "application/octet-stream" }), sanitizeFileName(state.name || "book"));
      if (res.ok) {
        toast("元のファイルを保存しました");
      } else if (!res.canceled) {
        toast(`保存できませんでした(${res.error || "不明なエラー"})`, { kind: "error" });
      }
      break;
    }
    case "theme-light":
    case "theme-sepia":
    case "theme-dark":
      setTheme(act.slice(6));
      break;
    case "options":
      chrome.runtime.openOptionsPage();
      break;
  }
});

document.addEventListener("keydown", e => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (e.key === "o" || e.key === "O")) {
    e.preventDefault();
    chooseFile();
    return;
  }
  if (e.key === "Escape") {
    menu.hidden = true;
  }
  onKeydown(e);
});

// ドラッグ&ドロップ
{
  let depth = 0;
  const drop = $("rdDrop");
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", e => {
    if (hasFiles(e)) {
      depth++;
      drop.hidden = false;
    }
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) {
      drop.hidden = true;
    }
  });
  window.addEventListener("dragover", e => {
    if (hasFiles(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });
  window.addEventListener("drop", e => {
    depth = 0;
    drop.hidden = true;
    if (!hasFiles(e)) {
      return;
    }
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) {
      openBlob(f, { name: f.name });
    }
  });
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
async function start() {
  await loadPrefs();
  applyLook();
  const params = new URLSearchParams(location.search);
  const h = params.get("h");
  const src = params.get("src");
  if (h) {
    showLoading("本を開いています…");
    const item = await getHandoff(h).catch(() => null);
    if (item?.blob) {
      await openBlob(item.blob, { name: item.name, url: item.url });
      return;
    }
    hideLoading();
    if (!src) {
      $("rdEmptyNote").textContent = "開こうとしたファイルが見つかりませんでした(受け渡しから 1 日たつと消えます)。もう一度ファイルを選んでください。";
      $("rdEmptyNote").hidden = false;
      return;
    }
  }
  if (src && /^(https?|file):/i.test(src)) {
    showLoading("本を読み込んでいます…");
    try {
      const res = await fetch(src, { credentials: /^https?:/i.test(src) ? "include" : "same-origin" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const name = decodeURIComponent(src.split(/[?#]/, 1)[0].split("/").pop() || "book");
      await openBlob(blob, { name, url: src });
    } catch (e) {
      const fileHelp = /^file:/i.test(src) && !(await chrome.extension.isAllowedFileSchemeAccess().catch(() => false));
      showError({
        title: "本を読み込めませんでした",
        message: fileHelp
          ? "パソコン内のファイル(file://)を開くには、Chrome の拡張機能の設定で「ファイルの URL へのアクセスを許可する」をオンにしてください。今回は「ほかのファイルを選んで開く」で開けます。"
          : `ファイルを取得できませんでした(${e.message || e})。`,
        details: `URL: ${src}`,
      });
    }
    return;
  }
}

start();

// 開発時の確認用(試験から参照する)
window.__seihonReader = {
  state,
  get prefs() {
    return prefs;
  },
  openBlob,
  runSearch,
};
