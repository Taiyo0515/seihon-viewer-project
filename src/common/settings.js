/**
 * 設定の定義と読み書き。
 *
 * - 保存先は chrome.storage.local の "settings" キー(1つのオブジェクト)。
 * - Service Worker・ビューア・詳細設定画面・初回案内画面で共通に使う。
 * - 値の検証(normalizeSettings)を必ず通してから使うので、
 *   古い版の設定や手で壊れた値が入っていても初期値に戻して動く。
 */

import { DEFAULT_ROLE_ITEMS, normalizeRoleItems } from "./role-items.js";
import { parseShortcut } from "./shortcut.js";

export const SETTINGS_KEY = "settings";

/** 設定の初期値(詳細設定画面の「初期値に戻す」もこれを使う) */
export const DEFAULT_SETTINGS = Object.freeze({
  // ---- 起動 ----
  /** "auto": PDFを開くと自動で製本ビューアに切り替える / "manual": ボタンを押したときだけ */
  launchMode: "auto",
  /** 自動切り替えの対象外にするサイト(ドメイン名の配列) */
  autoExcludeSites: [],
  /** ローカルファイル(file://)のPDFも自動で製本ビューアで開く */
  openLocalFiles: true,

  // ---- 表示 ----
  /** PDFを開いたときの表示: "book" 製本表示 / "spread" 通常の見開き / "single" 単ページ */
  initialView: "book",
  /** 綴じ方向: "ltr" 左綴じ / "rtl" 右綴じ */
  bindingDirection: "ltr",
  /** 0.5: 回転ボタンを押したときの回転(負は左 = 反時計回り)。ボタンの右クリックで変えられる */
  rotateStep: -90,
  /** 同じPDFを再び開いたとき、前回見ていた位置から表示する */
  restorePosition: true,
  /** テーマ: "system" システムに従う / "light" / "dark" */
  theme: "system",
  /**
   * 印刷の画質:
   * "max" 元の PDF で印刷(昔の名前は「最高画質」。元の PDF のまま Chrome の印刷機能で印刷する。画像は元の解像度、文字・OCR の文字も残る)/
   * "auto" 50ページまでは高画質、それより多いときは標準 / "standard" 150dpi / "high" 300dpi
   * (max 以外は、ビューアがページを画像にして印刷する)
   */
  printQuality: "max",

  // ---- 強制ダウンロード対策 ----
  /** 「表示せずダウンロード」させるサイトでもビューアで開く */
  guardEnabled: true,
  /** 強制ダウンロード対策の対象外にするサイト */
  guardExcludeSites: [],

  /** 強制ダウンロードされたPDFをビューアで開いた後の元ファイル(第3層): "keep" 残す / "delete" 削除 */
  guardOriginalFile: "keep",

  // ---- コピー(0.1 までの「AI用コピー」。設定の名前は互換のためそのまま) ----
  /** 1ページのとき: "clipboard-png" 画像をクリップボードへ / "file-pdf" PDFを保存 / "file-png" 画像を保存 */
  aiCopySingle: "clipboard-png",
  /**
   * 複数ページのとき: "pdf-copy" PDF をクリップボードへ(ファイルとして) / "image-copy" 画像をクリップボードへ(ファイルとして) /
   * "pdf" PDFを保存 / "zip" 画像をまとめて ZIP で保存
   */
  aiCopyMulti: "pdf-copy",
  /** 「画像としてコピー」で複数ページのとき: "files" 1ページ1枚の画像ファイル / "zip" ZIP にまとめる */
  copyImagesAs: "files",
  /**
   * 画像にする画質(コピー・画像の保存・ZIP・変換で共通。image-export.js):
   * "original" 元データ優先(スキャンしたページは元の画像の解像度、文字・図のページは 600dpi)/
   * "high" 高画質 300dpi / "standard" 標準 150dpi / "custom" imageDpi の dpi で描く
   */
  imageQuality: "original",
  /** 「指定する」のときに描く dpi(100〜1200。A4 で 300dpi = 2480×3508 ピクセル) */
  imageDpi: 300,
  /** 廃止(0.7.0 で dpi に統一。0.6.8 に戻したときのために値だけ残す) */
  pngMode: "longside",
  pngLongSide: 2400,
  pngScale: 3,
  /** コピーのショートカット(ビューア内) */
  aiCopyShortcut: "Ctrl+Shift+C",

  // ---- ページ収集 ----
  /** 書き出し後に収集を自動で空にする */
  collectClearAfterExport: false,
  /** 収集の保存上限(MB) */
  collectLimitMB: 1024,

  // ---- 製本用PDF出力 ----
  /** 白紙を入れる位置: "beforeBack" 裏表紙の直前 / "afterCover" 表紙の直後 / "custom" 毎回指定する */
  bindBlankPosition: "beforeBack",
  /** 面付け(中綴じ用に用紙1枚へ4ページ)する */
  bindImpose: true,
  /** 用紙: "auto" 元のページから推定 / "A3" "A4" "A5" "B4" "B5" "Letter" "Tabloid" / "double" 元のページ2枚分 */
  bindPaper: "auto",
  /** 両面の綴じ方向: "short" 短辺とじ(横向きの用紙に合う)/ "long" 長辺とじ */
  bindDuplex: "short",
  /**
   * ページの大きさがそろっていないときの基準: "mode" 最も多い大きさ / "first" 最初のページ /
   * "page" ページを指定する(0.5。何ページ目かは製本用PDF出力の画面で、PDF ごとに選ぶ)
   */
  bindSizeRef: "mode",
  /** 0.5: 製本用PDF出力の画面で、出力するページのプレビュー(サムネイル)を出さない */
  bindHidePreview: true,
  /** 0.5: 「カバー・表紙・帯などのページ」の項目(並び・表示・複数選択・追加した項目。common/role-items.js) */
  bindRoleItems: DEFAULT_ROLE_ITEMS,
  /** 付属(表紙・裏表紙・帯・折り返し・しおり)の出力: "separate" 別の PDF / "append" 本体の後ろに同梱 / "none" 出力しない */
  bindObiOutput: "separate",
  /**
   * 付属の役割のページの使い道(運用に合わせて割り当てを変えられるようにする)。
   * "obi" 付属として出力 / "cover" 本の最初のページ(カバーの表紙)の候補にする /
   * "back" 本の最後のページ(カバーの裏表紙)の候補にする / "none" 出力しない
   * (設定の名前は 0.1 までの役割の名前のまま: ObiFront = 表紙、ObiBack = 裏表紙)
   */
  bindUseObiFront: "obi",
  bindUseObiBack: "obi",
  bindUseObi: "obi",
  bindUseFlapFront: "obi",
  bindUseFlapBack: "obi",
  bindUseBookmark: "obi",
  /** 出力ファイル名に付ける言葉(元名_製本.pdf / 元名_製本_面付け.pdf) */
  bindNameSuffix: "_製本",
  /** 付属の出力ファイル名に付ける言葉(元名_付属.pdf) */
  bindObiSuffix: "_付属",

  // ---- スキャンの整え(0.3) ----
  /**
   * スキャンした見開き(本・ノートを開いてスキャンしたもの)を開いたとき:
   * "auto" 自動で1ページずつに分けて表示する / "ask" ツールバーのボタンで知らせる / "off" 何もしない
   * (ばらした冊子の並べ替えは、いつもボタンを押してから。PDF ごとに選んだ整え方は覚えておく)
   */
  scanArrange: "auto",
  /** 分けるときに、スキャンで入った余分なふち(余白・影・本の縁・ごみ)を除いて、ページの大きさをそろえる(「補正」のチェックの初期値) */
  scanTrim: true,
  /**
   * 0.5: スキャンした見開きの本を読む向きの初期値: "binding" ビューアの綴じ方向(設定)に合わせる /
   * "rtl" 右から左(縦書き) / "ltr" 左から右(横書き)。PDF ごとに「スキャンを整える」の「条件」で変えられる(覚えておく)
   */
  scanDirection: "binding",
  /** 0.5: PDF の1ページ目の初期値: "first" 本の最初のほうの見開き / "last" 本の最後のほうの見開き(順を逆にする) */
  scanFirstPage: "first",
  /**
   * 0.6: 傾きをまっすぐにする: "auto" 「補正」の「傾きをまっすぐにする」のチェックを、既定で入れておく /
   * "off" 既定では入れない(傾きの自動検出・ツールバーの知らせもしない。「スキャンを整える」の画面からは、いつも使える)
   */
  scanDeskew: "auto",
  /** 0.8.2: スキャンを整えている処理の様子(調べるページ・判定・部分表示の進み)を、ビューアの右下に表示する(開発者向け。初期値オフ) */
  scanDebugShow: false,

  // ---- 電子書籍・コミック(0.4) ----
  /**
   * コミック(CBZ・CBR)・画像の EPUB の読む向き
   *  "auto": 本の情報(ComicInfo.xml・EPUB の page-progression-direction)に従い、無ければ右綴じ
   *  "rtl": いつも右綴じ / "ltr": いつも左綴じ
   */
  comicDirection: "auto",
  /** コミックの見開きの画像(横長の 1 枚)を、2 ページに分けて表示する(画像は作り直さない) */
  comicSplitSpreads: true,
  /** パソコン内の電子書籍・コミック(file:// の EPUB・CBZ など)を開いたとき、製本ビューアで表示する */
  openLocalEbooks: true,

  // ---- 速度 ----
  /** 速度ログ(画面右下の計測表示とログの保存) */
  perfLog: false,
});

