/**
 * 0.5: 「カバー・表紙・帯などのページ」の項目を編集する表(製本用PDF出力の画面の詳細設定と、拡張機能の詳細設定で使う)。
 *  - 表示: 製本用PDF出力の画面・右クリックの「ページ役割」・役割の一覧に出すか
 *  - 複数: 製本用PDF出力の画面で、複数のページを選べるか(カバーの表紙・裏表紙は1ページなので選べない)
 *  - 追加した項目は、名前・使い道を変えたり、消したりできる
 *  - ↑↓ で並びを変える
 */

import {
  COVER_IDS,
  MAX_CUSTOM_ROLES,
  MAX_ROLE_LABEL,
  ROLE_USE_VALUES,
  cleanRoleLabel,
  isBuiltinRole,
  nextCustomRoleId,
  normalizeRoleItems,
  roleItemLabel,
} from "../../common/role-items.js";

const USE_LABEL = {
  obi: "付属として出力",
  cover: "最初のページの候補",
  back: "最後のページの候補",
  none: "出力しない",
};

/**
 * @param {HTMLElement} container
 * @param {object} o
 * @param {() => Array} o.getItems いまの項目(設定 bindRoleItems)
 * @param {(items:Array) => Promise<void>|void} o.save 変えた項目を保存する
 * @param {string} [o.idPrefix] 部品の id の頭
 * @param {(message:string) => void} [o.notify]
 */
