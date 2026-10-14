/**
 * 0.5: 製本用PDF出力の「カバー・表紙・帯などのページ」の項目(ページ役割)の並び・表示・複数選択の可否・追加した項目。
 *
 * 設定 bindRoleItems に、次の形の配列で保存する(並びは画面に出す順):
 *   { id, label?, show, multi, use? }
 *   - 決まった項目(cover・back・obiFront・obiBack・obi・flapFront・flapBack・bookmark)は消せない(show で隠せる)。
 *     名前は決まったまま(label は持たない)。使い道は今までどおり bindUse○○ の設定。
 *   - 追加した項目は id が "custom1" のような形。label(名前)と use(使い道)を持ち、消せる。
 *   - multi: 製本用PDF出力の画面で、複数のページを選べる(カバーの表紙・裏表紙は本の最初・最後の1ページなので選べない)。
 */

export const BUILTIN_ROLES = Object.freeze([
  { id: "cover", label: "カバーの表紙", short: "カバー表" },
  { id: "back", label: "カバーの裏表紙", short: "カバー裏" },
  { id: "obiFront", label: "表紙", short: "表紙" },
  { id: "obiBack", label: "裏表紙", short: "裏表紙" },
  { id: "obi", label: "帯", short: "帯" },
  { id: "flapFront", label: "表紙の折り返し", short: "表折返" },
  { id: "flapBack", label: "裏表紙の折り返し", short: "裏折返" },
  { id: "bookmark", label: "しおり", short: "しおり" },
]);
const BUILTIN_IDS = new Set(BUILTIN_ROLES.map(r => r.id));
/** 本の最初・最後のページになる項目(1ページだけ。複数選択にはできない) */
export const COVER_IDS = Object.freeze(["cover", "back"]);
export const ROLE_USE_VALUES = Object.freeze(["obi", "cover", "back", "none"]);
export const MAX_CUSTOM_ROLES = 20;
export const MAX_ROLE_LABEL = 20;

export const DEFAULT_ROLE_ITEMS = Object.freeze(BUILTIN_ROLES.map(r => Object.freeze({ id: r.id, show: true, multi: r.id === "obi" })));

export function isBuiltinRole(id) {
  return BUILTIN_IDS.has(id);
}

export function isCustomRoleId(id) {
  return typeof id === "string" && /^custom\d{1,4}$/.test(id);
}

/** 名前を整える(前後の空白を除き、長すぎれば切る)。使えなければ "" */
export function cleanRoleLabel(label) {
  return String(label ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ROLE_LABEL);
}

/** 保存値を検証して、決まった項目がすべてそろった配列にする */
export function normalizeRoleItems(value) {
  const out = [];
  const seen = new Set();
  const labels = new Set(BUILTIN_ROLES.map(r => r.label));
  let customs = 0;
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== "object" || seen.has(raw.id)) {
      continue;
    }
    if (isBuiltinRole(raw.id)) {
      out.push({ id: raw.id, show: raw.show !== false, multi: COVER_IDS.includes(raw.id) ? false : !!raw.multi });
      seen.add(raw.id);
    } else if (isCustomRoleId(raw.id) && customs < MAX_CUSTOM_ROLES) {
      const label = cleanRoleLabel(raw.label);
      if (!label || labels.has(label)) {
        continue;
      }
      labels.add(label);
      customs++;
      out.push({
        id: raw.id,
        label,
        show: raw.show !== false,
        multi: !!raw.multi,
        use: ROLE_USE_VALUES.includes(raw.use) ? raw.use : "obi",
      });
      seen.add(raw.id);
    }
  }
  // 足りない決まった項目は、初期値の位置(前の項目の後ろ)に入れる
  DEFAULT_ROLE_ITEMS.forEach((def, k) => {
    if (seen.has(def.id)) {
      return;
    }
    const prev = DEFAULT_ROLE_ITEMS.slice(0, k)
      .reverse()
      .find(d => seen.has(d.id));
    const at = prev ? out.findIndex(x => x.id === prev.id) + 1 : 0;
    out.splice(at, 0, { ...def });
    seen.add(def.id);
  });
  return out;
}

/** 新しく追加する項目の id */
export function nextCustomRoleId(items) {
  let n = 1;
  const used = new Set(items.map(i => i.id));
  while (used.has(`custom${n}`)) {
    n++;
  }
  return `custom${n}`;
}

/** 項目の名前 */
export function roleItemLabel(item) {
  return BUILTIN_ROLES.find(r => r.id === item.id)?.label || item.label || item.id;
}

/** 項目の短い名前(サムネイルのバッジ) */
export function roleItemShort(item) {
  const b = BUILTIN_ROLES.find(r => r.id === item.id);
  if (b) {
    return b.short;
  }
  const l = item.label || "";
  return l.length > 4 ? `${l.slice(0, 4)}…` : l;
}
