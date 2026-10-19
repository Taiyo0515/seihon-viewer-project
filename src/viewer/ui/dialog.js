/**
 * 確認ダイアログ(「はい / いいえ」を選んでもらう小さな画面)。
 */

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.message
 * @param {string} [o.okLabel]
 * @param {string} [o.cancelLabel]
 * @param {boolean} [o.danger] 取り消せない操作(赤いボタン)
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, okLabel = "OK", cancelLabel = "キャンセル", danger = false }) {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.className = "sh-dialog";
    const h = document.createElement("h2");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = message;
    const row = document.createElement("div");
    row.className = "sh-dialog-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "sh-btn";
    cancel.textContent = cancelLabel;
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = `sh-btn ${danger ? "sh-btn-danger" : "sh-btn-primary"}`;
    ok.textContent = okLabel;
    row.append(cancel, ok);
    dialog.append(h, p, row);
    document.body.append(dialog);
    let result = false;
    cancel.addEventListener("click", () => dialog.close());
    ok.addEventListener("click", () => {
      result = true;
      dialog.close();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    dialog.showModal();
    (danger ? cancel : ok).focus();
  });
}

/**
 * 3つ以上の選択肢から選んでもらうダイアログ(「保存する / 保存しない / キャンセル」など)。
 * Esc や枠の外での閉じ方は "cancel" を返す。
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.message
 * @param {Array<{id:string, label:string, kind?:"primary"|"danger"}>} o.buttons 左から順に並べる
 * @param {string} [o.defaultId] 最初に選ばれているボタン
 * @returns {Promise<string>} 押したボタンの id
 */
export function choiceDialog({ title, message, buttons, defaultId = null }) {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.className = "sh-dialog sh-choice-dialog";
    const h = document.createElement("h2");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = message;
    const row = document.createElement("div");
    row.className = "sh-dialog-buttons";
    let result = "cancel";
    let focusTarget = null;
    for (const b of buttons) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `sh-btn${b.kind === "primary" ? " sh-btn-primary" : b.kind === "danger" ? " sh-btn-danger-text" : ""}`;
      el.textContent = b.label;
      el.dataset.choice = b.id;
      el.addEventListener("click", () => {
        result = b.id;
        dialog.close();
      });
      row.append(el);
      if (b.id === defaultId) {
        focusTarget = el;
      }
    }
    dialog.append(h, p, row);
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    dialog.showModal();
    (focusTarget || row.lastElementChild)?.focus();
  });
}
