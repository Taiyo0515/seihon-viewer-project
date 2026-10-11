/**
 * ビューアの起動準備。PDF.js 本体(viewer.mjs)より先に実行される。
 *
 * 速度のため、ここでは「待たずに始められること」だけを先に始めておく。
 *  - URL の整理(?src= の正規化)
 *  - テーマの即時適用(画面のちらつき防止)
 *  - PDF.js の Worker(PDF解析用の別スレッド)を先に起動
 *  - 設定の読み込み・リファラ準備・ファイルアクセス確認を非同期で開始
 *  - PDF.js の各種オプションの設定(webviewerloaded イベント)
 */

import { loadSettings } from "../common/settings.js";
import { parseViewerExtras, parseViewerSrc } from "../common/viewer-url.js";
import { applyThemePreference, readCachedThemePreference } from "./theme.js";

const bootStart = performance.now();

/** 起動中の情報を main.js に渡すための入れ物 */
const state = (window.__seihon = {
  bootStart,
  marks: [["ビューア起動", bootStart]],
  src: null,
  /** 強制ダウンロード対策(第3層)で開いたときの、元のダウンロードのID */
  downloadId: null,
  wantsFilePicker: false,
  settingsPromise: null,
  preparePromise: null,
  fileAccessPromise: null,
});

// ---- URL の整理 ------------------------------------------------------------
{
  const src = parseViewerSrc(location.search);
  if (src) {
    state.src = src;
    state.downloadId = parseViewerExtras(location.search).downloadId;
    const extra = state.downloadId !== null ? `&dl=${state.downloadId}` : "";
    const normalized = `?src=${encodeURIComponent(src)}${extra}`;
    if (location.search !== normalized) {
      history.replaceState(history.state, "", `${location.pathname}${normalized}${location.hash}`);
    }
  } else if (location.search) {
    const params = new URLSearchParams(location.search);
    state.wantsFilePicker = params.get("open") === "file";
    // PDF.js が別の引数(file= など)を読まないよう、不要な引数は消しておく
    history.replaceState(history.state, "", `${location.pathname}${location.hash}`);
  }
}

// ---- テーマ(前回の設定を即時適用。正式な設定は main.js で反映) ---------------
applyThemePreference(readCachedThemePreference());

// ---- 非同期の準備を先に始める ----------------------------------------------
state.settingsPromise = loadSettings();
if (state.src && /^https?:/i.test(state.src)) {
  // 再読み込み時は、最初に開いたときのリファラ(このタブの sessionStorage に控えたもの)を使う
  let savedReferer = null;
  try {
    savedReferer = sessionStorage.getItem(`seihon.referer:${state.src}`);
  } catch {}
  state.preparePromise = chrome.runtime
    .sendMessage({ type: "prepare-fetch", url: state.src, referer: savedReferer })
    .catch(() => null);
} else if (state.src && /^file:/i.test(state.src)) {
  state.fileAccessPromise = chrome.extension.isAllowedFileSchemeAccess().catch(() => false);
}

// ---- PDF.js の Worker を先に起動しておく(本体の読み込みと並行して準備させる) ----
const workerUrl = chrome.runtime.getURL("pdfjs/build/pdf.worker.mjs");
let workerPort = null;
try {
  workerPort = new Worker(workerUrl, { type: "module" });
} catch (e) {
  console.warn("[製本ビューア] Worker の先行起動に失敗しました。通常の方法で起動します。", e);
}

// ---- PDF.js のオプション ---------------------------------------------------
document.addEventListener(
  "webviewerloaded",
  () => {
    const url = path => chrome.runtime.getURL(path);
    const options = window.PDFViewerApplicationOptions;
    options.setAll({
      // 設定は拡張側で管理する(PDF.js 独自の保存先は使わない)
      disablePreferences: true,
      defaultUrl: "",
      localeProperties: { lang: "ja" },
      // 同梱ファイルの場所
      workerSrc: workerUrl,
      ...(workerPort ? { workerPort } : {}),
      cMapUrl: url("pdfjs/web/cmaps/"),
      standardFontDataUrl: url("pdfjs/web/standard_fonts/"),
      wasmUrl: url("pdfjs/web/wasm/"),
      iccUrl: url("pdfjs/web/iccs/"),
      imageResourcesPath: url("pdfjs/web/images/"),
      sandboxBundleSrc: "",
      // 安全・速度のため使わない機能
      enableScripting: false, // PDF内のJavaScriptは実行しない
      enableWebGPU: false, // GPUの初期化待ちで最初の表示が遅れるのを避ける
      enableAltText: false,
      enableGuessAltText: false,
      enableAltTextModelDownload: false, // 外部からのAIモデル取得をしない
      enableNewAltTextWhenAddingImage: false,
      enableSignatureEditor: false,
      enableComment: false,
      enableHighlightFloatingButton: false,
      enableSplitMerge: true,
      enableMerge: false,
      historyUpdateUrl: false,
      supportsIntegratedFind: false,
      // 前回の位置を復元するときも、倍率は毎回「自動」から始める(Chrome 標準に近い動き)
      defaultZoomValue: "auto",
      // サイドバーは閉じた状態で開く(サムネイルの準備で最初のページの表示を遅らせない)
      sidebarViewOnLoad: 0,
      // リンクは Chrome 標準ビューアと同じく同じタブで開く(Ctrl+クリックで新しいタブ)
      externalLinkTarget: 0,
      // 蛍光ペンの色(Chrome の注釈に近い淡い色)
      highlightEditorColors:
        "yellow=#FFF176,green=#A5E5B0,blue=#9CCBF7,pink=#F8BBD9,red=#F4A6A6," +
        "yellow_HCM=#FFFFCC,green_HCM=#53FFBC,blue_HCM=#80EBFF,pink_HCM=#F6B8FF,red_HCM=#C50043",
    });
    state.marks.push(["PDF.js 読み込み完了", performance.now()]);
  },
  { once: true }
);