export function buildRoleItemsEditor(container, { getItems, save, idPrefix = "ri", notify = null }) {
  container.classList.add("sh-ri");
  // 保存の知らせが届く前に作り直しても古い内容に戻らないよう、いまの内容を手元に持つ
  let current = normalizeRoleItems(getItems());
  const render = () => {
    const items = current;
    container.textContent = "";
    const table = document.createElement("table");
    table.className = "sh-ri-table";
    const head = document.createElement("tr");
    for (const [text, cls] of [
      ["表示", "sh-ri-c-show"],
      ["項目", "sh-ri-c-name"],
      ["複数", "sh-ri-c-multi"],
      ["使い道", "sh-ri-c-use"],
      ["", "sh-ri-c-ops"],
    ]) {
      const th = document.createElement("th");
      th.textContent = text;
      th.className = cls;
      th.scope = "col";
      head.append(th);
    }
    const thead = document.createElement("thead");
    thead.append(head);
    const tbody = document.createElement("tbody");
    table.append(thead, tbody);

    const commit = async (next, message = null) => {
      current = normalizeRoleItems(next);
      render();
      await save(current);
      if (message) {
        notify?.(message);
      }
    };

    items.forEach((item, index) => {
      const builtin = isBuiltinRole(item.id);
      const tr = document.createElement("tr");
      tr.dataset.roleId = item.id;
      // 表示
      const show = document.createElement("input");
      show.type = "checkbox";
      show.checked = item.show;
      show.id = `${idPrefix}-show-${item.id}`;
      show.setAttribute("aria-label", `「${roleItemLabel(item)}」を表示する`);
      show.addEventListener("change", () => commit(items.map(x => (x.id === item.id ? { ...x, show: show.checked } : x))));
      // 項目の名前
      let name;
      if (builtin) {
        name = document.createElement("label");
        name.htmlFor = show.id;
        name.textContent = roleItemLabel(item);
      } else {
        name = document.createElement("input");
        name.type = "text";
        name.className = "sh-ri-name";
        name.value = item.label;
        name.maxLength = MAX_ROLE_LABEL;
        name.setAttribute("aria-label", "項目の名前");
        name.addEventListener("change", () => {
          const label = cleanRoleLabel(name.value);
          if (!label || items.some(x => x.id !== item.id && roleItemLabel(x) === label)) {
            notify?.(label ? `「${label}」はもうあります` : "名前を入れてください");
            name.value = item.label;
            return;
          }
          commit(items.map(x => (x.id === item.id ? { ...x, label } : x)));
        });
      }
      // 複数
      const multi = document.createElement("input");
      multi.type = "checkbox";
      multi.checked = item.multi;
      multi.id = `${idPrefix}-multi-${item.id}`;
      const cover = COVER_IDS.includes(item.id);
      multi.disabled = cover;
      multi.title = cover ? "本の最初・最後のページなので、1ページだけです" : "製本用PDF出力の画面で、複数のページを選べるようにします";
      multi.setAttribute("aria-label", `「${roleItemLabel(item)}」で複数のページを選べる`);
      multi.addEventListener("change", () => commit(items.map(x => (x.id === item.id ? { ...x, multi: multi.checked } : x))));
      // 使い道(追加した項目だけ。決まった項目は「付属の出力」の欄で変える)
      let use;
      if (builtin) {
        use = document.createElement("span");
        use.className = "sh-ri-muted";
        use.textContent = cover ? (item.id === "cover" ? "本の最初のページ" : "本の最後のページ") : "「付属の出力」の欄で";
      } else {
        use = document.createElement("select");
        use.className = "sh-select sh-select-small";
        use.setAttribute("aria-label", `「${item.label}」の使い道`);
        for (const v of ROLE_USE_VALUES) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = USE_LABEL[v];
          use.append(o);
        }
        use.value = item.use;
        use.addEventListener("change", () => commit(items.map(x => (x.id === item.id ? { ...x, use: use.value } : x))));
      }
      // 並べ替え・削除
      const ops = document.createElement("span");
      ops.className = "sh-ri-ops";
      const move = (delta, label) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "sh-ri-btn";
        b.textContent = delta < 0 ? "↑" : "↓";
        b.title = label;
        b.setAttribute("aria-label", `「${roleItemLabel(item)}」を${label}`);
        const to = index + delta;
        b.disabled = to < 0 || to >= items.length;
        b.addEventListener("click", () => {
          const next = [...items];
          [next[index], next[to]] = [next[to], next[index]];
          commit(next);
        });
        return b;
      };
      ops.append(move(-1, "上へ"), move(1, "下へ"));
      if (!builtin) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "sh-ri-btn sh-ri-del";
        del.textContent = "削除";
        del.setAttribute("aria-label", `「${item.label}」を削除`);
        del.addEventListener("click", () => {
          if (!confirm(`「${item.label}」の項目を削除しますか?\nこの項目を付けたページは、役割の無いページ(本文)に戻ります。`)) {
            return;
          }
          commit(
            items.filter(x => x.id !== item.id),
            `「${item.label}」を削除しました`
          );
        });
        ops.append(del);
      }
      for (const [el, cls] of [
        [show, "sh-ri-c-show"],
        [name, "sh-ri-c-name"],
        [multi, "sh-ri-c-multi"],
        [use, "sh-ri-c-use"],
        [ops, "sh-ri-c-ops"],
      ]) {
        const td = document.createElement("td");
        td.className = cls;
        td.append(el);
        tr.append(td);
      }
      tbody.append(tr);
    });

    // 追加
    const add = document.createElement("div");
    add.className = "sh-ri-add";
    const input = document.createElement("input");
    input.type = "text";
    input.id = `${idPrefix}-new`;
    input.className = "sh-ri-name";
    input.placeholder = "新しい項目の名前(例: 口絵)";
    input.maxLength = MAX_ROLE_LABEL;
    input.setAttribute("aria-label", "新しい項目の名前");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = `${idPrefix}-add`;
    btn.className = "sh-btn sh-btn-small";
    btn.textContent = "項目を追加";
    const customs = items.filter(x => !isBuiltinRole(x.id)).length;
    btn.disabled = customs >= MAX_CUSTOM_ROLES;
    const doAdd = () => {
      const label = cleanRoleLabel(input.value);
      if (!label) {
        notify?.("項目の名前を入れてください");
        input.focus();
        return;
      }
      if (items.some(x => roleItemLabel(x) === label)) {
        notify?.(`「${label}」はもうあります`);
        input.focus();
        return;
      }
      commit([...items, { id: nextCustomRoleId(items), label, show: true, multi: true, use: "obi" }], `「${label}」を追加しました(付属として出力します)`);
    };
    btn.addEventListener("click", doAdd);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        doAdd();
      }
    });
    add.append(input, btn);
    const help = document.createElement("p");
    help.className = "sh-ri-help";
    help.textContent =
      "「表示」を外した項目は、製本用PDF出力の画面や右クリックの「ページ役割」に出しません(すでに付けたページの役割はそのまま使います)。" +
      "「複数」にした項目は、製本用PDF出力の画面で何ページでも選べます。追加した項目のページは、使い道に合わせて付属などとして出力します。";
    container.append(table, add, help);
  };
  render();
  return {
    render,
    /** 設定から読み直して作り直す */
    reload() {
      current = normalizeRoleItems(getItems());
      render();
    },
  };
}
