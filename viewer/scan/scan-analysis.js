/**
 * スキャンした画像を調べる(0.3。スキャンの整え)。
 *
 * 画像は、ページを縮めて描いた灰色の画像(1画素 1バイト。0 = 黒、255 = 白)。
 * 1mm あたりの画素数(pxPerMm)を添えて渡す。長さの決まりは mm で書き、画素数に直して使う。
 *
 *  - findGutter: 見開きのノド(本の綴じ目の影・線)を探す
 *  - findCenterGap: 真ん中の、何も書かれていない縦の帯を探す(ばらした冊子の紙など、ノドの影が無いもの)
 *  - contentBox: ページの中身(文字・図・書き込み)の範囲を探す。スキャンで入ったもの
 *    (ふたの影・本の縁の線・ごみ・綴じ穴の影など)は除く
 *  - classifyDocument / planSpread / planBooklet: 文書全体の判断と、分け方・切り取り方を決める
 */

/** これより暗い画素を「インク」とみなす(縮めた画像では細い線が薄くなるため、白に近めの値) */
export const INK_LEVEL = 215;
/** まとまりの中でいちばん濃い画素がこれより薄ければ、中身ではない(罫線のかけら・裏写りなど) */
const FAINT_LEVEL = 190;
/** 切り取ったページの中身の周りに残す余白(mm) */
export const DEFAULT_MARGIN_MM = 6;

const mmToPx = (img, mm) => mm * img.pxPerMm;

/** RGBA の画素(ImageData.data)を灰色にする */
export function toGray(rgba, width, height) {
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    // 白い背景に重ねる(透明な部分は白)
    const a = rgba[i + 3];
    const y = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    out[j] = a === 255 ? y : 255 - (((255 - y) * a) / 255) | 0;
  }
  return out;
}

/** 灰色の画像を縮める(プレビュー用) */
export function shrinkGray(gray, W, H, width) {
  const w = Math.max(1, Math.min(width, W));
  const scale = w / W;
  const h = Math.max(1, Math.round(H * scale));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y / scale);
    const sy1 = Math.max(sy0 + 1, Math.min(H, Math.floor((y + 1) / scale)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x / scale);
      const sx1 = Math.max(sx0 + 1, Math.min(W, Math.floor((x + 1) / scale)));
      let sum = 0;
      let n = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        const row = yy * W;
        for (let xx = sx0; xx < sx1; xx++) {
          sum += gray[row + xx];
          n++;
        }
      }
      out[y * w + x] = n ? sum / n : 255;
    }
  }
  return { data: out, width: w, height: h, scale };
}

// ---------------------------------------------------------------------------
// ノド(綴じ目)
// ---------------------------------------------------------------------------

/**
 * 列 x が、左右(±k 画素)より暗い度合いの中央値(行 y0〜y1)。
 * ノドの線・影は上から下まで続くので、多くの行で暗い(中央値が大きい)。
 * 文字のある列は、暗い行が一部なので中央値は 0 に近い。
 */
function medianDarker(gray, W, x, k, y0, y1, hist) {
  hist.fill(0);
  for (let y = y0; y < y1; y++) {
    const row = y * W;
    const l = gray[row + x - k];
    const r = gray[row + x + k];
    hist[(l < r ? l : r) - gray[row + x] + 255]++;
  }
  const half = (y1 - y0) >> 1;
  let acc = 0;
  for (let i = 0; i < 511; i++) {
    acc += hist[i];
    if (acc > half) {
      return i - 255;
    }
  }
  return 0;
}

/**
 * 見開きのノド(綴じ目の線・影)を探す。
 * @param {{gray:Uint8Array, width:number, height:number, pxPerMm:number}} img
 * @param {{from?:number, to?:number}} [o] 探す範囲(幅に対する割合)
 * @returns {{x:number, score:number, k:number, top:number, bottom:number, ok:boolean, band:number}|null}
 *   x: ノドの位置(画素) / score: 濃さ(灰色の段階) / ok: ノドとみなせるか
 *   band: ノドの線・影として除く幅の半分(画素)
 */
export function findGutter(img, { from = 0.3, to = 0.7 } = {}) {
  const { gray, width: W, height: H } = img;
  const ks = [...new Set([0.7, 1.4, 2.7, 5.4].map(mm => Math.max(1, Math.round(mmToPx(img, mm)))))];
  const kMax = ks[ks.length - 1];
  const lo = Math.max(kMax, Math.floor(W * from));
  const hi = Math.min(W - kMax - 1, Math.ceil(W * to));
  if (hi <= lo || H < 20) {
    return null;
  }
  const y0 = Math.floor(H * 0.08);
  const y1 = Math.floor(H * 0.92);
  const hist = new Int32Array(511);
  let bestX = -1;
  let bestScore = -Infinity;
  let bestK = ks[0];
  for (let x = lo; x <= hi; x++) {
    for (const k of ks) {
      const s = medianDarker(gray, W, x, k, y0, y1, hist);
      if (s > bestScore) {
        bestScore = s;
        bestX = x;
        bestK = k;
      }
    }
  }
  if (bestX < 0) {
    return null;
  }
  // 上と下で同じ位置にあるか(まっすぐな縦の線か)
  const around = Math.round(mmToPx(img, 10));
  const posIn = (ya, yb) => {
    let px = bestX;
    let ps = -Infinity;
    const a = Math.floor(H * ya);
    const b = Math.floor(H * yb);
    for (let x = Math.max(bestK, bestX - around); x <= Math.min(W - bestK - 1, bestX + around); x++) {
      const s = medianDarker(gray, W, x, bestK, a, b, hist);
      if (s > ps) {
        ps = s;
        px = x;
      }
    }
    return px;
  };
  const top = posIn(0.08, 0.36);
  const bottom = posIn(0.64, 0.92);
  const ok = bestScore >= 8 && Math.abs(top - bottom) <= Math.max(2, mmToPx(img, 1.4));
  return {
    x: bestX,
    score: bestScore,
    k: bestK,
    top,
    bottom,
    ok,
    band: Math.round(bestK + mmToPx(img, 1)),
  };
}

/**
 * 0.5: ノドの影が、ページの中(上下の端を除いた本文の高さ)でノドからどこまで続くか(mm)。
 * 列ごとの明るさの中央値が、紙の明るさに戻るところまでの距離。影が無ければ 0。
 * @param {number} dir -1: 左のページ(ノドから左へ) / 1: 右のページ
 */
export function gutterShadowMm(img, x, dir) {
  const { gray, width: W, height: H } = img;
  const y0 = Math.floor(H * 0.15);
  const y1 = Math.floor(H * 0.85);
  const hist = new Int32Array(256);
  const half = (y1 - y0) >> 1;
  const colMedian = cx => {
    hist.fill(0);
    for (let y = y0; y < y1; y++) {
      hist[gray[y * W + cx]]++;
    }
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc > half) {
        return i;
      }
    }
    return 255;
  };
  const span = Math.round(mmToPx(img, 60));
  const meds = [];
  for (let k = 0; k <= span; k++) {
    const cx = Math.round(x + dir * k);
    if (cx < 0 || cx >= W) {
      break;
    }
    meds.push(colMedian(cx));
  }
  if (meds.length < mmToPx(img, 10)) {
    return 0;
  }
  const sorted = [...meds].sort((a, b) => a - b);
  const paper = sorted[Math.floor(sorted.length * 0.9)];
  // ノドのそばが紙よりはっきり暗いときだけ(影の無い平らな紙などでは 0)
  const near = meds.slice(0, Math.max(2, Math.round(mmToPx(img, 2))));
  if (paper - Math.min(...near) < 25) {
    return 0;
  }
  const cap = Math.round(mmToPx(img, 25));
  for (let k = 0; k < Math.min(meds.length, cap); k++) {
    if (meds[k] >= paper - 10) {
      return k / img.pxPerMm;
    }
  }
  return cap / img.pxPerMm;
}

/**
 * 0.5: 紙の上の端・下の端に出るノドの影を探す。
 * 本を強く押さえてスキャンすると、ノドは真ん中あたりでは白く写り、紙の上の端・下の端にだけ影が残る
 * (findGutter は上下の端を見ないので見つけられず、太い罫線などをノドと間違えることがある)。
 * 上の端・下の端の帯(高さの 7%)で、列ごとの明るさの中央値を取り、真ん中あたりでいちばん暗い所を探す。
 * @returns {{x:number, depth:number, width:number, top:object|null, bottom:object|null, ok:boolean}|null}
 *   x: ノドの位置(画素) / depth: 影の濃さ(紙の明るさとの差) / width: 影の幅(濃さが半分になる所まで。画素)
 */
