/**
 * 製本ビューア Service Worker(Manifest V3)
 *
 * 役割
 *  1. 通信の書き換えルール(PDF → 製本ビューア、強制ダウンロード対策 第1層)を設定に合わせて登録する
 *  2. download 属性を無効にするコンテンツスクリプト(強制ダウンロード対策 第2層)を登録する
 *  3. 「Chrome標準で開く」の一回だけの除外
 *  4. ローカルファイル(file://)でファイルアクセスが未許可のときの案内
 *  5. ビューアがPDFを取得するときのリファラ引き継ぎ(ログインやリファラ確認のあるサイト向け)
 *  6. 拡張アイコン・右クリックメニュー・初回案内
 *  7. 強制ダウンロード対策 第3層(それでも始まった PDF のダウンロードを見つけ、保存されたファイルをビューアで開く)
 *
 * 外部サーバーへの送信は一切行いません。
 */

import {
  DEFAULT_SETTINGS,
  loadSettings,
  onSettingsChanged,
  saveSettings,
} from "../common/settings.js";
import {
  fileUrlFromPath,
  isViewerUrl,
  looksLikePdfUrl,
  viewerBaseUrl,
  viewerUrlFor,
} from "../common/viewer-url.js";
import {
  buildBypassRules,
  buildDynamicRules,
  buildRefererRule,
} from "./dnr-rules.js";

const LOG = "[製本ビューア]";
const LINK_GUARD_ID = "seihon-link-guard";

/**
 * セッションルールのID割り当て(タブごとに10個ずつ)。
 * タブIDは大きな数になることがあり、そのままルールIDに使うと32ビット整数を超えるため、
 * タブごとに小さな番号を割り当てて storage.session に控える。
 *   +0〜+3: 「Chrome標準で開く」の一回だけの除外 / +4: リファラ引き継ぎ
 */
const RULE_BASE_START = 100000;
const RULE_BASE_MAX = 1000000000;
let allocChain = Promise.resolve();

function ruleBaseFor(tabId, { create = true } = {}) {
  const task = allocChain.then(async () => {
    const { ruleBases = {}, nextRuleBase = RULE_BASE_START } = await chrome.storage.session.get([
      "ruleBases",
      "nextRuleBase",
    ]);
    if (ruleBases[tabId]) {
      return ruleBases[tabId];
    }
    if (!create) {
      return null;
    }
    const base = nextRuleBase;
    ruleBases[tabId] = base;
    const next = base + 10 > RULE_BASE_MAX ? RULE_BASE_START : base + 10;
    await chrome.storage.session.set({ ruleBases, nextRuleBase: next });
    return base;
  });
  allocChain = task.catch(() => {});
  return task;
}

async function releaseRuleBase(tabId) {
  const base = await ruleBaseFor(tabId, { create: false });
  if (!base) {
    return;
  }
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [base, base + 1, base + 2, base + 3, base + 4] })
    .catch(() => {});
  allocChain = allocChain.then(async () => {
    const { ruleBases = {} } = await chrome.storage.session.get("ruleBases");
    delete ruleBases[tabId];
    await chrome.storage.session.set({ ruleBases });
  });
  await allocChain;
}

// ---------------------------------------------------------------------------
// 設定のキャッシュ
// ---------------------------------------------------------------------------

let settingsPromise = null;
function getSettings() {
  settingsPromise ||= loadSettings();
  return settingsPromise;
}

async function isFileAccessAllowed() {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. 通信の書き換えルールの登録
// ---------------------------------------------------------------------------

/** responseHeaders 条件に対応しているか(Chrome 128 以降)。PDF.js 公式拡張と同じ判定方法。 */
async function isHeaderConditionSupported() {
  const ruleId = 999999;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id: ruleId,
          condition: { responseHeaders: [{ header: "whatever" }], urlFilter: "|does_not_match_anything" },
          action: { type: "block" },
        },
      ],
    });
  } catch {
    return false;
  }
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          condition: { responseHeaders: [], urlFilter: "|does_not_match_anything" },
          action: { type: "block" },
        },
      ],
    });
    return false; // 空配列が通る = 検証が無効 = 機能が無効
  } catch {
    return true;
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
  }
}

