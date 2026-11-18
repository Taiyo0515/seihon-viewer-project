/**
 * 画像化したページの濃度補正(0.13.0)。
 *
 * 600dpi で画像にすると、文字の輪郭がアンチエイリアスで薄い灰色になり、印刷すると
 * かすれて見えることがある。ここでは「紙の白」と「文字の黒」はそのままに、その間の
 * 灰色(インクの量)だけを濃くする。同じ単調な曲線を R・G・B に同じだけ当てるので、
 * 色相は変わらない(写真の色が別の色に転ぶことはない)。
 *
 * - 紙に近いごく薄い灰色(インク 4〜5% 以下)は白に寄せる(紙のざらつき・薄いむらを残さない)。
 * - インクの量 a (0=白, 1=黒) を a^gamma に置き換える。gamma < 1 で中間が濃くなる。
 * - 写真だけの面(紙の白が少ない面)には掛けない。図表・写真への影響を抑えるため。
 *
 * 70MP 級の面では 1 画素ずつのループは数秒かかるので、通常は SVG の
 * feComponentTransfer(表)を Canvas の ctx.filter として当てる(GPU。数十 ms)。
 * 使えない環境では同じ表を 1 画素ずつ当てる(結果は同じ)。
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const FILTER_ID = "shRasterToneFilter";

/** 濃度補正の強さ。none: 補正なし / standard: 標準 / strong: 濃い */
export const RASTER_TONE_LEVELS = Object.freeze(["none", "standard", "strong"]);

/**
 * 補正の曲線。gamma が小さいほど中間が濃い。white は「白に寄せる」インクの上限。
 * standard は 50% 灰色を約 11% 濃く、strong は約 22% 濃くする(黒・白は変えない)。
 */
const CURVES = Object.freeze({
  standard: Object.freeze({ gamma: 0.8, white: 0.04 }),
  strong: Object.freeze({ gamma: 0.68, white: 0.05 }),
});

/** 画像化した面の、紙・インクの割合(0〜1) */
const PAPER_DOMINANT = 0.6;

/** 保存値から濃度補正の強さを決める。知らない値は補正なし(既存の出力を変えない) */
export function normalizeToneLevel(value) {
  return RASTER_TONE_LEVELS.includes(value) ? value : "none";
}

/**
 * 画素値(0〜255)を画素値に写す表。null は「補正なし」。
 * @param {"none"|"standard"|"strong"} level
 * @returns {Uint8Array|null}
 */
export function toneTable(level) {
  const curve = CURVES[level];
  if (!curve) {
    return null;
  }
  const table = new Uint8Array(256);
  for (let value = 0; value < 256; value++) {
    const ink = 1 - value / 255;
    // インクの量を gamma で濃くする。紙に近い薄いインクは 0(白)にする
    const boosted = ink <= curve.white ? 0 : ((ink - curve.white) / (1 - curve.white)) ** curve.gamma;
    table[value] = Math.round(255 * (1 - boosted));
  }
  return table;
}

/**
 * 画像化した面の内容を、間引いた帯から調べる(全画素は読まない。70MP でも 0.1〜0.2 秒ほど)。
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 * @returns {{white:number, paper:number, mid:number, chroma:number}}
 */
export function inkStats(canvas, ctx) {
  const width = canvas.width;
  const height = canvas.height;
  const bands = 8;
  const rows = Math.max(1, Math.min(16, Math.floor(height / (bands * 2))));
  let white = 0;
  let paper = 0;
  let mid = 0;
  let chroma = 0;
  let total = 0;
  if (!width || !height) {
    return { white: 0, paper: 0, mid: 0, chroma: 0 };
  }
  for (let band = 0; band < bands; band++) {
    const y = Math.min(height - rows, Math.floor(((height - rows) * (band + 0.5)) / bands));
    const data = ctx.getImageData(0, y, width, rows).data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luma = (r * 77 + g * 150 + b * 29) >> 8;
      total++;
      if (luma >= 250) {
        white++;
      }
      if (luma >= 235) {
        paper++;
      } else if (luma > 40) {
        mid++;
      }
      const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (max - min > 48) {
        chroma++;
      }
    }
  }
  if (!total) {
    return { white: 0, paper: 0, mid: 0, chroma: 0 };
  }
  return { white: white / total, paper: paper / total, mid: mid / total, chroma: chroma / total };
}

/** 濃度補正を掛けてよい面か(紙が多く、写真だけの面ではない) */
export function shouldApplyTone(stats) {
  return !!stats && stats.paper >= PAPER_DOMINANT;
}