export function findEdgeShadow(img, { from = 0.35, to = 0.65 } = {}) {
  const { gray, width: W, height: H } = img;
  if (H < 40 || W < 40) {
    return null;
  }
  const bandH = Math.max(4, Math.round(H * 0.07));
  const lo = Math.max(1, Math.floor(W * from));
  const hi = Math.min(W - 2, Math.ceil(W * to));
  const hist = new Int32Array(256);
  const smoothR = Math.max(1, Math.round(mmToPx(img, 0.7)));
  const measure = (y0, y1) => {
    const col = new Float32Array(W);
    const half = (y1 - y0) >> 1;
    for (let x = lo - smoothR; x <= hi + smoothR; x++) {
      if (x < 0 || x >= W) {
        continue;
      }
      hist.fill(0);
      for (let y = y0; y < y1; y++) {
        hist[gray[y * W + x]]++;
      }
      let acc = 0;
      let v = 255;
      for (let i = 0; i < 256; i++) {
        acc += hist[i];
        if (acc > half) {
          v = i;
          break;
        }
      }
      col[x] = v;
    }
    // ならす(文字の縦の線などの細かい凹凸を消す)
    const sm = new Float32Array(W);
    for (let x = lo; x <= hi; x++) {
      let sum = 0;
      let n = 0;
      for (let d = -smoothR; d <= smoothR; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < W) {
          sum += col[xx];
          n++;
        }
      }
      sm[x] = sum / n;
    }
    let minX = lo;
    for (let x = lo; x <= hi; x++) {
      if (sm[x] < sm[minX]) {
        minX = x;
      }
    }
    const vals = Array.from(sm.subarray(lo, hi + 1)).sort((a, b) => a - b);
    const paper = vals[Math.floor(vals.length * 0.8)];
    const depth = paper - sm[minX];
    const limit = paper - depth / 2;
    let a = minX;
    let b = minX;
    while (a > lo && sm[a - 1] < limit) {
      a--;
    }
    while (b < hi && sm[b + 1] < limit) {
      b++;
    }
    // 影は暗い所の真ん中(端の影は片側に長く尾を引くので、いちばん暗い所と暗い範囲の真ん中の間を取る)
    const x = Math.round((minX * 2 + (a + b) / 2) / 3);
    const width = b - a + 1;
    const ok = depth >= 35 && width >= mmToPx(img, 1.5) && width <= mmToPx(img, 25) && a > lo && b < hi;
    // 薄い影の範囲(白く覆う範囲。紙の明るさより少しでも暗い所まで)
    const faint = paper - Math.max(10, depth * 0.12);
    let fa = a;
    let fb = b;
    while (fa > lo && sm[fa - 1] < faint) {
      fa--;
    }
    while (fb < hi && sm[fb + 1] < faint) {
      fb++;
    }
    return { x, depth, width, paper, ok, a, b, fa, fb };
  };
  const top = measure(0, bandH);
  const bottom = measure(H - bandH, H);
  // 影の範囲(上の端・下の端からどこまで暗いか)。整えるときに白く覆う
  const extent = (t, fromTop) => {
    if (!t.ok) {
      return null;
    }
    const pad = Math.round(mmToPx(img, 1));
    const x0 = Math.max(0, t.fa - pad);
    const x1 = Math.min(W - 1, t.fb + pad);
    const lim = t.paper - Math.max(12, t.depth * 0.2);
    const rowDark = y => {
      // その行の、影の範囲の列の明るさの中央値
      const vals = [];
      for (let x = x0; x <= x1; x++) {
        vals.push(gray[y * W + x]);
      }
      vals.sort((p, q) => p - q);
      return vals[vals.length >> 1] < lim;
    };
    const maxRows = Math.round(H * 0.3);
    let n = 0;
    let miss = 0;
    for (let k = 0; k < maxRows && miss < 3; k++) {
      const y = fromTop ? k : H - 1 - k;
      if (rowDark(y)) {
        n = k + 1;
        miss = 0;
      } else {
        miss++;
      }
    }
    if (!n) {
      return null;
    }
    return fromTop ? [x0, 0, x1 + 1, n + pad] : [x0, H - n - pad, x1 + 1, H];
  };
  const near = Math.max(2, mmToPx(img, 6));
  let pick = null;
  if (top.ok && bottom.ok && Math.abs(top.x - bottom.x) <= near) {
    pick = { x: Math.round((top.x + bottom.x) / 2), depth: Math.max(top.depth, bottom.depth), width: Math.max(top.width, bottom.width) };
  } else {
    // 片方だけなら、はっきりした影のときだけ
    const one = [top, bottom].filter(t => t.ok && t.depth >= 60).sort((p, q) => q.depth - p.depth)[0];
    if (one) {
      pick = { x: one.x, depth: one.depth, width: one.width };
    }
  }
  const boxes = pick ? [extent(top, true), extent(bottom, false)].filter(Boolean) : [];
  return pick ? { ...pick, top, bottom, boxes, ok: true } : { x: null, depth: 0, width: 0, top, bottom, boxes, ok: false };
}

/**
 * 真ん中あたりの、何も書かれていない縦の帯を探す。
 * @returns {{from:number, to:number, x:number}|null} x: 分ける位置(帯が真ん中を含めば真ん中)
 */
export function findCenterGap(img, { from = 0.35, to = 0.65, minMm = 2 } = {}) {
  const { gray, width: W, height: H } = img;
  const y0 = Math.floor(H * 0.05);
  const y1 = Math.floor(H * 0.95);
  const rows = y1 - y0;
  const limit = Math.max(1, Math.floor(rows * 0.003));
  const lo = Math.floor(W * from);
  const hi = Math.ceil(W * to);
  const blank = new Uint8Array(W);
  for (let x = lo; x < hi; x++) {
    let ink = 0;
    for (let y = y0; y < y1; y++) {
      if (gray[y * W + x] < INK_LEVEL) {
        ink++;
      }
    }
    blank[x] = ink <= limit ? 1 : 0;
  }
  const runs = [];
  let start = -1;
  for (let x = lo; x <= hi; x++) {
    if (x < hi && blank[x]) {
      if (start < 0) {
        start = x;
      }
    } else if (start >= 0) {
      runs.push([start, x]);
      start = -1;
    }
  }
  const minWidth = Math.max(2, mmToPx(img, minMm));
  const center = W / 2;
  const candidates = runs.filter(([a, b]) => b - a >= minWidth);
  if (!candidates.length) {
    return null;
  }
  const containing = candidates.find(([a, b]) => a <= center && center <= b);
  const run = containing || candidates.sort((p, q) => Math.abs((p[0] + p[1]) / 2 - center) - Math.abs((q[0] + q[1]) / 2 - center))[0];
  const x = containing ? Math.round(center) : Math.round((run[0] + run[1]) / 2);
  return { from: run[0], to: run[1], x };
}

// ---------------------------------------------------------------------------
// つながっている画素のまとまり
// ---------------------------------------------------------------------------

/** 8方向につながった画素のまとまりに番号を付ける */
function labelComponents(mask, W, H) {
  const labels = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  const comps = [null];
  let next = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) {
      continue;
    }
    next++;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = next;
    let x0 = W;
    let x1 = -1;
    let y0 = H;
    let y1 = -1;
    let n = 0;
    while (sp) {
      const p = stack[--sp];
      const y = (p / W) | 0;
      const x = p - y * W;
      n++;
      if (x < x0) {
        x0 = x;
      }
      if (x > x1) {
        x1 = x;
      }
      if (y < y0) {
        y0 = y;
      }
      if (y > y1) {
        y1 = y;
      }
      const yA = y > 0 ? y - 1 : 0;
      const yB = y < H - 1 ? y + 1 : H - 1;
      const xA = x > 0 ? x - 1 : 0;
      const xB = x < W - 1 ? x + 1 : W - 1;
      for (let yy = yA; yy <= yB; yy++) {
        const row = yy * W;
        for (let xx = xA; xx <= xB; xx++) {
          const q = row + xx;
          if (mask[q] && !labels[q]) {
            labels[q] = next;
            stack[sp++] = q;
          }
        }
      }
    }
    comps.push({ id: next, x0, y0, x1: x1 + 1, y1: y1 + 1, n });
  }
  return { labels, comps };
}