let applyChain = Promise.resolve();
/** 設定に合わせて動的ルールとコンテンツスクリプトを登録し直す(多重実行は直列化) */
function applyAll(reason) {
  applyChain = applyChain.then(() => applyAllNow(reason)).catch(e => console.error(LOG, "ルール登録に失敗", e));
  return applyChain;
}

async function applyAllNow(reason) {
  const settings = await getSettings();
  const fileAccess = await isFileAccessAllowed();
  const supported = await isHeaderConditionSupported();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  let addRules = [];
  if (supported) {
    addRules = buildDynamicRules(settings, { fileAccess });
  } else {
    console.warn(LOG, "このChromeは応答ヘッダー条件に未対応のため、自動切り替えを無効にします(Chrome 128 以降が必要)");
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(r => r.id),
    addRules,
  });
  await syncLinkGuard(settings);
  await chrome.storage.session.set({ rulesApplied: true, headerConditionSupported: supported });
  console.info(LOG, `ルールを登録しました(${reason})`, addRules.map(r => r.id));
}

// ---------------------------------------------------------------------------
// 2. download 属性を無効にするコンテンツスクリプト(第2層)
// ---------------------------------------------------------------------------

function excludePatternsFor(sites) {
  const out = [];
  for (const host of sites) {
    out.push(`*://${host}/*`, `*://*.${host}/*`);
  }
  return out;
}

async function syncLinkGuard(settings) {
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [LINK_GUARD_ID] });
  if (!settings.guardEnabled) {
    if (registered.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [LINK_GUARD_ID] });
    }
    return;
  }
  const script = {
    id: LINK_GUARD_ID,
    matches: ["http://*/*", "https://*/*"],
    js: ["content/link-guard.js"],
    runAt: "document_start",
    allFrames: true,
    persistAcrossSessions: true,
  };
  const ex = excludePatternsFor(settings.guardExcludeSites);
  if (ex.length) {
    script.excludeMatches = ex;
  }
  if (registered.length) {
    // excludeMatches を消すときは update では消えないので登録し直す
    await chrome.scripting.unregisterContentScripts({ ids: [LINK_GUARD_ID] });
  }
  await chrome.scripting.registerContentScripts([script]);
}

// ---------------------------------------------------------------------------
// 3. 「Chrome標準で開く」(その1回だけ自動切り替えをしない)
// ---------------------------------------------------------------------------

/** file:// の案内リダイレクトを1回だけ止めるタブ */
async function getFileBypassTabs() {
  const { fileBypassTabs = [] } = await chrome.storage.session.get("fileBypassTabs");
  return new Set(fileBypassTabs);
}
async function setFileBypassTabs(set) {
  await chrome.storage.session.set({ fileBypassTabs: [...set] });
}

async function addBypass(tabId) {
  const base = await ruleBaseFor(tabId);
  const rules = buildBypassRules(tabId, base);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: rules.map(r => r.id),
    addRules: rules,
  });
  const tabs = await getFileBypassTabs();
  tabs.add(tabId);
  await setFileBypassTabs(tabs);
}

async function removeBypass(tabId) {
  const base = await ruleBaseFor(tabId, { create: false });
  if (!base) {
    return;
  }
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [base, base + 1, base + 2, base + 3] })
    .catch(() => {});
}

async function hasBypass(tabId) {
  const base = await ruleBaseFor(tabId, { create: false });
  if (!base) {
    return false;
  }
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  return rules.some(r => r.id === base);
}

