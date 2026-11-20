// 画像の先頭フレーム、TIFFの複数ページ・向き、カメラ連続追加を独立プロファイルで確認。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Pillow で作った小さな赤・青のテスト画像。
const fixtures = {
  "tiff": "SUkqABoAAAB4nPvPwPB/FDHgDAQAXbpfoQAKAAABAwABAAAACAAAAAEBAwABAAAADAAAAAIBAwADAAAAmAAAAAMBAwABAAAACAAAAAYBAwABAAAAAgAAABEBBAABAAAACAAAABUBAwABAAAAAwAAABYBAwABAAAADAAAABcBBAABAAAAEQAAABwBAwABAAAAAQAAALoAAAAIAAgACAAAAElJKgAaAAAAeJxjYPjPMIoYcAYCAJ5rX6EACgAAAQMAAQAAAAwAAAABAQMAAQAAAAgAAAACAQMAAwAAADgBAAADAQMAAQAAAAgAAAAGAQMAAQAAAAIAAAARAQQAAQAAAKgAAAAVAQMAAQAAAAMAAAAWAQMAAQAAAAgAAAAXAQQAAQAAABEAAAAcAQMAAQAAAAEAAAAAAAAACAAIAAgAAAA=",
  "gif": "R0lGODlhCAAMAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAACAAMAAAIEgABCBxIsKDBgwgTKlzIsGHBgAAh+QQBCgABACwAAAAACAAMAIEAAP8AAAAAAAAAAAAIEgABCBxIsKDBgwgTKlzIsGHBgAA7",
  "avif": "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAALQAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAACAAAAAwAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAANW1kYXQSAAoIGAj9tEBDQaEyHxPHh4ZlAYYYfhAAAAC+sqKyiGr37FTXCbHhS0rjtYA=",
  "oriented": "SUkqAAgAAAALAAABBAABAAAACAAAAAEBBAABAAAADAAAAAIBAwADAAAAkgAAAAMBAwABAAAAAQAAAAYBAwABAAAAAgAAABEBBAABAAAAmAAAABIBAwABAAAABgAAABUBAwABAAAAAwAAABYBBAABAAAADAAAABcBBAABAAAAIAEAABwBAwABAAAAAQAAAAAAAAAIAAgACAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAA="
};

(async () => {
  const ext = path.resolve(__dirname, "../../src");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "seihon-image-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    ignoreDefaultArgs: ["--disable-extensions"], args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
      "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  try {
    const page = await ctx.newPage();
    page.on("pageerror", e => console.log("PAGE ERROR", e.message));
    page.on("console", m => { if (m.type() === "error") { console.log("CONSOLE", m.text()); } });
    await page.goto("chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/viewer/viewer.html");
    await page.locator("#shCollectEdit").waitFor({state:"attached"});
    console.log("Viewer ready");
    const colors = await page.evaluate(async fixtures => {
      const { imagesToPdf } = await import("./image-input.js");
      const { loadPdfFromBytes } = await import("./page-export.js");
      const makeFile = (k, ext) => new File([Uint8Array.from(atob(fixtures[k]), ch => ch.charCodeAt(0))], k + "." + ext);
      const blob = await imagesToPdf([makeFile("gif","gif"),makeFile("tiff","tiff"),makeFile("oriented","tif"),makeFile("avif","avif")],
        "image", () => {});
      const doc = await loadPdfFromBytes(new Uint8Array(await blob.arrayBuffer()));
      const out = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const p = await doc.getPage(n), vp = p.getViewport({scale:4});
        const canvas = document.createElement("canvas");
        canvas.width = vp.width; canvas.height = vp.height;
        await p.render({canvas, viewport:vp}).promise;
        const pix = canvas.getContext("2d").getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
        out.push({color:pix[0] > 200 && pix[2] < 60 ? "red" : pix[2] > 200 && pix[0] < 60 ? "blue" : String(pix),
          direction:canvas.width > canvas.height ? "landscape" : "portrait"});
      }
      await doc.loadingTask.destroy();
      return out;
    }, fixtures);
    assert.deepEqual(colors.map(x => x.color), ["red","red","blue","red","red"]);
    assert.equal(colors[3].direction, "landscape");
    console.log("PASS GIF first frame; two TIFF pages; rotated TIFF; AVIF.");
    await page.evaluate(async () => { (await import("./ui/conversion-tools.js")).runConversionTool("images-pdf"); });
    const camera = page.locator("#shFileConversion [data-camera-open]");
    await camera.click();
    await page.waitForFunction(() => document.querySelector("#shFileConversion video")?.videoWidth > 0);
    await page.evaluate(() => { window.cameraTrack = document.querySelector("#shFileConversion video").srcObject.getVideoTracks()[0]; });
    for (let count = 1; count <= 2; count++) {
      await page.locator("[data-camera-shot]").click();
      await page.waitForFunction(count => document.querySelectorAll("#shFileConversion li").length === count, count);
    }
    await page.locator("#shFileConversion [data-run]").click();
    await page.getByRole("button", {name:"保存先を選ぶ…"}).waitFor();
    assert.equal(await page.evaluate(() => window.cameraTrack.readyState), "ended");
    await page.locator("[data-camera-open]").click();
    await page.waitForFunction(() => document.querySelector("#shFileConversion video")?.videoWidth > 0);
    await page.evaluate(() => { window.cameraTrack = document.querySelector("#shFileConversion video").srcObject.getVideoTracks()[0]; });
    await page.locator("#shFileConversion [data-close]").click();
    await page.waitForFunction(() => window.cameraTrack.readyState === "ended");
    console.log("PASS two camera captures and release on conversion and exit (simulated camera).");
  } finally { await ctx.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

