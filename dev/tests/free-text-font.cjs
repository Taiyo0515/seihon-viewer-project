/** 埋込文字フォントのUnicode・255字超・回転・対象識別・失敗時保護を確認する。 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const path = require("path"), fs = require("fs"), os = require("os"), assert = require("assert");
(async () => {
  const ext = path.resolve(__dirname, "../../src");
  const ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(), "seihon-ftfont-" + Date.now()), {
    headless: true, ignoreDefaultArgs: ["--disable-extensions"], executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 1100, height: 900 },
  });
  try {
    const page = await ctx.newPage(), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto("chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html");
    await page.waitForFunction(() => window.__seihonViewer);
    const result = await page.evaluate(async () => {
      const lib = await import("../lib/pdf-lib.esm.min.js");
      const { repairFreeTextAnnotations } = await import("./free-text-appearance.js");
      const { loadPdfFromBytes } = await import("./page-export.js");
      const { PDFDocument, PDFName, PDFHexString, PDFString } = lib;
      const doc = await PDFDocument.create();
      const all = [...Array(270)].map((_, i) => String.fromCodePoint(0x4e00 + i)).join("") + " αβ→∞ e\u0301 😀👩‍💻";
      for (const rotation of [0, 90, 180, 270]) {
        const p = doc.addPage([595, 842]);
        const dict = doc.context.obj({ Type: "Annot", Subtype: "FreeText", Rect: [40, 300, 555, 800], Rotate: rotation, DA: PDFString.of("/Helv 14 Tf 0.9 0.1 0.2 rg"), Contents: PDFHexString.fromText(all), F: 4 });
        p.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(dict)]));
      }
      const original = await doc.save();
      const unchanged = await repairFreeTextAnnotations(original);
      const unchangedOther = await repairFreeTextAnnotations(original, { annotations: [{ annotationType: 3, value: "unrelated", rect: [40, 300, 555, 800] }] });
      const targeted = await repairFreeTextAnnotations(original, { annotations: [{ annotationType: 3, value: all, rect: [40, 300, 555, 800], pageIndex: 0 }] });
      const targetedDoc = await PDFDocument.load(targeted);
      const changedPages = targetedDoc.getPages().map(p => {
        const annotation = targetedDoc.context.lookup(p.node.lookup(PDFName.of("Annots")).get(0));
        return annotation.has(PDFName.of("AP"));
      });
      let report;
      const bytes = await repairFreeTextAnnotations(original, { force: true, onReport: r => { report = r; } });
      const pdfjs = await loadPdfFromBytes(bytes);
      const annotations = [];
      for (let i = 1; i <= 4; i++) {
        const p = await pdfjs.getPage(i), a = (await p.getAnnotations())[0];
        const viewport = p.getViewport({ scale: 1 });
        const canvas = document.createElement("canvas"); canvas.width = viewport.width; canvas.height = viewport.height;
        await p.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        annotations.push({ rotation: a.rotation, fontSize: a.defaultAppearanceData.fontSize, contents: a.contentsObj.str, text: a.textContent.join("").replaceAll(" ", ""), rect: a.rect });
      }
      await pdfjs.loadingTask.destroy();
      return { bytes: Array.from(bytes), report, annotations, changedPages, unchanged: unchanged === original, unrelated: unchangedOther === original, expected: all.replaceAll(" ", "") };
    });
    assert(result.unchanged && result.unrelated);
    assert.deepEqual(result.changedPages, [true, false, false, false]);
    assert.equal(result.report.repaired, 4); assert(result.report.fonts >= 2);
    for (const a of result.annotations) { assert.equal(a.fontSize, 14); assert.equal(a.text, result.expected); assert(a.rect[0] >= 0 && a.rect[1] >= 0 && a.rect[2] <= 595 && a.rect[3] <= 842); }
    assert.deepEqual(errors, []);
    const out = path.resolve(__dirname, "../logs/text-annotation"); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "font-rotation-unicode.pdf"), Buffer.from(result.bytes)); delete result.bytes;
    fs.writeFileSync(path.join(out, "font-results.json"), JSON.stringify(result, null, 2));
    console.log("PASS 255文字超・結合文字・非BMP/emoji・Unicode復元・14pt・回転4方向・ページ内矩形・無関係注釈非変更");
  } finally { await ctx.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