/**
 * 設定の項目名(詳細設定の書き出し・読み込みで「変わる設定」を見せるときに使う)。
 * DEFAULT_SETTINGS のすべての項目について用意する。
 */
export const SETTING_LABELS = Object.freeze({
  launchMode: "起動方式",
  autoExcludeSites: "自動切り替えしないサイト",
  openLocalFiles: "パソコン内のPDF",
  initialView: "開いたときの表示",
  bindingDirection: "綴じ方向",
  restorePosition: "表示位置",
  rotateStep: "回転ボタンの動き",
  theme: "テーマ",
  printQuality: "印刷の画質",
  guardEnabled: "強制ダウンロード対策",
  guardExcludeSites: "対策の対象外にするサイト",
  guardOriginalFile: "強制ダウンロード時の元ファイル",
  aiCopySingle: "コピー(1ページ)",
  aiCopyMulti: "コピー(複数ページ)",
  copyImagesAs: "画像としてコピー(複数ページ)",
  imageQuality: "画像にする画質",
  imageDpi: "指定するdpi",
  pngMode: "画像の大きさの指定方法(廃止: 0.7.0 から dpi)",
  pngLongSide: "画像の長辺(廃止: 0.7.0 から dpi)",
  pngScale: "画像の倍率(廃止: 0.7.0 から dpi)",
  aiCopyShortcut: "コピーのショートカット",
  collectClearAfterExport: "書き出し後の収集",
  collectLimitMB: "収集の保存上限",
  bindBlankPosition: "白紙を入れる位置",
  bindImpose: "面付け",
  bindPaper: "出力用紙",
  bindDuplex: "両面の綴じ方向",
  bindSizeRef: "大きさの基準",
  bindHidePreview: "出力ページのプレビュー",
  bindRoleItems: "カバー・表紙・帯などの項目",
  bindObiOutput: "付属の出力",
  bindUseObiFront: "表紙の使い道",
  bindUseObiBack: "裏表紙の使い道",
  bindUseObi: "帯の使い道",
  bindUseFlapFront: "表紙の折り返しの使い道",
  bindUseFlapBack: "裏表紙の折り返しの使い道",
  bindUseBookmark: "しおりの使い道",
  bindNameSuffix: "出力ファイル名(本体)",
  bindObiSuffix: "出力ファイル名(付属)",
  scanArrange: "スキャンした見開き",
  scanTrim: "スキャンの余白を除く",
  scanDirection: "スキャンした本を読む向き",
  scanFirstPage: "スキャンの1ページ目",
  scanDeskew: "スキャンの傾きを直す",
  scanDebugShow: "スキャンの処理の表示",
  comicDirection: "コミックの読む向き",
  comicSplitSpreads: "コミックの見開きの画像を分ける",
  openLocalEbooks: "パソコン内の電子書籍・コミックを開く",
  perfLog: "速度ログ",
});