/** 指定のタブで、PDFをChrome標準ビューアで開く */
async function openNative(tabId, url) {
  await addBypass(tabId);
  await chrome.tabs.update(tabId, { url });
  // 万一読み込みが確定しない(ダウンロードになった等)場合に備えて、時間が経ったら解除する
  setTimeout(() => removeBypass(tabId), 30000);
}

// 読み込みが確定したら除外ルールを外す(「その1回だけ」)
chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) {
    return;
  }
  hasBypass(details.tabId).then(has => {
    if (has) {
      removeBypass(details.tabId);
    }
  });
  if (!isViewerUrl(details.url)) {
    removeRefererRule(details.tabId);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  releaseRuleBase(tabId);
  setPdfTab(tabId, false);
  getFileBypassTabs().then(tabs => {
    if (tabs.delete(tabId)) {
      setFileBypassTabs(tabs);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. ローカルファイル(file://): ファイルアクセス未許可でも案内画面を出す
// ---------------------------------------------------------------------------

chrome.webNavigation.onBeforeNavigate.addListener(
  async details => {
    if (details.frameId !== 0) {
      return;
    }
    const tabs = await getFileBypassTabs();
    if (tabs.has(details.tabId)) {
      tabs.delete(details.tabId);
      await setFileBypassTabs(tabs);
      return;
    }
    const settings = await getSettings();
    if (settings.launchMode !== "auto" || !settings.openLocalFiles) {
      return;
    }
    if (await isFileAccessAllowed()) {
      return; // 許可済みなら通信の書き換えルールが処理する
    }
    // 許可が無い場合: ビューアに切り替え、ビューア側で「アクセスの許可」の案内を出す
    chrome.tabs.update(details.tabId, { url: viewerUrlFor(details.url) });
  },
  {
    url: [
      { urlPrefix: "file://", pathSuffix: ".pdf" },
      { urlPrefix: "file://", pathSuffix: ".PDF" },
      { urlPrefix: "file://", pathSuffix: ".Pdf" },
    ],
  }
);

// ---------------------------------------------------------------------------
// 5. リファラの引き継ぎ
// ---------------------------------------------------------------------------

/** tabId -> { url, referer, time } (メモリ上のみ。5分で破棄) */
const lastMainFrame = new Map();
const MAIN_FRAME_MEMORY_MS = 5 * 60 * 1000;

chrome.webRequest.onSendHeaders.addListener(
  details => {
    if (details.tabId < 0) {
      return;
    }
    const ref = details.requestHeaders?.find(h => h.name.toLowerCase() === "referer")?.value || null;
    lastMainFrame.set(details.tabId, { url: details.url, referer: ref, time: Date.now() });
    // 古い記録を掃除
    const now = Date.now();
    for (const [id, v] of lastMainFrame) {
      if (now - v.time > MAIN_FRAME_MEMORY_MS) {
        lastMainFrame.delete(id);
      }
    }
  },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  ["requestHeaders", "extraHeaders"]
);

function stripHash(url) {
  const i = url.indexOf("#");
  return i >= 0 ? url.slice(0, i) : url;
}

async function removeRefererRule(tabId) {
  const base = await ruleBaseFor(tabId, { create: false });
  if (!base) {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [base + 4] }).catch(() => {});
}

/**
 * ビューアが PDF を取得する前に呼ばれる。
 * 元のページ遷移にリファラがあれば、同じリファラを付けて取得できるようにする。
 */
async function prepareFetch(tabId, url, refererHint) {
  let referer = null;
  const entry = lastMainFrame.get(tabId);
  if (entry && stripHash(entry.url) === stripHash(url)) {
    referer = entry.referer;
  }
  referer ||= refererHint || null;
  if (!referer || !/^https?:/i.test(url)) {
    await removeRefererRule(tabId);
    return { referer: null };
  }
  const host = new URL(url).hostname;
  const id = (await ruleBaseFor(tabId)) + 4;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [buildRefererRule(id, tabId, host, referer)],
  });
  return { referer };
}

// ---------------------------------------------------------------------------
// 6. 拡張アイコン・右クリックメニュー・初回案内
// ---------------------------------------------------------------------------

const PDF_LINK_PATTERNS = [
  "*://*/*.pdf",
  "*://*/*.pdf?*",
  "*://*/*.pdf#*",
  "*://*/*.PDF",
  "*://*/*.PDF?*",
  "file:///*.pdf",
  "file:///*.PDF",
];

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "seihon-open-link",
      title: "リンク先のPDFを製本ビューアで開く",
      contexts: ["link"],
      targetUrlPatterns: PDF_LINK_PATTERNS,
    });
    // Chrome 標準ビューアで PDF を表示しているタブでだけ見せる(下の updatePageMenu で切り替え)
    chrome.contextMenus.create({
      id: "seihon-open-page",
      title: "製本ビューアで開く",
      contexts: ["page", "frame"],
      visible: false,
    });
    chrome.contextMenus.create({
      id: "seihon-open-file",
      title: "PDFファイルを開く…",
      contexts: ["action"],
    });
    chrome.contextMenus.create({
      id: "seihon-welcome",
      title: "使い方と初期設定の確認",
      contexts: ["action"],
    });
  });
}

