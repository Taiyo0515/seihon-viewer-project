/**
 * 画面中央のパネル(PDF未選択・エラー)、ドラッグ&ドロップ、小さな通知。
 */

import { hydrateIcons } from "../icons.js";

// ---------------------------------------------------------------------------
// 小さな通知(画面下部に数秒表示)
// ---------------------------------------------------------------------------
export class Toast {
  constructor() {
    this.host = document.getElementById("shToastHost");
  }

  /**
   * @param {string} message
   * @param {{duration?: number, action?: {label: string, onClick: Function}, actions?: Array<{label: string, onClick: Function}>,
   *          kind?: "info"|"error"}} [opts]
   *   duration に 0 を渡すと自動では消えない(処理中の表示など。戻り値の関数で消す)
   * @returns {Function} 通知を消す関数。dismiss.update(文字) で文字を差し替えられる
   */
  show(message, opts = {}) {
    // 古い通知が溜まりすぎないようにする
    const existing = this.host.querySelectorAll(".sh-toast");
    if (existing.length >= 3) {
      existing[0].remove();
    }
    const el = document.createElement("div");
    el.className = `sh-toast${opts.kind === "error" ? " sh-toast-error" : ""}`;
    el.setAttribute("role", opts.kind === "error" ? "alert" : "status");
    const text = document.createElement("span");
    text.textContent = message;
    el.append(text);
    const actions = [...(opts.action ? [opts.action] : []), ...(opts.actions || [])];
    if (actions.length) {
      const box = document.createElement("span");
      box.className = "sh-toast-actions";
      for (const action of actions) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "sh-toast-action";
        b.textContent = action.label;
        b.addEventListener("click", () => {
          action.onClick();
          dismiss();
        });
        box.append(b);
      }
      el.append(box);
    }
    this.host.append(el);
    requestAnimationFrame(() => el.classList.add("sh-show"));
    const dismiss = () => {
      el.classList.remove("sh-show");
      setTimeout(() => el.remove(), 250);
    };
    dismiss.update = msg => {
      text.textContent = msg;
    };
    const duration = opts.duration ?? 4000;
    if (duration > 0) {
      setTimeout(dismiss, duration);
    }
    return dismiss;
  }
}

// ---------------------------------------------------------------------------
// PDFを開いていないときの画面
// ---------------------------------------------------------------------------
export class EmptyState {
  constructor({ onOpenFile }) {
    this.el = document.getElementById("shEmpty");
    this.note = document.getElementById("shEmptyNote");
    document.getElementById("shEmptyOpen").addEventListener("click", onOpenFile);
  }

  show(note = "") {
    this.note.hidden = !note;
    this.note.textContent = note;
    this.el.hidden = false;
    document.body.classList.add("sh-no-document");
  }

  hide() {
    this.el.hidden = true;
    document.body.classList.remove("sh-no-document");
  }
}

// ---------------------------------------------------------------------------
// エラー表示
// ---------------------------------------------------------------------------
export class ErrorPanel {
  constructor() {
    this.el = document.getElementById("shError");
    this.title = document.getElementById("shErrorTitle");
    this.message = document.getElementById("shErrorMessage");
    this.steps = document.getElementById("shErrorSteps");
    this.buttons = document.getElementById("shErrorButtons");
    this.details = document.getElementById("shErrorDetails");
  }

  /**
   * @param {{title?: string, message: string, steps?: string[], details?: string,
   *          buttons?: {label: string, primary?: boolean, onClick: Function}[]}} info
   */
  show(info) {
    this.title.textContent = info.title || "PDFを表示できませんでした";
    this.message.textContent = info.message || "";
    this.steps.textContent = "";
    this.steps.hidden = !info.steps?.length;
    for (const step of info.steps || []) {
      const li = document.createElement("li");
      li.textContent = step;
      this.steps.append(li);
    }
    this.buttons.textContent = "";
    for (const b of info.buttons || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `sh-btn${b.primary ? " sh-btn-primary" : ""}`;
      btn.textContent = b.label;
      btn.addEventListener("click", b.onClick);
      this.buttons.append(btn);
    }
    this.details.textContent = info.details || "";
    this.details.parentElement.hidden = !info.details;
    this.el.hidden = false;
    document.body.classList.add("sh-has-error");
    hydrateIcons(this.el);
    this.buttons.querySelector(".sh-btn-primary")?.focus();
  }

  hide() {
    this.el.hidden = true;
    document.body.classList.remove("sh-has-error");
  }
}

// ---------------------------------------------------------------------------
// ドラッグ&ドロップでPDFを開く(ウィンドウ全体が対象)
// ---------------------------------------------------------------------------
export function setupDropZone({ onFile, onUrl }) {
  const overlay = document.getElementById("shDropOverlay");
  let depth = 0;

  const hasFiles = e => [...(e.dataTransfer?.types || [])].some(t => t === "Files" || t === "text/uri-list");

  window.addEventListener(
    "dragenter",
    e => {
      if (!hasFiles(e)) {
        return;
      }
      depth++;
      overlay.hidden = false;
    },
    true
  );
  window.addEventListener(
    "dragleave",
    () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        overlay.hidden = true;
      }
    },
    true
  );
  window.addEventListener(
    "dragover",
    e => {
      if (!hasFiles(e)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    },
    true
  );
  window.addEventListener(
    "drop",
    e => {
      depth = 0;
      overlay.hidden = true;
      if (!hasFiles(e)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const file = [...(e.dataTransfer.files || [])].find(
        f => f.type === "application/pdf" || /\.pdf$/i.test(f.name)
      );
      if (file) {
        onFile(file);
        return;
      }
      if (e.dataTransfer.files?.length) {
        onFile(null);
        return;
      }
      const url = (e.dataTransfer.getData("text/uri-list") || "").split(/\r?\n/).find(l => l && !l.startsWith("#"));
      if (url) {
        onUrl(url.trim());
      }
    },
    true
  );
}
