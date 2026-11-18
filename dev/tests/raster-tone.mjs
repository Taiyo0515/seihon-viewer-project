/** 濃度補正(0.13.0)の表・分類の試験。ブラウザを使わずに node で動かす。 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(path.join(ROOT, "src", "viewer", "raster-tone.js"), "utf8");
// src の .js は拡張子のままだと node では CommonJS 扱いになるので、中身をそのまま ESM として読み込む
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const { RASTER_TONE_LEVELS, normalizeToneLevel, toneTable, chooseRasterEncoding, shouldApplyTone } = mod;

// ---- 強さの解釈 ----
assert.deepEqual([...RASTER_TONE_LEVELS], ["none", "standard", "strong"]);
assert.equal(normalizeToneLevel("strong"), "strong");
assert.equal(normalizeToneLevel("standard"), "standard");
assert.equal(normalizeToneLevel("none"), "none");
assert.equal(normalizeToneLevel(undefined), "none", "未指定は補正なし(既存の出力を変えない)");
assert.equal(normalizeToneLevel("unknown"), "none");

// ---- 補正の表 ----
assert.equal(toneTable("none"), null);
const standard = toneTable("standard");
const strong = toneTable("strong");
assert.equal(standard.length, 256);
assert.equal(standard[0], 0, "黒は黒のまま");
assert.equal(standard[255], 255, "白は白のまま");
assert.equal(standard[250], 255, "紙に近い薄い灰色は白に寄せる");
for (const table of [standard, strong]) {
  for (let v = 1; v < 256; v++) {
    assert.ok(table[v] >= table[v - 1], `画素値の順序が逆にならない(${v})`);
  }
}
// 中間(50% 灰色)は濃くなる。標準は 10% 前後、濃いはさらに濃い
assert.ok(standard[128] < 128 && standard[128] >= 108, `標準: 128 → ${standard[128]}`);
assert.ok(strong[128] < standard[128], `濃い: 128 → ${strong[128]}`);
// 濃い中間調ほど濃くなる(写真の暗部・明部はほとんど動かない)
assert.ok(standard[192] < 192);
assert.ok(standard[64] < 64);
assert.ok(Math.abs(standard[255] - 255) < 1);

// ---- 面の分類 ----
assert.equal(chooseRasterEncoding(null), "jpeg");
assert.equal(chooseRasterEncoding({ white: 0.9, paper: 0.93, mid: 0.02, chroma: 0 }), "png", "文字中心の面は可逆");
assert.equal(chooseRasterEncoding({ white: 0.5, paper: 0.7, mid: 0.25, chroma: 0.01 }), "jpeg", "スキャンのざらつきは JPEG");
assert.equal(chooseRasterEncoding({ white: 0.2, paper: 0.3, mid: 0.6, chroma: 0.4 }), "jpeg", "写真は JPEG");
assert.equal(chooseRasterEncoding({ white: 0.87, paper: 0.9, mid: 0.05, chroma: 0.2 }), "jpeg", "色の多い面は JPEG");

// ---- 補正を掛ける面か ----
assert.equal(shouldApplyTone({ paper: 0.93 }), true);
assert.equal(shouldApplyTone({ paper: 0.3 }), false, "写真だけの面には掛けない");
assert.equal(shouldApplyTone(null), false);

console.log("raster-tone: OK");
