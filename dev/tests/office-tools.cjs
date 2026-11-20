// ファイル変換を専用の Chromium プロファイルで往復する。中間ファイルは dev/logs に保存する。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

(async () => {
  const ext = path.resolve(__dirname, "../../src");
  const output = path.resolve(__dirname, "../logs/office");
  fs.mkdirSync(output, { recursive: true });
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "seihon-office-")), {
    headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    ignoreDefaultArgs: ["--disable-extensions"], args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    const page = await ctx.newPage();
    page.on("pageerror", e => console.log("PAGE ERROR", e.message));
    const viewer = "chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html";
    await page.goto(viewer);
    await page.locator("#shCollectEdit").waitFor({state:"attached"});
    const result = await page.evaluate(async () => {
      const { PDFDocument, rgb } = await import("../lib/pdf-lib.esm.min.js");
      const { loadPdfFromBytes } = await import("./page-export.js");
      const { pdfToOffice } = await import("./office-export.js");
      const { renderForPrint } = await import("./office-print.js");
      const { runConversionTool } = await import("./ui/conversion-tools.js");
      const pdf = await PDFDocument.create();
      const p = pdf.addPage([320, 400]);
      p.drawText("Item", { x: 30, y: 300, size: 13 });
      p.drawText("Value", { x: 180, y: 300, size: 13 });
      p.drawText("Bolt", { x: 30, y: 275, size: 13 });
      p.drawText("42", { x: 180, y: 275, size: 13 });
      const p2 = pdf.addPage([420, 250]);
      p2.drawRectangle({ x: 20, y: 20, width: 80, height: 50, color: rgb(1,0,0) });
      const data = await pdf.save();
      const doc = await loadPdfFromBytes(data);
      window.officeFiles = {};
      const out = {};
      for (const format of ["docx", "xlsx", "pptx"]) {
        const {blob, note} = await pdfToOffice(doc, format);
        const file = new File([blob], "roundtrip." + format);
        window.officeFiles[format] = file;
        const host = document.implementation.createHTMLDocument("test");
        const frame = document.createElement("iframe");
        document.body.append(frame);
        const urls = new Map();
        await renderForPrint(file, format, frame.contentDocument || host, urls);
        const body = frame.contentDocument.body;
        out[format] = {
          bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), note, text: body.textContent,
          images: body.querySelectorAll("img").length, slides: body.querySelectorAll(".slide").length,
        };
        for (const url of urls.values()) { URL.revokeObjectURL(url); }
        frame.remove();
      }
      await doc.loadingTask.destroy();
      runConversionTool("pptx-pdf");
      const dt = new DataTransfer(); dt.items.add(officeFiles.pptx);
      const input = document.querySelector("#shFileConversion input");
      input.files = dt.files; input.dispatchEvent(new Event("change"));
      return out;
    });
    assert.match(result.docx.text, /Item/);
    assert.equal(result.docx.images, 1);
    assert.match(result.xlsx.text, /Bolt42/);
    assert.match(result.xlsx.note, /1 ページ/);
    assert.equal(result.pptx.images, 2);
    assert.equal(result.pptx.slides, 2);
    for (const [format, data] of Object.entries(result)) {
      fs.writeFileSync(path.join(output, "roundtrip." + format), Buffer.from(data.bytes));
    }
    await page.locator("#shFileConversion [data-run]").click();
    await page.getByRole("button", {name:"印刷・PDF に保存…"}).waitFor();
    assert.equal(await page.frameLocator("#shFileConversion iframe").locator(".slide img").count(), 2);
    await page.locator("#shFileConversion [data-close]").click();
    await page.evaluate(async () => {
      const {runConversionTool} = await import("./ui/conversion-tools.js");
      runConversionTool("images-pdf");
    });
    const png = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 48; canvas.height = 32;
      canvas.getContext("2d").fillRect(0, 0, 48, 32);
      return canvas.toDataURL().split(",")[1];
    }), "base64");
    await page.locator("#shFileConversion [data-file]").setInputFiles([
      {name:"A.png",mimeType:"image/png",buffer:png},{name:"B.png",mimeType:"image/png",buffer:png},
    ]);
    await page.getByRole("button",{name:"B.pngを上へ"}).click();
    assert.match(await page.locator("#shFileConversion li").first().innerText(), /^B.png/);
    await page.locator("#shFileConversion [data-run]").click();
    await page.getByRole("button",{name:"保存先を選ぶ…"}).waitFor({timeout:10000}).catch(async e => {
      throw new Error(await page.locator("#shFileConversion [role=status]").innerText(), {cause:e});
    });
    await page.locator("#shFileConversion [data-close]").click();
    // ブラウザの印刷エンジンでプレビューからPDFを作り、外部のPDFリーダーでも照合できるようにする。
    for (const format of ["docx","xlsx","pptx"]) {
      const preview = await ctx.newPage();
      await preview.goto(viewer);
      await preview.locator("#shCollectEdit").waitFor({state:"attached"});
      await preview.evaluate(async ([format, bytes]) => {
        const {renderForPrint} = await import("./office-print.js");
        document.head.replaceChildren();
        document.body.replaceChildren();
        await renderForPrint(new File([Uint8Array.from(bytes)],"sample."+format),format,document,new Map());
      }, [format,result[format].bytes]);
      await preview.pdf({path:path.join(output,format+".pdf"),preferCSSPageSize:true,printBackground:true});
      await preview.close();
    }
    console.log("PASS Office 6 directions, image order, preview and save controls");
  } finally { await ctx.close(); }
})().catch(error=>{ console.error(error); process.exitCode=1; });

