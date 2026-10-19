// 製本ビューアの試験の共通部品(Playwright + 拡張機能を読み込んだ Chromium)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

/** Playwright を読み込む(環境変数 PLAYWRIGHT_MODULE → npm で入れたもの → 開発に使った環境の場所 の順に探す) */
async function loadPlaywright() {
  const tried = [];
  for (const m of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/npm-tools/node_modules/playwright/index.mjs']) {
    if (!m) {
      continue;
    }
    try {
      return await import(m);
    } catch (e) {
      tried.push(`${m}: ${e.code || e.message}`);
    }
  }
  throw new Error(`Playwright が見つかりません(npm install playwright、または環境変数 PLAYWRIGHT_MODULE で場所を指定)\n${tried.join('\n')}`);
}
const { chromium } = await loadPlaywright();

/** リポジトリの場所(このファイルは dev/tests/ にある) */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASE = 'http://127.0.0.1:8765';
/** 読み込む拡張機能(初期値はリポジトリの src/) */
export const EXT = process.env.EXT_DIR || path.join(ROOT, 'src');
/** 拡張機能の ID(manifest.json の key で固定しているので、置き場所によらず同じ) */
export const EXT_ID = 'miiaicaobmegmjkmicojhmajnancjnjp';
export const VIEWER = `chrome-extension://${EXT_ID}/viewer/viewer.html`;
export const DEV = path.join(ROOT, 'dev');
/** 試験で作るもの(ブラウザのプロファイル・ダウンロード先など)の置き場所 */
export const SP = process.env.SEIHON_TEST_TMP || path.join(os.tmpdir(), 'seihon-viewer-tests');
fs.mkdirSync(SP, { recursive: true });
/** 試験用サーバーが /files/ で配る PDF(dev/setup.sh でそろえる) */
export const PDFS = `${DEV}/pdfs`;

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function viewerUrl(src) {
  return `${VIEWER}?src=${encodeURIComponent(src.startsWith('/') ? BASE + src : src)}`;
}

/**
 * 拡張機能を読み込んだ Chromium を起動する。
 * @returns {Promise<{ctx, sw, downloadsDir, userDir, close}>}
 */
export async function launch({
  width = 1280,
  height = 900,
  dark = false,
  downloadsDir = null,
  userDir = null,
  extDir = EXT,
  extraArgs = [],
  prefs = null,
} = {}) {
  userDir ||= fs.mkdtempSync(path.join(SP, 'profile-'));
  downloadsDir ||= fs.mkdtempSync(path.join(SP, 'dl-'));
  fs.mkdirSync(path.join(userDir, 'Default'), { recursive: true });
  const prefFile = path.join(userDir, 'Default', 'Preferences');
  let p = {};
  try {
    p = JSON.parse(fs.readFileSync(prefFile, 'utf8'));
  } catch {}
  p.download = { ...(p.download || {}), default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true };
  p.savefile = { default_directory: downloadsDir };
  if (prefs) {
    for (const [k, v] of Object.entries(prefs)) {
      p[k] = typeof v === 'object' && v && !Array.isArray(v) ? { ...(p[k] || {}), ...v } : v;
    }
  }
  fs.writeFileSync(prefFile, JSON.stringify(p));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: false,
    viewport: { width, height },
    colorScheme: dark ? 'dark' : 'light',
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=DownloadBubble,DownloadBubbleV2',
      ...extraArgs,
    ],
  });
  let sw = ctx.serviceWorkers().find(w => w.url().includes(EXT_ID));
  if (!sw) {
    sw = await ctx.waitForEvent('serviceworker', { predicate: w => w.url().includes(EXT_ID), timeout: 20000 });
  }
  // 初回案内のタブは閉じる
  await sleep(500);
  for (const pg of ctx.pages()) {
    if (pg.url().includes('/welcome/')) {
      await pg.close().catch(() => {});
    }
  }
  // 0.4.2: 保存先を選ぶ画面(showSaveFilePicker・showDirectoryPicker)は試験では操作できないので、
  // 呼ばれた指定を window.__pickerCalls に記録し、選ばれた名前でダウンロードフォルダに保存する偽物にする。
  // window.__pickerCancel = true で「やめる」を選んだことにする。
  await ctx.addInitScript(FAKE_PICKER);
  // Playwright はダウンロードを GUID の名前で保存させるので、Chrome の通常の動き(設定のフォルダに、実際の名前で)に戻す
  const browserSession = await ctx.browser().newBrowserCDPSession();
  await browserSession.send('Browser.setDownloadBehavior', { behavior: 'default' });
  const env = { ctx, sw, downloadsDir, userDir, browserSession };
  env.close = () => ctx.close().catch(() => {});
  return env;
}