const ENUMS = {
  launchMode: ["auto", "manual"],
  initialView: ["book", "spread", "single"],
  rotateStep: [-90, -180, -270, 90, 180, 270],
  bindingDirection: ["ltr", "rtl"],
  theme: ["system", "light", "dark"],
  printQuality: ["max", "auto", "standard", "high"],
  guardOriginalFile: ["keep", "delete"],
  aiCopySingle: ["clipboard-png", "file-pdf", "file-png"],
  aiCopyMulti: ["pdf-copy", "image-copy", "pdf", "zip"],
  copyImagesAs: ["files", "zip"],
  imageQuality: ["original", "high", "standard", "custom"],
  bindBlankPosition: ["beforeBack", "afterCover", "custom"],
  bindPaper: ["auto", "A3", "A4", "A5", "B4", "B5", "Letter", "Tabloid", "double"],
  bindDuplex: ["short", "long"],
  bindSizeRef: ["mode", "first", "page"],
  bindObiOutput: ["separate", "append", "none"],
  bindUseObiFront: ["obi", "cover", "back", "none"],
  bindUseObiBack: ["obi", "cover", "back", "none"],
  bindUseObi: ["obi", "cover", "back", "none"],
  bindUseFlapFront: ["obi", "cover", "back", "none"],
  bindUseFlapBack: ["obi", "cover", "back", "none"],
  bindUseBookmark: ["obi", "cover", "back", "none"],
  scanArrange: ["auto", "ask", "off"],
  scanDirection: ["binding", "rtl", "ltr"],
  scanFirstPage: ["first", "last"],
  scanDeskew: ["auto", "off"],
  comicDirection: ["auto", "rtl", "ltr"],
};

