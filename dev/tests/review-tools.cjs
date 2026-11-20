/** 比較・墨消し・サインの描画と保存を実際の拡張ページで確認。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const ext = path.resolve(__dirname, "../../src");
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "seihon-review-")), {
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, headless: true,
    ignoreDefaultArgs: ["--disable-extensions"], args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 1040, height: 700 },
  });
  try {
    const page = await ctx.newPage();
    await page.goto("chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html");
    await page.waitForFunction(() => window.__seihonViewer);
    const checks = await page.evaluate(async () => {
      const lib = await import("../lib/pdf-lib.esm.min.js");
      const { loadPdfFromBytes } = await import("./page-export.js");
      const { comparePage, comparisonPdf, redactPdf, renderReviewPage, signedPdf } = await import("./pdf-review.js");
      const doc = await lib.PDFDocument.create();
      const first = doc.addPage([180, 240]);
      first.drawText("SECRET", { x: 50, y: 110, size: 12 });
      first.drawRectangle({ x: 2, y: 212, width: 12, height: 12, color: lib.rgb(0, 0, 1) });
      doc.setTitle("Secret original name");
      await doc.attach(new TextEncoder().encode("sensitive attachment"), "secret.txt");
      const two = doc.addPage([160, 120]);
      two.setCropBox(10, 5, 110, 90);
      two.setRotation(lib.degrees(90));
      two.node.set(lib.PDFName.of("UserUnit"), lib.PDFNumber.of(2));
      const bytes = await doc.save();
      window.reviewFixture = new File([bytes], "文書.pdf", { type: "application/pdf" });
      two.drawText("Edit", { x: 15, y: 10, size: 12 });
      doc.addPage([80, 80]);
      const changed = await doc.save();
      const a = await loadPdfFromBytes(bytes);
      const b = await loadPdfFromBytes(changed);
      const result = {};
      try {
        result.compare = [];
        for (let n = 1; n <= 3; n++) {
          const r = await comparePage(a, b, n);
          result.compare.push({ changed: !!r.changed, added: r.added });
        }
        const report = await loadPdfFromBytes(await comparisonPdf(a, b));
        result.report = report.numPages;
        await report.loadingTask.destroy();
        const redacted = await loadPdfFromBytes(await redactPdf(a, [{ page: 1, x: .23, y: .42, w: .40, h: .18 }]));
        try {
          result.extractedText = [];
          for (let i = 1; i <= redacted.numPages; i++) {
            result.extractedText.push((await (await redacted.getPage(i)).getTextContent()).items.length);
          }
          result.attachments = await redacted.getAttachments();
          result.redactedTitle = (await redacted.getMetadata()).info.Title || "";
          const { canvas } = await renderReviewPage(redacted, 1);
          const g = canvas.getContext("2d");
          result.black = [...g.getImageData(60, 118, 1, 1).data];
          result.blue = [...g.getImageData(5, 20, 1, 1).data];
          result.white = [...g.getImageData(150, 200, 1, 1).data];
        } finally { await redacted.loadingTask.destroy(); }
        const ink = document.createElement("canvas");
        ink.width = 40; ink.height = 20;
        ink.getContext("2d").fillRect(0, 0, 40, 20);
        const signed = await loadPdfFromBytes(await signedPdf(a, [{ page: 2, x: .2, y: .5, w: .6, h: .4 }],
          await new Promise(resolve => ink.toBlob(resolve))));
        try {
          const { canvas } = await renderReviewPage(signed, 2);
          const g = canvas.getContext("2d");
          result.signature = [...g.getImageData(Math.round(canvas.width * .5), Math.round(canvas.height * .7), 1, 1).data];
          result.signatureOutside = [...g.getImageData(Math.round(canvas.width * .8), Math.round(canvas.height * .2), 1, 1).data];
          result.textPreserved = (await (await signed.getPage(1)).getTextContent()).items.map(item => item.str);
        } finally { await signed.loadingTask.destroy(); }
      } finally { await Promise.all([a.loadingTask.destroy(), b.loadingTask.destroy()]); }
      window.showSaveFilePicker = async () => ({ name: "test.pdf", createWritable: async () => ({
        async write(blob) { window.reviewSaved = blob.size; }, async close() {},
      }) });
      return result;
    });
    assert.deepEqual(checks.compare, [{ changed: false, added: false }, { changed: true, added: false }, { changed: true, added: true }]);
    assert.equal(checks.report, 3);
    assert.deepEqual(checks.extractedText, [0, 0]);
    assert.equal(checks.attachments, null);
    assert.equal(checks.redactedTitle, "");
    assert.deepEqual(checks.black, [0, 0, 0, 255]);
    assert.deepEqual(checks.blue, [0, 0, 255, 255]);
    assert.deepEqual(checks.white, [255, 255, 255, 255]);
    assert.deepEqual(checks.signature, [0, 0, 0, 255]);
    assert.deepEqual(checks.signatureOutside, checks.white);
    assert.deepEqual(checks.textPreserved, ["SECRET"]);
    for (const id of ["redact", "sign", "compare"]) {
      await page.evaluate(async id => { window.reviewSaved = 0; (await import("./ui/review-tools.js")).runReviewTool(id); }, id);
      const dialog = page.locator("#shReviewTool");
      for (const picker of await dialog.locator('input[type="file"]').all()) {
        await picker.evaluate(el => {
          const data = new DataTransfer(); data.items.add(window.reviewFixture); el.files = data.files;
          el.dispatchEvent(new Event("change"));
        });
      }
      await dialog.locator(".sh-review-paper").waitFor({ state: "visible" });
      async function drag(selector) {
        const box = await dialog.locator(selector).boundingBox();
        await page.mouse.move(box.x + box.width * .2, box.y + box.height * .3);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * .7, box.y + box.height * .62, { steps: 4 });
        await page.mouse.up();
      }
      if (id === "sign") { await drag("[data-ink]"); }
      if (id !== "compare") { await drag("[data-overlay]"); }
      await dialog.locator("[data-run]").click();
      await dialog.getByRole("button", { name: "保存先を選ぶ…" }).click();
      await page.waitForFunction(() => window.reviewSaved > 0);
      await dialog.locator("[data-close]").click();
      await dialog.waitFor({ state: "detached" });
    }
    console.log("PASS 比較（差分・同一・追加）/ 実墨消し（色・文字0・添付0・元タイトル0）/ 90度非標準寸法へのサインと原文維持 / 全3画面から保存");
  } finally { await ctx.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