const FAKE_PICKER = `(() => {
  if (location.protocol !== 'chrome-extension:' || !globalThis.chrome?.downloads) return;
  const download = chrome.downloads.download.bind(chrome.downloads);
  const ua = navigator.userActivation; // 本物(試験で navigator.userActivation を差し替えても、こちらで記録する)
  window.__pickerCalls = [];
  const writeAs = (name, blob) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    download({ url, filename: name, saveAs: false, conflictAction: 'uniquify' }).then(id => {
      const check = () => chrome.downloads.search({ id }).then(([it]) => {
        if (it && it.state === 'complete') { URL.revokeObjectURL(url); resolve(it.filename); }
        else if (it && it.state === 'interrupted') reject(new Error(it.error));
        else setTimeout(check, 100);
      });
      check();
    }, reject);
  });
  const fileHandle = name => ({
    kind: 'file', name,
    async createWritable() {
      const parts = [];
      return {
        async write(d) { parts.push(d); },
        async close() {
          const blob = new Blob(parts, { type: parts[0]?.type || 'application/octet-stream' });
          (window.__pickerWritten ||= []).push({ name, size: blob.size });
          (window.__pickerBlobs ||= {})[name] = blob;
          if (!window.__pickerNoDownload) await writeAs(name, blob);
        },
        async abort() {},
      };
    },
  });
  const cancelled = () => { const e = new DOMException('The user aborted a request.', 'AbortError'); return e; };
  window.showSaveFilePicker = async (opts = {}) => {
    window.__pickerCalls.push({ kind: 'file', suggestedName: opts.suggestedName, types: opts.types, activation: ua?.isActive });
    if (window.__pickerCancel) throw cancelled();
    return fileHandle(opts.suggestedName || 'unnamed');
  };
  window.showDirectoryPicker = async (opts = {}) => {
    window.__pickerCalls.push({ kind: 'dir', mode: opts.mode, activation: ua?.isActive });
    if (window.__pickerCancel) throw cancelled();
    const made = new Set(window.__pickerExisting || []);
    return {
      kind: 'directory', name: 'picked',
      async getFileHandle(name, o = {}) {
        if (!made.has(name) && !o.create) throw new DOMException('not found', 'NotFoundError');
        made.add(name);
        return fileHandle(name);
      },
    };
  };
})();`;

/** クリックの効き目が切れた状態にする(Playwright の evaluate はクリックしたことになるため) */
export function expireActivation(page) {
  return page.evaluate(() => {
    const real = navigator.userActivation;
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      get: () => ({ isActive: false, hasBeenActive: real.hasBeenActive }),
    });
  });
}

/** 偽の保存先を選ぶ画面で書き込んだファイルの中身(Buffer) */
export async function pickerFile(page, name) {
  const b64 = await page.evaluate(async name => {
    const blob = window.__pickerBlobs?.[name];
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, name);
  return b64 === null ? null : Buffer.from(b64, 'base64');
}

/** 互換のため(launch の中で設定済み) */
export async function allowDownloads() {}

/** 設定を書き換える */
export async function setSettings(sw, patch) {
  await sw.evaluate(async patch => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...patch } });
  }, patch);
}

