/**
 * テーマ(ライト/ダーク)の切り替え。ビューア・詳細設定・案内画面で共通に使う。
 *
 * - 設定値 "system" はシステム(OS)のライト/ダークに追従する。
 * - 起動直後のちらつきを防ぐため、最後に使った設定値を localStorage にも控えておく
 *   (localStorage が使えない環境では単に毎回 "system" から始まる)。
 */

const CACHE_KEY = "seihon.themePreference";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let currentPreference = "system";

export function readCachedThemePreference() {
  try {
    return localStorage.getItem(CACHE_KEY) || "system";
  } catch {
    return "system";
  }
}

function cacheThemePreference(pref) {
  try {
    localStorage.setItem(CACHE_KEY, pref);
  } catch {
    // 保存できなくても動作には影響しない
  }
}

/** 設定値("system" / "light" / "dark")を画面に反映する */
export function applyThemePreference(pref) {
  currentPreference = pref === "light" || pref === "dark" ? pref : "system";
  const theme =
    currentPreference === "system" ? (darkQuery.matches ? "dark" : "light") : currentPreference;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themePreference = currentPreference;
  root.style.colorScheme = theme;
  cacheThemePreference(currentPreference);
  return theme;
}

darkQuery.addEventListener("change", () => {
  if (currentPreference === "system") {
    applyThemePreference("system");
  }
});
