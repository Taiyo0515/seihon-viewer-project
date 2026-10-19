import fs from "node:fs";
const A = await import("./sa-base.mjs");
const B = await import(new URL("../../src/viewer/scan/scan-analysis.js", import.meta.url).href);
function readPgm(f){const b=fs.readFileSync(f);let p=0;const tok=()=>{while(b[p]<=32)p++;let s="";while(b[p]>32)s+=String.fromCharCode(b[p++]);return s};tok();const w=+tok(),h=+tok();tok();p++;return {gray:new Uint8Array(b.subarray(p,p+w*h)),width:w,height:h}}
const N = 3;
const rows = [];
for (const f of process.argv.slice(2)) {
  const img = readPgm(f); img.pxPerMm = Math.max(img.width,img.height)/297;
  const run = (M) => { const t = performance.now(); for (let i = 0; i < N; i++) M.analyzeFull({ ...img, gray: img.gray.slice() }); return (performance.now() - t) / N; };
  run(A); run(B);
  const ta = (run(A) + run(A)) / 2, tb = (run(B) + run(B)) / 2;
  rows.push([f.split("/").slice(-2).join("/"), ta, tb]);
  console.log(f.split("/").slice(-2).join("/"), `${img.width}x${img.height}`, `前 ${ta.toFixed(0)} ms → 後 ${tb.toFixed(0)} ms (${(100 * (1 - tb / ta)).toFixed(0)}% 短縮)`);
}
const sa = rows.reduce((s, r) => s + r[1], 0), sb = rows.reduce((s, r) => s + r[2], 0);
console.log(`合計 前 ${sa.toFixed(0)} ms → 後 ${sb.toFixed(0)} ms (${(100 * (1 - sb / sa)).toFixed(0)}% 短縮)`);
