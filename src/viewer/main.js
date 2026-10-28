/**
 * 製本ビューア: ビューア画面の組み立て(PDF.js の初期化後に実行)。
 *
 * PDF.js 公式ビューア(PDFViewerApplication)はそのまま動かし、
 * ツールバー・メニュー・製本表示などの独自部分をここで結び付ける。
 */

import { sanitizeFileName, saveBlobAs, setSaveGestureAsker } from "../common/files.js";
import { onSettingsChanged, saveSettings } from "../common/settings.js";
import { matchesShortcut } from "../common/shortcut.js";
import { viewerUrlFor } from "../common/viewer-url.js";
import { BookLayout, VIEW_MODES } from "./book-layout.js";
import { Collection } from "./collection.js";
import { DocSource, decryptedCopy } from "./doc-source.js";
import { PageCopy } from "./page-copy.js";
import { PageEditor } from "./page-edit.js";
import { canPrintWithChrome, printWithChrome, removePrintFrame, withTitle } from "./print-native.js";
import { isRearranged, viewPageCount } from "./page-map.js";
import { PageRoles, applyRoleItems } from "./roles.js";
import { hydrateIcons, setIcon } from "./icons.js";
import { PerfLog } from "./perf.js";
import { RenderBudget } from "./render-budget.js";
import { applyThemePreference } from "./theme.js";
import { AnnotationTools } from "./ui/annotate.js";
import { BookbindingDialog } from "./ui/bookbinding-dialog.js";
import { CollectPanel } from "./ui/collect-panel.js";
import { ViewerContextMenu } from "./ui/context-menu.js";
import { EmptyState, ErrorPanel, Toast, setupDropZone } from "./ui/panels.js";
import { PopupMenu } from "./ui/popup.js";
import { RolesPanel } from "./ui/roles-panel.js";
import { RotateButton } from "./ui/rotate-menu.js";
import { ScanArranger } from "./scan/scan-arranger.js";
import { EbookRouter } from "./ebook/ebook-router.js";
import { ScanLogView } from "./scan/scan-log-view.js";
import { PdfConvertDialog } from "./ui/convert-dialog.js";
import { OPEN_ACCEPT } from "../common/ebook-formats.js";
import { getHandoff } from "../common/handoff.js";
import { ScanChip, ScanDialog } from "./ui/scan-ui.js";
import { SidebarTabs } from "./ui/sidebar.js";
import { SourceMenu } from "./ui/source-menu.js";
import { ThumbSelection } from "./ui/thumb-select.js";
import { Toolbar } from "./ui/toolbar.js";

const boot = window.__seihon;
const app = window.PDFViewerApplication;

hydrateIcons(document);

await app.initializedPromise;
boot.marks.push(["PDF.js 初期化完了", performance.now()]);

let settings = await boot.settingsPromise;
// 0.5: ページ役割の項目(詳細設定で追加・削除・非表示にしたもの)を、役割を読み込む前に反映する
applyRoleItems(settings.bindRoleItems);
applyThemePreference(settings.theme);

// ページを削除した後も「最後のページ」(End キーなど)が正しく動くよう、
// ページ数は表示しているページの数にする(PDF.js の初期の定義は元の PDF のページ数)
Object.defineProperty(app, "pagesCount", {
  configurable: true,
  get() {
    return viewPageCount(this.pdfDocument);
  },
});

// ---------------------------------------------------------------------------
// 部品の用意
// ---------------------------------------------------------------------------
const toast = new Toast();
// 0.4.2: 保存する内容を作るのに時間がかかり、保存先を選ぶ画面をすぐに出せないときは、ボタンを押してもらう
setSaveGestureAsker(
  fileName =>
    new Promise(resolve => {
      let settled = false;
      const done = v => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      toast.show(`保存の準備ができました(${fileName})`, {
        duration: 0,
        actions: [
          { label: "保存先を選ぶ", onClick: () => done(true) },
          { label: "やめる", onClick: () => done(false) },
        ],
      });
    })
);
const toolbar = new Toolbar(app);
const sidebarTabs = new SidebarTabs(app);
const annotations = new AnnotationTools(app, toast);
const book = new BookLayout(app);
const rotateButton = new RotateButton({ app, getSettings: () => settings, saveSettings, toast });
const perf = new PerfLog(app, boot);
const budget = new RenderBudget(app);
const errorPanel = new ErrorPanel();
const emptyState = new EmptyState({ onOpenFile: () => openFilePicker() });
perf.setEnabled(settings.perfLog);
book.setDirection(settings.bindingDirection, { silent: true });

/** いま表示している文書の出どころ */
let current = { kind: null, url: null, name: null };

// ---- フェーズ2: コピー(0.1 までの「AI用コピー」)・ページ収集 ----
const getSettings = () => settings;
const docSource = new DocSource(app, { getCurrent: () => current, getSettings });
const pageCopy = new PageCopy({ app, toast, docSource, getSettings });
let collectPanel = null;
const collection = new Collection({
  app,
  docSource,
  pageCopy,
  toast,
  getSettings,
  onShowPanel: () => collectPanel?.open(),
});
// ---- フェーズ3: ページ役割・製本用PDF出力 ----
const pageRoles = new PageRoles({ app, docSource, toast });
// ---- 0.1: ページの削除と保存 ----
const pageEditor = new PageEditor({ app, toast, docSource, roles: pageRoles });
// ---- 0.3: スキャンの整え(見開きの分割・余白の除去・冊子の並べ替え) ----
const scanArranger = new ScanArranger({
  app,
  toast,
  docSource,
  pageEditor,
  getSettings,
  getCurrent: () => current,
  getDirection: () => book.direction,
  openDocument: args => app.open(args),
  book,
});
const scanDialog = new ScanDialog({ arranger: scanArranger });
scanArranger.openDialog = () => scanDialog.open();
// 0.8.2: スキャンの整えの処理の様子(開発者向け。詳細設定の「スキャンの処理の表示」で出す)
const scanLogView = new ScanLogView({ arranger: scanArranger, getSettings });
new ScanChip({ arranger: scanArranger, dialog: scanDialog, toolbar });
// ---- 0.4: 電子書籍・コミック(EPUB・MOBI・AZW・AZW3・CBZ・CBR)と、PDF からの変換 ----
const ebookRouter = new EbookRouter({
  app,
  toast,
  errorPanel,
  toolbar,
  book,
  emptyState,
  getSettings,
  getCurrent: () => current,
  openDocument: args => app.open(args),
  openFilePicker: () => openFilePicker(),
});
const convertDialog = new PdfConvertDialog({ app, toast, docSource, getCurrent: () => current, getDirection: () => book.direction, pageEditor });
let rolesPanel = null;
let bindDialog = null;

