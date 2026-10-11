/**
 * 製本用 PDF の組み立ての計画(計算だけ。PDF の作成は bookbinding-export.js)。
 *
 * 1. 本体の組み立て: 最初のページ(カバーの表紙。選んだ候補)+ 本文 + 最後のページ(カバーの裏表紙。選んだ候補)
 *    本文は「役割の付いていないページ」を元の順番で並べたもの。
 *    付属の役割(表紙・裏表紙・帯・表紙の折り返し・裏表紙の折り返し・しおり)のページは付属の出力へ回す。
 *    (役割の id は 0.1 までと同じ。cover = カバーの表紙、back = カバーの裏表紙、obiFront = 表紙、obiBack = 裏表紙)
 * 2. 白紙の挿入: 本体のページ数 N が 4 の倍数になるよう、0〜3 枚の白紙を入れる(既定: 裏表紙の直前)
 * 3. 面付け(中綴じ): 用紙 k 枚目(k = 1〜N/4)
 *      表面: 左 = N − 2(k − 1)、右 = 2k − 1
 *      裏面: 左 = 2k、右 = N − 2k + 1
 *    右綴じでは左右を入れ替える。
 */

export const ROLE_IDS = Object.freeze({
  cover: "cover",
  back: "back",
  obiFront: "obiFront",
  obiBack: "obiBack",
  obi: "obi",
  flapFront: "flapFront",
  flapBack: "flapBack",
  bookmark: "bookmark",
});
/** 付属の役割(本体には入れず、付属として出力する。使い道は設定で変えられる)。並びは画面に出す順 */
export const ACCESSORY_ROLES = Object.freeze(["obiFront", "obiBack", "obi", "flapFront", "flapBack", "bookmark"]);
/** 0.1 までの名前(互換のため) */
export const OBI_ROLES = ACCESSORY_ROLES;

/** 付属の役割 → 設定の項目名 */
export const ROLE_USE_SETTING = Object.freeze({
  obiFront: "bindUseObiFront",
  obiBack: "bindUseObiBack",
  obi: "bindUseObi",
  flapFront: "bindUseFlapFront",
  flapBack: "bindUseFlapBack",
  bookmark: "bindUseBookmark",
});

/**
 * 付属の役割のページの使い道(詳細設定で変えられる)。
 * "obi" 付属として出力 / "cover" 最初のページ(カバーの表紙)の候補 / "back" 最後のページ(カバーの裏表紙)の候補 / "none" 出力しない
 */
export const ROLE_USES = Object.freeze(["obi", "cover", "back", "none"]);
export const DEFAULT_ROLE_USE = Object.freeze(Object.fromEntries(ACCESSORY_ROLES.map(r => [r, "obi"])));
export const ROLE_USE_LABEL = Object.freeze({
  obi: "付属として出力",
  cover: "最初のページの候補",
  back: "最後のページの候補",
  none: "出力しない",
});

/** 設定から使い道の割り当てを作る */
export function roleUseFromSettings(s) {
  return Object.fromEntries(ACCESSORY_ROLES.map(r => [r, s?.[ROLE_USE_SETTING[r]] || "obi"]));
}

/** 役割 → 出力での使い道("cover" "back" "obi" "none")。役割が無ければ null(本文) */
export function useOfRole(role, roleUse = DEFAULT_ROLE_USE) {
  if (!role) {
    return null;
  }
  if (role === "cover" || role === "back") {
    return role;
  }
  const use = roleUse?.[role];
  return ROLE_USES.includes(use) ? use : "obi";
}

/** 横向きの用紙(幅 > 高さ、単位 pt) */
export const PAPERS = Object.freeze({
  A3: { label: "A3 横", width: 1190.55, height: 841.89 },
  A4: { label: "A4 横", width: 841.89, height: 595.28 },
  A5: { label: "A5 横", width: 595.28, height: 419.53 },
  B4: { label: "B4 横(JIS)", width: 1031.81, height: 728.5 },
  B5: { label: "B5 横(JIS)", width: 728.5, height: 515.91 },
  Letter: { label: "レター 横", width: 792, height: 612 },
  Tabloid: { label: "タブロイド 横", width: 1224, height: 792 },
});

/**
 * 製本の計画を立てる。
 * @param {object} o
 * @param {number} o.numPages
 * @param {Map<number,string>} o.roles 0始まりのページ番号 → 役割
 * @param {number|null} [o.coverIndex] 使う表紙(0始まり)。null なら自動
 * @param {number|null} [o.backIndex] 使う裏表紙(0始まり)。null なら自動
 * @param {{mode:"beforeBack"|"afterCover"|"custom", after?:number[]}} [o.blank] 白紙の位置。after は「何ページ目の後ろ」(1始まり、重複可)
 * @param {Object<string,string>} [o.roleUse] 付属の役割のページの使い道
 */