/** 数値設定の範囲(範囲外は初期値に戻す) */
const NUMBER_RANGES = {
  imageDpi: [100, 1200],
  pngLongSide: [800, 12000],
  pngScale: [1, 8],
  collectLimitMB: [50, 20000],
};

/**
 * サイト指定の文字列を、ドメイン名(小文字・Punycode)に正規化する。
 * 「https://www.example.com/path」「*.example.com」「example.com」などを受け付ける。
 * 解釈できないものは null。
 */
export function normalizeSite(input) {
  if (typeof input !== "string") {
    return null;
  }
  let s = input.trim();
  if (!s) {
    return null;
  }
  s = s.replace(/^\*\./, "");
  try {
    const url = new URL(s.includes("://") ? s : `http://${s}`);
    const host = url.hostname.replace(/\.$/, "").toLowerCase();
    if (!host || host.includes("*")) {
      return null;
    }
    return host;
  } catch {
    return null;
  }
}

/** サイト一覧(配列または改行区切り文字列)を正規化し、重複を除く */
export function normalizeSiteList(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,、]+/)
      : [];
  const out = [];
  for (const item of list) {
    const host = normalizeSite(item);
    if (host && !out.includes(host)) {
      out.push(host);
    }
  }
  return out;
}

/** 保存値を検証し、欠けた項目・不正な値を初期値で補った設定オブジェクトを返す */
export function normalizeSettings(stored) {
  const src = stored && typeof stored === "object" ? stored : {};
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in src)) {
      continue;
    }
    const def = DEFAULT_SETTINGS[key];
    const val = src[key];
    if (key === "bindRoleItems") {
      out[key] = normalizeRoleItems(val);
    } else if (ENUMS[key]) {
      if (ENUMS[key].includes(val)) {
        out[key] = val;
      }
    } else if (Array.isArray(def)) {
      out[key] = normalizeSiteList(val);
    } else if (typeof def === "boolean") {
      if (typeof val === "boolean") {
        out[key] = val;
      }
    } else if (typeof def === "number") {
      const [lo, hi] = NUMBER_RANGES[key] || [-Infinity, Infinity];
      if (typeof val === "number" && Number.isFinite(val) && val >= lo && val <= hi) {
        out[key] = val;
      }
    } else if (key === "bindNameSuffix" || key === "bindObiSuffix") {
      if (typeof val === "string" && val.length <= 30 && !/[\\/:*?"<>|]/.test(val)) {
        out[key] = val;
      }
    } else if (key === "aiCopyShortcut") {
      if (typeof val === "string" && parseShortcut(val)) {
        out[key] = val;
      }
    } else if (typeof val === typeof def) {
      out[key] = val;
    }
  }
  out.bindRoleItems = normalizeRoleItems(out.bindRoleItems);
  return out;
}