// 右側のパネル(注釈・収集・ページ役割)は1つずつ開く
collectPanel = new CollectPanel({
  app,
  collection,
  docSource,
  toast,
  getSettings,
  onToggle: open => {
    if (open) {
      annotations.setTool(null);
      rolesPanel?.close();
    }
  },
});
rolesPanel = new RolesPanel({
  app,
  roles: pageRoles,
  onToggle: open => {
    if (open) {
      annotations.setTool(null);
      collectPanel.close();
    }
  },
  onOpenBookbinding: () => bindDialog.open(),
});
{
  const setTool = annotations.setTool.bind(annotations);
  annotations.setTool = tool => {
    if (tool) {
      collectPanel.close();
      rolesPanel.close();
    }
    return setTool(tool);
  };
}
bindDialog = new BookbindingDialog({
  app,
  roles: pageRoles,
  docSource,
  toast,
  getSettings,
  saveSettings,
  getDirection: () => book.direction,
  onOpenRoles: () => rolesPanel.open(),
});
document.getElementById("shBindOutput").addEventListener("click", () => bindDialog.open());
let contextMenu = null;
const thumbSelection = new ThumbSelection(app, {
  onCopy: pages => pageCopy.copyPages(pages),
  onCollect: pages => collection.addCurrentPages(pages),
  onDelete: pages => pageEditor.deletePages(pages),
  onRoles: (pages, anchor) => contextMenu?.openRoleMenuAt(pages, anchor),
  editor: pageEditor,
});
contextMenu = new ViewerContextMenu({
  app,
  pageCopy,
  collection,
  collectPanel,
  thumbSelection,
  docSource,
  roles: pageRoles,
  rolesPanel,
  pageEditor,
  getSettings,
});

// 元のリンク・ファイルの場所のコピー(タイトルの右のボタン)
const sourceButton = document.getElementById("shSource");
const sourceMenu = new SourceMenu({
  app,
  button: sourceButton,
  getCurrent: () => current,
  getDownloadId: () => boot.downloadId,
  toast,
});

// 「ページに合わせる」は、いちばん大きく見えているページを真ん中にして合わせる
toolbar.onFitPage = () => book.fitPageCentered();

/**
 * PDF.js は文書ごとに前回の表示状態(ページ・倍率・回転など)を localStorage に記録し、
 * 次に開いたとき復元する。製本ビューアでは「前回見ていたページ」だけを復元し、
 * 回転は復元しない(開いたら回っていた、という戸惑いを避ける)。
 */
function sanitizeViewHistory() {
  try {
    const raw = localStorage.getItem("pdfjs.history");
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw);
    let changed = false;
    for (const file of data?.files || []) {
      if (file.rotation) {
        file.rotation = 0;
        changed = true;
      }
    }
    if (changed) {
      localStorage.setItem("pdfjs.history", JSON.stringify(data));
    }
  } catch {
    // 記録が壊れていても表示には影響しない
  }
}

// タイトル表示を PDF.js のタイトル更新に合わせる
// タブの名前の先頭の「* 」は、保存していない変更があるしるし(PDF.js は書き込みのときだけ付けるので、ここで決める)
{
  const originalSetTitle = app.setTitle.bind(app);
  app.setTitle = (...args) => {
    originalSetTitle(...args);
    // 0.4.2: 名前を付け直していれば、タブの名前もそれにする
    const title = pageEditor.title ?? document.title.replace(/^\* /, "");
    document.title = pageEditor.dirty ? `* ${title}` : title;
    toolbar.updateTitle();
  };
}