/** 2値の画像を r 画素ずつ太らせる(正方形) */
function dilate(mask, W, H, r) {
  const tmp = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  // 横
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let count = 0;
    for (let x = 0; x < Math.min(r, W); x++) {
      count += mask[row + x];
    }
    for (let x = 0; x < W; x++) {
      const add = x + r;
      if (add < W) {
        count += mask[row + add];
      }
      const drop = x - r - 1;
      if (drop >= 0) {
        count -= mask[row + drop];
      }
      tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  // 縦
  for (let x = 0; x < W; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(r, H); y++) {
      count += tmp[y * W + x];
    }
    for (let y = 0; y < H; y++) {
      const add = y + r;
      if (add < H) {
        count += tmp[add * W + x];
      }
      const drop = y - r - 1;
      if (drop >= 0) {
        count -= tmp[drop * W + x];
      }
      out[y * W + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ページの中身の範囲
// ---------------------------------------------------------------------------

/**
 * 画像の横の範囲 [x0, x1) にある、ページの中身(文字・図・書き込み)の範囲を探す。
 * スキャンで入ったもの(ふたの影・本の縁の線・ノドの線・ごみ・綴じ穴の影)は除く。
 * @param {object} img
 * @param {number} x0
 * @param {number} x1
 * @param {"L"|"R"|"C"} side 外側の向き(L: 左が外側 = 見開きの左のページ / R: 右が外側 / C: 両側)
 * @returns {{box:number[]|null, ink:number, limits:{outer:number|null, top:number|null, bottom:number|null}, blobs:number[][]}}
 *   box: [x0, y0, x1, y1](画像の座標)
 *   limits: 縁に沿って入ったもの(本の縁の線・影など)の内側の端。切り取る範囲をここより内側にすると、それが入らない
 *   blobs: 縁の近くの小さなもの(ふたの影の角・綴じ穴の影など)の範囲
 */
export function contentBox(img, x0, x1, side = "C", debug = null) {
  const { gray, width: W, height: H } = img;
  x0 = Math.max(0, Math.round(x0));
  x1 = Math.min(W, Math.round(x1));
  const w = x1 - x0;
  if (w <= 4 || H <= 4) {
    return { box: null, ink: 0, limits: { outer: null, top: null, bottom: null }, blobs: [] };
  }
  const mm = v => v * img.pxPerMm;
  const ink = new Uint8Array(w * H);
  for (let y = 0; y < H; y++) {
    const src = y * W + x0;
    const dst = y * w;
    for (let x = 0; x < w; x++) {
      ink[dst + x] = gray[src + x] < INK_LEVEL ? 1 : 0;
    }
  }
  const outerLeft = side === "L" || side === "C";
  const outerRight = side === "R" || side === "C";
  const leftEdge = outerLeft && x0 <= 0;
  const rightEdge = outerRight && x1 >= W;
  // スキャンで入ったもの(ごみの点は除く)の画素と、縁の近くの小さなもの(画像全体の座標)
  const junkMask = new Uint8Array(w * H);
  const blobs = [];
  const smallBlob = (bw, bh) => bw <= mm(25) && bh <= mm(25);

  // 1. 太らせる前に、外側の縁に触れているもの(ふたの影・縁の線)と、縁の近くの長い縦線を取り除く
  {
    const { labels, comps } = labelComponents(ink, w, H);
    const remove = new Uint8Array(comps.length);
    let any = false;
    for (let id = 1; id < comps.length; id++) {
      const c = comps[id];
      const touch = c.y0 <= 0 || c.y1 >= H || (leftEdge && c.x0 <= 0) || (rightEdge && c.x1 >= w);
      const cw = c.x1 - c.x0;
      const ch = c.y1 - c.y0;
      const tallThin = ch >= 0.25 * H && cw <= mm(3);
      const nearOuter = (outerLeft && c.x0 <= 0.15 * w) || (outerRight && c.x1 >= 0.85 * w);
      const nearInner = (side === "L" && c.x1 >= 0.9 * w) || (side === "R" && c.x0 <= 0.1 * w);
      if (touch || (tallThin && (nearOuter || nearInner))) {
        remove[id] = 1;
        any = true;
        if (touch && smallBlob(cw, ch)) {
          blobs.push([c.x0 + x0, c.y0, c.x1 + x0, c.y1]);
        }
      }
    }
    if (any) {
      for (let i = 0; i < ink.length; i++) {
        if (ink[i] && remove[labels[i]]) {
          ink[i] = 0;
          junkMask[i] = 1;
        }
      }
    }
  }

  // 1b. 縁に触れていない長い直線(本の縁・影の線、表の罫線など)を、いったん取り除く。
  //     中身の範囲を決めた後で、中身の範囲の外にあるものだけを「スキャンで入ったもの」とする(中の罫線は中身に戻す)。
  //     文字の並びは字の間・行の間で途切れるので、長い線にはならない。少し傾いた線も拾えるよう、上下(左右)2画素ずつの幅で見る
  const lines = [];
  {
    const T = 2;
    const take = (x0l, x1l, y0l, y1l, vertical) => {
      const pixels = [];
      for (let yy = y0l; yy <= y1l; yy++) {
        const row = yy * w;
        for (let xx = x0l; xx <= x1l; xx++) {
          if (ink[row + xx]) {
            ink[row + xx] = 0;
            pixels.push(row + xx);
          }
        }
      }
      if (pixels.length) {
        lines.push({ vertical, box: [x0l + x0, y0l, x1l + 1 + x0, y1l + 1], pixels });
      }
    };
    // 横の線(上下 25% の帯の中で、ページの幅の半分より長いもの)
    const hBand = Math.round(H * 0.25);
    const minH = Math.round(w * 0.5);
    const rowsWith = new Uint8Array(w);
    for (const [ya, yb] of [
      [0, hBand],
      [H - hBand, H],
    ]) {
      for (let y = Math.max(0, ya); y < Math.min(H, yb); y++) {
        const y0r = Math.max(0, y - T);
        const y1r = Math.min(H - 1, y + T);
        for (let x = 0; x < w; x++) {
          let v = 0;
          for (let yy = y0r; yy <= y1r && !v; yy++) {
            v = ink[yy * w + x];
          }
          rowsWith[x] = v;
        }
        let x = 0;
        while (x < w) {
          if (!rowsWith[x]) {
            x++;
            continue;
          }
          let e = x;
          while (e < w && (rowsWith[e] || (e + 1 < w && rowsWith[e + 1]))) {
            e++;
          }
          if (e - x >= minH) {
            take(x, e - 1, y0r, y1r, false);
          }
          x = e + 1;
        }
      }
    }
    // 縦の線(外側の半分の中で、高さの 40% より長いもの)
    const minV = Math.round(H * 0.4);
    const columns = [];
    for (let x = 0; x < w; x++) {
      const inOuterHalf = (outerLeft && x < w * 0.5) || (outerRight && x >= w * 0.5);
      if (inOuterHalf) {
        columns.push(x);
      }
    }
    const colWith = new Uint8Array(H);
    for (const x of columns) {
      const x0c = Math.max(0, x - T);
      const x1c = Math.min(w - 1, x + T);
      for (let y = 0; y < H; y++) {
        let v = 0;
        const row = y * w;
        for (let xx = x0c; xx <= x1c && !v; xx++) {
          v = ink[row + xx];
        }
        colWith[y] = v;
      }
      let y = 0;
      while (y < H) {
        if (!colWith[y]) {
          y++;
          continue;
        }
        let e = y;
        while (e < H && (colWith[e] || (e + 1 < H && colWith[e + 1]))) {
          e++;
        }
        if (e - y >= minV) {
          take(x0c, x1c, y, e - 1, true);
        }
        y = e + 1;
      }
    }
  }

  // 2. 太らせて、文字を語・行のまとまりにする
  const r = Math.max(1, Math.round(mm(1.2)));
  const grown = dilate(ink, w, H, r);
  const { labels, comps } = labelComponents(grown, w, H);
  const count = comps.length;
  const cnt = new Int32Array(count);
  const bx0 = new Int32Array(count).fill(w);
  const bx1 = new Int32Array(count).fill(-1);
  const by0 = new Int32Array(count).fill(H);
  const by1 = new Int32Array(count).fill(-1);
  const darkest = new Uint8Array(count).fill(255);
  for (let y = 0; y < H; y++) {
    const row = y * w;
    const src = y * W + x0;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!ink[i]) {
        continue;
      }
      const id = labels[i];
      cnt[id]++;
      const v = gray[src + x];
      if (v < darkest[id]) {
        darkest[id] = v;
      }
      if (x < bx0[id]) {
        bx0[id] = x;
      }
      if (x > bx1[id]) {
        bx1[id] = x;
      }
      if (y < by0[id]) {
        by0[id] = y;
      }
      if (y > by1[id]) {
        by1[id] = y;
      }
    }
  }

  let box = null;
  let total = 0;
  const junkIds = new Uint8Array(count);
  for (let id = 1; id < count; id++) {
    const n = cnt[id];
    if (!n) {
      continue;
    }
    // 画像全体の座標
    const tx0 = bx0[id] + x0;
    const tx1 = bx1[id] + 1 + x0;
    const ty0 = by0[id];
    const ty1 = by1[id] + 1;
    const tw = tx1 - tx0;
    const th = ty1 - ty0;
    const dTop = ty0 / img.pxPerMm;
    const dBottom = (H - ty1) / img.pxPerMm;
    const dLeft = tx0 / img.pxPerMm;
    const dRight = (W - tx1) / img.pxPerMm;
    const dOut = side === "L" ? dLeft : side === "R" ? dRight : Math.min(dLeft, dRight);
    const touch = ty0 <= 0 || ty1 >= H || (leftEdge && tx0 <= 0) || (rightEdge && tx1 >= W);
    const longSide = Math.max(tw, th);
    // ごみ(小さな点)
    const speck = longSide <= mm(1.6) || (n <= 15 && longSide <= mm(6));
    // 縦の線(本の縁)
    const vline = tw <= mm(2.5) && th >= 3 * tw;
    const hline = th <= mm(1.6) && tw >= 4 * th;
    const outerZone =
      (side === "L" && tx0 - x0 <= 0.12 * w) || (side === "R" && x1 - tx1 <= 0.12 * w) || (side === "C" && (tx0 - x0 <= 0.12 * w || x1 - tx1 <= 0.12 * w));
    const density = n / Math.max(1, tw * th);
    // 縁の近くの、細長くて薄いもの(重なった紙の縁・影)
    const edgeLike = dOut <= 12 && tw <= mm(10) && th >= 2 * tw && density < 0.15;
    // 薄い灰色だけのもの(ノートの罫線のかけら・裏写り・影)。文字や書き込みには、どこかに濃いところがある
    const faint = darkest[id] >= FAINT_LEVEL;
    // 縁の近くの、小さなもの(綴じ穴の影・ごみ)
    const nearBorder = Math.min(dTop, dBottom, dOut) <= 12 && longSide <= mm(10);
    const junk = touch || speck || faint || (vline && outerZone) || edgeLike || (nearBorder && (vline || hline || n <= 40));
    if (junk) {
      if (!speck) {
        junkIds[id] = 1;
        if ((touch || nearBorder) && smallBlob(tw, th)) {
          blobs.push([tx0, ty0, tx1, ty1]);
        }
      }
      continue;
    }
    total += n;
    debug?.push({ box: [tx0, ty0, tx1, ty1], n });
    if (!box) {
      box = [tx0, ty0, tx1, ty1];
    } else {
      box[0] = Math.min(box[0], tx0);
      box[1] = Math.min(box[1], ty0);
      box[2] = Math.max(box[2], tx1);
      box[3] = Math.max(box[3], ty1);
    }
  }
  for (let i = 0; i < ink.length; i++) {
    if (ink[i] && junkIds[labels[i]]) {
      junkMask[i] = 1;
    }
  }
  // 1b で取り除いた長い直線: 中身の範囲の中(横線なら上下、縦線なら左右の範囲の中)にあれば中身(罫線)、外なら本の縁など
  {
    const near = mm(1);
    for (const line of lines) {
      const [lx0, ly0, lx1, ly1] = line.box;
      const inside =
        box &&
        (line.vertical
          ? lx0 >= box[0] - near && lx1 <= box[2] + near && ly1 > box[1] && ly0 < box[3]
          : ly0 >= box[1] - near && ly1 <= box[3] + near && lx1 > box[0] && lx0 < box[2]);
      if (inside) {
        box[0] = Math.min(box[0], lx0);
        box[1] = Math.min(box[1], ly0);
        box[2] = Math.max(box[2], lx1);
        box[3] = Math.max(box[3], ly1);
      } else {
        for (const i of line.pixels) {
          junkMask[i] = 1;
        }
      }
    }
  }
  // 縁に沿って入ったもの(縦・横に長く続くもの)の、内側の端
  const limits = { outer: null, top: null, bottom: null };
  const colCount = x => {
    let c = 0;
    for (let y = 0; y < H; y++) {
      c += junkMask[y * w + x];
    }
    return c;
  };
  const rowCount = y => {
    let c = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      c += junkMask[row + x];
    }
    return c;
  };
  const colLimit = 0.12 * H;
  const rowLimit = 0.12 * w;
  if (side === "L") {
    for (let x = 0; x <= Math.ceil(w * 0.15) && x < w; x++) {
      if (colCount(x) >= colLimit) {
        limits.outer = x0 + x + 1;
      }
    }
  } else if (side === "R") {
    for (let x = w - 1; x >= Math.floor(w * 0.85) && x >= 0; x--) {
      if (colCount(x) >= colLimit) {
        limits.outer = x0 + x;
      }
    }
  }
  for (let y = 0; y <= Math.ceil(H * 0.08) && y < H; y++) {
    if (rowCount(y) >= rowLimit) {
      limits.top = y + 1;
    }
  }
  for (let y = H - 1; y >= Math.floor(H * 0.92) && y >= 0; y--) {
    if (rowCount(y) >= rowLimit) {
      limits.bottom = y;
    }
  }
  // 紙の端(0.4.1): 紙の外(ふた・台の影)との境目。中身の範囲の外にあるときだけ使う
  const paper = paperEdges(img, x0, x1, side, box);
  limits.paperTop = paper.top;
  limits.paperBottom = paper.bottom;
  limits.paperOuter = paper.outer;
  return { box, ink: total, limits, blobs };
}

/** 明るい画素(紙)とみなす明るさ */
const PAPER_LEVEL = 235;

/**
 * 紙の端を探す(0.4.1)。スキャンでは、紙の外側(コピー機のふた・台)が紙と少し違う明るさで写るか、
 * 紙の外側の縁に沿った影の帯の幅が、紙の角で変わる。その境目を紙の端とする。
 *  - 外側の縁の影の帯: 行ごとに、外側の端から紙(明るい画素の並び)までの幅を見る。帯の内側の端が紙の外側の端。
 *    下(上)の端の近くで帯がはっきり広くなり、そのまま画像の端まで続くところが、紙の下(上)の端。
 *  - 紙の外が灰色に写るとき: 行ごとの明るさ(中央値)が、紙の明るさより暗いまま画像の端まで続くところ。
 * 見つからなければ null。中身(box)にかかる位置は使わない。
 * @returns {{top:number|null, bottom:number|null, outer:number|null}} 画像の座標
 */
export function paperEdges(img, x0, x1, side, box) {
  const { gray, width: W, height: H } = img;
  const out = { top: null, bottom: null, outer: null };
  const w = x1 - x0;
  if (w < 20 || H < 20) {
    return out;
  }
  const mm = img.pxPerMm;
  const keep = mm; // 中身から 1mm は離す
  const boxTop = box ? box[1] - keep : H * 0.3;
  const boxBottom = box ? box[3] + keep : H * 0.7;
  const minRun = Math.max(2, Math.round(0.8 * mm));

  // 1. 外側の縁の影の帯
  if (side === "L" || side === "R") {
    const maxBand = Math.round(w * 0.15);
    const bandAt = y => {
      const row = y * W;
      for (let k = 0; k < maxBand; k++) {
        const x = side === "R" ? x1 - 1 - k : x0 + k;
        const step = side === "R" ? -1 : 1;
        if (gray[row + x] >= PAPER_LEVEL && gray[row + x + step] >= PAPER_LEVEL && gray[row + x + 2 * step] >= PAPER_LEVEL) {
          return k;
        }
      }
      return maxBand;
    };
    const widths = new Int32Array(H);
    for (let y = 0; y < H; y++) {
      widths[y] = bandAt(y);
    }
    const mid = [];
    for (let y = Math.round(H * 0.3); y < Math.round(H * 0.7); y++) {
      mid.push(widths[y]);
    }
    mid.sort((a, b) => a - b);
    const base = mid[mid.length >> 1];
    if (base >= 1 && base < maxBand) {
      out.outer = side === "R" ? x1 - base : x0 + base;
      const wide = Math.max(2, Math.round(0.8 * mm));
      // 下の端: 画像の下の端から上へ、帯が広いところが続く範囲
      const runFrom = (start, dir, limit) => {
        let y = start;
        let misses = 0;
        let last = null;
        while (y >= 0 && y < H && (dir < 0 ? y >= limit : y <= limit)) {
          if (widths[y] >= base + wide) {
            last = y;
            misses = 0;
          } else if (++misses > Math.max(1, Math.round(0.3 * mm))) {
            break;
          }
          y += dir;
        }
        return last;
      };
      const b = runFrom(H - 1, -1, Math.round(H * 0.8));
      if (b !== null && H - b >= minRun && b >= boxBottom) {
        out.bottom = b;
      }
      const t = runFrom(0, 1, Math.round(H * 0.2));
      if (t !== null && t + 1 >= minRun && t + 1 <= boxTop) {
        out.top = t + 1;
      }
    }
  }

  // 2. 紙の外が紙より暗く写るとき(行ごとの明るさの中央値で見る)
  {
    const cx0 = x0 + Math.round(w * 0.12);
    const cx1 = x1 - Math.round(w * 0.12);
    const hist = new Uint32Array(256);
    const rowMed = new Uint8Array(H);
    const n = Math.max(1, cx1 - cx0);
    for (let y = 0; y < H; y++) {
      hist.fill(0);
      const row = y * W;
      for (let x = cx0; x < cx1; x++) {
        hist[gray[row + x]]++;
      }
      let acc = 0;
      let v = 0;
      while (v < 255 && acc + hist[v] <= n / 2) {
        acc += hist[v];
        v++;
      }
      rowMed[y] = v;
    }
    const mids = [];
    for (let y = Math.round(H * 0.2); y < Math.round(H * 0.8); y++) {
      mids.push(rowMed[y]);
    }
    mids.sort((a, b) => a - b);
    const level = mids[mids.length >> 1];
    if (level >= PAPER_LEVEL) {
      const dark = y => rowMed[y] <= level - 4;
      let y = H - 1;
      while (y > H * 0.8 && dark(y)) {
        y--;
      }
      if (H - 1 - y >= minRun && y + 1 >= boxBottom) {
        out.bottom = out.bottom === null ? y + 1 : Math.min(out.bottom, y + 1);
      }
      y = 0;
      while (y < H * 0.2 && dark(y)) {
        y++;
      }
      if (y >= minRun && y <= boxTop) {
        out.top = out.top === null ? y : Math.max(out.top, y);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1ページ分の調べ
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 傾き(0.6)
// ---------------------------------------------------------------------------

/** 傾きを探す範囲(度。これより大きく傾いたスキャンは、向きの間違いとみなして直さない) */
export const SKEW_MAX_DEG = 8;
/** これより小さい傾きは、直さない(度) */
export const SKEW_MIN_DEG = 0.2;
/** これより確からしさ(findSkew の conf)が低い傾きは、直さない */
export const SKEW_MIN_CONF = 3;

/** 傾きを直すページか(検出した傾きが、直すだけの大きさと確からしさを持つ) */
export function isSkewed(skew) {
  return !!skew && Math.abs(skew.angle) >= SKEW_MIN_DEG && skew.conf >= SKEW_MIN_CONF;
}

/**
 * 文字・罫線のように、まわりより濃い画素の位置を集める(影・ノド・紙の縁のような広い暗い部分は、まわりと変わらないので入らない)。
 * @returns {{xs:Float32Array, ys:Float32Array, n:number}}
 */
function inkPoints(img, limit = 140000) {
  const { gray, width: W, height: H } = img;
  // まわり(縦横およそ 8mm)の平均を、積分画像で求める
  const r = Math.max(4, Math.round(mmToPx(img, 4)));
  const stride = W + 1;
  const sat = new Float64Array(stride * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += gray[y * W + x];
      sat[(y + 1) * stride + x + 1] = sat[y * stride + x + 1] + row;
    }
  }
  const pts = [];
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const v = gray[y * W + x];
      if (v > 170) {
        continue;
      }
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(W, x + r + 1);
      const mean = (sat[y1 * stride + x1] - sat[y0 * stride + x1] - sat[y1 * stride + x0] + sat[y0 * stride + x0]) / ((x1 - x0) * (y1 - y0));
      if (v < mean - 45) {
        pts.push(x, y);
      }
    }
  }
  let n = pts.length >> 1;
  const step = Math.max(1, Math.ceil(n / limit));
  const xs = new Float32Array(Math.ceil(n / step));
  const ys = new Float32Array(xs.length);
  let k = 0;
  for (let i = 0; i < n; i += step) {
    xs[k] = pts[2 * i];
    ys[k] = pts[2 * i + 1];
    k++;
  }
  return { xs: xs.subarray(0, k), ys: ys.subarray(0, k), n: k };
}

/**
 * 点を(cx, cy)のまわりに phi 度(画面で時計回りが正)回したときの、行(または列)ごとの点の数の「くっきり度」。
 * 文字の行(縦書きなら列)がそろうほど、行ごとの点の数が大きく上下する。
 */
function profileSharpness(pts, cx, cy, phiDeg, vertical, size) {
  const t = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const bins = new Int32Array(size + 2);
  const off = size / 2;
  const { xs, ys, n } = pts;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - cx;
    const dy = ys[i] - cy;
    const v = vertical ? dx * cos - dy * sin : dx * sin + dy * cos;
    const b = Math.round(v + off);
    if (b >= 0 && b <= size) {
      bins[b]++;
    }
  }
  let s = 0;
  for (let i = 1; i < bins.length; i++) {
    const d = bins[i] - bins[i - 1];
    s += d * d;
  }
  return s;
}

/**
 * スキャンの傾きを調べる。文字の行(縦書きなら列)・罫線がまっすぐ並ぶ角度を探す。
 * @returns {{angle:number, conf:number, vertical:boolean}} angle: まっすぐにするために画像を回す角度(度。画面で時計回りが正)/
 *   conf: 確からしさ(0〜。2以上ならほぼ確か)/ vertical: 縦書き(列でそろえた)か
 */
export function findSkew(img, { maxDeg = SKEW_MAX_DEG } = {}) {
  const none = { angle: 0, conf: 0, vertical: false };
  const { width: W, height: H } = img;
  const pts = inkPoints(img);
  // 文字・線がほとんど無いページ(白紙・写真だけ)は調べない
  if (pts.n < Math.max(400, W * H * 0.0015)) {
    return none;
  }
  const cx = W / 2;
  const cy = H / 2;
  const size = Math.ceil(Math.hypot(W, H));
  let best = null;
  for (const vertical of [false, true]) {
    // 粗く(0.25度ずつ)→細かく(0.05度ずつ)→さらに細かく(0.01度ずつ)
    const scores = [];
    let top = { phi: 0, s: -1 };
    for (let phi = -maxDeg; phi <= maxDeg + 1e-9; phi += 0.25) {
      const s = profileSharpness(pts, cx, cy, phi, vertical, size);
      scores.push(s);
      if (s > top.s) {
        top = { phi, s };
      }
    }
    const sorted = [...scores].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1] || 1;
    for (const [span, step] of [
      [0.3, 0.05],
      [0.06, 0.01],
    ]) {
      const c = top.phi;
      for (let phi = c - span; phi <= c + span + 1e-9; phi += step) {
        const s = profileSharpness(pts, cx, cy, phi, vertical, size);
        if (s > top.s) {
          top = { phi, s };
        }
      }
    }
    const conf = top.s / med - 1;
    if (!best || conf > best.conf) {
      best = { angle: top.phi, conf, vertical };
    }
  }
  // 探す範囲の端で見つかったものは、ほかの向きの紙・斜めの図で、傾きではない
  if (!best || Math.abs(best.angle) > maxDeg - 0.3) {
    return none;
  }
  return { angle: Math.round(best.angle * 100) / 100, conf: Math.round(best.conf * 100) / 100, vertical: best.vertical };
}

