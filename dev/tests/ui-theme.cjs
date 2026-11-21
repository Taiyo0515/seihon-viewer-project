const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const ext = path.resolve(__dirname, "../../src");
  const context = await chromium.launchPersistentContext("", {
    headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--load-extension="+ext,"--disable-extensions-except="+ext],
    viewport: {width: 1280, height: 800}
  });
  try {
    const base = "chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/";
    const options = await context.newPage();
    await options.goto(base+"options/options.html#sec-view");
    const pages = [];
    for (const url of ["viewer/viewer.html","reader/reader.html","reader/document.html","welcome/welcome.html"]) {
      const page = await context.newPage();
      await page.goto(base+url);
      pages.push(page);
    }
    const viewer = pages[0];
    await viewer.waitForSelector("#shHomeCatalog [data-tool]");
    assert(await options.locator('[name=uiTheme][value=original]').isChecked());
    for (const theme of ["classic","original"]) {
      await options.locator('[name=uiTheme][value='+theme+']').check();
      for (const page of pages) await page.waitForFunction(t=>document.documentElement.dataset.uiTheme===t,theme);
      await viewer.reload();
      await viewer.waitForSelector("#shHomeCatalog [data-tool]");
      await viewer.waitForFunction(t=>document.documentElement.dataset.uiTheme===t,theme);
      const columns = await viewer.locator("#shHomeCatalog").evaluate(el=>getComputedStyle(el).display);
      assert.equal(columns === "grid", theme === "original");
    }
    if (process.env.THEME_SCREENSHOT) await viewer.screenshot({path:process.env.THEME_SCREENSHOT});
    await viewer.evaluate(async () => {
      const r = await fetch("../samples/sample-book.pdf");
      await PDFViewerApplication.open({data:new Uint8Array(await r.arrayBuffer())});
      await PDFViewerApplication.pdfViewer.pagesPromise;
    });
    await viewer.waitForSelector(".page canvas");
    for (const width of [1280,680,390]) {
      await viewer.setViewportSize({width,height:800});
      await viewer.waitForFunction(()=> {
        const r = document.querySelector("#shMore").getBoundingClientRect();
        return r.width && r.left>=0 && r.right<=innerWidth;
      });
    }
    console.log("PASS persisted theme and live updates on five screens, PDF render, responsive toolbar");
  } finally {await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