// ---------------------------------------------------------------------------
// 文書を開く(PDF.js の open をくるんで、画面の状態を管理する)
// ---------------------------------------------------------------------------
{
  const originalOpen = app.open.bind(app);
  // ---- 読み込み中の状況表示(0.6.6: 出所・進捗・速度) ----------------
  // file:// は Chrome が総サイズを教えないので、こちらで先に読んで PDF.js に渡す。
  // インターネットの文書は PDF.js の進捗(%)を借りて見せる。
  let netAllowed = false;
  let netToken = 0;
  let localBlobUrl = null;
  const shLoadRoot = document.getElementById("shLoadStatus");
  const shLoadBar = shLoadRoot?.querySelector("#shLoadBar");
  const shLoadFill = shLoadBar?.firstElementChild;
  const shLoadText = shLoadRoot?.querySelector("#shLoadText");
  let shLoadToken = 0;
  let shLoadXhr = null;
  /** この時間より長くかかりそうな読みだけ、状況を見せる(すぐ終わる読みで何度も出てうるさくしないため)(0.6.6) */
  const SH_LOAD_REVEAL_MS = 900;
  let shLoadRevealed = false;
  let shLoadShowTimer = null;
  const shFmtMB = bytes => `${(bytes / 1048576).toFixed(1)}MB`;

  function shLoadBegin(kind) {
    if (!shLoadRoot) {
      return 0;
    }
    const token = ++shLoadToken;
    shLoadXhr?.abort?.();
    shLoadXhr = null;
    shLoadRevealed = false;
    clearTimeout(shLoadShowTimer);
    shLoadRoot.hidden = true;
    shLoadRoot.classList.remove("sh-nobar");
    shLoadBar?.classList.remove("sh-indeterminate", "sh-stall");
    if (shLoadFill) {
      shLoadFill.style.width = "0";
    }
    // しばらくかかるようなら、ここで初めて出す
    shLoadShowTimer = setTimeout(() => {
      if (token !== shLoadToken) {
        return;
      }
      shLoadRevealed = true;
      shLoadRoot.hidden = false;
      if (shLoadText) {
        shLoadText.textContent = kind === "net" ? "インターネットから取得中…" : "ローカルのファイルを取り込み中…";
      }
    }, SH_LOAD_REVEAL_MS);
    return token;
  }

  function shLoadUpdate(token, { percent = null, indeterminate = false, stall = false, text = null }) {
    if (!shLoadRoot || token !== shLoadToken || !shLoadRevealed) {
      return;
    }
    const hasPercent = percent !== null && !indeterminate;
    shLoadRoot.classList.toggle("sh-nobar", hasPercent);
    shLoadBar?.classList.toggle("sh-indeterminate", indeterminate);
    shLoadBar?.classList.toggle("sh-stall", stall);
    if (shLoadFill) {
      if (hasPercent) {
        shLoadFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      } else if (indeterminate) {
        // 流れる帯の幅はスタイルシートの側で決める。インラインの幅が残っていると 0 幅のまま動かない(0.6.8 で修正)
        shLoadFill.style.width = "";
      }
    }
    if (text !== null && shLoadText) {
      shLoadText.textContent = text;
    }
  }

  function shLoadEnd() {
    shLoadToken++;
    shLoadRevealed = false;
    clearTimeout(shLoadShowTimer);
    if (shLoadRoot) {
      shLoadRoot.hidden = true;
      shLoadRoot.classList.remove("sh-nobar");
      shLoadBar?.classList.remove("sh-indeterminate", "sh-stall");
    }
  }

  /**
   * file:// をこちらで読む(0.6.6)。CSV のプレースホルダのように取り込みが遅い箱でも、
   * 読めたバイト数と速度を出し続ける。読めたら配列バッファで返す
   */
  function shReadFileUrl(url, token) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url);
      xhr.responseType = "arraybuffer";
      shLoadXhr = xhr;
      const started = performance.now();
      let paintedAt = 0;
      let stallShown = false;
      let lastLoaded = 0;
      let lastProgressAt = started;
      const paint = () => {
        if (token !== shLoadToken) {
          return;
        }
        const now = performance.now();
        const seconds = (now - started) / 1000;
        const speed =
          seconds > 0.5 && lastLoaded > 524288 ? ` ≈${(lastLoaded / seconds / 1048576).toFixed(1)}MB/s` : "";
        const stall = now - lastProgressAt > 2500;
        let text = `ローカルのファイルを取り込み中 ${shFmtMB(lastLoaded)}${speed}`;
        if (stall) {
          text += " (取り込み待ち…)";
        }
        if (stall !== stallShown || now - paintedAt > 180) {
          stallShown = stall;
          paintedAt = now;
          shLoadUpdate(token, { indeterminate: true, stall, text });
        }
      };
      paint();
      const timer = setInterval(() => {
        if (token !== shLoadToken) {
          clearInterval(timer);
          return;
        }
        paint();
      }, 300);
      xhr.onprogress = evt => {
        lastLoaded = evt.loaded || 0;
        lastProgressAt = performance.now();
      };
      const finish = () => {
        clearInterval(timer);
        if (shLoadXhr === xhr) {
          shLoadXhr = null;
        }
      };
      xhr.onload = () => {
        finish();
        if (token !== shLoadToken) {
          reject(new Error("読み込んでいる間に別の文書が開かれました"));
          return;
        }
        resolve(xhr.response);
      };
      xhr.onerror = () => {
        finish();
        reject(new Error("読み込めませんでした"));
      };
      xhr.onabort = () => {
        finish();
        reject(new Error("読み込みを中止しました"));
      };
      xhr.send();
    });
  }

  // PDF.js が出す進捗(総サイズが分かる文書)を借りて、インターネットの文書の % を見せる
  if (typeof app.progress === "function") {
    const originalProgress = app.progress.bind(app);
    app.progress = percent => {
      originalProgress(percent);
      if (netAllowed && shLoadRoot) {
        if (!netToken) {
          netToken = shLoadBegin("net");
        }
        if (Number.isFinite(percent)) {
          shLoadUpdate(netToken, { percent, text: `インターネットから取得中 ${Math.round(percent)}%` });
        } else {
          shLoadUpdate(netToken, { indeterminate: true, text: "インターネットから取得中…" });
        }
      }
    };
  }
  // 開き終わったら状況表示は消す(「完了」は出さない)
  app.eventBus.on("documentloaded", () => {
    netAllowed = false;
    netToken = 0;
    shLoadEnd();
  });

  app.open = async args => {
    // 製本ビューアが自分で開く文書(0.3: 整えたスキャンの PDF・元のスキャンに戻すとき)。出どころは元の文書のものを引き継ぐ
    const special = args?.seihon || null;
    if (special) {
      delete args.seihon;
    }
    netAllowed = false;
    netToken = 0;
    localBlobUrl = null;    // 編集して保存していない PDF を閉じる前に確かめる(自分で開くときは、呼ぶ側で確かめている)
    if (app.pdfDocument && !special && !(await pageEditor.guard("別の PDF を開く"))) {
      return false;
    }
    if (!special) {
      scanArranger.beforeUserOpen();
      // 0.4: 電子書籍・コミックなら、それに合った方法で開く(PDF なら null が返り、このまま PDF.js で開く)
      const handled = await ebookRouter.intercept(args);
      if (handled !== null) {
        return handled;
      }
      const openUrl = typeof args?.url === "string" ? args.url : "";
      if (openUrl.startsWith("file:")) {
        // 0.6.6: file:// は Chrome が総サイズを教えないので、いったんこちらで読んで進捗(MB・速度)を
        // 見せてから、blob に替えて PDF.js に渡す(ファイルの読みは1回)
        const token = shLoadBegin("local");
        let proceed = true;
        try {
          const bytes = await shReadFileUrl(openUrl, token);
          const blob = new Blob([bytes], { type: "application/pdf" });
          localBlobUrl = URL.createObjectURL(blob);
          let path = openUrl.startsWith("file:///") ? openUrl.slice("file:///".length) : openUrl;
          try {
            path = decodeURIComponent(path.split(/[?#]/, 1)[0]);
          } catch {}
          args = { ...args, url: localBlobUrl, originalUrl: encodeURIComponent(path), __seihonLocal: openUrl };
        } catch {
          if (token !== shLoadToken) {
            // 読み込んでいる間に別の文書が開かれた。この読みは捨てる
            proceed = false;
          }
          // それ以外の失敗(アクセス許可が無い等)は、替えずにこれまでどおり PDF.js に開かせる
        } finally {
          shLoadEnd();
        }
        if (!proceed) {
          return false;
        }
      } else if (/^https?:/i.test(openUrl)) {
        netAllowed = true;
        netToken = 0;
      }
    }
    // いまの文書は閉じるので、編集の状態(「保存」ボタンなど)も消す
    pageEditor.resetFor(null);
    errorPanel.hide();
    emptyState.hide();
    toolbar.setLoading(true);
    docSource.resetForOpen();
    if (special?.key) {
      docSource.presetNextKey(special.key);
    }
    thumbSelection.clear();
    annotations.reset();
    sidebarTabs.reset();
    budget.reset();
    if (special) {
      current = { ...special.current };
      delete current.arranged;
      if (special.arranged) {
        current.arranged = special.arranged;
      }
    } else if (args.__seihonLocal) {
      // 0.6.6: こちらで先に読んだローカルの PDF。出どころは file:// のままにして、
      // これまでどおりの表示・メニュー(Chrome標準で開く、file:// のリンクをコピー など)にする
      const localUrl = String(args.__seihonLocal);
      let localName = "";
      try {
        localName = decodeURIComponent(args.originalUrl || "");
      } catch {
        localName = String(args.originalUrl || "");
      }
      delete args.__seihonLocal;
      current = { kind: "url", url: localUrl, name: localName };
    } else if (args.url && String(args.url).startsWith("blob:")) {
      let name = args.originalUrl || "";
      try {
        name = decodeURIComponent(name);
      } catch {}
      current = { kind: "file", url: args.url, name };
    } else if (args.url) {
      current = { kind: "url", url: String(args.url), name: null };
    } else {
      current = { kind: "data", url: null, name: args.filename || null };
    }
    perf.startDocument(current.name || current.url || "");
    sourceMenu.update();
    sanitizeViewHistory();
    book.applyInitialOptions(book.mode || settings.initialView, book.direction);
    try {
      await originalOpen(args);
      if (localBlobUrl) {
        // こちらで読んだローカルの PDF の仮の URL は、PDF.js に渡ったらもう要らない
        const oldBlobUrl = localBlobUrl;
        localBlobUrl = null;
        setTimeout(() => URL.revokeObjectURL(oldBlobUrl), 600);
      }
      return true;
    } catch (reason) {
      shLoadEnd();
      netAllowed = false;
      if (localBlobUrl) {
        const oldBlobUrl = localBlobUrl;
        localBlobUrl = null;
        setTimeout(() => URL.revokeObjectURL(oldBlobUrl), 600);
      }
      // 0.4: PDF ではなかったとき、中身が電子書籍・コミックならそちらで開く(拡張子の無いダウンロードの URL など)
      if (!special && reason?.name === "InvalidPDFException" && typeof args.url === "string") {
        const handled = await ebookRouter.retryAsEbook(args.url, args.originalUrl).catch(() => null);
        if (handled !== null) {
          return handled;
        }
      }
      showLoadError(reason);
      return false;
    }
  };
}

function openFilePicker() {
  app.eventBus.dispatch("openfile", { source: window });
}

// 0.4: ファイルを選ぶ画面で、PDF と電子書籍・コミックを選べるようにする
if (app._openFileInput) {
  app._openFileInput.accept = OPEN_ACCEPT;
}

/** コミックなどから作った PDF を保存する */
async function saveConvertedPdf() {
  const data = await app.pdfDocument.getData();
  const res = await saveBlobAs(new Blob([data], { type: "application/pdf" }), current.converted.fileName);
  if (res.ok) {
    toast.show("PDF を保存しました");
  } else if (!res.canceled) {
    toast.show(`保存できませんでした(${res.error || "不明なエラー"})`, { kind: "error" });
  }
}

/** 起動時に開く文書 */
async function openInitial() {
  const src = boot.src;
  // 前回の表示位置から開くか(PDF.js の「viewOnLoad」: 0=前回の位置 / 1=最初のページ)
  window.PDFViewerApplicationOptions.set("viewOnLoad", settings.restorePosition ? 0 : 1);
  book.applyInitialOptions(settings.initialView, settings.bindingDirection);
  if (!src && boot.handoff) {
    // 0.4: 電子書籍リーダーの画面から渡された PDF・コミック
    const item = await getHandoff(boot.handoff).catch(() => null);
    if (item?.blob) {
      await app.open({ url: URL.createObjectURL(item.blob), originalUrl: encodeURIComponent(item.name || "document.pdf") });
      return;
    }
  }
  if (!src) {
    toolbar.reset();
    toolbar.setLoading(false);
    emptyState.show(boot.wantsFilePicker ? "「ファイルを選ぶ」を押して、開くファイルを選んでください。" : "");
    if (boot.wantsFilePicker) {
      document.getElementById("shEmptyOpen").focus();
    }
    return;
  }
  if (/^file:/i.test(src)) {
    const allowed = await (boot.fileAccessPromise || chrome.extension.isAllowedFileSchemeAccess());
    if (!allowed) {
      current = { kind: "url", url: src, name: null };
      sourceMenu.update();
      showFileAccessHelp(src);
      return;
    }
  }
  if (/^https?:/i.test(src)) {
    // リファラの引き継ぎ(Service Worker 側の準備を待つ。boot.js で先に依頼済み)
    const prepared = await boot.preparePromise;
    if (prepared?.referer) {
      try {
        sessionStorage.setItem(`seihon.referer:${src}`, prepared.referer);
      } catch {}
    }
  }
  await app.open({
    url: src,
    originalUrl: src,
    withCredentials: /^https?:/i.test(src),
    docBaseUrl: src.split("#", 1)[0],
  });
  if (boot.downloadId !== null && app.pdfDocument) {
    afterDownloadedFileOpened(boot.downloadId);
  }
}

/**
 * 強制ダウンロード対策(第3層)で、保存されたファイルを開いたあとの処理。
 * 設定が「削除」なら、PDF をすべて読み込んでから元のファイルを削除する。
 */
async function afterDownloadedFileOpened(downloadId) {
  const doc = app.pdfDocument;
  if (settings.guardOriginalFile !== "delete") {
    toast.show("サイトが保存させた PDF を、保存されたファイルから製本ビューアで開きました", {
      duration: 6000,
      action: { label: "フォルダを開く", onClick: () => chrome.downloads.show(downloadId) },
    });
    return;
  }
  try {
    await doc.getData(); // 全部読み込まれるまで待つ
    if (doc !== app.pdfDocument) {
      return;
    }
    await chrome.downloads.removeFile(downloadId);
    await chrome.downloads.erase({ id: downloadId });
    toast.show(
      "サイトが保存させた PDF を製本ビューアで開き、元のファイルは削除しました(詳細設定で「残す」に変えられます)。残したい場合はダウンロードボタンで保存してください",
      { duration: 8000 }
    );
  } catch (e) {
    console.warn("[製本ビューア] 元のファイルを削除できませんでした", e);
  }
}

// ---------------------------------------------------------------------------
// エラー表示
// ---------------------------------------------------------------------------
function nativeButton(label = "Chrome標準で開く") {
  return { label, primary: true, onClick: () => openNative() };
}

function showLoadError(reason) {
  toolbar.setLoading(false);
  const status = reason?.status;
  const name = reason?.name || "";
  const isUrl = current.kind === "url" && /^(https?|file):/i.test(current.url || "");
  const buttons = [];
  if (isUrl) {
    buttons.push(nativeButton());
  }
  buttons.push({ label: "再読み込み", onClick: () => location.reload() });
  buttons.push({ label: "ファイルを選んで開く", onClick: () => openFilePicker() });

  let message = "PDFの読み込み中にエラーが発生しました。";
  if (name === "ResponseException" || status) {
    if (isUrl && /^https?:/i.test(current.url) && (status === 404 || status === 410 || status === 403)) {
      // 使い捨て URL の可能性: そのサイトを自動切り替えの対象外にすれば、次からは Chrome が直接受け取る
      // (ダウンロードされた場合は第3層が製本ビューアで開く)
      buttons.splice(1, 0, { label: "このサイトは自動で切り替えない", onClick: () => excludeSiteAndGoBack(current.url) });
    }
    if (status === 401 || status === 403) {
      message = `サーバーにアクセスを拒否されました(HTTP ${status})。ログインが必要なページか、アクセス期限が切れている可能性があります。「Chrome標準で開く」を押すと、サイト側のログイン画面などが表示されることがあります。`;
    } else if (status === 404 || status === 410) {
      message = `PDFが見つかりませんでした(HTTP ${status})。一度しか使えないURL(使い捨てURL)の場合、自動切り替えの際に使い切ってしまい、再取得できないことがあります。「このサイトは自動で切り替えない」を押すと、次からはこのサイトの PDF を Chrome が直接受け取ります(保存させるサイトなら、保存されたファイルを製本ビューアで開きます)。元のページからもう一度開いてください。`;
    } else if (status) {
      message = `サーバーからPDFを取得できませんでした(HTTP ${status})。`;
    } else {
      message = "サーバーからPDFを取得できませんでした。ネットワークの状態を確認してください。";
    }
  } else if (name === "InvalidPDFException") {
    message = "PDFとして読み込めませんでした。ファイルが壊れているか、PDFの代わりにログイン画面などが返された可能性があります。";
  } else if (name === "PasswordException") {
    message = "パスワードが入力されなかったため、PDFを開けませんでした。";
  } else if (/Failed to fetch|NetworkError|network/i.test(reason?.message || "")) {
    message = "ネットワークエラーのため、PDFを取得できませんでした。";
  }
  errorPanel.show({
    message,
    buttons,
    details: [
      current.url ? `URL: ${current.url}` : current.name ? `ファイル: ${current.name}` : "",
      reason?.name ? `種類: ${reason.name}` : "",
      reason?.message ? `内容: ${reason.message}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

async function excludeSiteAndGoBack(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  if (!host) {
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "auto-exclude-site", host }).catch(() => null);
  if (!res?.ok) {
    toast.show("設定を変更できませんでした", { kind: "error" });
    return;
  }
  toast.show(`${host} を「自動切り替えしないサイト」に追加しました。元のページからもう一度開いてください`, { duration: 8000 });
  setTimeout(() => {
    if (history.length > 1) {
      history.back();
    }
  }, 1500);
}

function showFileAccessHelp(fileUrl) {
  toolbar.setLoading(false);
  const fromDownload = boot.downloadId !== null;
  errorPanel.show({
    title: fromDownload ? "保存された PDF を開くには許可が必要です" : "パソコン内のPDFを開くには許可が必要です",
    message: fromDownload
      ? "サイトが PDF を表示せずに保存させたため、保存されたファイルを製本ビューアで開こうとしました。パソコン内のファイル(file://)を開くには、Chrome の拡張機能の設定で「ファイルの URL へのアクセスを許可する」をオンにする必要があります。今回は「このファイルを選んで開く」で開けます。"
      : "製本ビューアでローカルファイル(file://)を開くには、Chrome の拡張機能の設定で「ファイルの URL へのアクセスを許可する」をオンにする必要があります。",
    steps: [
      "下の「拡張機能の設定を開く」を押します。",
      "「ファイルの URL へのアクセスを許可する」をオンにします。",
      "設定を変えると拡張機能が再読み込みされ、このタブは閉じます。PDFをもう一度開いてください。",
    ],
    buttons: [
      {
        label: "拡張機能の設定を開く",
        primary: true,
        onClick: () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }),
      },
      { label: "このファイルを選んで開く", onClick: () => openFilePicker() },
      fromDownload
        ? { label: "保存されたフォルダを開く", onClick: () => chrome.downloads.show(boot.downloadId) }
        : { label: "今回はChrome標準で開く", onClick: () => openNative() },
    ],
    details: `ファイル: ${decodeURI(fileUrl)}`,
  });
}

// ---------------------------------------------------------------------------
// Chrome 標準ビューアで開く
// ---------------------------------------------------------------------------
async function openNative() {
  if ((current.arranged || current.converted) && app.pdfDocument) {
    // 整えたスキャンの PDF・コミックから作った PDF: 同じ内容を新しいタブの Chrome 標準ビューアで開く(このタブはそのまま)
    if (pageEditor.dirty || hasEdits()) {
      await openEditedInNative();
      return;
    }
    const data = await app.pdfDocument.getData();
    const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    toast.show(current.converted ? "PDF にしたものを、新しいタブの Chrome 標準ビューアで開きました" : "整えた PDF を、新しいタブの Chrome 標準ビューアで開きました", { duration: 5000 });
    return;
  }
  if (current.kind === "url" && /^(https?|file):/i.test(current.url || "")) {
    // このタブを Chrome 標準ビューアに切り替える(編集した内容は持っていけない)
    if (!(await pageEditor.guard("Chrome標準ビューアに切り替える"))) {
      return;
    }
    const page = app.pdfDocument ? app.pdfViewer.currentPageNumber : 1;
    const base = current.url.split("#", 1)[0];
    const target = page > 1 ? `${base}#page=${page}` : current.url;
    try {
      const res = await chrome.runtime.sendMessage({ type: "open-native", url: target });
      if (!res?.ok) {
        throw new Error(res?.error || "unknown");
      }
    } catch (e) {
      toast.show("Chrome標準ビューアへの切り替えに失敗しました", { kind: "error" });
      console.error(e);
    }
    return;
  }
  // ファイルを選んで開いた場合: 同じ内容を新しいタブの Chrome 標準ビューアで開く
  let blobUrl = current.kind === "file" ? current.url : null;
  if (!blobUrl && app.pdfDocument) {
    const data = await app.pdfDocument.getData();
    blobUrl = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
  }
  if (blobUrl) {
    window.open(blobUrl, "_blank");
    toast.show(
      pageEditor.dirty
        ? "新しいタブで Chrome 標準ビューアを開きました(編集する前の PDF です。編集した内容は「保存」で保存できます)"
        : "新しいタブで Chrome 標準ビューアを開きました",
      { duration: pageEditor.dirty ? 7000 : 4000 }
    );
  }
}

document.getElementById("shOpenNative").addEventListener("click", () => openNative());

// ---------------------------------------------------------------------------
// ダウンロード・印刷
// ---------------------------------------------------------------------------
const downloadButton = document.getElementById("shDownload");
const downloadMenu = new PopupMenu({
  anchor: downloadButton,
  items: () => {
    const items = [];
    if (hasEdits()) {
      items.push({ label: "編集した内容を含めて保存…", hint: "保存先を選んで、新しい PDF として保存します", onSelect: () => pageEditor.save() });
    }
    if (current.arranged) {
      // 0.3: 整えたスキャンの PDF を表示しているとき
      items.push({
        label: hasEdits() ? "整えた PDF を保存(編集は含めない)…" : "整えた PDF を保存…",
        hint: "スキャンを分けた・並べ替えた PDF を、保存先を選んで保存します(画質は元のまま)",
        onSelect: () => scanArranger.saveArranged(),
      });
      items.push({ label: "元の PDF を保存(整える前のスキャン)", onSelect: () => scanArranger.saveOriginal() });
    } else if (current.converted) {
      // 0.4: コミック・画像の EPUB を PDF にしたもの
      items.push({
        label: hasEdits() ? "PDF として保存(編集は含めない)…" : "PDF として保存…",
        hint: "画像を並べた PDF を、保存先を選んで保存します(画質は元のまま)",
        onSelect: () => saveConvertedPdf(),
      });
      items.push({ label: `元のファイルを保存(${current.converted.sourceName})`, onSelect: () => ebookRouter.saveSource() });
    } else {
      items.push({ label: "元のPDFを保存(編集は含めない)", onSelect: () => app.download() });
    }
    if (app.pdfDocument) {
      items.push({ label: "ほかの形式に変換して保存…", hint: "画像(ZIP)・CBZ・EPUB・テキストにして保存します", onSelect: () => convertDialog.open() });
    }
    return items;
  },
});
/** 元の PDF から変えたところがある(ページの削除・書き込み・フォームの入力。保存したかどうかは問わない) */
function hasEdits() {
  const doc = app.pdfDocument;
  return !!doc && (pageEditor.dirty || pageEditor.title !== null || isRearranged(doc) || (doc.annotationStorage?.size || 0) > 0);
}

// 0.4.2: 左上の名前をクリックして、文書の名前(PDF の題名)を付け直す。保存するときに PDF に書き込む
toolbar.getTitleOverride = () => pageEditor.title;
toolbar.onRename = title => {
  const before = pageEditor.title;
  pageEditor.setTitle(title);
  if (pageEditor.title === before) {
    return;
  }
  app.setTitle();
  toast.show(
    pageEditor.title === null ? "名前を元に戻しました" : `名前を「${pageEditor.title}」にしました。保存すると、PDF の中の名前(題名)として書き込まれます`,
    { duration: 5000, action: { label: "元に戻す", onClick: () => toolbar.onRename(before) } }
  );
};
downloadButton.addEventListener("click", () => {
  if (!app.pdfDocument) {
    return;
  }
  if (hasEdits() || current.arranged || current.converted) {
    downloadMenu.toggle();
  } else {
    app.download(); // 元のPDFをそのまま保存(再生成しない)
  }
});

// 「保存」ボタン: 保存していない変更があるときだけ出す
const saveButton = document.getElementById("shSaveEdits");
saveButton.addEventListener("click", () => pageEditor.save());
pageEditor.onChange(() => {
  const wasHidden = saveButton.hidden;
  saveButton.hidden = !pageEditor.dirty;
  saveButton.disabled = pageEditor.saving;
  if (wasHidden !== saveButton.hidden) {
    toolbar.fitToWidth();
  }
  app.setTitle();
});

// Ctrl+S: 編集していれば保存先を選んで保存、していなければ元の PDF を保存(PDF.js の保存の代わり)
window.addEventListener(
  "keydown",
  e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (e.key !== "s" && e.key !== "S") || !app.pdfDocument) {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (pageEditor.dirty) {
      pageEditor.save();
    } else if (hasEdits() || current.arranged || current.converted) {
      downloadMenu.open();
    } else {
      app.download();
    }
  },
  true
);

document.getElementById("shPrint").addEventListener("click", () => app.triggerPrinting());

/**
 * 印刷(印刷ボタン・Ctrl+P)。画質が「元の PDF で印刷」(初期値。0.7.0 までの名前は「最高画質」)なら、元の PDF のまま Chrome の印刷機能で印刷する
 * (画像は元の解像度、文字・OCR の文字も残る。print-native.js)。それ以外は PDF.js の印刷(ページを画像にして印刷)。
 * ブラウザのメニューから印刷したときは、PDF.js の印刷になる(高画質)。
 */
{
  const pdfjsPrint = app.triggerPrinting.bind(app);
  let preparing = false;
  app.triggerPrinting = () => {
    if (!app.pdfDocument) {
      return;
    }
    if (settings.printQuality !== "max" || !canPrintWithChrome()) {
      updatePrintResolution();
      pdfjsPrint();
      return;
    }
    if (preparing) {
      return;
    }
    preparing = true;
    printOriginal()
      .catch(e => {
        console.warn("[製本ビューア] 元の PDF のままで印刷できなかったため、ページを画像にして印刷します", e);
        toast.show(`元の PDF のままで印刷できなかったため、ページを画像にして印刷します(${e.message || e})`, { duration: 6000 });
        updatePrintResolution();
        pdfjsPrint();
      })
      .finally(() => {
        preparing = false;
      });
  };
  // Ctrl+P(boot.js が PDF.js より先に受け取る): 元の PDF で印刷 なら、ここで印刷する
  boot.printHandler = () => {
    if (!app.pdfDocument || settings.printQuality !== "max" || !canPrintWithChrome()) {
      return false; // PDF.js の印刷(ページを画像にして印刷)
    }
    app.triggerPrinting();
    return true;
  };
}

/** 元の PDF(編集していれば編集を反映した PDF)を Chrome の印刷画面で印刷する */
async function printOriginal() {
  const doc = app.pdfDocument;
  const passwordDoc = docSource.passwordDocs.has(doc);
  const edited = hasEdits();
  if (passwordDoc && edited) {
    // 編集を反映した写しにもパスワードが必要になるため、画像にして印刷する
    throw new Error("パスワード付きの PDF を編集しているため");
  }
  const busy = toast.show("印刷の準備をしています…", { duration: 0 });
  try {
    let bytes;
    if (edited) {
      pageEditor.sweepDeletedEditors();
      bytes = await pageEditor.buildEditedBytes(doc);
    } else if (passwordDoc) {
      bytes = await decryptedCopy(doc);
    } else {
      bytes = await doc.getData();
    }
    if (!bytes?.length) {
      throw new Error("印刷する PDF を作れませんでした");
    }
    // 題名の無い PDF は、「PDF に保存」のファイル名の候補が英数字の羅列にならないよう、ファイル名を題名にする
    const info = await doc.getMetadata().catch(() => null);
    if (pageEditor.title === null && !String(info?.info?.Title || "").trim()) {
      const base = sanitizeFileName(docSource.baseName());
      bytes = await withTitle(bytes, edited ? `${base}_編集済み` : base);
    }
    if (doc !== app.pdfDocument) {
      return;
    }
    busy();
    await printWithChrome(bytes);
  } finally {
    busy();
  }
}
app.eventBus.on("documentinit", () => removePrintFrame());

/**
 * ページを画像にして印刷するときの解像度。PDF.js は印刷を始めるときにこの値を読む
 * (元の PDF で印刷 以外の印刷ボタン・Ctrl+P と、ブラウザのメニューからの印刷)。
 * 元の PDF で印刷 の設定でブラウザのメニューから印刷したときは、高画質(300dpi)にする。
 */
function updatePrintResolution() {
  const count = viewPageCount(app.pdfDocument);
  const q = settings.printQuality;
  const dpi = q === "high" || q === "max" || (q === "auto" && count > 0 && count <= 50) ? 300 : 150;
  window.PDFViewerApplicationOptions.set("printResolution", dpi);
  return dpi;
}
app.eventBus.on("documentloaded", () => updatePrintResolution());
app.eventBus.on("pagesedited", () => updatePrintResolution());

// 印刷の準備中ダイアログに「Chrome標準ビューアで印刷」を追加(巨大なPDFで遅い・崩れるとき用)
{
  const dialog = document.getElementById("printServiceDialog");
  const row = dialog.querySelector(".buttonRow");
  const note = document.createElement("p");
  note.className = "sh-print-note";
  note.textContent = "時間がかかる・崩れる場合は、Chrome標準ビューアで印刷できます。";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "secondaryButton";
  b.textContent = "Chrome標準ビューアで印刷";
  b.addEventListener("click", () => {
    document.getElementById("printCancel").click();
    openNativeForPrint();
  });
  row.prepend(b);
  dialog.insertBefore(note, row);
}

async function openNativeForPrint() {
  // ページを削除したり書き込んだりしていれば、その内容を反映した PDF を新しいタブの Chrome 標準ビューアで開く
  // (元の PDF に切り替えると、削除したページも印刷され、書き込みは印刷されないため)
  if (app.pdfDocument && (hasEdits() || current.arranged || current.converted)) {
    if (hasEdits()) {
      await openEditedInNative();
    } else {
      await openNative();
      toast.show("開いたタブで Ctrl+P を押して印刷してください。", { duration: 6000 });
    }
    return;
  }
  if (current.kind === "url") {
    toast.show("Chrome標準ビューアに切り替えます。表示されたら Ctrl+P で印刷してください。", { duration: 2500 });
    setTimeout(() => openNative(), 900);
  } else {
    openNative();
    toast.show("開いたタブで Ctrl+P を押して印刷してください。", { duration: 6000 });
  }
}

/** 編集した内容を反映した PDF を、新しいタブの Chrome 標準ビューアで開く(このタブの編集はそのまま) */
async function openEditedInNative() {
  const busy = toast.show("編集した内容を反映した PDF を作っています…", { duration: 0 });
  try {
    pageEditor.sweepDeletedEditors();
    const bytes = await pageEditor.buildEditedBytes(app.pdfDocument);
    busy();
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    toast.show(
      "編集した内容を反映した PDF を、新しいタブの Chrome 標準ビューアで開きました。そのタブで Ctrl+P を押して印刷してください(このタブの編集はそのまま残っています)",
      { duration: 9000 }
    );
  } catch (e) {
    busy();
    console.error(e);
    toast.show(`PDF を作れませんでした: ${e.message || e}`, { kind: "error", duration: 8000 });
  }
}

// ---------------------------------------------------------------------------
// 表示モード(製本表示・見開き・単ページ)と綴じ方向
// ---------------------------------------------------------------------------
// 表示モードのボタンは、押すたびに 単ページ → 製本表示 → 見開き → 単ページ… と切り替える(0.2)。
// その右の綴じ方向のボタンで、左綴じ・右綴じを切り替える。
const NEXT_VIEW_MODE = Object.freeze({ single: "book", book: "spread", spread: "single" });
const viewModeButton = document.getElementById("shViewMode");
const bindDirButton = document.getElementById("shBindDir");
viewModeButton.addEventListener("click", () => {
  const next = NEXT_VIEW_MODE[book.mode] || "book";
  book.setMode(next);
  toast.show(`表示モード: ${VIEW_MODES[next].label}`, { duration: 1500 });
});
bindDirButton.addEventListener("click", () => {
  const next = book.direction === "rtl" ? "ltr" : "rtl";
  changeDirection(next);
  toast.show(next === "rtl" ? "右綴じにしました(← キーで次のページ)" : "左綴じにしました(→ キーで次のページ)", { duration: 2500 });
});

function changeDirection(direction) {
  book.setDirection(direction);
  saveSettings({ bindingDirection: direction }).catch(() => {});
  // 0.3: スキャンを整えて表示していれば、新しい綴じ方向で並べ直す
  scanArranger.onDirectionChanged(direction);
  // 0.4: コミックの見開きの画像を分けていれば、新しい綴じ方向で作り直す
  ebookRouter.onDirectionChanged(direction).catch(e => console.error(e));
}

function updateViewButtons() {
  const m = VIEW_MODES[book.mode] || VIEW_MODES.book;
  const next = VIEW_MODES[NEXT_VIEW_MODE[book.mode] || "book"];
  setIcon(viewModeButton, m.icon);
  viewModeButton.title = `表示モード: ${m.label}(${m.detail})。押すと「${next.label}」に切り替えます`;
  viewModeButton.setAttribute("aria-label", `表示モード: ${m.label}。押すと${next.label}`);
  viewModeButton.dataset.mode = book.mode;
  const rtl = book.direction === "rtl";
  setIcon(bindDirButton, rtl ? "bind-rtl" : "bind-ltr");
  bindDirButton.title = rtl
    ? "綴じ方向: 右綴じ(表紙が左・縦書きの本・漫画)。押すと左綴じに切り替えます"
    : "綴じ方向: 左綴じ(表紙が右・横書きの本)。押すと右綴じに切り替えます";
  bindDirButton.setAttribute("aria-label", rtl ? "綴じ方向: 右綴じ。押すと左綴じ" : "綴じ方向: 左綴じ。押すと右綴じ");
  bindDirButton.dataset.direction = book.direction;
}
book.onChange(() => updateViewButtons());
updateViewButtons();

// ---------------------------------------------------------------------------
// ⋮ メニュー
// 0.5: 「ファイルを開く」「PDFを閉じる」「回転」「表示中のページをコピー」「元のリンク・ファイルの場所をコピー」「ページを選ぶ」は
// メニューから外した(Ctrl+O・Ctrl+[・Ctrl+]・コピーのショートカット・ツールバーのボタンは残す)
// ---------------------------------------------------------------------------
const moreButton = document.getElementById("shMore");
const moreMenu = new PopupMenu({
  anchor: moreButton,
  items: () => {
    const hasDoc = !!app.pdfDocument;
    const handOn = app.pdfCursorTools?.activeTool === 1;
    return [
      { label: "最初のページ", icon: "first-page", shortcut: "Home", disabled: !hasDoc, onSelect: () => (app.page = 1) },
      { label: "最後のページ", icon: "last-page", shortcut: "End", disabled: !hasDoc, onSelect: () => (app.page = app.pagesCount) },
      {
        label: handOn ? "テキスト選択ツールに戻す" : "手のひらツール(ドラッグで移動)",
        icon: handOn ? "text-cursor" : "hand",
        disabled: !hasDoc,
        onSelect: () => app.eventBus.dispatch("switchcursortool", { source: window, tool: handOn ? 0 : 1 }),
      },
      { label: "プレゼンテーション(全画面)", icon: "present", shortcut: "Ctrl+Alt+P", disabled: !hasDoc || !app.supportsFullscreen, onSelect: () => app.requestPresentationMode() },
      { separator: true },
      { label: "Chrome標準ビューアで開いて印刷", icon: "print", disabled: !hasDoc && current.kind !== "url", hint: "巨大なPDFで印刷が遅い・崩れる場合に", onSelect: () => openNativeForPrint() },
      { label: "ドキュメントのプロパティ", icon: "info", disabled: !hasDoc, onSelect: () => app.pdfDocumentProperties?.open() },
      { separator: true },
      { label: "表示中のページを収集に追加", icon: "collect", disabled: !hasDoc, onSelect: () => collection.addCurrentPages([app.page]) },
      { label: `ページ収集を表示(${collection.count}ページ)`, icon: "collect", onSelect: () => collectPanel.open() },
      { separator: true },
      { label: "製本用PDF出力…", icon: "bind-output", disabled: !hasDoc, onSelect: () => bindDialog.open() },
      {
        label: "スキャンを整える(見開きの分割・余白の除去・冊子の並べ替え)…",
        icon: "scan-split",
        disabled: !hasDoc || !scanArranger.base || scanArranger.state === "busy",
        hint: "スキャンした見開きを1ページずつに分けたり、紙の周りの余白(写真など)を除いたり、ばらした冊子を表紙から順に並べ替えたりします(画質は元のまま)",
        onSelect: () => scanDialog.open(),
      },
      {
        label: "ほかの形式に変換して保存…",
        icon: "file-zip",
        disabled: !hasDoc,
        hint: "画像(ZIP)・コミック(CBZ)・EPUB・テキストにして保存します",
        onSelect: () => convertDialog.open(),
      },
      { label: "ページ役割(カバー・表紙・帯など)の一覧", icon: "label", disabled: !hasDoc, onSelect: () => rolesPanel.open() },
      ...(settings.perfLog ? [{ label: "速度ログを表示", icon: "speed", disabled: !perf.done, onSelect: () => perf.render() }] : []),
      { separator: true },
      { label: "詳細設定", icon: "settings", onSelect: () => chrome.runtime.openOptionsPage() },
    ];
  },
});
moreButton.addEventListener("click", () => moreMenu.toggle());

// ---------------------------------------------------------------------------
// 検索バー
// ---------------------------------------------------------------------------
{
  document.getElementById("shFindClose").addEventListener("click", () => app.findBar?.close());
  const toggle = document.getElementById("shFindOptionsToggle");
  const options = document.getElementById("shFindOptions");
  toggle.addEventListener("click", () => {
    options.hidden = !options.hidden;
    toggle.setAttribute("aria-expanded", options.hidden ? "false" : "true");
    toggle.classList.toggle("sh-pressed", !options.hidden);
  });
}

// ---------------------------------------------------------------------------
// キーボードショートカット(Chrome 標準ビューアに合わせて追加するもの)
//   Ctrl+[ 反時計回り / Ctrl+] 時計回り / Ctrl+\ 幅・ページに合わせるの切り替え
// ---------------------------------------------------------------------------
window.addEventListener("keydown", e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !app.pdfDocument) {
    return;
  }
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
    return;
  }
  if (e.key === "[") {
    app.rotatePages(-90);
  } else if (e.key === "]") {
    app.rotatePages(90);
  } else if (e.key === "\\" || e.code === "Backslash" || e.code === "IntlYen" || e.code === "IntlRo") {
    toolbar.toggleFit();
  } else {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
});

// ---------------------------------------------------------------------------
// 右綴じのときは、← で次のページ、→ で前のページ(右綴じの本は左へめくって読み進めるため)
// 拡大して横にスクロールできるときは、PDF.js と同じく矢印キーで横にスクロールする
// ---------------------------------------------------------------------------
window.addEventListener(
  "keydown",
  e => {
    if (book.direction !== "rtl" || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) {
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !app.pdfDocument || e.defaultPrevented) {
      return;
    }
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
      return;
    }
    // サイドバー・検索バー・メニュー・パネル・書き込みの上では、それぞれの矢印キーの動きのままにする
    if (t?.closest?.("#viewsManager, #findbar, .sh-popup, dialog, #shAnnotPanel, #shCollectPanel, #shRolesPanel, .annotationEditorLayer")) {
      return;
    }
    if (document.querySelector("#shPopupLayer > .sh-popup:not([hidden])")) {
      return;
    }
    const viewer = app.pdfViewer;
    // 書き込みの道具を使っているとき(選んだ書き込みを矢印キーで動かす)は入れ替えない
    if ((viewer.annotationEditorMode ?? 0) > 0) {
      return;
    }
    if (viewer.isHorizontalScrollbarEnabled && viewer.currentScaleValue !== "page-fit" && !viewer.isInPresentationMode) {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "ArrowLeft") {
      viewer.nextPage();
    } else {
      viewer.previousPage();
    }
  },
  true
);

