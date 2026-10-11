/**
 * 設定の定義と読み書き。
 *
 * - 保存先は chrome.storage.local の "settings" キー(1つのオブジェクト)。
 * - Service Worker・ビューア・詳細設定画面・初回案内画面で共通に使う。
 * - 値の検証(normalizeSettings)を必ず通してから使うので、
 *   古い版の設定や手で壊れた値が入っていても初期値に戻して動く。
 */

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
  /** 同じPDFを再び開いたとき、前回見ていた位置から表示する */
  restorePosition: true,
  /** テーマ: "system" システムに従う / "light" / "dark" */
  theme: "system",
  /**
   * 印刷の画質(ビューアはページを画像にして印刷する):
   * "auto" 50ページまでは高画質、それより多いときは標準 / "standard" 150dpi / "high" 300dpi
   */
  printQuality: "auto",

  // ---- 強制ダウンロード対策 ----
  /** 「表示せずダウンロード」させるサイトでもビューアで開く */
  guardEnabled: true,
  /** 強制ダウンロード対策の対象外にするサイト */
  guardExcludeSites: [],

  /** 強制ダウンロードされたPDFをビューアで開いた後の元ファイル(第3層): "keep" 残す / "delete" 削除 */
  guardOriginalFile: "keep",

  // ---- AI用コピー ----
  /** 1ページのとき: "clipboard-png" PNGをクリップボードへ / "file-pdf" PDFを保存 / "file-png" PNGを保存 */
  aiCopySingle: "clipboard-png",
  /** 複数ページのとき: "pdf" PDFを保存 / "zip" PNG群をZIPで保存 */
  aiCopyMulti: "pdf",
  /** PNGの大きさの指定方法: "longside" 長辺ピクセル / "scale" 倍率 */
  pngMode: "longside",
  /** 長辺ピクセル(文字が潰れない高め。A4 で約 205dpi、A5・B5 で約 240〜290dpi) */
  pngLongSide: 2400,
  /** 倍率(1 = ビューアの100%表示と同じ大きさ = 96dpi。3 なら 288dpi) */
  pngScale: 3,
  /** AI用コピーのショートカット(ビューア内) */
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
  /** ページの大きさがそろっていないときの基準: "mode" 最も多い大きさ / "first" 最初のページ */
  bindSizeRef: "mode",
  /** 帯の出力: "separate" 別の PDF / "append" 本体の後ろに同梱 / "none" 出力しない */
  bindObiOutput: "separate",
  /**
   * 帯の役割のページの使い道(帯の運用が違う場合に、割り当てを変えられるようにする)。
   * "obi" 帯として出力 / "cover" 表紙の候補にする / "back" 裏表紙の候補にする / "none" 出力しない
   */
  bindUseObiFront: "obi",
  bindUseObi: "obi",
  bindUseObiBack: "obi",
  /** 出力ファイル名に付ける言葉(元名_製本.pdf / 元名_製本_面付け.pdf) */
  bindNameSuffix: "_製本",
  /** 帯の出力ファイル名に付ける言葉(元名_帯.pdf) */
  bindObiSuffix: "_帯",

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
  theme: "テーマ",
  printQuality: "印刷の画質",
  guardEnabled: "強制ダウンロード対策",
  guardExcludeSites: "対策の対象外にするサイト",
  guardOriginalFile: "強制ダウンロード時の元ファイル",
  aiCopySingle: "AI用コピー(1ページ)",
  aiCopyMulti: "AI用コピー(複数ページ)",
  pngMode: "PNG の解像度の指定方法",
  pngLongSide: "PNG の長辺",
  pngScale: "PNG の倍率",
  aiCopyShortcut: "AI用コピーのショートカット",
  collectClearAfterExport: "書き出し後の収集",
  collectLimitMB: "収集の保存上限",
  bindBlankPosition: "白紙を入れる位置",
  bindImpose: "面付け",
  bindPaper: "出力用紙",
  bindDuplex: "両面の綴じ方向",
  bindSizeRef: "大きさがそろっていないとき",
  bindObiOutput: "帯の出力",
  bindUseObiFront: "帯表紙の使い道",
  bindUseObi: "帯の使い道",
  bindUseObiBack: "帯裏表紙の使い道",
  bindNameSuffix: "出力ファイル名(本体)",
  bindObiSuffix: "出力ファイル名(帯)",
  perfLog: "速度ログ",
});

const ENUMS = {
  launchMode: ["auto", "manual"],
  initialView: ["book", "spread", "single"],
  bindingDirection: ["ltr", "rtl"],
  theme: ["system", "light", "dark"],
  printQuality: ["auto", "standard", "high"],
  guardOriginalFile: ["keep", "delete"],
  aiCopySingle: ["clipboard-png", "file-pdf", "file-png"],
  aiCopyMulti: ["pdf", "zip"],
  pngMode: ["longside", "scale"],
  bindBlankPosition: ["beforeBack", "afterCover", "custom"],
  bindPaper: ["auto", "A3", "A4", "A5", "B4", "B5", "Letter", "Tabloid", "double"],
  bindDuplex: ["short", "long"],
  bindSizeRef: ["mode", "first"],
  bindObiOutput: ["separate", "append", "none"],
  bindUseObiFront: ["obi", "cover", "back", "none"],
  bindUseObi: ["obi", "cover", "back", "none"],
  bindUseObiBack: ["obi", "cover", "back", "none"],
};

/** 数値設定の範囲(範囲外は初期値に戻す) */
const NUMBER_RANGES = {
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
    if (ENUMS[key]) {
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
  return out;
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
