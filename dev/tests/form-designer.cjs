// 作成した欄を実際に開き、位置・既存の値・記入後の保存を確認する。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const ext = path.resolve(__dirname, "../../src");
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "seihon-form-")), {
    headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    ignoreDefaultArgs: ["--disable-extensions"], args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 1100, height: 820 },
  });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html");
    await page.waitForFunction(() => !!window.__seihonViewer);
    const sample = await page.evaluate(async () => {
      const { PDFDocument, degrees } = await import("../lib/pdf-lib.esm.min.js");
      const pdf = await PDFDocument.create();
      for (const rotation of [0, 90, 180, 270]) {
        const p = pdf.addPage([420, 260]);
        p.setCropBox(12, 24, 320, 200); p.setRotation(degrees(rotation));
      }
      const old = pdf.getForm().createTextField("既存欄");
      old.setText("keep"); old.addToPage(pdf.getPage(0), { x: 90, y: 90, width: 75, height: 18 });
      window.showSaveFilePicker = async () => ({
        name: "test.pdf", createWritable: async () => ({ write: async blob => { window.savedForm = blob; }, close: async () => {} }),
      });
      const { runFormTool } = await import("./ui/form-designer.js");
      runFormTool("form-designer");
      return Array.from(await pdf.save());
    });
    const d = page.locator("#shFormDesigner");
    await d.locator("input[type=file]").setInputFiles({ name: "sample.pdf", mimeType: "application/pdf", buffer: Buffer.from(sample) });
    await d.locator("[data-center]:enabled").waitFor();
    const fields = [];
    for (const [i, rotation] of [0, 90, 180, 270].entries()) {
      if (i) {
        await d.locator("[data-page]").fill(String(i + 1));
        await d.locator("[data-page]").press("Enter");
        await d.locator("[data-page]").blur();
        await d.locator("[data-center]:enabled").waitFor();
      }
      const name = "Field" + i;
      const type = i % 2 ? "check" : "text";
      await d.locator("[data-kind]").selectOption(type);
      await d.locator("[data-name]").fill(name);
      const layer = d.locator(".sh-form-marks");
      await d.locator(".sh-form-stage").evaluate(el => el.scrollTop = 0);
      const r = await layer.boundingBox();
      const x1 = r.x + r.width * .16, y1 = r.y + r.height * .08;
      const x2 = x1 + 90, y2 = y1 + 30;
      await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2); await page.mouse.up();
      assert.equal(await layer.locator("span").last().textContent(), name);
      fields.push({ name, type, rotation, x1: (x1 - r.x) / r.width, y1: (y1 - r.y) / r.height, x2: (x2 - r.x) / r.width, y2: (y2 - r.y) / r.height });
    }
    await d.locator("[data-save]").click();
    await d.getByRole("button", {name: "保存先を選ぶ…"}).click();
    await d.getByText("フォーム付きPDFを保存しました").waitFor();
    const out = await page.evaluate(async fields => {
      const { loadPdfFromBytes, editedDocumentBytes } = await import("./page-export.js");
      const data = new Uint8Array(await savedForm.arrayBuffer());
      const doc = await loadPdfFromBytes(data);
      const objects = await doc.getFieldObjects(), checks = [];
      for (const [i, field] of fields.entries()) {
        const p = await doc.getPage(i + 1);
        const widgets = objects.get(field.name);
        const annotations = await p.getAnnotations();
        const a = annotations.find(entry => entry.fieldName === field.name);
        if (!a) { throw new Error(JSON.stringify({ field, widgets, onPage: annotations.map(entry => [entry.fieldName, entry.id]) })); }
        const vp = p.getViewport({ scale: 1 });
        const [x,y] = vp.convertToViewportPoint(a.rect[0],a.rect[1]);
        const [x2,y2] = vp.convertToViewportPoint(a.rect[2],a.rect[3]);
        checks.push({ x1: Math.min(x,x2)/vp.width, x2: Math.max(x,x2)/vp.width, y1: Math.min(y,y2)/vp.height, y2: Math.max(y,y2)/vp.height, rotation: a.rotation });
        doc.annotationStorage.setValue(a.id, { value: field.type === "text" ? "entry" : true });
      }
      const { PDFDocument } = await import("../lib/pdf-lib.esm.min.js");
      const updated = await PDFDocument.load(await editedDocumentBytes(doc));
      const form = updated.getForm();
      const values = { "既存欄": form.getTextField("既存欄").getText() };
      for (const field of fields) {
        values[field.name] = field.type === "text" ? form.getTextField(field.name).getText() : form.getCheckBox(field.name).isChecked();
      }
      await doc.loadingTask.destroy();
      return { checks, values };
    }, fields);
    for (const [i, wanted] of fields.entries()) {
      const actual = out.checks[i];
      for (const key of ["x1","y1","x2","y2"]) { assert(Math.abs(actual[key] - wanted[key]) < .007, JSON.stringify({ wanted, actual })); }
      assert.equal(actual.rotation, wanted.rotation);
      assert.equal(out.values[wanted.name], wanted.type === "text" ? "entry" : true);
    }
    assert.equal(out.values["既存欄"], "keep");
    assert.deepEqual(errors, []);
    console.log("PASS placed and filled fields on four rotated / offset pages; existing field preserved");
  } finally { await context.close(); }
})().catch(e => { console.error(e); process.exit(1); });
