// 段階3: 境界・空に近い入力で、段階2の前後の結果が同じか
const A = await import("./sa-base.mjs");
const B = await import(new URL("../../src/viewer/scan/scan-analysis.js", import.meta.url).href);
const mk = (w, h, f) => { const g = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = f(x, y); return { gray: g, width: w, height: h, pxPerMm: Math.max(w, h) / 297 }; };
let seed = 1; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const cases = {
  "白紙 800x600": mk(800, 600, () => 255),
  "真っ黒 800x600": mk(800, 600, () => 0),
  "ノイズ 700x500": mk(700, 500, () => (rnd() < 0.05 ? 0 : 255)),
  "とても小さい 40x40": mk(40, 40, (x, y) => ((x + y) % 7 ? 255 : 0)),
  "細長い 1200x60": mk(1200, 60, (x, y) => (y % 12 < 2 && x % 9 < 6 ? 0 : 255)),
  "横線だけ 900x700": mk(900, 700, (x, y) => (y % 30 < 2 ? 20 : 250)),
  "傾いた行 1000x700": mk(1000, 700, (x, y) => ((y + x * 0.02) % 24 < 3 && x % 14 < 9 && x > 80 && x < 920 ? 10 : 245)),
  "縦長・傾いた列 600x900": mk(600, 900, (x, y) => ((x - y * 0.015) % 26 < 3 && y % 13 < 9 && y > 60 && y < 840 ? 10 : 245)),
  "横長・真ん中に線 1100x780": mk(1100, 780, (x, y) => (Math.abs(x - 550) < 3 ? 40 : (y % 22 < 3 && x % 11 < 7 && (x < 520 || x > 580) && x > 60 && x < 1040 ? 15 : 240))),
};
let same = 0, diff = 0;
for (const [name, img] of Object.entries(cases)) {
  const ra = { skew: A.findSkew(img), full: A.analyzeFull({ ...img, gray: img.gray.slice() }), forced: A.analyzeFull({ ...img, gray: img.gray.slice() }, { turn: "force" }) };
  const rb = { skew: B.findSkew(img), full: B.analyzeFull({ ...img, gray: img.gray.slice() }), forced: B.analyzeFull({ ...img, gray: img.gray.slice() }, { turn: "force" }) };
  for (const r of [ra.full, ra.forced, ra.full.turned?.cw, ra.full.turned?.ccw, ra.forced.turned?.cw, ra.forced.turned?.ccw]) { if (r?.deskewed) delete r.deskewed.halfSkew; }
  const rep = (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v);
  const ok = JSON.stringify(ra, rep) === JSON.stringify(rb, rep);
  ok ? same++ : diff++;
  console.log(ok ? "同じ" : "違う", name, JSON.stringify(rb.skew));
}
console.log(`同じ ${same} / 違う ${diff}`);
