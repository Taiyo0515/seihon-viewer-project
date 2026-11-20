const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = "chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp";
(async () => {
  const ext = path.resolve(__dirname,"../../src");
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(),"seihon-doc-")),{
    headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE || undefined,
    ignoreDefaultArgs:["--disable-extensions"], args:["--load-extension="+ext,"--disable-extensions-except="+ext]
  });
  try {
    const page = await ctx.newPage();
    await page.goto(base+"/viewer/viewer.html");
    await page.waitForSelector("#shEmptyOpen");
    async function documentTab(name, text) {
      const id = await page.evaluate(async ([name,text]) => {
        const {putHandoff} = await import("../common/handoff.js");
        return putHandoff(new Blob([text]),{name});
      },[name,text]);
      const tab = await ctx.newPage();
      await tab.goto(base+"/reader/document.html?h="+id);
      return tab;
    }
    const md = await documentTab("diagram.mmd","flowchart LR\n A-->B");
    await md.waitForSelector("#preview iframe");
    await md.click("#edit");
    await md.fill("#source","this is not a valid diagram");
    await md.waitForFunction(() => document.querySelector("#status").textContent.includes("更新できません"));
    assert.equal(await md.locator("#preview iframe").count(),1);
    await md.fill("#source","flowchart LR\n A-->C");
    await md.waitForFunction(() => !document.querySelector("#status").textContent);
    await md.setViewportSize({width:450,height:700});
    await md.click("#switch");
    assert.equal(await md.locator("#preview").isVisible(),true);
    assert.equal(await md.locator("#source").isVisible(),false);
    const tex = await documentTab("note.tex","test");
    await tex.waitForSelector("#connect");
    assert.equal(await tex.locator("#refresh").isVisible(),false);
    assert.equal(await tex.locator("#edit").isVisible(),false);
    const pageNumbers = await tex.evaluate(async () => {
      const {PDFDocument} = await import("../lib/pdf-lib.esm.min.js");
      const doc = await PDFDocument.create();
      doc.addPage([300,350]); doc.addPage([300,350]);
      const {showCompiledPdf} = await import("./tex-preview.js");
      const view = await showCompiledPdf(document.querySelector("#preview"),new Blob([await doc.save()]),2);
      const n = view.page(); await view.dispose(); return n;
    });
    assert.equal(pageNumbers,2);
    console.log("PASS live Mermaid errors/recovery, mobile pane switching, TeX opt-in, compiled PDF page retention");
  } finally {await ctx.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
