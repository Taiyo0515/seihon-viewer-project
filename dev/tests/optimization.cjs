/** 出力順・保存方針を変えない最適化の回帰試験。専用ブラウザーで保存と解放も確認する。 */
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { performance } = require("node:perf_hooks");

const root = path.resolve(__dirname, "../..");

// 比較用の従来処理。混在・重複ページの並びをそのまま保つことを確かめる。
function originalPageInfos(pages) {
  const groups = new Map();
  pages.forEach((p, position) => {
    let layers = groups.get(p.source);
    if (!layers) { layers = []; groups.set(p.source, layers); }
    let layer = layers.find(l => !l.some(e => e.pageIndex === p.pageIndex));
    if (!layer) { layer = []; layers.push(layer); }
    layer.push({ pageIndex: p.pageIndex, position });
  });
  const infos = [];
  for (const [source, layers] of groups) {
    for (const layer of layers) {
      layer.sort((a, b) => a.pageIndex - b.pageIndex);
      infos.push({
        document: source === "current" ? null : source,
        includePages: layer.map(e => e.pageIndex),
        pageIndices: layer.map(e => e.position),
      });
    }
  }
  return infos;
}

(async () => {
  const { extractPagesToPdf, editedDocumentBytes } = await import(pathToFileURL(path.join(root, "src/viewer/page-export.js")));
  const sources = ["current", new Uint8Array([1]), new Uint8Array([1]), new Uint8Array([2])];
  let seed = 17947;
  const random = n => ((seed = (seed * 1664525 + 1013904223) >>> 0) % n);
  const capture = async pages => {
    let infos;
    await extractPagesToPdf({ extractPages: async value => { infos = value; return new Uint8Array([1]); } }, pages);
    return infos;
  };
  for (let run = 0; run < 120; run++) {
    const pages = Array.from({ length: 1 + random(900) }, () => ({ source: sources[random(sources.length)], pageIndex: random(80) }));
    assert.deepEqual(await capture(pages), originalPageInfos(pages));
  }
  const large = Array.from({ length: 12000 }, (_, pageIndex) => ({ source: "current", pageIndex }));
  let start = performance.now();
  const oldInfos = originalPageInfos(large);
  const oldMs = performance.now() - start;
  start = performance.now();
  assert.deepEqual(await capture(large), oldInfos);
  const newMs = performance.now() - start;
  console.log(`PASS ページ指定の等価比較 120 ケース / 12,000 ページ: 従来 ${oldMs.toFixed(1)} ms → 変更後 ${newMs.toFixed(1)} ms`);

  let reads = 0;
  const transfer = [];
  let saved;
  await editedDocumentBytes({
    annotationStorage: { size: 1, get serializable() { reads++; return { map: new Map([["annotation", { pageIndex: 0, value: "保持" }]]), transfer }; } },
    pagesMapper: { getMapping: () => [3, 1, 2] },
    _transport: { _numPages: 3, messageHandler: { sendWithPromise: async (...args) => { saved = args; return new Uint8Array([2]); } } },
  });
  assert.equal(reads, 1);
  assert.equal(saved[1].annotationStorage.get("annotation").pageIndex, 2);
  assert.equal(saved[1].annotationStorage.get("annotation").value, "保持");
  assert.equal(saved[2], transfer);
  console.log("PASS 注釈データは1回の取得で、ページ対応・転送指定を保持");

  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
  const ext = path.join(root, "src");
  const context = await chromium.launchPersistentContext(path.join(os.tmpdir(), `seihon-optimization-${Date.now()}`), {
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html");
    await page.waitForSelector("#shCollectEdit", { state: "attached" });
    const result = await page.evaluate(async () => {
      const dbModule = await import("../common/db.js");
      const db = await dbModule.openDb();
      const transact = (db, store, mode, action) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        action(tx.objectStore(store));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      const readAll = (db, name) => new Promise((resolve, reject) => {
        const req = db.transaction(name).objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await transact(db, "scanCache", "readwrite", store => {
        store.clear();
        for (const row of [
          { key: "same", baseKey: "base", size: 100, t: 1 },
          { key: "old", baseKey: "other1", size: 800000000, t: 2 },
          { key: "newer", baseKey: "other2", size: 800000000, t: 3 },
        ]) { store.put({ ...row, data: new Blob(["test"]) }); }
      });
      let reads = 0;
      const originalGetAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function (...args) {
        if (this.name === "scanCache") { reads++; }
        return originalGetAll.apply(this, args);
      };
      try { await dbModule.putScanCache("current", new Uint8Array([1, 2, 3]), "base"); }
      finally { IDBObjectStore.prototype.getAll = originalGetAll; }
      const cache = (await readAll(db, "scanCache")).map(row => row.key).sort();
      const cacheBytes = Array.from(await dbModule.getScanCache("current"));

      const handoff = await import("../common/handoff.js");
      await handoff.putHandoff(new Blob(["initialize"]));
      const handoffDb = await new Promise((resolve, reject) => {
        const req = indexedDB.open("seihon-handoff");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const now = Date.now();
      const ids = ["1", "2", "3", "4"].map(value => value.repeat(24));
      await transact(handoffDb, "files", "readwrite", store => {
        store.clear();
        store.put({ id: ids[0], time: now - 86400001, size: 2, blob: new Blob(["expired"]) });
        store.put({ id: ids[1], time: now - 2000, size: 800000000, blob: new Blob(["older"]) });
        store.put({ id: ids[2], time: now - 1000, size: 800000000, blob: new Blob(["newest"]) });
        store.put({ id: ids[3], time: now - 3000, size: 1, blob: new Blob(["after-limit"]) });
      });
      const inserted = await handoff.putHandoff(new Blob(["incoming"]), { name: "incoming" });
      const retained = (await readAll(handoffDb, "files")).map(row => row.id).sort();
      handoffDb.close();

      const { PDFDocument } = await import("../lib/pdf-lib.esm.min.js");
      const source = await PDFDocument.create();
      source.addPage([200, 100]).drawText("MEMORY", { x: 10, y: 50, size: 12 });
      const bytes = await source.save();
      const { loadPdfFromBytes, extractPagesToPdf } = await import("./page-export.js");
      const probe = await loadPdfFromBytes(bytes);
      const taskProto = Object.getPrototypeOf(probe.loadingTask);
      await probe.loadingTask.destroy();
      const originalDestroy = taskProto.destroy;
      let destroyed = 0;
      taskProto.destroy = function (...args) { destroyed++; return originalDestroy.apply(this, args); };
      let raster;
      try {
        const { rasterizePdf } = await import("./bookbinding-export.js");
        raster = await rasterizePdf(bytes, { dpi: 72 });
      } finally { taskProto.destroy = originalDestroy; }
      const size = raster.getPage(0).getSize();
      const rasterBytes = await raster.save();
      const reopened = await loadPdfFromBytes(rasterBytes);
      const renderPage = await reopened.getPage(1);
      const ops = await renderPage.getOperatorList();
      const images = ops.fnArray.filter(op => op === pdfjsLib.OPS.paintImageXObject).length;
      await reopened.loadingTask.destroy();

      const pdf = await PDFDocument.create();
      for (const label of ["FIRST", "SECOND", "THIRD"]) { pdf.addPage([200, 100]).drawText(label, { x: 10, y: 50, size: 12 }); }
      const sourceBytes = await pdf.save();
      const extracted = await extractPagesToPdf(null, [2, 0, 2, 1, 0].map(pageIndex => ({ source: sourceBytes, pageIndex })));
      const check = await loadPdfFromBytes(extracted);
      const labels = [];
      for (let index = 1; index <= check.numPages; index++) {
        labels.push((await (await check.getPage(index)).getTextContent()).items.map(item => item.str).join(""));
      }
      await check.loadingTask.destroy();
      return { reads, cache, cacheBytes, retained, expectedRetained: [ids[2], inserted].sort(), destroyed, size, images, labels };
    });
    assert.equal(result.reads, 1);
    assert.deepEqual(result.cache, ["current", "newer"]);
    assert.deepEqual(result.cacheBytes, [1, 2, 3]);
    assert.deepEqual(result.retained, result.expectedRetained);
    assert.equal(result.destroyed, 1);
    assert.deepEqual(result.size, { width: 200, height: 100 });
    assert.equal(result.images, 1);
    assert.deepEqual(result.labels, ["THIRD", "FIRST", "THIRD", "SECOND", "FIRST"]);
    assert.deepEqual(errors, []);
    console.log("PASS キャッシュ1回取得・従来と同じ削除順・一時ファイルの期限と容量整理");
    console.log("PASS 画像化PDFの寸法と画像・補助文書解放・重複抜き出しの文字順");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
