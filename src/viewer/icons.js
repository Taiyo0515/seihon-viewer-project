/** 製本ビューアの操作に使う線画アイコン。 */
const SVG_NS = "http://www.w3.org/2000/svg";

/** 線画アイコン(viewBox 0 0 24 24、線) */
function s(body) {
  return { viewBox: "0 0 24 24", fill: false, body };
}

export const ICONS = {
  "menu": s('<path d="M3 5h18v14H3z M9 5v14 M5.5 9h1 M5.5 12h1"/>'),
  "remove": s('<path d="M5 12h14"/>'),
  "add": s('<path d="M5 12h14 M12 5v14"/>'),
  "fit-page-height": s('<path d="M5 3h14 M5 21h14 M12 6v12 m-3-9 3-3 3 3 m-6 6 3 3 3-3"/>'),
  "fit-page-width": s('<path d="M3 5v14 M21 5v14 M6 12h12 M9 9l-3 3 3 3 M15 9l3 3-3 3"/>'),
  "rotate-ccw": s('<path d="M4 9a8 8 0 1 1 .8 9 M4 4v5h5"/>'),
  "undo": s('<path d="M9 5 3 10l6 5 M4 10h10c6 0 7 5 5 9"/>'),
  "redo": s('<path d="m15 5 6 5-6 5 M20 10h-10c-6 0-7 5-5 9"/>'),
  "print": s('<path d="M7 8V3h10v5 M7 17H3V9h18v8h-4 M7 14h10v7H7z M16 11h2"/>'),
  "more-vert": s('<path d="M4 12h2 M11 12h2 M18 12h2"/>'),
  "check": s('<path d="m4 12 5 5L20 6"/>'),
  "image": s('<path d="M3 4h18v16H3z M3 17l5-5 4 3 4-6 5 6 M7 8h1"/>'),
  "list-alt": s('<path d="M5 3h14v18H5z M8 8h1m3 0h4m-8 4h1m3 0h4m-8 4h1m3 0h4"/>'),
  "attach-file": s('<path d="m8 14 7-8a3 3 0 0 1 5 4l-9 10a5 5 0 0 1-7-7l9-10"/>'),
  "fullscreen-exit": s('<path d="M3 8h5V3 M21 8h-5V3 M3 16h5v5 M21 16h-5v5"/>'),
  "gesture": s('<path d="M3 18c8-15 12-19 11-12-1 5-9 12-7 12 3 0 7-8 8-6s-2 5 0 5 4-1 6-2"/>'),
  "text-fields": s('<path d="M3 5h12 M9 5v14 M6 19h6 M15 10h6 M18 10v9"/>'),
  "ink-pen": s('<path d="m4 16 11-12 5 4L9 20l-6 1z M13 7l5 4"/>'),
  "ink-pen-filled": s('<path d="m4 16 11-12 5 4L9 20l-6 1z M13 7l5 4" fill="currentColor"/>'),
  "ink-highlighter": s('<path d="m5 13 9-10 7 6-9 10z M8 16l-4 4h4l3-2"/>'),
  "ink-highlighter-filled": s('<path d="m5 13 9-10 7 6-9 10z M8 16l-4 4h4l3-2" fill="currentColor"/>'),
  "ink-eraser": s('<path d="m3 14 11-11 7 7-10 11H9z M7 10l7 7 M14 21h6"/>'),
  "ink-eraser-filled": s('<path d="m3 14 11-11 7 7-10 11H9z M7 10l7 7 M14 21h6" fill="currentColor"/>'),
  "download": s('<path d="M12 3v12m-5-5 5 5 5-5 M4 16v5h16v-5"/>'),
  "rotate-cw": s('<path d="M20 9a8 8 0 1 0-.8 9 M20 4v5h-5"/>'),
  // ---- 以下、この拡張用の線画アイコン ----
  "view-book": s('<path d="M12 6.8c-1.8-1.5-4.6-2.3-8-2.3v13c3.4 0 6.2.8 8 2.3 1.8-1.5 4.6-2.3 8-2.3v-13c-3.4 0-6.2.8-8 2.3Z"/><path d="M12 6.8v13"/>'),
  "view-spread": s('<rect x="2.5" y="5" width="9" height="14" rx="1"/><rect x="12.5" y="5" width="9" height="14" rx="1"/>'),
  "view-single": s('<rect x="6.5" y="3.5" width="11" height="17" rx="1"/>'),
  "book-large": s('<path d="M12 6.8c-1.8-1.5-4.6-2.3-8-2.3v13c3.4 0 6.2.8 8 2.3 1.8-1.5 4.6-2.3 8-2.3v-13c-3.4 0-6.2.8-8 2.3Z"/><path d="M12 6.8v13"/>'),
  "open-native": s('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8.5h18"/><path d="M12 18v-6"/><path d="m9.3 14.2 2.7-2.7 2.7 2.7"/>'),
  "folder-open": s('<path d="M3.5 8V6.2c0-.9.7-1.7 1.7-1.7h3.7l2 2h7.9c.9 0 1.7.8 1.7 1.7V9"/><path d="M3 19.5 5.3 11c.2-.6.8-1.1 1.4-1.1H21l-2.3 8.5c-.2.6-.8 1.1-1.4 1.1H3Z"/>'),
  "tune": s('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  "present": s('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
  "first-page": s('<path d="M6.5 5v14"/><path d="M17.5 6 11 12l6.5 6"/>'),
  "last-page": s('<path d="M17.5 5v14"/><path d="M6.5 6 13 12l-6.5 6"/>'),
  "hand": s('<path d="M8 13V6a1.5 1.5 0 0 1 3 0v5M11 10.5V4.8a1.5 1.5 0 0 1 3 0V11M14 11V6.3a1.5 1.5 0 0 1 3 0V14c0 3.9-2.4 6.5-6 6.5-2.5 0-4-1-5.4-3l-2.4-3.4a1.4 1.4 0 0 1 2.2-1.7L8 14"/>'),
  "text-cursor": s('<path d="M9 4.5c1.7 0 3 .6 3 2v11c0 1.4-1.3 2-3 2M15 4.5c-1.7 0-3 .6-3 2M15 19.5c-1.7 0-3-.6-3-2M9.5 12h5"/>'),
  "info": s('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.7v.1"/>'),
  "chevron-up": s('<path d="m6 15 6-6 6 6"/>'),
  "chevron-down": s('<path d="m6 9 6 6 6-6"/>'),
  "close": s('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  "error": s('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v6"/><path d="M12 16.6v.1"/>'),
  "layers": s('<path d="m12 4 9 5-9 5-9-5 9-5Z"/><path d="m3 14 9 5 9-5"/>'),
  "speed": s('<path d="M5.6 18.4a9 9 0 1 1 12.8 0"/><path d="m12 13 3.5-4"/>'),
  "settings": s('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  "binding-ltr": s('<path d="M4 5h7v14H4zM13 5h7v14h-7z"/><path d="m8 12-2 0M18 12h-2"/><path d="M6.5 9.5 4.5 12l2 2.5"/>'),
  // ---- 0.2: 綴じ方向(左綴じ = 綴じ目が左、→ の向きに読み進める / 右綴じ = 綴じ目が右、← の向き)・元の場所 ----
  "bind-ltr": s('<rect x="5.5" y="3.5" width="13" height="17" rx="1.5"/><path d="M8.5 3.5v17" stroke-width="2.6"/><path d="M11.5 12h4.5M14 9.5l2.5 2.5-2.5 2.5"/>'),
  "bind-rtl": s('<rect x="5.5" y="3.5" width="13" height="17" rx="1.5"/><path d="M15.5 3.5v17" stroke-width="2.6"/><path d="M12.5 12H8M10 9.5 7.5 12l2.5 2.5"/>'),
  // 0.3 スキャンの整え: 見開きを真ん中で分ける / ばらした冊子を並べ替える
  "scan-split": s('<rect x="2.5" y="5.5" width="19" height="13" rx="1.2"/><path d="M12 3.5v17" stroke-dasharray="2.2 1.8"/><path d="M5.5 9.5h3.5M5.5 12h3.5M15 9.5h3.5M15 12h3.5"/>'),
  "scan-booklet": s('<path d="M4.5 4.5h7v15h-7z"/><path d="M12.5 4.5h7v15h-7z"/><path d="M8 9.5v5M6.5 11l1.5-1.5 1.5 1.5M16 9.5v5M14.5 13l1.5 1.5 1.5-1.5"/>'),
  "link": s('<path d="M10 13.5a4 4 0 0 0 5.66.34l2.83-2.83a4 4 0 0 0-5.66-5.66l-1.4 1.4"/><path d="M14 10.5a4 4 0 0 0-5.66-.34l-2.83 2.83a4 4 0 0 0 5.66 5.66l1.4-1.4"/>'),
  "arrow-drop-down": s('<path d="m8 10 4 4 4-4"/>'),
  "file-pdf": s('<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M8.5 13h7M8.5 16h5"/>'),
  // ---- フェーズ2: コピー・ページ収集 ----
  "collect": s('<rect x="7.5" y="3.5" width="13" height="13" rx="1.5"/><path d="M4 7.5V18a2.5 2.5 0 0 0 2.5 2.5H17"/><path d="M14 6.8v6.4M10.8 10h6.4"/>'),
  "collect-remove": s('<rect x="7.5" y="3.5" width="13" height="13" rx="1.5"/><path d="M4 7.5V18a2.5 2.5 0 0 0 2.5 2.5H17"/><path d="M10.8 10h6.4"/>'),
  "ai-copy": s('<rect x="8.5" y="8.5" width="12" height="12" rx="1.5"/><path d="M15.5 8.5V5A1.5 1.5 0 0 0 14 3.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/><path d="M14.5 11.3l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>'),
  "copy": s('<rect x="8.5" y="8.5" width="12" height="12" rx="1.5"/><path d="M15.5 8.5V5A1.5 1.5 0 0 0 14 3.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/>'),
  "file-png": s('<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="m8 17.5 2.6-3 1.9 2 1.4-1.5 2.1 2.5"/><path d="M10.5 11.2v.1"/>'),
  "file-zip": s('<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M10 5v1.6M11.4 7.4V9M10 9.8v1.6M11.4 12.2v1.6"/><rect x="9.6" y="15" width="2.2" height="2.6" rx=".5"/>'),
  "arrow-up": s('<path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5"/>'),
  "arrow-down": s('<path d="M12 5v13.5M6.5 13l5.5 5.5 5.5-5.5"/>'),
  "delete": s('<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2"/><path d="M6.5 6.5l1 13.5h9l1-13.5"/><path d="M10 10.5v6M14 10.5v6"/>'),
  "drag": s('<path d="M9 6.5h.01M15 6.5h.01M9 12h.01M15 12h.01M9 17.5h.01M15 17.5h.01" stroke-width="3"/>'),
  // ---- フェーズ3: ページ役割・製本用PDF出力 ----
  "bind-output": s('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M12 4v16" stroke-dasharray="2 2"/><path d="M6 8h3M6 11h3M15 13h3M15 16h3"/>'),
  "label": s('<path d="M3.5 11.6V4.8c0-.7.6-1.3 1.3-1.3h6.8l8.6 8.6c.5.5.5 1.4 0 1.9l-6.8 6.8c-.5.5-1.4.5-1.9 0Z"/><circle cx="8" cy="8" r="1.4"/>'),
  "select-off": s('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m9 9 6 6M15 9l-6 6"/>'),
  // ---- 0.1: ページの選択・削除・保存 ----
  "select": s('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8.2 12.2 2.6 2.6 5-5.4"/>'),
  "save": s('<path d="M5.2 4h10.6L20 8.2v10.6c0 .7-.5 1.2-1.2 1.2H5.2c-.7 0-1.2-.5-1.2-1.2V5.2C4 4.5 4.5 4 5.2 4Z"/><path d="M8 4v4.5h7V4"/><rect x="7.5" y="13" width="9" height="7"/>'),
  // ---- 0.4: 電子書籍リーダー ----
  "search": s('<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5.5 5.5"/>'),
  "swap-vert": s('<path d="M8 4v15M4.5 7.5 8 4l3.5 3.5M16 20V5M12.5 16.5 16 20l3.5-3.5"/>'),
  "chevron-left": s('<path d="m14.5 6-6 6 6 6"/>'),
  "chevron-right": s('<path d="m9.5 6 6 6-6 6"/>'),
  "font-minus": s('<path d="M3.5 18 8 6l4.5 12M5.2 14h5.6"/><path d="M15 12h6"/>'),
  "font-plus": s('<path d="M3.5 18 8 6l4.5 12M5.2 14h5.6"/><path d="M15 12h6M18 9v6"/>'),
  "theme": s('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor"/>'),
  "toc": s('<path d="M4 6.5h.01M4 12h.01M4 17.5h.01" stroke-width="2.6"/><path d="M8 6.5h12M8 12h12M8 17.5h9"/>'),
  "ebook": s('<path d="M6 3.5h10.5a1.5 1.5 0 0 1 1.5 1.5v14.5H7.5A1.5 1.5 0 0 1 6 18Z"/><path d="M6 18a1.5 1.5 0 0 1 1.5-1.5H18"/><path d="M9.5 7.5h5M9.5 10.5h5"/>'),
};

/** アイコン名から <svg> 要素を作る */
export function createIcon(name) {
  const def = ICONS[name];
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", def ? def.viewBox : "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("sh-icon");
  if (def) {
    if (def.fill) {
      svg.setAttribute("fill", "currentColor");
    } else {
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "1.8");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
    }
    // 中身は固定の定義文字列のみ(外部入力は入らない)
    svg.innerHTML = def.body;
  }
  return svg;
}

/** root 以下の data-icon 属性を持つ要素にアイコンを入れる */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    setIcon(el, el.getAttribute("data-icon"));
  }
}

/** 要素のアイコンを差し替える */
export function setIcon(el, name) {
  el.setAttribute("data-icon", name);
  el.querySelector(":scope > svg.sh-icon")?.remove();
  el.prepend(createIcon(name));
}
