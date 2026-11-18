/** 印刷表示と製本機能の分離・旧設定引き継ぎ・設定ファイルの互換性を専用ブラウザーで確認する。 */
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const ext = path.resolve(__dirname, "../../src");
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "seihon-output-settings-")), {
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 1100, height: 800 },
  });
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto("chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/options/options.html#print");
    await page.waitForSelector("#bindingEnabled");
    const result = await page.evaluate(async () => {
      const s = await import("../common/settings.js");
      const b = await import("../common/backup.js");
      const pick = value => ({ binding: value.bindingEnabled, print: value.printButtonVisible });
      const result = {
        fresh: pick(s.normalizeSettings({})),
        legacyTrue: pick(s.normalizeSettings({ printBindVisible: true })),
        legacyFalse: pick(s.normalizeSettings({ printBindVisible: false })),
        independent: pick(s.normalizeSettings({ printBindVisible: true, bindingEnabled: false, printButtonVisible: true })),
        invalid: pick(s.normalizeSettings({ bindingEnabled: "false", printButtonVisible: 0 })),
        migrated: pick(s.migrateSettings({ printBindVisible: true, bindPaper: "A5" }, "0.11.0")),
        preserved: s.migrateSettings({ bindingEnabled: false, printButtonVisible: true, bindPaper: "A5" }, "0.12.0") === null,
        labels: Object.keys(s.DEFAULT_SETTINGS).every(k => !!s.SETTING_LABELS[k]),
      };
      result.reset = pick(await s.resetSettings());
      await s.saveSettings({ bindingEnabled: true, printButtonVisible: false, bindPaper: "A5" });
      const backup = await b.createBackup({ settings: true, roles: false });
      await s.resetSettings();
      await b.applyBackup(b.parseBackup(JSON.stringify(backup)), { roles: false });
      result.roundtrip = pick(await s.loadSettings());
      result.paper = (await s.loadSettings()).bindPaper;
      for (const enabled of [false, true]) {
        const legacy = b.parseBackup(JSON.stringify({ format: b.BACKUP_FORMAT, formatVersion: 1, settings: { printBindVisible: enabled } }));
        await b.applyBackup(legacy, { roles: false });
        result[enabled ? "oldBackupTrue" : "oldBackupFalse"] = pick(await s.loadSettings());
      }
      await s.resetSettings();
      return result;
    });
    assert.deepEqual(result.fresh, { binding: false, print: true });
    assert.deepEqual(result.reset, result.fresh);
    assert.deepEqual(result.legacyTrue, { binding: true, print: true });
    assert.deepEqual(result.legacyFalse, { binding: false, print: false });
    assert.deepEqual(result.independent, { binding: false, print: true });
    assert.deepEqual(result.invalid, result.fresh);
    assert.deepEqual(result.migrated, result.legacyTrue);
    assert(result.preserved && result.labels);
    assert.deepEqual(result.roundtrip, { binding: true, print: false });
    assert.equal(result.paper, "A5");
    assert.deepEqual(result.oldBackupTrue, result.legacyTrue);
    assert.deepEqual(result.oldBackupFalse, result.legacyFalse);
    console.log("PASS 新規初期値・旧true/false引継ぎ・独立設定・不正値・更新移行");
    console.log("PASS 全設定ラベル・新旧設定ファイルの保存/読み込み・既存製本値保持");
    await page.reload();
    await page.waitForSelector("#bindingEnabled");
    assert.equal(await page.locator("#printButtonVisible").isChecked(), true);
    assert.equal(await page.locator("#bindingEnabled").isChecked(), false);
    assert.equal(await page.locator("section[aria-labelledby=sec-bind]").isVisible(), false);
    assert.equal(await page.locator("section[aria-labelledby=sec-print]").isVisible(), true);
    await page.locator("#bindingEnabled").check();
    await page.waitForFunction(() => !document.querySelector("section[aria-labelledby=sec-bind]").hidden);
    await page.locator("#printButtonVisible").uncheck();
    await page.waitForFunction(async () => !(await (await import("../common/settings.js")).loadSettings()).printButtonVisible);
    await page.reload();
    await page.waitForSelector("#bindingEnabled");
    assert.equal(await page.locator("#bindingEnabled").isChecked(), true);
    assert.equal(await page.locator("#printButtonVisible").isChecked(), false);
    await page.locator("#bindingEnabled").uncheck();
    await page.waitForFunction(() => document.querySelector("section[aria-labelledby=sec-bind]").hidden);
    assert.equal(await page.locator("section[aria-labelledby=sec-print]").isVisible(), true);
    assert.equal(await page.locator("#backupExport").innerText(), "設定をファイルに保存…");
    assert.deepEqual(errors, []);
    console.log("PASS 設定画面で独立切替・即反映・再読込保持・製本OFFでも通常印刷設定維持・画面エラー0");
  } finally { await ctx.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