/**
 * 灰色の画像を、中心のまわりに phi 度(画面で時計回りが正)回す。はみ出した部分は白。
 * 傾きを直したあとの画像で、余白・ノドを調べるのに使う(元の画像の大きさのまま)。
 */
export function rotateGray(gray, W, H, phiDeg) {
  const t = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const dy = y - cy;
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      // 出来上がりの (x, y) に来る元の位置(逆向きに回す)
      const sx = dx * cos + dy * sin + cx;
      const sy = -dx * sin + dy * cos + cy;
      if (sx < 0 || sy < 0 || sx > W - 1 || sy > H - 1) {
        out[y * W + x] = 255;
        continue;
      }
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = Math.min(W - 1, x0 + 1);
      const y1 = Math.min(H - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const a = gray[y0 * W + x0] * (1 - fx) + gray[y0 * W + x1] * fx;
      const b = gray[y1 * W + x0] * (1 - fx) + gray[y1 * W + x1] * fx;
      out[y * W + x] = (a * (1 - fy) + b * fy + 0.5) | 0;
    }
  }
  return out;
}

/**
 * 1枚のスキャンを調べる。
 * @param {object} img {gray, width, height, pxPerMm}
 * @param {{trim?:boolean}} [o]
 * @returns {{width:number, height:number, pxPerMm:number, landscape:boolean, gutter:object|null, gap:object|null,
 *   halves:{L:number[]|null, R:number[]|null}|null}}
 */
