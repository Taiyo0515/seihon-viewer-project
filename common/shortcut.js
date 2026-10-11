/**
 * ショートカットキーの表記(例: "Ctrl+Shift+C")の読み取りと判定。
 * Mac では「Ctrl」は ⌘(Command)キーとしても受け付ける。
 */

const IS_MAC = /Mac/i.test(globalThis.navigator?.platform || "");
const MODIFIERS = ["Ctrl", "Alt", "Shift"];

/** 表記を { ctrl, alt, shift, key } に分解する。不正なら null */
export function parseShortcut(spec) {
  const parts = String(spec || "")
    .split("+")
    .map(s => s.trim())
    .filter(Boolean);
  if (!parts.length) {
    return null;
  }
  const key = parts.pop();
  if (MODIFIERS.includes(key) || !parts.every(p => MODIFIERS.includes(p))) {
    return null;
  }
  return {
    ctrl: parts.includes("Ctrl"),
    alt: parts.includes("Alt"),
    shift: parts.includes("Shift"),
    key: key.length === 1 ? key.toUpperCase() : key,
  };
}

/** キーボードイベントが指定のショートカットか */
export function matchesShortcut(e, spec) {
  const s = parseShortcut(spec);
  if (!s) {
    return false;
  }
  const ctrl = IS_MAC ? e.metaKey || e.ctrlKey : e.ctrlKey;
  if (ctrl !== s.ctrl || e.altKey !== s.alt || e.shiftKey !== s.shift || (!IS_MAC && e.metaKey)) {
    return false;
  }
  if (/^[A-Z]$/.test(s.key)) {
    return e.code === `Key${s.key}` || (e.key || "").toUpperCase() === s.key;
  }
  if (/^[0-9]$/.test(s.key)) {
    return e.code === `Digit${s.key}` || e.key === s.key;
  }
  return (e.key || "").toLowerCase() === s.key.toLowerCase();
}

/**
 * キーボードイベントから表記を作る(設定画面でキーを押して登録するとき)。
 * 修飾キー(Ctrl / Alt)の無いものは、文字入力と区別できないので受け付けない(F1〜F12 は可)。
 * @returns {string|null}
 */
export function shortcutFromEvent(e) {
  const key = e.key;
  if (!key || ["Control", "Shift", "Alt", "Meta", "Process", "Dead", "Unidentified"].includes(key)) {
    return null;
  }
  let main;
  if (/^Key[A-Z]$/.test(e.code)) {
    main = e.code.slice(3);
  } else if (/^Digit[0-9]$/.test(e.code)) {
    main = e.code.slice(5);
  } else if (/^F([1-9]|1[0-2])$/.test(key)) {
    main = key;
  } else {
    return null;
  }
  const ctrl = IS_MAC ? e.metaKey || e.ctrlKey : e.ctrlKey;
  const isFn = /^F\d+$/.test(main);
  if (!ctrl && !e.altKey && !isFn) {
    return null;
  }
  const parts = [];
  if (ctrl) {
    parts.push("Ctrl");
  }
  if (e.altKey) {
    parts.push("Alt");
  }
  if (e.shiftKey) {
    parts.push("Shift");
  }
  parts.push(main);
  return parts.join("+");
}

/** Chrome やビューアがすでに使っているため、避けたほうがよい組み合わせ */
export const RESERVED_SHORTCUTS = new Set([
  "Ctrl+A", "Ctrl+C", "Ctrl+F", "Ctrl+N", "Ctrl+O", "Ctrl+P", "Ctrl+R", "Ctrl+S", "Ctrl+T", "Ctrl+V",
  "Ctrl+W", "Ctrl+X", "Ctrl+Z", "Ctrl+Y", "Ctrl+0", "Ctrl+L", "Ctrl+D", "Ctrl+G", "Ctrl+H", "Ctrl+J",
  "Ctrl+K", "Ctrl+E", "Ctrl+U", "Ctrl+Shift+N", "Ctrl+Shift+T", "Ctrl+Shift+W", "Ctrl+Shift+I",
  "Ctrl+Shift+J", "Ctrl+Shift+B", "Ctrl+Shift+O", "Ctrl+Shift+A", "Ctrl+Shift+R", "Ctrl+Shift+G",
  "Ctrl+Shift+Z", "Ctrl+Shift+V", "Ctrl+Shift+Q", "Ctrl+Shift+M", "Ctrl+Shift+D", "Ctrl+Alt+P", "F1",
  "F3", "F5", "F6", "F7", "F11", "F12",
]);