// ---------------------------------------------------------------------------
// コピーのショートカット(既定 Ctrl+Shift+C。詳細設定で変更可)
//   サムネイルを複数選んでいれば選んだページ、そうでなければマウスの下のページ(無ければ表示中のページ)
// ---------------------------------------------------------------------------
{
  let pointer = null;
  document.addEventListener(
    "pointermove",
    e => {
      pointer = { x: e.clientX, y: e.clientY };
    },
    { passive: true }
  );
  window.addEventListener(
    "keydown",
    e => {
      if (!app.pdfDocument || !matchesShortcut(e, settings.aiCopyShortcut)) {
        return;
      }
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (thumbSelection.size) {
        pageCopy.copyPages(thumbSelection.pages());
        return;
      }
      let pageNumber = app.page;
      if (pointer) {
        const el = document.elementFromPoint(pointer.x, pointer.y)?.closest?.(".page[data-page-number]");
        if (el) {
          pageNumber = Number(el.dataset.pageNumber);
        }
      }
      pageCopy.copySinglePage(pageNumber);
    },
    true
  );
}

// 最初のページを表示し終えて手が空いたら、文書の指紋を計算しておく(収集済みかどうかの表示に使う)
app.eventBus.on("documentloaded", () => {
  collectPanel.update();
  const doc = app.pdfDocument;
  const run = () => {
    if (doc === app.pdfDocument) {
      docSource.key(doc).catch(() => {});
    }
  };
  if ("requestIdleCallback" in window) {
    requestIdleCallback(run, { timeout: 4000 });
  } else {
    setTimeout(run, 1500);
  }
});

