// analyzeFull の結果を JSON にして保存する(段階2の前後の比較用): node snap-analysis.mjs <出力フォルダ> <pgm>...
import fs from "node:fs";
import path from "node:path";
const mod = process.env.MOD || new URL("../../src/viewer/scan/scan-analysis.js", import.meta.url).href;
const A = await import(mod);
function readPgm(f){const b=fs.readFileSync(f);let p=0;const tok=()=>{while(b[p]<=32)p++;let s="";while(b[p]>32)s+=String.fromCharCode(b[p++]);return s};tok();const w=+tok(),h=+tok();tok();p++;return {gray:new Uint8Array(b.subarray(p,p+w*h)),width:w,height:h}}
const [out, ...files] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const replacer = (k, v) => (v instanceof Uint8Array || v instanceof Float32Array || v instanceof Int32Array ? Array.from(v) : v);
let total = 0;
for (const f of files) {
  const img = readPgm(f); img.pxPerMm = Math.max(img.width, img.height) / 297;
  const t = performance.now();
  const scan = A.analyzeFull({ ...img, gray: img.gray.slice() });
  const forced = A.analyzeFull({ ...img, gray: img.gray.slice() }, { turn: "force" });
  total += performance.now() - t;
  const name = f.replace(/^\//, "").replace(/[\/]/g, "_");
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ scan, forced }, replacer));
}
console.log(`${files.length} files, ${total.toFixed(0)} ms`);