// ---- 「製本ビューアで開く」(ページの右クリック)を、PDF表示中のタブでだけ見せる ----------
// Chrome の右クリックメニューは表示の直前に中身を変えられないため、
// タブごとに「いま PDF を表示しているか」を記録し、タブの切り替え時に表示/非表示を切り替える。

async function getPdfTabs() {
  const { pdfTabs = {} } = await chrome.storage.session.get("pdfTabs");
  return pdfTabs;
}

let pdfTabsChain = Promise.resolve();
function setPdfTab(tabId, isPdf) {
  pdfTabsChain = pdfTabsChain
    .then(async () => {
      const pdfTabs = await getPdfTabs();
      if (!!pdfTabs[tabId] === isPdf) {
        return;
      }
      if (isPdf) {
        pdfTabs[tabId] = true;
      } else {
        delete pdfTabs[tabId];
      }
      await chrome.storage.session.set({ pdfTabs });
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active?.id === tabId) {
        await updatePageMenu(tabId);
      }
    })
    .catch(() => {});
}

async function updatePageMenu(tabId) {
  const pdfTabs = await getPdfTabs();
  chrome.contextMenus.update("seihon-open-page", { visible: !!pdfTabs[tabId] }, () => void chrome.runtime.lastError);
}

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId < 0 || (details.statusCode >= 300 && details.statusCode < 400)) {
      return;
    }
    const get = name => details.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value || "";
    const type = get("content-type").toLowerCase();
    const isPdf =
      /^(application\/(x-)?pdf|application\/acrobat|text\/(x-)?pdf)/.test(type) ||
      (/octet-stream|download|unknown|binary/.test(type) &&
        (looksLikePdfUrl(details.url) || /\.pdf\b/i.test(get("content-disposition"))));
    setPdfTab(details.tabId, isPdf);
  },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  ["responseHeaders"]
);

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0 || /^https?:/i.test(details.url)) {
    return; // http(s) は応答ヘッダーで判定済み
  }
  setPdfTab(details.tabId, /^file:/i.test(details.url) && looksLikePdfUrl(details.url));
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updatePageMenu(tabId);
});

/** タブで表示中のものが PDF かどうか(Chrome 標準ビューア表示中を含む) */
async function isPdfTab(tab) {
  const url = tab.url || "";
  if (!/^(https?|file):/i.test(url)) {
    return false;
  }
  if (looksLikePdfUrl(url)) {
    return true;
  }
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.contentType,
    });
    return res?.result === "application/pdf";
  } catch {
    return false;
  }
}