export function analyzeScan(img) {
  const { width: W, height: H } = img;
  const landscape = W >= H * 1.15;
  const result = { width: W, height: H, pxPerMm: img.pxPerMm, landscape, gutter: null, gap: null, split: null };
  if (!landscape) {
    return result;
  }
  result.gutter = findGutter(img);
  result.gap = findCenterGap(img);
  // 0.5: 上の端・下の端のノドの影。見つかれば、ノドの位置はこちらを使う
  // (ノドの影が端にしか無いスキャンや、太い罫線をノドと間違えたとき。罫線とノドが近ければ、線の位置のまま)
  const shadow = findEdgeShadow(img);
  result.shadow = shadow;
  if (shadow?.ok) {
    const g = result.gutter;
    if (!g?.ok || Math.abs(g.x - shadow.x) > mmToPx(img, 6)) {
      result.gutter = {
        x: shadow.x,
        score: shadow.depth,
        k: 0,
        top: shadow.top?.ok ? shadow.top.x : shadow.x,
        bottom: shadow.bottom?.ok ? shadow.bottom.x : shadow.x,
        ok: true,
        band: Math.round(mmToPx(img, 1.5)),
        by: "shadow",
      };
    }
  }
  return result;
}

/**
 * 1枚のスキャンを、傾きも含めて調べる(Worker と、Worker が使えないときの画面から呼ぶ)。
 * 傾きがあるページは、まっすぐにした画像でも調べ直して scan.deskewed に入れる
 * (見開きを分ける位置・余白の範囲を、まっすぐにしたあとの座標で決めるため)。
 */
