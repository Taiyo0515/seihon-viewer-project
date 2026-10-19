// 自作の ES モジュールの import / export の突き合わせ(名前・パスのずれを見つける)
//   node dev/lint/check/imports.mjs   (acorn・acorn-walk が必要。npm で入れるか、NODE_PATH で場所を指定)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
let require = createRequire(import.meta.url);
try {
  require.resolve("acorn");
} catch {
  require = createRequire("/opt/npm-tools/node_modules/"); // 開発に使った環境の場所
}
const acorn = require("acorn");
const walk = require("acorn-walk");
const ROOT = fileURLToPath(new URL("../../../src", import.meta.url));
const OUT = fileURLToPath(new URL("../../logs/unused-exports.txt", import.meta.url));
const files = [];
(function scan(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!["pdfjs", "lib", "tools", "helper"].includes(e.name) || d !== ROOT) scan(p); }
    else if (p.endsWith(".js") || p.endsWith(".mjs")) files.push(p);
  }
})(ROOT);
const cache = new Map();
function info(file) {
  if (cache.has(file)) return cache.get(file);
  const src = fs.readFileSync(file, "utf8");
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }); }
  catch (e) {
    try { ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" }); }
    catch (e2) { console.log("PARSE ERROR", file, e.message); cache.set(file, null); return null; }
  }
  const exports = new Set(); let star = [];
  const imports = []; const dyn = [];
  for (const n of ast.body) {
    if (n.type === "ExportNamedDeclaration") {
      if (n.declaration) {
        if (n.declaration.id) exports.add(n.declaration.id.name);
        if (n.declaration.declarations) for (const d of n.declaration.declarations) {
          if (d.id.type === "Identifier") exports.add(d.id.name);
          else if (d.id.type === "ObjectPattern") for (const p of d.id.properties) exports.add(p.value.name);
        }
      }
      for (const s of n.specifiers || []) exports.add(s.exported.name ?? s.exported.value);
      if (n.source) imports.push({ src: n.source.value, names: (n.specifiers || []).map(s => s.local.name ?? s.local.value), line: n.loc?.start?.line, reexport: true });
    } else if (n.type === "ExportDefaultDeclaration") exports.add("default");
    else if (n.type === "ExportAllDeclaration") { star.push(n.source.value); }
    else if (n.type === "ImportDeclaration") {
      imports.push({ src: n.source.value, names: n.specifiers.map(s => s.type === "ImportDefaultSpecifier" ? "default" : s.type === "ImportNamespaceSpecifier" ? "*" : (s.imported.name ?? s.imported.value)) });
    }
  }
  walk.simple(ast, { ImportExpression(n) { if (n.source.type === "Literal") dyn.push(n.source.value); } });
  const r = { exports, star, imports, dyn };
  cache.set(file, r);
  return r;
}
function resolve(from, spec) {
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const p = spec.startsWith("/") ? path.join(ROOT, spec) : path.resolve(path.dirname(from), spec);
    return p;
  }
  return null;
}
function allExports(file, seen = new Set()) {
  if (seen.has(file)) return new Set(); seen.add(file);
  const i = info(file); if (!i) return new Set();
  const out = new Set(i.exports);
  for (const s of i.star) { const p = resolve(file, s); if (p && fs.existsSync(p)) for (const e of allExports(p, seen)) out.add(e); }
  return out;
}
let problems = 0;
for (const f of files) {
  const i = info(f); if (!i) { problems++; continue; }
  for (const imp of i.imports) {
    const p = resolve(f, imp.src);
    if (!p) { console.log("BARE", f, imp.src); continue; }
    if (!fs.existsSync(p)) { console.log("MISSING FILE", path.relative(ROOT, f), "->", imp.src); problems++; continue; }
    if (p.includes("/pdfjs/")) continue;
    const ex = allExports(p);
    for (const n of imp.names) {
      if (n === "*") continue;
      if (!ex.has(n)) { console.log("MISSING EXPORT", path.relative(ROOT, f), "imports", n, "from", imp.src); problems++; }
    }
  }
  for (const d of i.dyn) {
    const p = resolve(f, d);
    if (p && !fs.existsSync(p)) { console.log("MISSING DYNAMIC", path.relative(ROOT, f), d); problems++; }
  }
}
// 使われていない export(段階2の候補)
const used = new Map();
for (const f of files) { const i = info(f); if (!i) continue;
  for (const imp of i.imports) { const p = resolve(f, imp.src); if (!p) continue; for (const n of imp.names) { const k = p + "#" + n; used.set(k, (used.get(k) || 0) + 1); } if (imp.names.includes("*")) used.set(p + "#*", 1); }
}
const unusedExports = [];
for (const f of files) { const i = info(f); if (!i) continue; if (f.includes("/lib/")) continue;
  for (const e of i.exports) if (!used.has(f + "#" + e) && !used.has(f + "#*")) unusedExports.push(path.relative(ROOT, f) + " : " + e);
}
console.log("files", files.length, "problems", problems);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, unusedExports.join("\n"));
console.log("unused exports:", unusedExports.length, "→", OUT);