/**
 * 画像の圧縮方式を選ぶ。文字中心で色の少ない面は、可逆な PNG のほうが
 * JPEG より小さく(試験用の文字中心の面で約 1/2.5)、輪郭も劣化しない。
 * 写真・スキャンのざらつきがある面は JPEG にする(PNG は数倍に膨らむ)。
 * @param {{white:number, paper:number, mid:number, chroma:number}} stats
 * @returns {"png"|"jpeg"}
 */
export function chooseRasterEncoding(stats) {
  if (!stats) {
    return "jpeg";
  }
  return stats.paper >= PAPER_DOMINANT && stats.mid <= 0.12 && stats.chroma <= 0.08 ? "png" : "jpeg";
}

/** SVG フィルタを作り直す(強さを変えたときだけ)。作れなければ null */
let filterState = null;
function toneFilterRef(level) {
  const table = toneTable(level);
  if (!table) {
    return null;
  }
  if (filterState && filterState.level === level && filterState.svg.isConnected) {
    return `url(#${FILTER_ID})`;
  }
  filterState?.svg.remove();
  filterState = null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  const filter = document.createElementNS(SVG_NS, "filter");
  filter.id = FILTER_ID;
  filter.setAttribute("color-interpolation-filters", "sRGB");
  filter.setAttribute("x", "0");
  filter.setAttribute("y", "0");
  filter.setAttribute("width", "100%");
  filter.setAttribute("height", "100%");
  const transfer = document.createElementNS(SVG_NS, "feComponentTransfer");
  const values = Array.from(table, value => (value / 255).toFixed(5)).join(" ");
  for (const name of ["feFuncR", "feFuncG", "feFuncB"]) {
    const func = document.createElementNS(SVG_NS, name);
    func.setAttribute("type", "table");
    func.setAttribute("tableValues", values);
    transfer.append(func);
  }
  filter.append(transfer);
  svg.append(filter);
  document.body.append(svg);
  filterState = { level, svg };
  return `url(#${FILTER_ID})`;
}

/** ctx.filter の SVG フィルタが実際に効くか(効かない環境では 1 画素ずつ当てる) */
let filterSupported = false;
function svgFilterWorks(ref) {
  if (filterSupported) {
    return true;
  }
  const probe = document.createElement("canvas");
  probe.width = 2;
  probe.height = 1;
  const ctx = probe.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 2, 1);
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, 1, 1);
  ctx.filter = ref;
  ctx.drawImage(probe, 0, 0);
  ctx.filter = "none";
  const value = ctx.getImageData(0, 0, 1, 1).data[0];
  probe.width = probe.height = 0;
  // 128 がそのまま(効いていない)なら false。補正後は必ず 128 より小さくなる
  filterSupported = value < 120;
  return filterSupported;
}

/** 表を 1 画素ずつ当てる(フォールバック)。面を帯に分けて、メモリを増やさない */
function applyTableByPixel(ctx, canvas, table) {
  const width = canvas.width;
  const height = canvas.height;
  // 1回に読む量を約 16MB(RGBA)までにする
  const strip = Math.max(1, Math.min(512, Math.floor(4_000_000 / Math.max(1, width))));
  for (let y = 0; y < height; y += strip) {
    const rows = Math.min(strip, height - y);
    const image = ctx.getImageData(0, y, width, rows);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = table[data[i]];
      data[i + 1] = table[data[i + 1]];
      data[i + 2] = table[data[i + 2]];
    }
    ctx.putImageData(image, 0, y);
  }
}

/**
 * 面に濃度補正を掛ける。写真だけの面には掛けない。
 * @param {HTMLCanvasElement} canvas
 * @param {"none"|"standard"|"strong"} level
 * @param {{white:number, paper:number, mid:number, chroma:number}} [stats] inkStats() の結果
 * @returns {"gpu"|"js"|"none"|"skipped"} 実際に行った処理(試験・記録用)
 */
export function applyRasterTone(canvas, level, stats) {
  const table = toneTable(level);
  if (!table) {
    return "none";
  }
  if (!shouldApplyTone(stats)) {
    return "skipped";
  }
  const ctx = canvas.getContext("2d", { alpha: false });
  const ref = toneFilterRef(level);
  if (ref && svgFilterWorks(ref)) {
    ctx.save();
    ctx.filter = ref;
    // 同じキャンバスへ描き直す(Chrome は描く前の内容を読み取ってから描く)
    ctx.drawImage(canvas, 0, 0);
    ctx.restore();
    return "gpu";
  }
  applyTableByPixel(ctx, canvas, table);
  return "js";
}