// ---------------------------------------------------------------------------
// ドラッグ&ドロップ
// ---------------------------------------------------------------------------
setupDropZone({
  onFile: file => {
    if (!file) {
      toast.show("開けない種類のファイルです(PDF・EPUB・MOBI・AZW・AZW3・CBZ・CBR を開けます)", { kind: "error" });
      return;
    }
    app.open({ url: URL.createObjectURL(file), originalUrl: encodeURIComponent(file.name) });
  },
  onUrl: async url => {
    if (/^(https?|file):/i.test(url)) {
      if (!(await pageEditor.guard("別の PDF を開く"))) {
        return;
      }
      location.href = viewerUrlFor(url);
    }
  },
});

// ---------------------------------------------------------------------------
// 設定の変更をその場で反映
// ---------------------------------------------------------------------------
onSettingsChanged(next => {
  const prev = settings;
  settings = next;
  if (next.theme !== prev.theme) {
    applyThemePreference(next.theme);
  }
  // 設定の綴じ方向を変えたときだけ合わせる(コミック・整えたスキャンで一時的に変えている向きを、ほかの設定の変更で戻さない)
  if (next.bindingDirection !== prev.bindingDirection && next.bindingDirection !== book.direction) {
    book.setDirection(next.bindingDirection);
  }
  if (JSON.stringify(next.bindRoleItems) !== JSON.stringify(prev.bindRoleItems)) {
    applyRoleItems(next.bindRoleItems);
    pageRoles.emit();
    bindDialog.onRoleItemsChanged();
  }
  if (next.rotateStep !== prev.rotateStep) {
    rotateButton.update();
  }
  if (next.perfLog !== prev.perfLog) {
    perf.setEnabled(next.perfLog);
  }
  if (next.printQuality !== prev.printQuality) {
    updatePrintResolution();
  }
});

// サイドバーの開閉・ページの読み込み状態に応じた体裁
app.eventBus.on("documentloaded", () => document.body.classList.add("sh-document-loaded"));

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
await openInitial();

// 開発時の確認用(テストから参照する)
window.__seihonViewer = {
  app,
  book,
  toolbar,
  annotations,
  perf,
  docSource,
  pageCopy,
  /** 0.1 までの名前(試験・互換用) */
  aiCopy: pageCopy,
  collection,
  collectPanel,
  thumbSelection,
  pageRoles,
  sourceMenu,
  scanArranger,
  scanDialog,
  ebookRouter,
  convertDialog,
  rolesPanel,
  bindDialog,
  pageEditor,
  contextMenu,
  get current() {
    return current;
  },
};