export function planBook({ numPages, roles = new Map(), coverIndex = null, backIndex = null, blank = { mode: "beforeBack" }, roleUse = DEFAULT_ROLE_USE }) {
  const warnings = [];
  const roleOf = i => roles.get(i) || null;
  const useOf = i => useOfRole(roleOf(i), roleUse);
  const all = Array.from({ length: numPages }, (_, i) => i);
  const coverCandidates = all.filter(i => useOf(i) === "cover");
  const backCandidates = all.filter(i => useOf(i) === "back");
  const unassigned = all.filter(i => !roleOf(i));

  // ---- 表紙・裏表紙 ----
  let cover = coverIndex;
  let coverAuto = false;
  if (cover === null || cover === undefined || cover < 0 || cover >= numPages) {
    cover = coverCandidates[0] ?? null;
    if (cover === null) {
      cover = unassigned[0] ?? null; // 役割が無ければ、役割の無い最初のページを表紙にする
      coverAuto = cover !== null;
    }
  }
  let back = backIndex;
  let backAuto = false;
  if (back === null || back === undefined || back < 0 || back >= numPages || back === cover) {
    back = backCandidates.find(i => i !== cover) ?? null;
    if (back === null) {
      const rest = unassigned.filter(i => i !== cover);
      back = rest.length ? rest[rest.length - 1] : null; // 役割が無ければ、役割の無い最後のページを裏表紙にする
      backAuto = back !== null;
    }
  }

  // ---- 本文(役割の無いページ。表紙・裏表紙に使ったページは除く) ----
  const body = unassigned.filter(i => i !== cover && i !== back);
  // 付属(元のページの順)
  const obi = all.filter(i => ACCESSORY_ROLES.includes(roleOf(i)) && useOf(i) === "obi");
  const omitted = all.filter(i => useOf(i) === "none");

  const sequence = [];
  if (cover !== null) {
    sequence.push({ kind: "page", pageIndex: cover, part: "cover" });
  }
  for (const i of body) {
    sequence.push({ kind: "page", pageIndex: i, part: "body" });
  }
  if (back !== null) {
    sequence.push({ kind: "page", pageIndex: back, part: "back" });
  }
  const n0 = sequence.length;
  if (!n0) {
    return { error: "出力できるページがありません", warnings, sequence: [], N: 0, blanks: 0, obi, omitted, cover, back, body, coverCandidates, backCandidates };
  }

  // ---- 白紙 ----
  const blanks = (4 - (n0 % 4)) % 4;
  let remaining = blanks;
  // 指定の位置(「何ページ目の後ろ」)に1枚ずつ入れる
  if (remaining && blank.mode === "custom" && Array.isArray(blank.after) && blank.after.length) {
    const afterCount = new Map();
    for (const pageNumber of blank.after) {
      const inBook = sequence.some(s => s.pageIndex === pageNumber - 1);
      if (!inBook) {
        warnings.push(`${pageNumber}ページ目は本体に含まれないため、その後ろには白紙を入れられません`);
        continue;
      }
      if (!remaining) {
        warnings.push(`白紙は ${blanks} 枚で足りるため、${pageNumber}ページ目の後ろには入れません`);
        continue;
      }
      afterCount.set(pageNumber - 1, (afterCount.get(pageNumber - 1) || 0) + 1);
      remaining--;
    }
    const rebuilt = [];
    for (const item of sequence) {
      rebuilt.push(item);
      for (let k = 0; k < (afterCount.get(item.pageIndex) || 0); k++) {
        rebuilt.push({ kind: "blank" });
      }
    }
    sequence.splice(0, sequence.length, ...rebuilt);
  }
  // 残り(または既定): 裏表紙の直前 / 表紙の直後
  if (remaining) {
    const filler = Array.from({ length: remaining }, () => ({ kind: "blank" }));
    const coverPos = sequence.findIndex(s => s.part === "cover");
    const backPos = sequence.findIndex(s => s.part === "back");
    if (blank.mode === "afterCover" && coverPos >= 0) {
      sequence.splice(coverPos + 1, 0, ...filler);
    } else {
      sequence.splice(backPos >= 0 ? backPos : sequence.length, 0, ...filler);
    }
  }
  const N = sequence.length;
  return {
    error: null,
    warnings,
    sequence,
    N,
    blanks,
    obi,
    omitted,
    cover,
    back,
    body,
    coverAuto,
    backAuto,
    coverCandidates,
    backCandidates,
  };
}

/**
 * 中綴じの面付け。position は本体の並び(白紙を含む)での 1始まりの位置。
 * @returns {Array<{sheet:number, front:[number,number], back:[number,number]}>} [左, 右]
 */