/**
 * 古い版から更新したときの設定の引き継ぎ(拡張機能の更新時に1回だけ Service Worker が呼ぶ)。
 * 初期値が変わった項目は、前の版の初期値のままなら新しい初期値にする(自分で選んだ値はそのまま)。
 * @param {object|undefined} stored 保存されている設定
 * @param {string} previousVersion 更新前の版(例: "0.1.0")
 * @returns {object|null} 書き換えた設定(変えるものが無ければ null)
 */
export function migrateSettings(stored, previousVersion) {
  if (!stored || typeof stored !== "object" || !previousVersion || compareVersions(previousVersion, "0.7.0") >= 0) {
    return null;
  }
  const next = { ...stored };
  let changed = false;
  if (compareVersions(previousVersion, "0.2.0") < 0) {
    // 0.2: 印刷とコピーの初期値を「最高画質」「クリップボードへ」に、付属の出力ファイル名を「_付属」に
    const defaultsBefore12 = { printQuality: "auto", aiCopyMulti: "pdf", bindObiSuffix: "_帯" };
    for (const [key, oldDefault] of Object.entries(defaultsBefore12)) {
      if (next[key] === oldDefault) {
        next[key] = DEFAULT_SETTINGS[key];
        changed = true;
      }
    }
  }
  // 0.7.0: 画像にする画質を「dpi」を基本とした選び方に(元データ優先/300dpi/150dpi/指定するdpi)。
  // 旧の選び方を、dpi に換算して引き継ぐ(倍率1 = 96dpi。長辺px は A4 の長辺 297mm = 11.69in で換算する)
  if (next.imageQuality === "max") {
    next.imageQuality = "original";
    changed = true;
  }
  if (typeof next.imageDpi !== "number") {
    let dpi = 300;
    if (next.pngMode === "scale" && typeof next.pngScale === "number") {
      dpi = Math.round(next.pngScale * 96);
    } else if (next.pngMode === "longside" && typeof next.pngLongSide === "number" && next.pngLongSide > 0) {
      dpi = Math.round(next.pngLongSide / 11.69 / 10) * 10;
    }
    next.imageDpi = Math.min(1200, Math.max(100, dpi));
    changed = true;
  }
  return changed ? normalizeSettings(next) : null;
}

/** "0.2.0" のような版を比べる(a が新しければ正) */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(n => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) {
      return d;
    }
  }
  return 0;
}

/** 設定を読み込む(常に検証済みの完全なオブジェクトを返す) */
export async function loadSettings() {
  try {
    const items = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(items[SETTINGS_KEY]);
  } catch (e) {
    console.warn("[製本ビューア] 設定の読み込みに失敗したため初期値で動作します", e);
    return { ...DEFAULT_SETTINGS };
  }
}

/** 設定の一部を書き換えて保存し、保存後の設定を返す */
export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** 設定をすべて初期値に戻す */
export async function resetSettings() {
  const next = { ...DEFAULT_SETTINGS };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** 設定の変更を監視する。callback(新しい設定, 古い設定) */
export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area === "local" && changes[SETTINGS_KEY]) {
      callback(
        normalizeSettings(changes[SETTINGS_KEY].newValue),
        normalizeSettings(changes[SETTINGS_KEY].oldValue)
      );
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
