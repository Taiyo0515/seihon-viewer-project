import fs from "node:fs";
const A = await import("./sa-base.mjs");
const B = await import(new URL("../../src/viewer/scan/scan-analysis.js?new", import.meta.url).href);
function readPgm(f){const b=fs.readFileSync(f);let p=0;const tok=()=>{while(b[p]<=32)p++;let s="";while(b[p]>32)s+=String.fromCharCode(b[p++]);return s};tok();const w=+tok(),h=+tok();tok();p++;return {gray:new Uint8Array(b.subarray(p,p+w*h)),width:w,height:h}}
let same=0, diff=0, ta=0, tb=0;
for (const f of process.argv.slice(2)) {
  const img = readPgm(f); img.pxPerMm = Math.max(img.width,img.height)/297;
  let t=performance.now(); const ra = A.findSkew(img); ta += performance.now()-t;
  t=performance.now(); const rb = B.findSkew(img); tb += performance.now()-t;
  if (JSON.stringify(ra)===JSON.stringify(rb)) same++; else { diff++; console.log("DIFF", f, JSON.stringify(ra), JSON.stringify(rb)); }
}
console.log(`same ${same} diff ${diff}  time A ${ta.toFixed(0)} ms  B ${tb.toFixed(0)} ms`);
