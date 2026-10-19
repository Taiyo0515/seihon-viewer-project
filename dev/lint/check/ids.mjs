// JS が参照する要素の id が HTML(または JS で作る要素)にあるか
//   node dev/lint/check/ids.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../../../src", import.meta.url));
const pages = {
  viewer: { html: ["viewer/viewer.html"], js: dir("viewer") },
  options: { html: ["options/options.html"], js: ["options/options.js"] },
  reader: { html: ["reader/reader.html"], js: ["reader/reader.js", "reader/print-book.js"] },
  welcome: { html: ["welcome/welcome.html"], js: ["welcome/welcome.js"] },
};
function dir(d) { const out = []; (function s(p) { for (const e of fs.readdirSync(path.join(ROOT, p), { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) s(q); else if (q.endsWith(".js")) out.push(q); } })(d); return out; }
const common = dir("common");
for (const [name, pg] of Object.entries(pages)) {
  const ids = new Set();
  for (const h of pg.html) for (const m of fs.readFileSync(path.join(ROOT, h), "utf8").matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  const pdfjsIds = new Set();
  // pdf.js の viewer.html 由来の要素(viewer.html に含まれていればそのまま)
  const js = [...pg.js, ...common];
  const dyn = new Set();
  for (const f of js) { const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const m of s.matchAll(/\.id\s*=\s*["'`]([^"'`$]+)["'`]/g)) dyn.add(m[1]);
    for (const m of s.matchAll(/\bid=\\?["']([^"'$\\]+)\\?["']/g)) dyn.add(m[1]);
    for (const m of s.matchAll(/\bid:\s*["']([^"']+)["']/g)) dyn.add(m[1]);
  }
  const missing = [];
  for (const f of js) { const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    const refs = [...s.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g), ...s.matchAll(/\$\(\s*["']([A-Za-z][\w-]*)["']\s*\)/g), ...s.matchAll(/querySelector(?:All)?\(\s*["']#([A-Za-z][\w-]*)[^"']*["']\s*\)/g)];
    for (const m of refs) { const id = m[1]; if (!ids.has(id) && !dyn.has(id)) { const line = s.slice(0, m.index).split("\n").length; missing.push(`${f}:${line} ${id}`); } }
  }
  console.log(`== ${name}: html ids ${ids.size}, dyn ${dyn.size}, missing ${missing.length}`);
  for (const m of missing) console.log("  ", m);
}
