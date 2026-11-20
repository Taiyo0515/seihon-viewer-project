/** ホーム用ツールの結果を PDF.js で再読し、文書の内容とUIでの保存を検証する。 */
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const ext = path.resolve(__dirname, "../../src");
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "seihon-tools-")), {
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    headless: true, ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 900, height: 650 },
  });
  try {
    const page = await context.newPage();
    await page.goto("chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html");
    await page.waitForFunction(() => window.__seihonViewer);
    const result = await page.evaluate(async () => {
      const { preparePdfTool, describeToolFile } = await import("./pdf-tool-operations.js");
      const { PDFDocument, degrees, PDFName, PDFNumber } = await import("../lib/pdf-lib.esm.min.js");
      const { loadPdfFromBytes } = await import("./page-export.js");
      const { unzipSync } = await import("../lib/fflate/fflate.js");
      const source = await PDFDocument.create();
      source.setTitle("講義ノート");
      for (let i = 1; i <= 3; i++) { source.addPage([150, 220]).drawText("Page " + i, { x: 30, y: 100, size: 14 }); }
      source.getPage(0).setRotation(degrees(90));
      source.getPage(0).setCropBox(10, 5, 120, 210);
      source.getPage(0).node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
      const bytes = await source.save({ useObjectStreams: false });
      const file = new File([bytes], "講義.pdf", { type: "application/pdf" });
      const next = await PDFDocument.create();
      next.addPage([120, 200]).drawText("Second file");
      const second = new File([await next.save()], "補足.pdf", { type: "application/pdf" });
      const run = async (id, opts = {}, files = [file]) => preparePdfTool(id, files, opts);
      async function inspect(blob) {
        const doc = await loadPdfFromBytes(new Uint8Array(await blob.arrayBuffer()));
        try {
          const pages = [];
          for (let i = 1; i <= doc.numPages; i++) {
            const sheet = await doc.getPage(i);
            const text = (await sheet.getTextContent()).items.map(item => item.str).filter(Boolean);
            pages.push({ text, rotation: sheet.rotate, view: sheet.view, width: sheet.getViewport({ scale: 1 }).width });
          }
          return pages;
        } finally { await doc.loadingTask.destroy(); }
      }
      const texts = async (id, options, files) => (await inspect((await run(id, options, files)).blob)).map(p => p.text.join(" "));
      const result = { info: await describeToolFile(file) };
      result.merge = await texts("merge", {}, [second, file]);
      result.extract = await texts("extract", { pages: "３、１" });
      result.reorder = await texts("reorder", { pages: "3,1-2" });
      result.remain = await texts("delete", { pages: "2" });
      const split = await run("split", { splitMode: "range", pages: "1-2,3" });
      result.split = [];
      for (const [name, part] of Object.entries(unzipSync(new Uint8Array(await split.blob.arrayBuffer())))) {
        result.split.push([name, (await inspect(new Blob([part]))).map(p => p.text.join(" "))]);
      }
      result.rotations = (await inspect((await run("rotate", { pages: "1,3", angle: 270 })).blob)).map(p => p.rotation);
      result.numbers = await texts("number", { start: 10, pages: "1,3" });
      result.blank = await inspect((await run("insert-blank", { after: 1 })).blob);
      result.crop = (await inspect((await run("crop-margins", { pages: "2", margin: 2.54 })).blob))[1].view;
      const mark = (await run("watermark", { text: "複製用・見本" })).blob;
      const doc = await loadPdfFromBytes(new Uint8Array(await mark.arrayBuffer()));
      try {
        const marked = await doc.getPage(1);
        const ops = await marked.getOperatorList();
        result.mark = ops.fnArray.includes(globalThis.pdfjsLib.OPS.paintImageXObject);
      } finally { await doc.loadingTask.destroy(); }
      const meta = await run("metadata", { title: "新しいタイトル", author: "太陽", subject: "確認用" });
      result.meta = await describeToolFile(new File([meta.blob], "更新.pdf"));
      const lossless = await run("compress");
      result.lossless = { smaller: lossless.blob.size <= file.size, text: (await inspect(lossless.blob)).map(p => p.text.join(" ")) };
      // 末尾にPDFとして許可される空白を足し、画像化結果が採用される入力を作る。
      const padded = new File([bytes, " ".repeat(120000)], file.name);
      const lossy = await run("compress", { quality: "100" }, [padded]);
      result.lossy = { smaller: lossy.blob.size < padded.size, pages: (await inspect(lossy.blob)).length };
      const invalid = [["delete", { pages: "1-3" }], ["extract", { pages: "4" }], ["reorder", { pages: "1" }],
        ["insert-blank", { after: -1 }], ["crop-margins", { margin: 1900 }]];
      result.errors = [];
      for (const [id, opts] of invalid) {
        try { await run(id, opts); } catch (e) { result.errors.push(e.message); }
      }
      window.toolFixture = file;
      window.showSaveFilePicker = async () => ({ name: "test.pdf", createWritable: async () => ({
        async write(blob) { window.toolSaved = await inspect(blob); }, async close() {},
      }) });
      return result;
    });
    assert.deepEqual(result.merge, ["Second file", "Page 1", "Page 2", "Page 3"]);
    assert.deepEqual(result.extract, ["Page 3", "Page 1"]);
    assert.deepEqual(result.reorder, ["Page 3", "Page 1", "Page 2"]);
    assert.deepEqual(result.remain, ["Page 1", "Page 3"]);
    assert.deepEqual(result.split.map(entry => entry[1]), [["Page 1", "Page 2"], ["Page 3"]]);
    assert.deepEqual(result.rotations, [0, 0, 270]);
    assert.deepEqual(result.numbers, ["Page 1 10", "Page 2", "Page 3 11"]);
    assert.equal(result.blank.length, 4);
    assert.deepEqual(result.blank[1].text, []);
    assert.equal(result.blank[1].width, result.blank[0].width);
    assert(Math.abs(result.crop[0] - 7.2) < 0.001);
    assert(result.mark && result.lossless.smaller && result.lossy.smaller);
    assert.deepEqual(result.lossless.text, ["Page 1", "Page 2", "Page 3"]);
    assert.equal(result.lossy.pages, 3);
    assert.deepEqual(result.meta, { count: 3, title: "新しいタイトル", author: "太陽", subject: "確認用" });
    assert.equal(result.info.title, "講義ノート");
    assert.equal(result.errors.length, 5);
    await page.evaluate(async () => (await import("./ui/pdf-tools.js")).runPdfTool("extract"));
    const dialog = page.locator("#shPdfToolDialog");
    await dialog.locator('input[type="file"]').evaluate(el => {
      const data = new DataTransfer();
      data.items.add(window.toolFixture);
      el.files = data.files;
      el.dispatchEvent(new Event("change"));
    });
    await dialog.locator('[name="pages"]').fill("3,1");
    await dialog.locator("[data-run]").click();
    await dialog.getByRole("button", { name: "保存先を選ぶ…" }).click();
    await page.waitForFunction(() => !!window.toolSaved);
    assert.deepEqual(await page.evaluate(() => window.toolSaved.map(p => p.text[0])), ["Page 3", "Page 1"]);
    console.log("PASS ローカルPDFツール12種・分割ZIPの再読・回転ページとUserUnit・圧縮2方式・範囲エラー・画面から保存");
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