export async function getSettings(sw) {
  return sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings || {});
}

/** ビューアで PDF を開き、表示されるまで待つ */
export async function openViewer(ctx, src, { wait = true, page = null } = {}) {
  page ||= await ctx.newPage();
  await page.goto(viewerUrl(src));
  if (wait) {
    await waitViewerReady(page);
  }
  return page;
}

export async function waitViewerReady(page, timeout = 30000) {
  await page.waitForFunction(
    () => {
      const v = window.__seihonViewer;
      return v && v.app.pdfDocument && v.app.pdfViewer.pagesCount > 0 && document.querySelector('.page canvas, .page .canvasWrapper canvas');
    },
    null,
    { timeout }
  );
  await page.waitForFunction(() => !document.getElementById('shToolbar').classList.contains('sh-loading'), null, { timeout });
}

export async function viewerState(page) {
  return page.evaluate(() => {
    const v = window.__seihonViewer;
    const app = v.app;
    return {
      page: app.page,
      pages: app.pagesCount,
      scale: app.pdfViewer.currentScale,
      scaleValue: app.pdfViewer.currentScaleValue,
      spreadMode: app.pdfViewer.spreadMode,
      mode: v.book.mode,
      direction: v.book.direction,
      title: document.getElementById('shTitle').textContent,
    };
  });
}

/** フォルダ(下のフォルダも含む)の中のファイルを待つ */
export async function waitForFile(dir, pred = () => true, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const files = listFiles(dir).filter(f => !/\.(crdownload|tmp)$/i.test(f) && pred(f));
    if (files.length) {
      // 書き込みが終わるまで少し待つ
      const full = path.join(dir, files[0]);
      let size = -1;
      for (let i = 0; i < 20; i++) {
        const s = fs.statSync(full).size;
        if (s > 0 && s === size) {
          break;
        }
        size = s;
        await sleep(150);
      }
      return full;
    }
    await sleep(200);
  }
  throw new Error(`ファイルが保存されませんでした(${dir})`);
}

export function listFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...listFiles(path.join(dir, e.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

export function clearDir(dir) {
  if (fs.existsSync(dir)) {
    for (const e of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, e), { recursive: true, force: true });
    }
  }
}

export function pdfInfo(file) {
  const out = execFileSync('pdfinfo', [file], { encoding: 'latin1' });
  const pages = Number(/Pages:\s+(\d+)/.exec(out)?.[1] || 0);
  const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(out);
  return { pages, width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0, raw: out };
}

export function pdfText(file, page = null) {
  const args = page ? ['-f', String(page), '-l', String(page), file, '-'] : [file, '-'];
  return execFileSync('pdftotext', args, { encoding: 'utf8' });
}

export function pdfImages(file) {
  const out = execFileSync('pdfimages', ['-list', file], { encoding: 'utf8' });
  return out
    .split('\n')
    .slice(2)
    .filter(Boolean)
    .map(l => l.trim().split(/\s+/))
    .map(c => ({ page: Number(c[0]), type: c[2], width: Number(c[3]), height: Number(c[4]), color: c[5], enc: c[8], xppi: Number(c[12]), yppi: Number(c[13]) }));
}

/** 画像の大きさ(identify) */
export function imageSize(file) {
  const out = execFileSync('identify', ['-format', '%w %h %m', file], { encoding: 'utf8' });
  const [w, h, fmt] = out.trim().split(/\s+/);
  return { width: Number(w), height: Number(h), format: fmt };
}

/** 試験の結果の記録 */
export class Results {
  constructor(name) {
    this.name = name;
    this.items = [];
    this.only = (process.argv.slice(2).filter(a => !a.startsWith('-'))).map(s => s.toUpperCase());
  }

