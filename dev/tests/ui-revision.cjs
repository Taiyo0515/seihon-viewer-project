/** UI整理の画面幅・直接選択・編集領域を専用プロファイルで確かめる。 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const path = require("path"), fs = require("fs"), os = require("os"), assert = require("assert");

(async () => {
  const ext = path.resolve(__dirname, "../../src");
  const log = path.resolve(__dirname, "../logs");
  fs.mkdirSync(log, { recursive: true });
  const context = await chromium.launchPersistentContext(path.join(os.tmpdir(), "seihon-ui-" + Date.now()), {
    headless: true, ignoreDefaultArgs: ["--disable-extensions"], executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 1440, height: 1000 },
  });
  try {
    const page = await context.newPage();
    await page.bringToFront();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(20000);
    await page.goto("chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html");
    await page.waitForSelector("#shCollectEdit", { state: "attached" });
    await page.evaluate(async () => {
      const { saveSettings } = await import("../common/settings.js");
      await saveSettings({ scanArrange: "off", scanDeskew: "off", printBindVisible: true, bindingEnabled: true, printButtonVisible: true });
      const { PDFDocument } = await import("../lib/pdf-lib.esm.min.js");
      const doc = await PDFDocument.create();
      for (let i = 0; i < 8; i++) { doc.addPage([400, 600]).drawText(`UI TEST PAGE ${i + 1}`, { x: 50, y: 400 }); }
      const bytes = await doc.save();
      await PDFViewerApplication.open({ data: bytes.slice() });
      await PDFViewerApplication.pdfViewer.pagesPromise;
      const db = await import("../common/db.js");
      await db.putPdf({ key: "ui-test", name: "画面確認.pdf", bytes, size: bytes.length, pages: 8 });
      await db.addCollectionItems("ui-test", "画面確認.pdf", [{ pageIndex: 0 }, { pageIndex: 1 }]);
      const { CollectionEditor } = await import("./ui/collection-editor.js");
      const original = CollectionEditor.prototype.open;
      CollectionEditor.prototype.open = function () { window.editor = this; return original.call(this); };
    });
    await page.waitForFunction(() => !document.getElementById("shBindOutput").hidden);
    await page.locator("#shViewMode").click();
    assert.equal(await page.getByRole("menuitemradio").count(), 3);
    await page.getByRole("menuitemradio", { name: "単ページ", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("shViewMode").dataset.mode === "single");
    await page.locator("#shViewMode").click();
    assert.equal(await page.getByRole("menuitemradio", { name: "単ページ", exact: true }).getAttribute("aria-checked"), "true");
    await page.getByRole("menuitemradio", { name: "見開き", exact: true }).click();
    assert.equal(await page.locator("#shViewMode").getAttribute("data-mode"), "spread");
    console.log("PASS direct mode selection and current mode");

    const widths = [];
    for (const width of [1440, 1100, 900, 680, 560, 440, 360, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => {
        document.getElementById("shScan").hidden = false;
        document.getElementById("shSaveEdits").hidden = false;
      });
      await page.waitForTimeout(150);
      await page.waitForFunction(() => !__seihonViewer.toolbar.endOverlapsCenter());
      const layout = await page.evaluate(() => {
        const toolbar = document.getElementById("shToolbar"), rect = toolbar.getBoundingClientRect();
        const buttons = [...toolbar.querySelectorAll("button, input")].filter(el => {
          const r = el.getBoundingClientRect(), style = getComputedStyle(el);
          return r.width && r.height && style.visibility !== "hidden" && el.id !== "shTitle";
        }).map(el => ({ id: el.id, rect: el.getBoundingClientRect().toJSON() }));
        const overlap = [];
        for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
          const a = buttons[i], b = buttons[j];
          if (Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left) > 1 &&
              Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) > 1) overlap.push([a.id, b.id]);
        }
        return { overlap, overflow: buttons.filter(b => b.rect.right > rect.right + 1 || b.rect.left < rect.left - 1).map(b => b.id), classes: toolbar.className, pageVisible: !!document.getElementById("shPageInput").offsetWidth };
      });
      if (layout.overlap.length || layout.overflow.length) console.log(JSON.stringify({ width, ...layout }));
      assert.deepEqual(layout.overlap, [], `${width}px overlap`);
      assert.deepEqual(layout.overflow, [], `${width}px overflow`);
      assert(layout.pageVisible, `${width}px page input remains visible`);
      widths.push({ width, ...layout });
      if (width === 680) await page.screenshot({ path: path.join(log, "ui-toolbar-680.png") });
    }
    console.log("PASS toolbar at 320–1440px with every optional button");
    await page.locator("#shMore").click();
    assert.deepEqual(await page.locator(".sh-menu-header").allTextContents(), ["閲覧", "ページの整理・収集", "補正・変換・出力", "設定・文書情報"]);
    assert.equal(await page.getByRole("menuitem", { name: "製本用PDF出力…", exact: true }).count(), 1);
    await page.getByRole("menuitemradio", { name: "単ページ", exact: true }).click();
    assert.equal(await page.locator("#shViewMode").getAttribute("data-mode"), "single");
    await page.locator("#shMore").click();
    await page.getByRole("menuitem", { name: "回転の向きと角度…", exact: true }).click();
    await page.locator("#shRotateDir").selectOption("right");
    await page.locator("#shRotateAngle").selectOption("180");
    await page.locator("#shRotateRun").click();
    assert.equal(await page.evaluate(() => PDFViewerApplication.pdfViewer.pagesRotation), 180);
    await page.evaluate(() => PDFViewerApplication.rotatePages(180));
    await page.evaluate(() => { __seihonViewer.scanArranger.state = "arranged"; __seihonViewer.scanArranger.arranged = { options: { mode: "none", trim: true } }; document.getElementById("shScan").hidden = false; });
    await page.locator("#shMore").click();
    await page.getByRole("menuitem", { name: "スキャンの操作…", exact: true }).click();
    assert.equal(await page.getByRole("menuitem", { name: "元のスキャンに戻す", exact: true }).count(), 1);
    assert.equal(await page.getByRole("menuitem", { name: "整えた PDF を保存…", exact: true }).count(), 1);
    await page.keyboard.press("Escape");
    await page.evaluate(() => { __seihonViewer.scanArranger.state = "none"; __seihonViewer.scanArranger.arranged = null; document.getElementById("shScan").hidden = true; });
    console.log("PASS compact menu groups and hidden toolbar operations");

    await page.setViewportSize({ width: 1100, height: 800 });
    await page.locator("#shBindOutput").click();
    await page.waitForSelector("#shBindDialog[open]");
    assert.equal(await page.locator("#shBindRolesDetails").getAttribute("open"), null);
    const bind = await page.evaluate(() => ({ paper: document.getElementById("shBindPaper").getBoundingClientRect().top, roles: document.getElementById("shBindRolesDetails").getBoundingClientRect().top }));
    assert(bind.paper < bind.roles);
    await page.locator("#shBindRolesDetails summary").click();
    await page.waitForSelector("#shBindRoleGrid", { state: "visible" });
    await page.locator("#shBindRolesDetails summary").click();
    await page.screenshot({ path: path.join(log, "ui-binding.png") });
    await page.locator("#shBindClose").click();
    console.log("PASS paper and binding before collapsible accessory pages");

    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator("#shCollect").click();
    await page.locator("#shCollectEdit").click();
    await page.waitForFunction(() => window.editor && editor.canvas.width > 0 && !editor.busy);
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".sh-edit-add-settings").getAttribute("open"), null);
    assert.equal(await page.locator("[data-action=reset]").innerText(), "回転・トリミングを戻す");
    const preview = await page.evaluate(() => ({ canvas: editor.canvas.getBoundingClientRect().height, stage: editor.stage.clientHeight, height: innerHeight }));
    assert(preview.canvas > preview.height * .55, JSON.stringify(preview));
    await page.locator("#shCollectionEditor [data-field=zoomMode]").selectOption("page");
    assert(await page.evaluate(() => editor.canvas.getBoundingClientRect().height <= editor.stage.clientHeight + 1));
    await page.locator(".sh-edit-add-settings summary").click();
    await page.locator("[data-field=position]").selectOption("before");
    await page.locator("[data-field=size]").selectOption("image");
    await page.locator(".sh-edit-add-settings summary").click();
    assert.equal(await page.locator("[data-field=size]").inputValue(), "image");
    await page.locator("[data-action=right]").click();
    await page.waitForFunction(() => !editor.busy && editor.item.edits?.rotation === 90);
    await page.locator("[data-action=reset]").click();
    await page.waitForFunction(() => !editor.busy && Object.keys(editor.item.edits).length === 0);
    await page.screenshot({ path: path.join(log, "ui-collection-editor.png") });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const colors = await page.evaluate(() => ({ button: getComputedStyle(editor.dialog.querySelector("[data-action=pdf]")).backgroundColor, primary: getComputedStyle(document.documentElement).getPropertyValue("--sh-btn-primary-bg").trim() }));
      assert(colors.button && colors.primary);
    }
    await page.setViewportSize({ width: 680, height: 350 });
    const bottom = await page.locator("#shCollectionEditor").evaluate(el => { el.scrollTop = el.scrollHeight; return { end: el.querySelector("footer").getBoundingClientRect().bottom, dialog: el.getBoundingClientRect().bottom }; });
    assert(bottom.end <= bottom.dialog + 1);
    console.log("PASS enlarged preview, collapsed image settings, reset and low-height reachability");
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(log, "ui-revision-results.json"), JSON.stringify({ widths, bind, preview, bottom, errors }, null, 2));
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exit(1); });