/** タブの PDF を製本ビューアで開く。PDF でなければ空のビューア(ファイルを開く画面)を新しいタブで開く */
async function openTabInViewer(tab) {
  if (!tab || tab.id === undefined) {
    return;
  }
  if (isViewerUrl(tab.url || "")) {
    return; // すでに製本ビューア
  }
  if (await isPdfTab(tab)) {
    await chrome.tabs.update(tab.id, { url: viewerUrlFor(tab.url) });
    return;
  }
  await chrome.tabs.create({ url: viewerBaseUrl(), index: tab.index + 1, openerTabId: tab.id });
}

chrome.action.onClicked.addListener(tab => {
  openTabInViewer(tab);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case "seihon-open-link":
      chrome.tabs.create({
        url: viewerUrlFor(info.linkUrl),
        index: tab ? tab.index + 1 : undefined,
        openerTabId: tab?.id,
      });
      break;
    case "seihon-open-page": {
      const url = info.frameUrl && looksLikePdfUrl(info.frameUrl) ? info.frameUrl : info.pageUrl;
      if (tab && url && (looksLikePdfUrl(url) || url === tab.url)) {
        openTabInViewer({ ...tab, url });
      }
      break;
    }
    case "seihon-open-file":
      chrome.tabs.create({ url: `${viewerBaseUrl()}?open=file` });
      break;
    case "seihon-welcome":
      chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") });
      break;
  }
});

chrome.runtime.onInstalled.addListener(details => {
  createContextMenus();
  applyAll(`onInstalled:${details.reason}`);
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html?first=1") });
  }
});

chrome.runtime.onStartup.addListener(() => {
  applyAll("onStartup");
});

onSettingsChanged(newSettings => {
  settingsPromise = Promise.resolve(newSettings);
  applyAll("settingsChanged");
});

// Service Worker の起動のたびに、このセッションでルールが登録済みか確認する
chrome.storage.session.get("rulesApplied").then(({ rulesApplied }) => {
  if (!rulesApplied) {
    applyAll("swStart");
  }
});

// ---------------------------------------------------------------------------
// 7. 強制ダウンロード対策 第3層
// ---------------------------------------------------------------------------
//
// 第1層・第2層をすり抜けて(blob: の URL、ページのスクリプトによる保存など)ダウンロードが終わったとき、
// それが PDF なら、保存されたファイルを製本ビューアで開く。元のファイルは設定に従って残す(既定)か削除する。
//
// 次のものは開かない(誤作動の防止):
//  - 拡張機能が保存したもの(製本ビューアのダウンロード・書き出しを含む)
//  - Alt+クリックなど、ユーザーが「保存したい」と操作したもの
//  - 開いているタブがそのまま表示している PDF の保存(Chrome 標準ビューアの保存ボタンなど)
//  - 強制ダウンロード対策がオフのとき、対策の対象外サイト、起動方式が「ボタンを押したときのみ」のとき
//  - PDF と判断できないもの

const PDF_MIME = /^(application\/(x-)?pdf|application\/acrobat|text\/(x-)?pdf)\b/i;
const OCTET_MIME = /^(application\/(octet-stream|x-download|force-download|download|unknown|binary|x-unknown)|binary\/octet-stream)?$/i;
/** PDF ではないことがはっきりしている拡張子(中身を確かめない) */
const NON_PDF_EXT =
  /\.(zip|7z|rar|gz|tgz|bz2|xz|exe|msi|dmg|pkg|deb|rpm|apk|iso|img|jpg|jpeg|png|gif|webp|bmp|tif|tiff|svg|heic|mp3|mp4|m4a|mov|avi|mkv|webm|wav|flac|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|txt|csv|json|xml|html|htm|epub|mobi|js|css|ttf|otf|woff2?)$/i;
const SNIFF_MAX_BYTES = 300 * 1024 * 1024;
const USER_DOWNLOAD_MEMORY_MS = 60 * 1000;