export function analyzeFull(img) {
  const skew = findSkew(img);
  const scan = analyzeScan(img);
  scan.skew = skew;
  scan.candidates = candidateHalves(img, scan);
  if (isSkewed(skew)) {
    const straight = { ...img, gray: rotateGray(img.gray, img.width, img.height, skew.angle) };
    const d = analyzeScan(straight);
    d.skew = skew;
    d.candidates = candidateHalves(straight, d);
    scan.deskewed = d;
  }
  return scan;
}

/**
 * 分ける位置を決めたあとで、左右の中身の範囲を調べる。
 * @param {object} img
 * @param {number} x 分ける位置
 * @param {number} band 分ける位置の両側で除く幅(ノドの線・影)
 */
export function analyzeHalves(img, x, band) {
  const left = contentBox(img, 0, x - band, "L");
  const right = contentBox(img, x + band, img.width, "R");
  return {
    // 0.5: ノドの影がページの中へどこまで続くか(mm。整えるときに、内側の端を影の外へ寄せる)
    shadowMmL: gutterShadowMm(img, x, -1),
    shadowMmR: gutterShadowMm(img, x, 1),
    L: left.box,
    R: right.box,
    inkL: left.ink,
    inkR: right.ink,
    limitsL: left.limits,
    limitsR: right.limits,
    blobsL: left.blobs,
    blobsR: right.blobs,
  };
}

// ---------------------------------------------------------------------------
// 文書全体の判断
// ---------------------------------------------------------------------------

/**
 * 文書の種類を決める。
 * @param {Array<object>} scans analyzeScan() の結果(調べたページだけ)
 * @returns {"spread"|"sheets"|null}
 *   spread: 本・ノートを開いてスキャンした見開き(ノドの線・影がある)
 *   sheets: 2ページ分が並んだ平らな紙(ばらした冊子など。真ん中に何も無い帯がある)
 */
export function classifyDocument(scans) {
  const land = scans.filter(s => s && s.landscape);
  if (!land.length || land.length < scans.filter(Boolean).length * 0.6) {
    return null;
  }
  const withGutter = land.filter(s => s.gutter?.ok).length;
  if (withGutter >= Math.max(1, land.length * 0.6)) {
    return "spread";
  }
  const withGap = land.filter(s => s.gap).length;
  if (withGap >= Math.max(1, land.length * 0.6)) {
    return "sheets";
  }
  return null;
}

