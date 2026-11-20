import assert from "node:assert/strict";
import { launch, VIEWER, pickerFile } from "./lib.mjs";

const env = await launch();
try {
  const page = await env.ctx.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  async function open(name, buffer) {
    await page.goto(VIEWER);
    const chooser = page.waitForEvent("filechooser");
    await page.locator("#shEmptyOpen").click();
    await (await chooser).setFiles({ name, buffer, mimeType: "text/plain" });
    await page.waitForURL("**/reader/document.html?h=*");
    await page.waitForFunction(name => document.querySelector("#name")?.textContent === name, name);
    await page.evaluate(() => { window.__pickerNoDownload = true; });
  }
  async function saved(name) {
    await page.locator("#save").click();
    await page.waitForFunction(name => !!window.__pickerBlobs?.[name], name);
    return pickerFile(page, name);
  }
  const title = "講義原稿.txt", sample = "電界《でんかい》\n初稿";
  await open(title, Buffer.from(sample));
  await page.locator("#ao").check();
  await page.locator("ruby rt").waitFor();
  assert.equal(await page.locator("ruby rt").textContent(), "でんかい");
  await page.locator("#edit").click();
  await page.locator("#auto").uncheck();
  await page.locator("#source").fill("手動更新を確認");
  // Wait longer than the editor debounce to detect unwanted background updates.
  await page.waitForTimeout(650);
  assert.match(await page.locator("#preview").textContent(), /初稿/);
  await page.locator("#refresh").click();
  await page.waitForFunction(() => document.querySelector("#preview").textContent === "手動更新を確認");
  await page.locator("#auto").check();
  await page.locator("#source").fill("自動更新と保存");
  await page.waitForFunction(() => document.querySelector("#preview").textContent === "自動更新と保存");
  assert.deepEqual(await saved(title), Buffer.from("自動更新と保存"));

  const name = "表.csv";
  const bom = Buffer.from([0xef,0xbb,0xbf]);
  await open(name, Buffer.concat([bom,Buffer.from('001,"日本,語"\r\n002,値\r\n')]));
  await page.locator("#edit").click();
  const cell = page.locator('td[contenteditable="plaintext-only"]').last();
  await cell.fill("新しい値");
  assert.deepEqual(await saved(name), Buffer.concat([bom,Buffer.from('001,"日本,語"\r\n002,新しい値\r\n')]));
  await open("図.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="200" height="200" fill="red"/><rect x="200" width="200" height="200" fill="blue"/></svg>'));
  const image = page.locator(".df-svg-stage img");
  await image.waitFor();
  await image.evaluate(img => img.decode());
  await image.scrollIntoViewIfNeeded();
  const rect = await image.boundingBox();
  await page.mouse.move(rect.x + rect.width * .05, rect.y + rect.height * .1);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * .25, rect.y + rect.height * .3);
  await page.mouse.up();
  await page.getByRole("button",{name:"PNGを保存…"}).click();
  await page.waitForFunction(() => window.__pickerWritten?.length > 0);
  const pixels = await page.evaluate(async () => {
    const img = await createImageBitmap(Object.values(window.__pickerBlobs)[0]);
    const ctx = new OffscreenCanvas(1,1).getContext("2d");
    ctx.drawImage(img,0,0,1,1);
    return {width:img.width,height:img.height,rgba:[...ctx.getImageData(0,0,1,1).data]};
  });
  assert(Math.abs(pixels.width - 320) < 6 && Math.abs(pixels.height - 160) < 6);
  assert.deepEqual(pixels.rgba,[255,0,0,255]);
  assert.deepEqual(errors, []);
  console.log("PASS document file picker, Japanese text, manual/live preview, CSV grid, encoding, SVG region PNG and saves");
} finally {
  await env.close();
}
