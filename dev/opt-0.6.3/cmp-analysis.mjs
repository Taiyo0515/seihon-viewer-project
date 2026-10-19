// 段階2の前後で analyzeFull の結果が同じか(前の結果から、使っていなかった deskewed.halfSkew だけを除いて比べる)
import fs from "node:fs";
import path from "node:path";
const [a, b] = process.argv.slice(2);
const strip = o => {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === "object") {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === "deskewed" && v && typeof v === "object") {
        const { halfSkew, ...rest } = v;
        out[k] = strip(rest);
      } else out[k] = strip(v);
    }
    return out;
  }
  return o;
};
let same = 0, diff = 0, removed = 0;
for (const f of fs.readdirSync(a).sort()) {
  const A = JSON.parse(fs.readFileSync(path.join(a, f), "utf8"));
  const B = JSON.parse(fs.readFileSync(path.join(b, f), "utf8"));
  const sa = JSON.stringify(strip(A)), sb = JSON.stringify(B);
  removed += (JSON.stringify(A).match(/"deskewed":\{[^]*?"halfSkew"/g) || []).length ? 1 : 0;
  if (sa === sb) same++; else { diff++; console.log("DIFF", f); }
}
console.log(`同じ ${same} / 違う ${diff}(前の結果のうち deskewed.halfSkew を含んでいたファイル ${removed})`);
