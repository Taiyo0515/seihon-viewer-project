const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const ext = path.resolve(__dirname, "../../src");
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "seihon-tools-")), {
    headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    ignoreDefaultArgs: ["--disable-extensions"], args: ["--disable-extensions-except=" + ext, "--load-extension=" + ext],
    viewport: { width: 1000, height: 720 },
  });
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    const base = "chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html";
    await page.goto(base);
    await page.locator("#shHomeCatalog [data-tool=ocr]").waitFor();
    const count = await page.locator("#shHomeCatalog [data-tool]").count();
    assert(count >= 33);
    await page.locator("#shHomeCatalog input").fill("pPTx");
    assert.equal(await page.locator("#shHomeCatalog [data-tool]:visible").count(), 2);
    await page.locator("#shHomeCatalog input").fill("");
    fs.mkdirSync(path.resolve(__dirname, "../logs"), { recursive: true });
    await page.screenshot({ path: path.resolve(__dirname, "../logs/tool-home.png") });
    console.log("PASS searchable catalog", count);
    await page.evaluate(async () => {
      const { PDFDocument, rgb } = await import("../lib/pdf-lib.esm.min.js");
      const doc = await PDFDocument.create();
      const sheet = doc.addPage([360, 320]);
      sheet.drawRectangle({ x: 0, y: 200, width: 120, height: 120, color: rgb(1,0,0) });
      sheet.drawText("TEST DOCUMENT", { x: 50, y: 70, size: 24 });
      window.fixture = await doc.save();
    });
    const qpdfResult = await page.evaluate(async () => {
      const { rewritePdf } = await import("./document-processing.js");
      const { loadPdfFromBytes } = await import("./page-export.js");
      const signal = new AbortController().signal;
      const enc = await rewritePdf("protect", fixture.slice(), "sample-A123", signal);
      const encrypted = new Uint8Array(await enc.blob.arrayBuffer());
      let protectedDoc = false, wrong = false;
      try { await loadPdfFromBytes(encrypted); } catch (e) { protectedDoc = e.name === "PasswordException"; }
      try { await rewritePdf("unlock", encrypted.slice(), "WRONG", signal); } catch { wrong = true; }
      const dec = await rewritePdf("unlock", encrypted, "sample-A123", signal);
      const repaired = await rewritePdf("repair", new Uint8Array(await dec.blob.arrayBuffer()), "", signal);
      const pdf = await loadPdfFromBytes(new Uint8Array(await repaired.blob.arrayBuffer()));
      const text = (await (await pdf.getPage(1)).getTextContent()).items.map(i => i.str).join("");
      await pdf.loadingTask.destroy();
      return { protectedDoc, wrong, text };
    });
    assert(qpdfResult.protectedDoc && qpdfResult.wrong && qpdfResult.text.includes("TEST DOCUMENT"));
    console.log("PASS AES password, wrong password, decrypt, rewrite");
    for (const textOnly of [true, false]) {
      const result = await page.evaluate(async textOnly => {
        const { recognizePdf } = await import("./document-processing.js");
        const { loadPdfFromBytes } = await import("./page-export.js");
        const { blob } = await recognizePdf(fixture.slice(), { language: textOnly ? "jpn+eng" : "eng", textOnly, signal: new AbortController().signal, progress() {} });
        if (textOnly) { return blob.text(); }
        const pdf = await loadPdfFromBytes(new Uint8Array(await blob.arrayBuffer()));
        const sheet = await pdf.getPage(1);
        const size = sheet.getViewport({scale:1});
        if (size.width !== 360 || size.height !== 320) { throw new Error("OCR page size"); }
        const text = (await sheet.getTextContent()).items.map(i => i.str).join(" ");
        await pdf.loadingTask.destroy(); return text;
      }, textOnly);
      assert.match(result.replace(/\s+/g, ""), /TESTDOCUMENT/i);
      console.log("PASS offline OCR", textOnly ? "text" : "searchable PDF");
    }
    const buffer = Buffer.from(await page.evaluate(() => Array.from(fixture)));
    const assets = await page.evaluate(async () => {
      const { PDFDocument } = await import("../lib/pdf-lib.esm.min.js");
      const { loadPdfFromBytes } = await import("./page-export.js");
      const { extractAssets } = await import("./ui/extract-assets.js");
      const { unzipSync } = await import("../lib/fflate/fflate.js");
      const out = await PDFDocument.create(), sheet = out.addPage([200, 250]);
      const canvas = document.createElement("canvas"); canvas.width = 31; canvas.height = 42;
      const g = canvas.getContext("2d"); g.fillStyle = "#c00"; g.fillRect(0, 0, 31, 42);
      const image = await out.embedPng(canvas.toDataURL());
      sheet.drawImage(image, { x: 10, y: 20, width: 65, height: 78 });
      sheet.drawImage(image, { x: 100, y: 120, width: 20, height: 25 });
      await out.attach(new TextEncoder().encode("fixture"), "sample.txt");
      const doc = await loadPdfFromBytes(await out.save());
      try {
        const pngs = await extractAssets("embedded-images", doc);
        const files = await extractAssets("attachments", doc);
        const images = unzipSync(new Uint8Array(await pngs.blob.arrayBuffer()));
        const attachments = unzipSync(new Uint8Array(await files.blob.arrayBuffer()));
        const bitmap = await createImageBitmap(new Blob([Object.values(images)[0]], { type: "image/png" }));
        const size = [bitmap.width, bitmap.height]; bitmap.close();
        return [pngs.count, size, new TextDecoder().decode(attachments["sample.txt"])];
      } finally { await doc.loadingTask.destroy(); }
    });
    assert.deepEqual(assets, [1, [31,42], "fixture"]); console.log("PASS original image size, deduplication and attachment ZIP");
    const coordinates = await page.evaluate(async () => {
      const { PDFDocument, rgb, degrees } = await import("../lib/pdf-lib.esm.min.js");
      const { renderPagePng } = await import("./image-export.js");
      const { loadPdfFromBytes } = await import("./page-export.js");
      const pdf = await PDFDocument.create();
      const sheet = pdf.addPage([320, 400]);
      sheet.setCropBox(30, 45, 220, 280); sheet.setRotation(degrees(90));
      sheet.drawRectangle({ x: 60, y: 80, width: 50, height: 50, color: rgb(0,0,1) });
      const doc = await loadPdfFromBytes(await pdf.save());
      const page = await doc.getPage(1);
      const colors = [];
      try {
        for (const rotation of [0, 90, 180, 270]) {
          const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
          const [x, y] = viewport.convertToViewportPoint(85, 105);
          const region = { x: (x - 10) / viewport.width, y: (y - 10) / viewport.height, w: 20 / viewport.width, h: 20 / viewport.height };
          const { blob, width, height } = await renderPagePng(doc, 1, { settings: { imageQuality: "high" }, rotation, region });
          const bitmap = await createImageBitmap(blob);
          const ctx = new OffscreenCanvas(width, height).getContext("2d"); ctx.drawImage(bitmap, 0, 0);
          colors.push([...ctx.getImageData(0, 0, 1, 1).data]); bitmap.close();
        }
      } finally { await doc.loadingTask.destroy(); }
      return colors;
    });
    assert(coordinates.every(c => c[2] === 255 && c[0] === 0 && c[1] === 0));
    console.log("PASS offset CropBox and four display rotations");
    const html = await page.evaluate(async () => {
      const doc = document.implementation.createHTMLDocument();
      const { renderForPrint } = await import("./office-print.js");
      await renderForPrint(new File(['<h1>原稿</h1><table><tr><td>表</td></tr></table><iframe></iframe><scr' + 'ipt>fail()</scr' + 'ipt><a href="https://example.invalid/">説明</a>'], "原稿.html"), "html", doc, new Map());
      return [doc.querySelector("h1").textContent, doc.querySelector("td").textContent, doc.querySelectorAll("script,iframe,a").length];
    });
    assert.deepEqual(html, ["原稿", "表", 0]); console.log("PASS local HTML print content");
    const picker = page.waitForEvent("filechooser");
    await page.locator("#shHomeCatalog [data-tool=region]").click();
    await (await picker).setFiles({ name: "sample.pdf", mimeType: "application/pdf", buffer });
    await page.locator(".sh-region-layer").waitFor({ timeout: 8000 }).catch(async e => {
      console.error(await page.evaluate(() => ({ pages: PDFViewerApplication.pagesCount, current: PDFViewerApplication.page,
        layers: document.querySelectorAll(".sh-region-layer").length, bar: !!document.querySelector(".sh-region-bar"),
        message: document.querySelector("#shToastHost").innerText, error: document.querySelector("#shErrorMessage").innerText })));
      throw e;
    });
    const a = await page.locator(".sh-region-layer").boundingBox();
    const start = [a.x + a.width * .06, a.y + a.height * .08], end = [a.x + a.width * .26, a.y + a.height * .28];
    await page.mouse.move(...end); await page.mouse.down(); await page.mouse.move(...start); await page.mouse.up();
    await page.evaluate(() => {
      window.showSaveFilePicker = async () => ({name: "clip.png", createWritable: async () => ({write(blob) { window.saved = blob; }, close() {}})});
      Object.defineProperty(navigator, "clipboard", { configurable:true, value:{ async write(items) { window.copied = await items[0].getType("image/png"); } } });
    });
    await page.locator("[data-op=copy]").click();
    await page.waitForFunction(() => window.copied);
    await page.locator("[data-op=copy]:enabled").waitFor();
    const beforeWidth = await page.evaluate(async () => {
      const original = await createImageBitmap(window.copied);
      const width = original.width;
      original.close();
      window.copied = null;
      return width;
    });

    const selection = page.locator(".sh-region-rect");
    const initial = await selection.boundingBox();
    const drag = async (box, dx, dy) => {
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy);
      await page.mouse.up();
    };
    // The initial crop lies inside the red rectangle. Move it fully onto white paper.
    await drag(initial, a.width * .4, 0);
    const moved = await selection.boundingBox();
    assert(Math.abs(moved.x - initial.x - a.width * .4) < 1.1);
    assert(Math.abs(moved.width - initial.width) < .1);
    await selection.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    const nudged = await selection.boundingBox();
    assert(Math.abs(nudged.x - moved.x - 1) < .1);
    assert(Math.abs(nudged.y - moved.y - 10) < .1);
    await drag(await selection.locator('[data-edge="e"]').boundingBox(), 17, 0);
    const resized = await selection.boundingBox();
    assert(Math.abs(resized.x - nudged.x) < .1);
    assert(Math.abs(resized.width - nudged.width - 17) < 1.1);
    assert(Math.abs(resized.height - nudged.height) < .1);
    await page.locator("[data-op=copy]").click();
    await page.waitForFunction(() => window.copied);
    await page.locator("[data-op=save]").click();
    await page.waitForFunction(() => window.saved);
    await page.locator("[data-op=collect]").click();
    await page.waitForFunction(() => __seihonViewer.collection.count === 1);
    const image = await page.evaluate(async () => {
      const c = await createImageBitmap(copied);
      const surface = document.createElement("canvas"); surface.width = c.width; surface.height = c.height;
      const g = surface.getContext("2d"); g.drawImage(c, 0, 0);
      const color = [...g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data]; c.close();
      const item = __seihonViewer.collection.items[0];
      const db = await import("../common/db.js");
      const { loadPdfFromBytes } = await import("./page-export.js");
      const pdf = await loadPdfFromBytes(await db.getPdfBytes(item.pdfKey));
      const sheet = await pdf.getPage(1); const v = sheet.getViewport({ scale: 1 });
      await pdf.loadingTask.destroy();
      const copyBytes = new Uint8Array(await copied.arrayBuffer());
      const savedBytes = new Uint8Array(await saved.arrayBuffer());
      const same = copyBytes.length === savedBytes.length && copyBytes.every((byte, i) => byte === savedBytes[i]);
      return { color, width:surface.width, height:surface.height, same, area:[v.width,v.height] };
    });
    assert(image.same && image.color.every(channel => channel > 244));
    assert(Math.abs(image.area[0] - resized.width / a.width * 360) < 1);
    assert(Math.abs(image.area[1] - resized.height / a.height * 320) < 1);
    assert(image.width > beforeWidth && image.width > 250);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".sh-region-layer").count(), 0);
    assert.deepEqual(errors, []);
    await page.reload();
    await page.locator("#shHomeCatalog [data-tool=collection]").click();
    await page.locator("#shCollectionEditor canvas").waitFor();
    assert(await page.locator("#shCollectionEditor li").count() === 1);
    console.log("PASS region reverse drag, image, save, copy, collection, physical page size, Escape", image);
  } finally { await ctx.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