export function imposition(N, direction = "ltr") {
  if (N % 4 !== 0) {
    throw new Error("ページ数が4の倍数ではありません");
  }
  const sheets = [];
  for (let k = 1; k <= N / 4; k++) {
    let front = [N - 2 * (k - 1), 2 * k - 1];
    let back = [2 * k, N - 2 * k + 1];
    if (direction === "rtl") {
      front = [front[1], front[0]];
      back = [back[1], back[0]];
    }
    sheets.push({ sheet: k, front, back });
  }
  return sheets;
}

/** ページの大きさ(回転を反映した見た目の大きさ) */
export function displaySize(width, height, rotate = 0) {
  return ((rotate % 180) + 180) % 180 === 90 ? { width: height, height: width } : { width, height };
}

/**
 * ページの大きさがそろっているかを調べ、基準の大きさを決める。
 * @param {Array<{width:number,height:number}>} sizes 本体のページの見た目の大きさ(並び順)
 * @param {"mode"|"first"} ref 最も多い大きさ / 最初のページ
 */
export function referenceSize(sizes, ref = "mode") {
  const TOL = 2; // pt(スキャンの端数などの誤差は同じ大きさとみなす)
  const groups = [];
  for (const s of sizes) {
    const g = groups.find(x => Math.abs(x.width - s.width) <= TOL && Math.abs(x.height - s.height) <= TOL);
    if (g) {
      g.count++;
    } else {
      groups.push({ width: s.width, height: s.height, count: 1 });
    }
  }
  if (!groups.length) {
    return { width: 595.28, height: 841.89, mixed: false, kinds: 0 };
  }
  const chosen = ref === "first" ? groups.find(g => Math.abs(g.width - sizes[0].width) <= TOL && Math.abs(g.height - sizes[0].height) <= TOL) : [...groups].sort((a, b) => b.count - a.count)[0];
  return { width: chosen.width, height: chosen.height, mixed: groups.length > 1, kinds: groups.length };
}

/**
 * 元のページの大きさから、面付けに使う用紙を推定する(2ページを横に並べて収まるもの)。
 * 例: A5 縦 → A4 横、B5 縦 → B4 横。
 * @returns {{id:string, label:string, width:number, height:number, scale:number}}
 */
export function estimatePaper(pageWidth, pageHeight) {
  const needW = pageWidth * 2;
  const needH = pageHeight;
  const options = Object.entries(PAPERS).map(([id, p]) => ({
    id,
    ...p,
    scale: Math.min(p.width / needW, p.height / needH),
  }));
  // 3% までの縮小で収まる用紙のうち、いちばん小さいもの(= 拡大縮小がいちばん少ないもの)
  const fitting = options.filter(o => o.scale >= 0.97).sort((a, b) => a.scale - b.scale);
  if (fitting.length) {
    const best = fitting[0];
    // 大きすぎる(元のページより 1.15 倍以上に拡大する)用紙しか無いときは、元の大きさの2ページ分にする
    if (best.scale <= 1.15) {
      return best;
    }
  }
  if (!fitting.length) {
    // どれにも収まらない大きなページ: いちばん大きく印刷できる用紙
    return options.sort((a, b) => b.scale - a.scale)[0];
  }
  return doublePaper(pageWidth, pageHeight);
}

/** 元のページ2枚分の大きさの用紙 */
export function doublePaper(pageWidth, pageHeight) {
  return { id: "double", label: "元のページ2枚分", width: pageWidth * 2, height: pageHeight, scale: 1 };
}

/** 用紙の指定(設定値)から用紙を決める */
export function resolvePaper(choice, refSize) {
  if (choice === "double") {
    return doublePaper(refSize.width, refSize.height);
  }
  if (choice && PAPERS[choice]) {
    const p = PAPERS[choice];
    return { id: choice, ...p, scale: Math.min(p.width / (refSize.width * 2), p.height / refSize.height) };
  }
  return estimatePaper(refSize.width, refSize.height);
}

/**
 * 「5, 12」「5の後ろに2枚 → 5, 5」のような白紙の位置の指定を読み取る(1始まりのページ番号の配列)。
 */
export function parseBlankPositions(text) {
  const s = String(text || "").normalize("NFKC").replace(/[、,;]/g, " ").trim();
  if (!s) {
    return { after: [], error: null };
  }
  const after = [];
  for (const token of s.split(/\s+/)) {
    const m = token.match(/^(\d+)(?:[x×*](\d+))?$/i);
    if (!m) {
      return { after: [], error: `「${token}」を読み取れません(例: 5, 12 / 5x2 は5ページ目の後ろに2枚)` };
    }
    const count = m[2] ? Number(m[2]) : 1;
    for (let k = 0; k < Math.min(count, 3); k++) {
      after.push(Number(m[1]));
    }
  }
  return { after, error: null };
}
