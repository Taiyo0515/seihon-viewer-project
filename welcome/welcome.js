/**
 * 初回案内画面: ファイルアクセスの許可と Chrome の PDF 設定の確認を促す。
 */

import { loadSettings } from "../common/settings.js";
import { viewerUrlFor } from "../common/viewer-url.js";
import { applyThemePreference } from "../viewer/theme.js";

const $ = id => document.getElementById(id);

function setCheck(li, ok, text) {
  const mark = li.querySelector(".mark");
  mark.textContent = ok ? "✓" : "!";
  mark.className = `mark ${ok ? "ok" : "warn"}`;
  li.querySelector(".detail").textContent = text;
}

async function check() {
  const settings = await loadSettings();
  applyThemePreference(settings.theme);

  // Chrome のバージョン(応答ヘッダーを条件にした通信の書き換えは Chrome 128 以降)
  const m = navigator.userAgent.match(/Chrome\/(\d+)/);
  const version = m ? Number(m[1]) : 0;
  let supported = version >= 128;
  try {
    const status = await chrome.runtime.sendMessage({ type: "get-status" });
    if (status) {
      supported = status.headerConditionSupported;
    }
  } catch {}
  setCheck(
    $("checkChrome"),
    supported,
    supported
      ? `Chrome ${version || ""} で動作します。PDFを開くと自動で製本ビューアに切り替わります。`
      : `Chrome ${version || "(不明)"} は古いため、自動切り替えが使えません。Chrome を最新版に更新してください(128 以降が必要)。`
  );

  // ファイルアクセス
  const fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
  const li = $("checkFile");
  setCheck(
    li,
    fileAccess,
    fileAccess
      ? "許可されています。パソコン内のPDFも製本ビューアで開きます。"
      : "まだ許可されていません。パソコン内のPDFを製本ビューアで開くには、次の手順で許可してください(Webサイト上のPDFだけ使う場合は不要です)。"
  );
  li.querySelector(".steps").hidden = fileAccess;
  li.querySelector(".buttons").hidden = fileAccess;
}

$("openExtSettings").addEventListener("click", () => {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});
$("openPdfSettings").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/content/pdfDocuments" });
});
$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("openSample").href = viewerUrlFor(chrome.runtime.getURL("samples/sample-book.pdf"));

check();