  want(id) {
    return !this.only.length || this.only.includes(id.toUpperCase());
  }

  async run(id, title, fn) {
    if (!this.want(id)) {
      return;
    }
    const t0 = Date.now();
    try {
      const detail = await fn();
      this.items.push({ id, title, ok: true, detail });
      console.log(`PASS  ${id} ${title}${detail ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''} (${Date.now() - t0} ms)`);
    } catch (e) {
      this.items.push({ id, title, ok: false, error: e });
      console.log(`FAIL  ${id} ${title}  — ${e?.message || e}`);
      if (process.env.VERBOSE) {
        console.log(e?.stack);
      }
    }
  }

  summary() {
    const ok = this.items.filter(i => i.ok).length;
    const line = `${this.name}: ${ok}/${this.items.length} passed`;
    console.log(line);
    return { ok, total: this.items.length, line };
  }
}

export function assert(cond, message) {
  if (!cond) {
    throw new Error(message || 'assertion failed');
  }
}

export function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message || '値が違います'}: ${a} ≠ ${b}`);
  }
}

/** クリップボードを読む(試験用のページで読む。読み終えたら元のページを前に戻す) */
export async function readClipboard(ctx, backTo = null) {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const helper = await ctx.newPage();
  await helper.goto(`${BASE}/`);
  await helper.bringToFront();
  const out = await helper.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const res = [];
    for (const it of items) {
      for (const t of it.types) {
        const b = await it.getType(t);
        if (t.startsWith('image/')) {
          const bmp = await createImageBitmap(b);
          res.push({ type: t, width: bmp.width, height: bmp.height, size: b.size });
        } else {
          res.push({ type: t, text: await b.text() });
        }
      }
    }
    return res;
  });
  await helper.close();
  await backTo?.bringToFront();
  return out;
}

/** クリップボードを空にする(文字を入れておく) */
export async function setClipboardText(ctx, text, backTo = null) {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const helper = await ctx.newPage();
  await helper.goto(`${BASE}/`);
  await helper.bringToFront();
  await helper.evaluate(t => navigator.clipboard.writeText(t), text);
  await helper.close();
  await backTo?.bringToFront();
}

/** 通知(トースト)に、条件に合う文が出るまで待つ */
export async function waitToast(page, re, timeout = 60000) {
  const handle = await page.waitForFunction(
    src => {
      const r = new RegExp(src);
      const t = [...document.querySelectorAll('.sh-toast')].map(e => e.textContent).find(x => r.test(x));
      return t || null;
    },
    re.source,
    { timeout }
  );
  return handle.jsonValue();
}

/** ページ(またはサムネイル)を右クリックしてメニューの項目の名前を返す */
export async function contextMenuAt(page, selector, { x = 0.5, y = 0.3 } = {}) {
  await page.locator(selector).first().scrollIntoViewIfNeeded();
  await sleep(200);
  const box = await page.locator(selector).first().boundingBox();
  await page.mouse.click(box.x + box.width * x, box.y + box.height * y, { button: 'right' });
  await page.waitForSelector('.sh-context-menu:not([hidden])');
  return page.$$eval('.sh-context-menu .sh-menu-item .sh-menu-label', els => els.map(e => e.textContent));
}

export async function clickMenuItem(page, text) {
  const re = text instanceof RegExp ? text : new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  await page.locator('.sh-popup:not([hidden]) .sh-menu-item', { hasText: re }).first().click();
}

/** 印刷を「PDF に保存」に自動で回す起動の設定(--kiosk-printing) */
export const KIOSK_PRINT = {
  extraArgs: ['--kiosk-printing'],
  prefs: {
    printing: {
      print_preview_sticky_settings: {
        appState: JSON.stringify({
          recentDestinations: [{ id: 'Save as PDF', origin: 'local', account: '' }],
          selectedDestinationId: 'Save as PDF',
          version: 2,
        }),
      },
    },
  },
};