async function rememberUserDownload(url) {
  const { userDownloads = [] } = await chrome.storage.session.get("userDownloads");
  const now = Date.now();
  const list = userDownloads.filter(d => now - d.time < USER_DOWNLOAD_MEMORY_MS);
  list.push({ url: stripHash(url), time: now });
  await chrome.storage.session.set({ userDownloads: list.slice(-50) });
}

async function isUserDownload(urls) {
  const { userDownloads = [] } = await chrome.storage.session.get("userDownloads");
  const now = Date.now();
  const wanted = new Set(urls.filter(Boolean).map(stripHash));
  return userDownloads.some(d => now - d.time < USER_DOWNLOAD_MEMORY_MS && wanted.has(d.url));
}

/** すでに処理したダウンロードか(Service Worker が止まって再開しても二重に開かない) */
async function markDownloadHandled(id) {
  const { handledDownloads = [] } = await chrome.storage.session.get("handledDownloads");
  if (handledDownloads.includes(id)) {
    return false;
  }
  handledDownloads.push(id);
  await chrome.storage.session.set({ handledDownloads: handledDownloads.slice(-300) });
  return true;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isHostListed(host, sites) {
  return !!host && sites.some(site => host === site || host.endsWith(`.${site}`));
}

/** 拡張機能(Chrome 標準 PDF ビューアを含む)の中で作られたデータか */
function isExtensionOrigin(url) {
  return /^(blob:|filesystem:)?chrome-extension:/i.test(url || "");
}

/** いずれかのタブが、この URL をそのまま表示しているか(表示中の PDF の保存ボタンによる保存) */
async function isShownInSomeTab(urls) {
  const wanted = new Set(urls.filter(u => /^https?:|^file:/i.test(u || "")).map(stripHash));
  if (!wanted.size) {
    return false;
  }
  const tabs = await chrome.tabs.query({});
  return tabs.some(t => t.url && wanted.has(stripHash(t.url)));
}

let sniffChain = Promise.resolve();
/** 保存されたファイルの先頭を読み、PDF かどうかを確かめる(画面の無い補助ページで読む) */
function sniffIsPdf(fileUrl) {
  const task = sniffChain.then(async () => {
    if (!chrome.offscreen || !(await isFileAccessAllowed())) {
      return false;
    }
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: "offscreen/sniff.html",
        reasons: ["BLOBS"],
        justification: "ダウンロードされたファイルが PDF かどうかを、ファイルの先頭を読んで確かめるため",
      });
    }
    try {
      const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "sniff-file", url: fileUrl });
      return !!res?.isPdf;
    } finally {
      chrome.offscreen.closeDocument().catch(() => {});
    }
  });
  sniffChain = task.catch(() => {});
  return task;
}

/** ダウンロードされたものが PDF か */
async function isPdfDownload(item) {
  const name = item.filename || "";
  if (PDF_MIME.test(item.mime || "") || /\.pdf$/i.test(name)) {
    return true;
  }
  // 種類が「不明」で、拡張子からも判断できないものだけ、中身を確かめる
  const hasKnownOtherExt = NON_PDF_EXT.test(name);
  const size = item.fileSize > 0 ? item.fileSize : item.totalBytes;
  if (OCTET_MIME.test(item.mime || "") && !hasKnownOtherExt && size > 0 && size <= SNIFF_MAX_BYTES) {
    try {
      return await sniffIsPdf(fileUrlFromPath(name));
    } catch (e) {
      console.warn(LOG, "ファイルの中身を確かめられませんでした", e);
    }
  }
  return false;
}

