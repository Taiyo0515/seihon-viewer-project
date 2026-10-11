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
  return { box, ink: total, limits, blobs };
}

// ---------------------------------------------------------------------------
// 1ページ分の調べ
// ---------------------------------------------------------------------------

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
  return result;
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
  const outer = Math.max(...outerList) + marginMm;
  const bandMm = Math.max(0, ...splits.filter(Boolean).map((sp, i) => sp.band / (scans.find(Boolean)?.pxPerMm || 1)));
  const inner = Math.max(bandMm, Math.min(...innerList) - marginMm);
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
    const topMm = Math.min(...known.map(u => u[0])) - marginMm;
    const bottomMm = Math.max(...known.map(u => u[1])) + marginMm;
    frameHeight = bottomMm - topMm;
    topOf = () => topMm;
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
    // ノドからの距離で、左右の範囲を決める(スキャンの外にはみ出す分は白い余白になる)
    const innerPx = Math.max(sp.band, px(inner));
    const h = halves[i] || {};
    const frameL = [sp.x - px(outer), y0, sp.x - innerPx, y1];
    const frameR = [sp.x + innerPx, y0, sp.x + px(outer), y1];
    // 大きさはそろえたまま、縁に入ったもの(本の縁の線・影)にかかる部分は白く覆う
    rects[i] = {
      L: frameL,
      R: frameR,
      masksL: [...masksOutside(frameL, avoidJunk(frameL, h.L, h.limitsL, "L", s.pxPerMm)), ...blobMasks(frameL, h.L, h.blobsL, s.pxPerMm)],
      masksR: [...masksOutside(frameR, avoidJunk(frameR, h.R, h.limitsR, "R", s.pxPerMm)), ...blobMasks(frameR, h.R, h.blobsR, s.pxPerMm)],
    };
  });
  return rects;
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
export function orderSpread(rects, direction = "ltr") {
  const out = [];
  rects.forEach((r, i) => {
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
