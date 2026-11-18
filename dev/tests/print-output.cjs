/** 印刷するPDFの内容・未編集時の近道・設定と製本の共通経路を確認する。 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const path = require("path"), fs = require("fs"), os = require("os"), assert = require("assert");
(async () => {
  const ext = path.resolve(__dirname, "../../src");
  const context = await chromium.launchPersistentContext(path.join(os.tmpdir(), "seihon-output-" + Date.now()), {
    headless: true, ignoreDefaultArgs: ["--disable-extensions"], executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 1100, height: 850 },
  });
  try {
    const page = await context.newPage(); const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto("chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html");
    await page.waitForFunction(() => window.__seihonViewer?.outputDialog);
    await page.evaluate(async () => {
      const { saveSettings } = await import("../common/settings.js");
      await saveSettings({ scanArrange: "off", scanDeskew: "off", bindingEnabled: false, printButtonVisible: true });
      const { PDFDocument } = await import("../lib/pdf-lib.esm.min.js");
      const pdf = await PDFDocument.create();
      for (const text of ["FIRST", "SECOND", "THIRD"]) { pdf.addPage([200, 300]).drawText(text, { x: 20, y: 150, size: 20 }); }
      window.originalBytes = await pdf.save();
      await PDFViewerApplication.open({ data: originalBytes.slice() });
      await PDFViewerApplication.pdfViewer.pagesPromise;
      window.v = __seihonViewer; window.output = v.outputDialog;
      window.inspect = async bytes => {
        const { loadPdfFromBytes } = await import("./page-export.js");
        const doc = await loadPdfFromBytes(bytes);
        try { const texts = []; for (let i = 1; i <= doc.numPages; i++) { texts.push((await (await doc.getPage(i)).getTextContent()).items.map(x => x.str).join(" ")); } return { count: doc.numPages, texts }; }
        finally { await doc.loadingTask.destroy(); }
      };
    });
    await page.waitForFunction(() => !document.getElementById("shPrint").hidden);
    const exact = await page.evaluate(async () => {
      const doc = PDFViewerApplication.pdfDocument;
      const old = doc.getMetadata; doc.getMetadata = () => { throw Error("metadata rewrite must not happen"); };
      const start = performance.now(); const result = await output.prepare(doc, [0, 1, 2], "max"); const ms = performance.now() - start;
      doc.getMetadata = old;
      return { equal: result.bytes.length === originalBytes.length && result.bytes.every((b, i) => b === originalBytes[i]), ms };
    });
    assert(exact.equal); console.log("PASS untouched original bytes, no metadata read/rewrite", exact);
    const offRoles = await page.evaluate(async () => ({
      visible: (await v.contextMenu.pageItems(1)).some(item => item.label?.startsWith("ページ役割")),
      hidden: document.getElementById("shThumbSelectRoles").hidden,
    }));
    assert.deepEqual(offRoles, {visible:false, hidden:true});
    await page.locator("#shPrint").click(); await page.waitForSelector("#shOutputDialog[open]");
    assert.equal(await page.locator("#shOutputDialog [data-bind]").isVisible(), false);
    await page.evaluate(() => { output.printBytes = async bytes => { window.printedBytes = bytes; }; });
    await page.locator("[data-pages]").fill("9"); await page.locator("[data-print]").click();
    assert((await page.locator("[data-status]").innerText()).includes("範囲"));
    await page.locator("[data-pages]").fill("3,1"); await page.locator("[data-print]").click();
    await page.waitForFunction(() => !output.dialog.open);
    assert.deepEqual(await page.evaluate(() => inspect(printedBytes)), { count: 2, texts: ["THIRD", "FIRST"] });
    console.log("PASS toolbar settings dialog, invalid range, selected-page print order");
    await page.evaluate(() => {
      output.open();
      Object.defineProperty(navigator,"userActivation",{configurable:true,value:{isActive:false}});
      window.showSaveFilePicker = async opts => ({name:opts.suggestedName,createWritable:async()=>({write:async blob=>{window.savedBytes=new Uint8Array(await blob.arrayBuffer());},close:async()=>{},abort:async()=>{}})});
      output.pagesInput.value="2";
    });
    await page.evaluate(() => output.run("save"));
    assert.equal(await page.locator("[data-save]").innerText(),"保存先を選ぶ…");
    await page.evaluate(()=>{navigator.userActivation.isActive=true;});
    await page.locator("[data-save]").click();
    await page.waitForFunction(()=>!!window.savedBytes&&!output.busy);
    assert.deepEqual(await page.evaluate(()=>inspect(savedBytes)),{count:1,texts:["SECOND"]});
    assert.equal(await page.locator("[data-status]").innerText(),"保存しました");
    await page.evaluate(()=>{delete navigator.userActivation;});
    await page.locator("[data-close]").click();
    console.log("PASS staged save stays in dialog and saves selected PDF through picker");
    const raster = await page.evaluate(async () => inspect((await output.prepare(v.app.pdfDocument, [1], "standard")).bytes));
    assert.equal(raster.count, 1); assert.equal(raster.texts[0], ""); console.log("PASS raster quality affects selected page only");
    const edited = await page.evaluate(async () => {
      await v.pageEditor.deletePages([2]); v.pageEditor.setTitle("Changed title");
      return inspect((await output.prepare(v.app.pdfDocument, [1], "max")).bytes);
    });
    assert.deepEqual(edited, { count: 1, texts: ["THIRD"] }); console.log("PASS deletion mapping and explicit title edit preserved");
    await page.evaluate(() => output.open()); await page.keyboard.press("Escape");
    const gated = await page.evaluate(async () => { await v.bindDialog.open(); return v.bindDialog.dialog.open; });
    assert.equal(gated, false);
    await page.evaluate(async () => { const { saveSettings } = await import("../common/settings.js"); await saveSettings({ bindingEnabled: true }); });
    await page.waitForFunction(() => !document.getElementById("shBindOutput").hidden);
    assert.equal(await page.evaluate(async () => (await v.contextMenu.pageItems(1)).some(item => item.label?.startsWith("ページ役割"))),true);
    await page.evaluate(() => v.app.triggerPrinting()); await page.waitForSelector("#shOutputDialog[open]");
    await page.locator("[data-bind]").click(); await page.waitForFunction(() => v.bindDialog.plan && !v.bindDialog.plan.error && !document.getElementById("shBindRun").disabled);
    await page.evaluate(() => { v.bindDialog.printBytes = async bytes => { window.boundBytes = bytes; }; });
    await page.locator("#shBindPrint").click(); await page.waitForFunction(() => !v.bindDialog.busy && window.boundBytes);
    const bound = await page.evaluate(() => inspect(boundBytes)); assert(bound.count > 0);
    await page.locator("#shBindNormal").click(); await page.waitForSelector("#shOutputDialog[open]");
    console.log("PASS binding feature gate, shared navigation, generated binding PDF sent to print");
    const fallback = await page.evaluate(async () => {
      v.docSource.passwordDocs.add(v.app.pdfDocument);
      output.onFallback = quality => { window.fallbackQuality = quality; };
      output.pagesInput.value="1";
      await output.run("print");
      if (window.fallbackQuality || !output.dialog.open || !output.status.textContent.includes("空欄")) { throw Error("subset must not silently fall back to all pages"); }
      output.pagesInput.value="";
      await output.run("print");
      v.docSource.passwordDocs.delete(v.app.pdfDocument);
      return { quality: fallbackQuality, open: output.dialog.open };
    });
    assert.equal(fallback.open, false); assert.equal(fallback.quality, "max");
    console.log("PASS edited password PDF retains image-print fallback");
    await page.keyboard.press("Control+p"); await page.waitForSelector("#shOutputDialog[open]");
    console.log("PASS Ctrl+P uses same settings dialog");
    const races = await page.evaluate(async () => {
      const originalPrepare = output.prepare;
      const originalGuard = v.pageEditor.guard;
      const results = [];
      v.pageEditor.guard = async () => true;
      for (const action of ["print", "save"]) {
        if (!output.dialog.open) { output.open(); }
        let release;
        output.prepare = () => new Promise(resolve => { release = resolve; });
        window.printedBytes = null; window.savedBytes = null;
        const oldRun = output.run(action);
        const { PDFDocument } = await import("../lib/pdf-lib.esm.min.js");
        const next = await PDFDocument.create(); next.addPage([200,300]).drawText("NEW "+action);
        await v.app.open({data:await next.save()}); await v.app.pdfViewer.pagesPromise;
        output.open();
        release({bytes:originalBytes,fileName:"old.pdf"});
        await oldRun;
        results.push({action,printed:!!window.printedBytes,saved:!!window.savedBytes,open:output.dialog.open,busy:!!output.busy});
        output.dialog.close();
      }
      output.prepare = originalPrepare; v.pageEditor.guard = originalGuard;
      return results;
    });
    assert.deepEqual(races,[{action:"print",printed:false,saved:false,open:true,busy:false},{action:"save",printed:false,saved:false,open:true,busy:false}]);
    console.log("PASS old print/save preparation cannot act on reopened dialog for a new document");
    fs.mkdirSync(path.resolve(__dirname, "../logs"), { recursive: true });
    await page.screenshot({ path: path.resolve(__dirname, "../logs/output-dialog.png") });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.resolve(__dirname, "../logs/print-output-results.json"), JSON.stringify({ exact, raster, edited, bound, fallback, races, errors }, null, 2));
  } finally { await context.close(); }
})().catch(e => { console.error(e); process.exit(1); });