async function handleCompletedDownload(id) {
  const [item] = await chrome.downloads.search({ id });
  if (!item || item.state !== "complete" || !item.exists || !item.filename) {
    return;
  }
  const settings = await getSettings();
  if (!settings.guardEnabled || settings.launchMode !== "auto") {
    return;
  }
  if (item.byExtensionId) {
    return; // 拡張機能(この拡張を含む)が保存したもの
  }
  const urls = [item.url, item.finalUrl];
  if (urls.some(isExtensionOrigin)) {
    return; // 製本ビューア・Chrome 標準ビューアの中で作られたデータ(ダウンロードボタンなど)
  }
  const host = hostOf(item.finalUrl || item.url) || hostOf(item.referrer);
  if (isHostListed(host, settings.guardExcludeSites) || isHostListed(hostOf(item.referrer), settings.guardExcludeSites)) {
    return;
  }
  if (await isUserDownload(urls)) {
    return; // Alt+クリックなど、ユーザーが保存を選んだもの
  }
  if (await isShownInSomeTab(urls)) {
    return; // 表示中の PDF の保存
  }
  if (!(await isPdfDownload(item))) {
    return;
  }
  if (!(await markDownloadHandled(id))) {
    return;
  }
  const fileUrl = fileUrlFromPath(item.filename);
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  console.info(LOG, "ダウンロードされた PDF をビューアで開きます(第3層)", item.filename);
  await chrome.tabs.create({
    url: viewerUrlFor(fileUrl, { downloadId: id }),
    active: true,
    ...(active ? { index: active.index + 1, windowId: active.windowId, openerTabId: active.id } : {}),
  });
}

chrome.downloads.onChanged.addListener(delta => {
  if (delta.state?.current === "complete") {
    handleCompletedDownload(delta.id).catch(e => console.error(LOG, "第3層の処理に失敗", e));
  }
});

// 動作確認用(拡張機能の Service Worker の DevTools から呼べる。外部からは呼べない)
globalThis.seihonDebug = { applyAll, openTabInViewer, isPdfTab, getSettings, handleCompletedDownload };

// ---------------------------------------------------------------------------
// メッセージ(ビューア・詳細設定画面から)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const tabId = sender.tab?.id;
  switch (message.type) {
    case "open-native":
      if (tabId === undefined || typeof message.url !== "string") {
        sendResponse({ ok: false });
        return undefined;
      }
      openNative(tabId, message.url).then(
        () => sendResponse({ ok: true }),
        e => sendResponse({ ok: false, error: String(e) })
      );
      return true;
    case "prepare-fetch":
      if (tabId === undefined || typeof message.url !== "string") {
        sendResponse({ referer: null });
        return undefined;
      }
      prepareFetch(tabId, message.url, message.referer).then(sendResponse, () =>
        sendResponse({ referer: null })
      );
      return true;
    case "user-download":
      // Alt+クリックなど、ユーザーが保存を選んだリンク(第3層で開かない)
      if (typeof message.url === "string") {
        rememberUserDownload(message.url).then(() => sendResponse({ ok: true }));
        return true;
      }
      return undefined;
    case "auto-exclude-site":
      // 使い捨て URL などで開けなかったときに、そのサイトを自動切り替えの対象外にする
      if (typeof message.host === "string" && message.host) {
        getSettings()
          .then(settings =>
            saveSettings({ autoExcludeSites: [...new Set([...settings.autoExcludeSites, message.host])] })
          )
          .then(() => applyAll("auto-exclude-site"))
          .then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: String(e) }));
        return true;
      }
      return undefined;
    case "reapply-rules":
      applyAll("request").then(() => sendResponse({ ok: true }));
      return true;
    case "get-status":
      Promise.all([
        isFileAccessAllowed(),
        chrome.storage.session.get("headerConditionSupported"),
        chrome.declarativeNetRequest.getDynamicRules(),
      ]).then(([fileAccess, { headerConditionSupported }, rules]) =>
        sendResponse({
          fileAccess,
          headerConditionSupported: headerConditionSupported !== false,
          ruleCount: rules.length,
          version: chrome.runtime.getManifest().version,
          defaults: DEFAULT_SETTINGS,
        })
      );
      return true;
  }
  return undefined;
});