/** 中央値 */
function median(values) {
  if (!values.length) {
    return null;
  }
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * 各スキャンの分ける位置を決める。
 * @param {Array<object>} scans analyzeScan() の結果
 * @param {"spread"|"sheets"} kind
 * @returns {Array<{x:number, band:number}|null>} 分けないページは null
 */
export function chooseSplits(scans, kind) {
  const gapCenter = median(scans.filter(s => s?.landscape && s.gap).map(s => (s.gap.from + s.gap.to) / 2 / s.width));
  const centered = gapCenter === null || Math.abs(gapCenter - 0.5) <= 0.02;
  return scans.map(s => {
    if (!s || !s.landscape) {
      return null;
    }
    if (kind === "spread") {
      if (s.gutter?.ok) {
        return { x: s.gutter.x, band: s.gutter.band, by: "gutter" };
      }
      // ノドが見つからないページ: 真ん中あたりの何も無い帯があれば、そこで分ける(無ければ分けない)
      return s.gap ? { x: s.gap.x, band: 0, by: "gap" } : null;
    }
    // 平らな紙: ふつうは紙の真ん中が折り目。何も無い帯がどのページでも真ん中から外れているときだけ、帯の中で分ける
    if (centered || !s.gap) {
      return { x: s.width / 2, band: 0, by: "center" };
    }
    return { x: s.gap.x, band: 0, by: "gap" };
  });
}

/**
 * 分ける位置の候補ごとに、左右の中身の範囲を調べておく(あとで整え方を変えても、画像を読み直さずに済むように)。
 * @returns {Array<{x:number, band:number, by:string, L:number[]|null, R:number[]|null}>}
 */
export function candidateHalves(img, scan) {
  const out = [];
  if (!scan.landscape) {
    return out;
  }
  // 近い位置(3mm 以内)の候補は1つにまとめる(調べる時間を減らす。中身の範囲は数 mm の違いではほとんど変わらない)
  const add = (x, band, by) => {
    if (out.some(c => Math.abs(c.x - x) <= 3 * img.pxPerMm)) {
      return;
    }
    out.push({ x, band, by, ...analyzeHalves(img, x, band) });
  };
  if (scan.gutter?.ok) {
    add(scan.gutter.x, scan.gutter.band, "gutter");
  }
  if (scan.gap) {
    add(scan.gap.x, 0, "gap");
  }
  add(img.width / 2, 0, "center");
  return out;
}

/** 分ける位置に合う、調べておいた左右の中身の範囲 */
export function halvesFor(scan, split) {
  const list = scan?.candidates || [];
  let best = null;
  let bestD = Infinity;
  for (const c of list) {
    const d = Math.abs(c.x - split.x) + (c.band === split.band ? 0 : 0.5);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 切り取り方
// ---------------------------------------------------------------------------

/**
 * 見開きの各ページの切り取る範囲を決める(全部のページを同じ大きさにそろえる)。
 *  - 横: 分ける位置(ノド)からの距離でそろえる(本の綴じ目からの位置は、どのページも同じなので)
 *  - 縦: 全部のページの中身が収まる範囲で、どのページも同じ位置
 * @param {Array<object>} scans analyzeScan() の結果
 * @param {Array<{x:number,band:number}|null>} splits chooseSplits() の結果
 * @param {Array<{L:number[]|null,R:number[]|null}|null>} halves analyzeHalves() の結果
 * @param {{trim:boolean, marginMm?:number}} o
 * @returns {Array<{L:number[], R:number[]}|null>} 画像の座標の [x0, y0, x1, y1]。分けないページは null
 */
export function cropRects(scans, splits, halves, { trim, marginMm = DEFAULT_MARGIN_MM }) {
  const rects = scans.map(() => null);
  // 余白を除かない: ノドの線・影だけ除いて、左右に分ける
  if (!trim) {
    scans.forEach((s, i) => {
      const sp = splits[i];
      if (!s || !sp) {
        return;
      }
      rects[i] = { L: [0, 0, sp.x - sp.band, s.height], R: [sp.x + sp.band, 0, s.width, s.height] };
    });
    return rects;
  }
  const outerList = [];
  const innerList = [];
  const unions = [];
  scans.forEach((s, i) => {
    const sp = splits[i];
    const h = halves[i];
    if (!s || !sp || !h) {
      unions.push(null);
      return;
    }
    if (h.L) {
      outerList.push((sp.x - h.L[0]) / s.pxPerMm);
      innerList.push((sp.x - h.L[2]) / s.pxPerMm);
    }
    if (h.R) {
      outerList.push((h.R[2] - sp.x) / s.pxPerMm);
      innerList.push((h.R[0] - sp.x) / s.pxPerMm);
    }
    const boxes = [h.L, h.R].filter(Boolean);
    unions.push(boxes.length ? [Math.min(...boxes.map(b => b[1])) / s.pxPerMm, Math.max(...boxes.map(b => b[3])) / s.pxPerMm] : null);
  });
  if (!outerList.length) {
    return cropRects(scans, splits, halves, { trim: false });
  }
  // 単位は mm(ページによって画素の大きさが違っても合うように)
  let outer = Math.max(...outerList) + marginMm;
  // 0.4.1: 紙の外側の端が分かるページがあれば、そこより外は切る(紙の外の余白を入れない)。中身には 1mm 以上の余白を残す
  {
    const paperOuter = [];
    scans.forEach((s, i) => {
      const sp = splits[i];
      const h = halves[i];
      if (!s || !sp || !h) {
        return;
      }
      if (h.L && h.limitsL?.paperOuter != null) {
        paperOuter.push((sp.x - h.limitsL.paperOuter) / s.pxPerMm);
      }
      if (h.R && h.limitsR?.paperOuter != null) {
        paperOuter.push((h.limitsR.paperOuter - sp.x) / s.pxPerMm);
      }
    });
    const contentOuter = Math.max(...outerList);
    const usable = paperOuter.filter(v => v >= contentOuter + 1);
    if (usable.length) {
      outer = Math.max(contentOuter + 1, Math.min(outer, ...usable));
    }
  }
  const bandMm = Math.max(0, ...splits.filter(Boolean).map((sp, i) => sp.band / (scans.find(Boolean)?.pxPerMm || 1)));
  const inner = Math.max(bandMm, Math.min(...innerList) - marginMm);
  // 0.5: ノドの影がページの中まで続くときは、内側の端を影の外へ寄せる(中身には 1mm 以上の余白を残す)。
  // ページの大きさは変えずに、左右のページごとに位置をずらす(外側の余白が増える)
  const innerSide = {};
  for (const side of ["L", "R"]) {
    const contentInner = [];
    const shadow = [];
    scans.forEach((s, i) => {
      const sp = splits[i];
      const h = halves[i];
      if (!s || !sp || !h || !h[side] || sp.by === "center") {
        return;
      }
      contentInner.push(side === "L" ? (sp.x - h.L[2]) / s.pxPerMm : (h.R[0] - sp.x) / s.pxPerMm);
      shadow.push(h[`shadowMm${side}`] || 0);
    });
    if (!contentInner.length) {
      innerSide[side] = inner;
      continue;
    }
    // 影の幅は、ページによる違いを考えて多め(4分の3の位置)を使う
    const sh = [...shadow].sort((a, b) => a - b)[Math.floor((shadow.length - 1) * 0.75)];
    innerSide[side] = Math.max(inner, Math.min(sh + 0.5, Math.min(...contentInner) - 1));
  }
  // 縦: 本のように、どの見開きにも上下いっぱいの中身(見出し・ページ番号など)があるときは、見開きごとに中身の範囲に合わせる
  // (手で置いたときの上下のずれを直す)。ノートのように中身の量がまちまちなときは、どのページも同じ位置で切る
  // (中身の真ん中に合わせると、書き込みの量でページが上下にずれて見えるため)。
  const known = unions.filter(Boolean);
  const heights = known.map(u => u[1] - u[0]);
  const maxHeight = Math.max(...heights);
  const fullFlags = unions.map(u => !!u && u[1] - u[0] >= maxHeight - 5);
  const fullCount = fullFlags.filter(Boolean).length;
  const bookLike = fullCount >= Math.max(2, Math.ceil(known.length * 0.6));
  let frameHeight;
  let topOf;
  if (bookLike) {
    frameHeight = maxHeight + 2 * marginMm;
    const fullTops = unions.filter((u, i) => fullFlags[i]).map(u => (u[0] + u[1]) / 2 - frameHeight / 2);
    const typicalTop = median(fullTops);
    topOf = i => (fullFlags[i] ? (unions[i][0] + unions[i][1]) / 2 - frameHeight / 2 : typicalTop);
  } else {
    const contentTop = Math.min(...known.map(u => u[0]));
    const contentBottom = Math.max(...known.map(u => u[1]));
    let topMm = contentTop - marginMm;
    let bottomMm = contentBottom + marginMm;
    // 0.4.1: 紙の上下の端が分かれば、そこで切る(どのページも同じ位置で切るので、いちばん内側の端に合わせる)
    const edges = paperEdgesMm(scans, splits, halves);
    const bottoms = edges.bottom.filter(v => v >= contentBottom + 1);
    if (bottoms.length) {
      bottomMm = Math.max(contentBottom + 1, Math.min(bottomMm, ...bottoms));
    }
    const tops = edges.top.filter(v => v <= contentTop - 1);
    if (tops.length) {
      topMm = Math.min(contentTop - 1, Math.max(topMm, ...tops));
    }
    frameHeight = bottomMm - topMm;
    topOf = () => topMm;
  }
  if (bookLike) {
    // 0.4.1: 本のときも、紙の上下の端が分かるページがあれば、どのページの紙にも収まる高さまで縮める(中身は切らない)
    const edges = paperEdgesMm(scans, splits, halves, true);
    const spans = edges.spans.filter(v => v >= maxHeight + 2);
    if (spans.length) {
      frameHeight = Math.max(maxHeight + 2, Math.min(frameHeight, ...spans));
    }
  }
  scans.forEach((s, i) => {
    const sp = splits[i];
    if (!s || !sp) {
      return;
    }
    const px = v => v * s.pxPerMm;
    // スキャンの外にはみ出さないように、同じ高さのまま上下にずらす(高さがスキャンより大きいときは切る)
    let y0 = px(topOf(i));
    let y1 = y0 + px(frameHeight);
    if (y1 > s.height) {
      y0 -= y1 - s.height;
      y1 = s.height;
    }
    if (y0 < 0) {
      y1 = Math.min(s.height, y1 - y0);
      y0 = 0;
    }
    // 0.4.1: 紙の端の外にはみ出すときは、中身を切らない範囲で紙の中へずらす
    {
      const h = halves[i] || {};
      const lims = [h.limitsL, h.limitsR].filter(Boolean);
      const pTop = Math.max(-Infinity, ...lims.map(l => l.paperTop ?? -Infinity));
      const pBottom = Math.min(Infinity, ...lims.map(l => l.paperBottom ?? Infinity));
      const boxes = [h.L, h.R].filter(Boolean);
      const cTop = boxes.length ? Math.min(...boxes.map(b => b[1])) : y0;
      const cBottom = boxes.length ? Math.max(...boxes.map(b => b[3])) : y1;
      if (y1 > pBottom) {
        const d = Math.min(y1 - pBottom, Math.max(0, cTop - y0));
        y0 -= d;
        y1 -= d;
      } else if (y0 < pTop) {
        const d = Math.min(pTop - y0, Math.max(0, y1 - cBottom));
        y0 += d;
        y1 += d;
      }
    }
    // ノドからの距離で、左右の範囲を決める(スキャンの外にはみ出す分は白い余白になる)
    const h = halves[i] || {};
    const width = px(outer - inner);
    const innerL = Math.max(sp.band, px(innerSide.L));
    const innerR = Math.max(sp.band, px(innerSide.R));
    const frameL = [sp.x - innerL - width, y0, sp.x - innerL, y1];
    const frameR = [sp.x + innerR, y0, sp.x + innerR + width, y1];
    // 大きさはそろえたまま、縁に入ったもの(本の縁の線・影)にかかる部分は白く覆う
    rects[i] = {
      L: frameL,
      R: frameR,
      masksL: [
        ...masksOutside(frameL, avoidJunk(frameL, h.L, h.limitsL, "L", s.pxPerMm)),
        ...blobMasks(frameL, h.L, h.blobsL, s.pxPerMm),
        ...shadowMasks(frameL, h.L, s.shadow?.boxes),
      ],
      masksR: [
        ...masksOutside(frameR, avoidJunk(frameR, h.R, h.limitsR, "R", s.pxPerMm)),
        ...blobMasks(frameR, h.R, h.blobsR, s.pxPerMm),
        ...shadowMasks(frameR, h.R, s.shadow?.boxes),
      ],
    };
  });
  return rects;
}

/**
 * 0.5: 紙の上の端・下の端のノドの影を、切り取った範囲の中で白く覆う(中身にはかけない)。
 * @returns {number[][]} 覆う範囲 [x0, y0, x1, y1](画素)
 */
function shadowMasks(frame, box, shadowBoxes) {
  const out = [];
  for (const sb of shadowBoxes || []) {
    let r = [Math.max(frame[0], sb[0]), Math.max(frame[1], sb[1]), Math.min(frame[2], sb[2]), Math.min(frame[3], sb[3])];
    if (r[2] <= r[0] || r[3] <= r[1]) {
      continue;
    }
    if (box && r[0] < box[2] && r[2] > box[0] && r[1] < box[3] && r[3] > box[1]) {
      // 中身と重なる: 上の影なら中身より上だけ、下の影なら中身より下だけ
      r = sb[1] <= frame[1] + 1 || sb[1] === 0 ? [r[0], r[1], r[2], Math.min(r[3], box[1] - 1)] : [r[0], Math.max(r[1], box[3] + 1), r[2], r[3]];
      if (r[3] <= r[1]) {
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

/**
 * 紙の上下の端(mm)。edges.top / edges.bottom はページごとの値の一覧、edges.spans は上下の両方が分かるページの紙の高さ。
 */
function paperEdgesMm(scans, splits, halves) {
  const top = [];
  const bottom = [];
  const spans = [];
  scans.forEach((s, i) => {
    const h = halves[i];
    if (!s || !splits[i] || !h) {
      return;
    }
    const lims = [h.L ? h.limitsL : null, h.R ? h.limitsR : null].filter(Boolean);
    const t = lims.map(l => l.paperTop).filter(v => v != null);
    const b = lims.map(l => l.paperBottom).filter(v => v != null);
    if (t.length) {
      top.push(Math.max(...t) / s.pxPerMm);
    }
    if (b.length) {
      bottom.push(Math.min(...b) / s.pxPerMm);
    }
    if (t.length && b.length) {
      spans.push((Math.min(...b) - Math.max(...t)) / s.pxPerMm);
    }
  });
  return { top, bottom, spans };
}

/**
 * そろえた範囲が、そのページの縁に入ったもの(本の縁の線・影・ふたの影)にかかるときは、その手前で切る
 * (そのページの中身には、少なくとも 2mm の余白を残す)。
 */
function avoidJunk(rect, box, limits, side, pxPerMm) {
  if (!limits) {
    return rect;
  }
  const [x0, y0, x1, y1] = rect;
  const gap = pxPerMm; // 1mm 離す
  const keep = 2 * pxPerMm;
  let [a, b, c, d] = [x0, y0, x1, y1];
  if (side === "L" && limits.outer !== null && limits.outer + gap > a) {
    a = Math.min(limits.outer + gap, box ? box[0] - keep : Infinity, c - 10 * pxPerMm);
    a = Math.max(a, x0);
  }
  if (side === "R" && limits.outer !== null && limits.outer - gap < c) {
    c = Math.max(limits.outer - gap, box ? box[2] + keep : -Infinity, a + 10 * pxPerMm);
    c = Math.min(c, x1);
  }
  if (limits.top !== null && limits.top + gap > b) {
    b = Math.max(y0, Math.min(limits.top + gap, box ? box[1] - keep : Infinity, d - 10 * pxPerMm));
  }
  if (limits.bottom !== null && limits.bottom - gap < d) {
    d = Math.min(y1, Math.max(limits.bottom - gap, box ? box[3] + keep : -Infinity, b + 10 * pxPerMm));
  }
  // 0.4.1: 紙の端の外(ふた・台)は白く覆う(中身には 1mm の余白を残す)
  const near = pxPerMm;
  if (limits.paperBottom != null && limits.paperBottom < d) {
    d = Math.min(d, Math.max(limits.paperBottom, box ? box[3] + near : -Infinity, b + 10 * pxPerMm));
  }
  if (limits.paperTop != null && limits.paperTop > b) {
    b = Math.max(b, Math.min(limits.paperTop, box ? box[1] - near : Infinity, d - 10 * pxPerMm));
  }
  if (limits.paperOuter != null) {
    if (side === "L" && limits.paperOuter > a) {
      a = Math.max(a, Math.min(limits.paperOuter, box ? box[0] - near : Infinity, c - 10 * pxPerMm));
    }
    if (side === "R" && limits.paperOuter < c) {
      c = Math.min(c, Math.max(limits.paperOuter, box ? box[2] + near : -Infinity, a + 10 * pxPerMm));
    }
  }
  return [a, b, c, d];
}

/** 縁の近くの小さなもの(ふたの影の角など)を白く覆う範囲(中身の範囲には重ねない) */
function blobMasks(frame, box, blobs, pxPerMm) {
  const out = [];
  const pad = 0.5 * pxPerMm;
  const keep = 2 * pxPerMm;
  for (const [a, b, c, d] of blobs || []) {
    const m = [Math.max(frame[0], a - pad), Math.max(frame[1], b - pad), Math.min(frame[2], c + pad), Math.min(frame[3], d + pad)];
    if (m[2] <= m[0] || m[3] <= m[1]) {
      continue; // 範囲の外
    }
    if (box && m[0] < box[2] + keep && m[2] > box[0] - keep && m[1] < box[3] + keep && m[3] > box[1] - keep) {
      continue; // 中身に近い
    }
    out.push(m);
  }
  return out;
}

/** 範囲 frame のうち、inner の外側の部分(白く覆う部分。最大4つの長方形) */
function masksOutside(frame, inner) {
  const [x0, y0, x1, y1] = frame;
  const [a, b, c, d] = inner;
  const out = [];
  const min = 0.5;
  if (a - x0 > min) {
    out.push([x0, y0, a, y1]);
  }
  if (x1 - c > min) {
    out.push([c, y0, x1, y1]);
  }
  if (b - y0 > min) {
    out.push([a, y0, c, b]);
  }
  if (y1 - d > min) {
    out.push([a, d, c, y1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ページの並び
// ---------------------------------------------------------------------------

/**
 * 見開きを読む順に並べる。
 * @param {Array<{L:number[], R:number[]}|null>} rects cropRects() の結果
 * @param {"ltr"|"rtl"} direction 左綴じ(左のページが先)/ 右綴じ(右のページが先)
 * @returns {Array<{scan:number, half:"L"|"R"|null, rect:number[]|null, masks:number[][], rotate:number}>}
 *   rect が null なら分けずにそのまま。masks: 白く覆う範囲
 */
export function orderSpread(rects, direction = "ltr", reverse = false) {
  const out = [];
  // reverse(0.4.1): 最後の見開きから順にスキャンしたもの(右綴じの本を左綴じの本と同じ向きにめくってスキャンしたときなど)
  const order = rects.map((r, i) => [r, i]);
  if (reverse) {
    order.reverse();
  }
  order.forEach(([r, i]) => {
    if (!r) {
      out.push({ scan: i, half: null, rect: null, masks: [], rotate: 0 });
      return;
    }
    const first = direction === "rtl" ? "R" : "L";
    const second = first === "L" ? "R" : "L";
    out.push({ scan: i, half: first, rect: r[first], masks: r[`masks${first}`] || [], rotate: 0 });
    out.push({ scan: i, half: second, rect: r[second], masks: r[`masks${second}`] || [], rotate: 0 });
  });
  return out;
}

/**
 * ばらした中綴じの冊子を、両面スキャンしたものを、読む順(表紙 → 裏表紙)に並べる。
 *
 * 中綴じの冊子(N ページ、紙 N/4 枚)では、外側から j 番目(0 から)の紙に、次のページが載っている(左綴じ):
 *  - 外側の面: 左 = N − 2j、右 = 2j + 1(いちばん外側の紙の外側の面は「裏表紙 | 表紙」)
 *  - 内側の面: 左 = 2j + 2、右 = N − 2j − 1
 * 右綴じでは左右が入れ替わる。
 *
 * @param {Array<{L:number[], R:number[]}|null>} rects cropRects() の結果(全部のスキャンを分けていること)
 * @param {object} o
 * @param {"ltr"|"rtl"} o.direction
 * @param {"outer"|"inner"} [o.sheetOrder] スキャンした紙の順: 外側の紙から / 内側の紙から
 * @param {"outer"|"inner"} [o.firstSide] 1枚の紙のうち、先にスキャンした面: 外側の面 / 内側の面
 * @param {boolean} [o.flipBacks] 後からスキャンした面が上下逆さま
 * @returns {{pages:Array<{scan:number, half:"L"|"R", rect:number[], rotate:number, page:number}>|null, error?:string}}
 */
export function orderBooklet(rects, { direction = "ltr", sheetOrder = "outer", firstSide = "outer", flipBacks = false } = {}) {
  const M = rects.length;
  if (M < 2 || M % 2 !== 0) {
    return { pages: null, error: "odd" };
  }
  if (rects.some(r => !r)) {
    return { pages: null, error: "unsplit" };
  }
  const N = M * 2;
  const S = M / 2;
  const slots = new Array(N + 1).fill(null);
  for (let i = 0; i < M; i++) {
    const pair = Math.floor(i / 2);
    const sideIndex = i % 2; // 0: 先にスキャンした面
    const sheet = sheetOrder === "outer" ? pair : S - 1 - pair;
    const outerSide = firstSide === "outer" ? sideIndex === 0 : sideIndex === 1;
    let leftPage;
    let rightPage;
    if (outerSide) {
      [leftPage, rightPage] = direction === "rtl" ? [2 * sheet + 1, N - 2 * sheet] : [N - 2 * sheet, 2 * sheet + 1];
    } else {
      [leftPage, rightPage] = direction === "rtl" ? [N - 2 * sheet - 1, 2 * sheet + 2] : [2 * sheet + 2, N - 2 * sheet - 1];
    }
    const flipped = flipBacks && sideIndex === 1;
    // 上下逆さまの面は、画像の左に見えているのが本当は右の半分
    const leftHalf = flipped ? "R" : "L";
    const rightHalf = flipped ? "L" : "R";
    const rotate = flipped ? 180 : 0;
    slots[leftPage] = { scan: i, half: leftHalf, rect: rects[i][leftHalf], masks: rects[i][`masks${leftHalf}`] || [], rotate, page: leftPage };
    slots[rightPage] = { scan: i, half: rightHalf, rect: rects[i][rightHalf], masks: rects[i][`masks${rightHalf}`] || [], rotate, page: rightPage };
  }
  const pages = slots.slice(1);
  if (pages.some(p => !p)) {
    return { pages: null, error: "mapping" };
  }
  return { pages };
}
