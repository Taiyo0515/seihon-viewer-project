/** 合成PDFを画面操作でPDF/Aに保存する。出力先を指定すれば外部検査に利用できる。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const ext = path.resolve(__dirname, "../../src");
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "seihon-archive-")), {
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, headless: true, ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    const page = await ctx.newPage();
    await page.goto("chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html");
    await page.waitForFunction(() => window.__seihonViewer);
    await page.evaluate(async () => {
      const { PDFDocument, degrees, rgb } = await import("../lib/pdf-lib.esm.min.js");
      const pdf = await PDFDocument.create();
      const first = pdf.addPage([180, 240]);
      first.drawText("Example", { x: 10, y: 110, size: 20, color: rgb(0, 0, 1) });
      first.drawRectangle({ x: 60, y: 90, width: 100, height: 100, color: rgb(1, 0.5, 0), opacity: 0.5 });
      const second = pdf.addPage([120, 150]); second.setRotation(degrees(90));
      await pdf.attach(new Uint8Array([1, 2, 3]), "input.txt");
      window.showSaveFilePicker = async () => ({ name: "archive.pdf", createWritable: async () => ({
        async write(blob) { window.archivedBytes = Array.from(new Uint8Array(await blob.arrayBuffer())); }, async close() {},
      }) });
      (await import("./ui/archive-tool.js")).runArchiveTool("pdfa");
      const picker = document.querySelector("#shArchiveTool input");
      const data = new DataTransfer();
      data.items.add(new File([await pdf.save()], "テスト.pdf", { type: "application/pdf" }));
      picker.files = data.files; picker.dispatchEvent(new Event("change"));
    });
    await page.getByRole("button", { name: "PDF/Aを作成" }).click();
    await page.getByRole("button", { name: "保存先を選ぶ…" }).click();
    await page.waitForFunction(() => window.archivedBytes?.length > 0);
    const bytes = await page.evaluate(() => window.archivedBytes);
    if (process.argv[2]) { fs.writeFileSync(process.argv[2], Buffer.from(bytes)); }
    const summary = await page.evaluate(async () => {
      const doc = await (await import("./page-export.js")).loadPdfFromBytes(new Uint8Array(window.archivedBytes));
      try {
        const metadata = (await doc.getMetadata()).metadata;
        return [doc.numPages, metadata.get("pdfaid:part"), metadata.get("pdfaid:conformance"), await doc.getAttachments(),
          (await (await doc.getPage(1)).getTextContent()).items.length, (await doc.getPage(2)).view];
      } finally { await doc.loadingTask.destroy(); }
    });
    assert.deepEqual(summary, [2, "2", "B", null, 0, [0, 0, 150, 120]]);
    console.log("PASS PDF/A設定画面から画像化・保存・2ページ/回転後の用紙寸法/XMP/元の文字・添付なしを確認");
  } finally { await ctx.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
