// 0.6.3(引き継ぎ前の品質向上: 段階1 デバッグ)の試験。見つけた不具合の再現と、直ったことの確認
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BASE, EXT, Results, SP, assert, eq, launch, openViewer, setSettings, sleep, viewerUrl, waitViewerReady, waitToast } from './lib.mjs';
import { parseBackup } from '../../src/common/backup.js';

/** 補助プログラム(Linux)の場所 */
const HELPER = path.join(EXT, 'helper/linux/seihon-clipboard.py');

const R = new Results('Phase 13 (0.6.3 デバッグ)');
const env = await launch({ width: 1400, height: 950 });
const { ctx, sw } = env;
const errors = [];
const watch = page => {
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 200)}`));
  return page;
};
const open = async src => watch(await openViewer(ctx, `${BASE}${src}`));
const clearChoices = () => sw.evaluate(() => chrome.storage.local.remove('scanChoices'));
const scanState = page => page.evaluate(() => {
  const a = window.__seihonViewer.scanArranger;
  return { state: a.state, kind: a.kind, checked: !!a.base?.checked, analyzed: !!a.base?.analyzed, arranged: !!a.arranged, progress: a.progress };
});
const toasts = page => page.evaluate(() => [...document.querySelectorAll('.sh-toast')].map(e => e.textContent));

await setSettings(sw, { scanDeskew: 'auto', scanArrange: 'auto', scanDirection: 'binding', bindingDirection: 'ltr', theme: 'system' });

// ---------------------------------------------------------------------------
// D1: 設定「スキャンした見開き」が「何もしない」なら、横に置いてスキャンした見開きも案内しない
// ---------------------------------------------------------------------------
await R.run('D1', '「スキャンした見開き: 何もしない」では、横に置いてスキャンした見開き(縦長)も案内・自動の分割をしない', async () => {
  await clearChoices();
  await setSettings(sw, { scanArrange: 'off', scanDeskew: 'auto' });
  try {
    const page = await open('/files/side-a.pdf');
    await page.waitForFunction(() => window.__seihonViewer.scanArranger.base?.checked, null, { timeout: 90000 });
    await sleep(800);
    const st = await scanState(page);
    const t = await toasts(page);
    assert(st.kind !== 'turned', `横置きの見開きとして案内した: ${JSON.stringify(st)}`);
    assert(!t.some(x => /横に置いて/.test(x)), `横置きの案内が出た: ${t.join(' / ')}`);
    assert(st.state !== 'arranged' && st.state !== 'busy', `整えた: ${JSON.stringify(st)}`);
    await page.close();
    return `${st.state}/${st.kind}`;
  } finally {
    await setSettings(sw, { scanArrange: 'auto' });
  }
});

// ---------------------------------------------------------------------------
// D2: 自動で整えている途中は、⋮ メニューの「スキャンを整える…」を押せない(押せると、自動の整えが黙って止まる)
// ---------------------------------------------------------------------------
await R.run('D2', '自動で整えている間は ⋮ の「スキャンを整える…」を押せず、自動の整えはそのまま終わる', async () => {
  await clearChoices();
  const page = watch(await ctx.newPage());
  await page.goto(viewerUrl(`${BASE}/files/kokugo2018.pdf`));
  await page.waitForFunction(() => window.__seihonViewer?.scanArranger?.state === 'busy' && /調べて/.test(window.__seihonViewer.scanArranger.progress), null, { timeout: 90000 });
  await page.click('#shMore');
  const item = page.locator('.sh-popup:not([hidden]) .sh-menu-item', { hasText: 'スキャンを整える' });
  await item.waitFor({ timeout: 5000 });
  const disabled = await item.isDisabled();
  // 通知の「整え方…」などから開こうとしたときも、開かずに知らせる
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__seihonViewer.scanDialog.open());
  await sleep(300);
  const dialogOpened = await page.evaluate(() => document.getElementById('shScanDialog').open);
  if (dialogOpened) {
    await page.click('#shScanClose');
  }
  if (!disabled) {
    await page.click('#shMore');
    // 押して、すぐ閉じる(使う人が「やっぱりやめた」とき)
    await item.click();
    await page.waitForFunction(() => document.getElementById('shScanDialog').open, null, { timeout: 5000 });
    await sleep(400);
    await page.click('#shScanClose');
  }
  await page.waitForFunction(() => window.__seihonViewer.scanArranger.state !== 'busy', null, { timeout: 120000 });
  await sleep(1500);
  const st = await scanState(page);
  await page.close();
  assert(disabled, 'メニューの項目が押せた');
  assert(!dialogOpened, '整えている途中に、整え方の画面が開いた');
  eq(st.state, 'arranged', `自動の整え: ${JSON.stringify(st)}`);
  return st.state;
});

// ---------------------------------------------------------------------------
// D3: コミック(右綴じ)を見ているときに、ほかの設定を変えても綴じ方向が変わらない
// ---------------------------------------------------------------------------
await R.run('D3', 'コミック(右綴じ)・右綴じに整えたスキャンの表示中に、ほかの設定(テーマ・回転の向き)を変えても、綴じ方向は変わらない', async () => {
  await setSettings(sw, { bindingDirection: 'ltr', comicDirection: 'auto' });
  const page = watch(await ctx.newPage());
  await page.goto(viewerUrl(`${BASE}/book/comic.cbz`));
  await page.waitForFunction(() => window.__seihonViewer?.current?.converted && window.__seihonViewer.app.pdfDocument, null, { timeout: 60000 });
  await waitViewerReady(page);
  const before = await page.evaluate(() => window.__seihonViewer.book.direction);
  eq(before, 'rtl', 'コミックは右綴じ');
  await setSettings(sw, { theme: 'dark' });
  await sleep(800);
  const afterTheme = await page.evaluate(() => window.__seihonViewer.book.direction);
  await setSettings(sw, { rotateStep: 90 });
  await sleep(800);
  const afterRotate = await page.evaluate(() => window.__seihonViewer.book.direction);
  // 設定の綴じ方向そのものを変えたときは、これまでどおり変わる
  await setSettings(sw, { bindingDirection: 'rtl' });
  await sleep(500);
  await setSettings(sw, { bindingDirection: 'ltr' });
  await sleep(800);
  const afterDir = await page.evaluate(() => window.__seihonViewer.book.direction);
  await setSettings(sw, { theme: 'system', rotateStep: -90 });
  await page.close();
  eq([afterTheme, afterRotate], ['rtl', 'rtl'], 'ほかの設定を変えた後の綴じ方向');
  eq(afterDir, 'ltr', '設定の綴じ方向を変えたとき');
  return `${before} → ${afterTheme} → ${afterRotate} → (設定を変える) ${afterDir}`;
});

// ---------------------------------------------------------------------------
// D4: 補助プログラム(Linux)は、一時フォルダの場所がほかの人の作ったリンクのとき、リンク先のファイルを消さない
// ---------------------------------------------------------------------------
await R.run('D4', '補助プログラム(Linux): 一時フォルダがリンク(ほかの場所を指す)なら使わず、リンク先のファイルを消さない', async () => {
  const tmp = fs.mkdtempSync(path.join(SP, 'helper-tmp-'));
  const victim = fs.mkdtempSync(path.join(SP, 'helper-victim-'));
  fs.writeFileSync(path.join(victim, 'important.txt'), 'keep me');
  const uid = process.getuid();
  fs.symlinkSync(victim, path.join(tmp, `seihon-viewer-copy-${uid}`));
  const msg = obj => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    return Buffer.concat([head, body]);
  };
  const input = Buffer.concat([
    msg({ type: 'begin', place: 'temp', root: 'x', folder: '', files: [{ name: 'a.pdf', size: 3 }] }),
    msg({ type: 'chunk', index: 0, data: Buffer.from('abc').toString('base64') }),
  ]);
  const out = execFileSync('python3', ['-I', HELPER], {
    input,
    env: { ...process.env, TMPDIR: tmp, PATH: '/usr/bin:/bin' },
  });
  // 返事を読む
  const replies = [];
  for (let p = 0; p + 4 <= out.length; ) {
    const n = out.readUInt32LE(p);
    replies.push(JSON.parse(out.subarray(p + 4, p + 4 + n).toString('utf8')));
    p += 4 + n;
  }
  const kept = fs.existsSync(path.join(victim, 'important.txt'));
  const wroteIntoVictim = fs.readdirSync(victim).filter(f => f !== 'important.txt');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(victim, { recursive: true, force: true });
  assert(kept, `リンク先のファイルが消えた(返事: ${JSON.stringify(replies[0])})`);
  eq(wroteIntoVictim, [], 'リンク先に書き込んだもの');
  eq(replies[0]?.ok, false, '一時フォルダを使わない(Chrome のダウンロードで保存し直す)');
  return replies[0]?.error;
});

await R.run('D4b', '補助プログラム(Linux): ふつうの一時フォルダでは、これまでどおり保存でき、前のコピーは消える', async () => {
  const tmp = fs.mkdtempSync(path.join(SP, 'helper-tmp-'));
  const msg = obj => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    return Buffer.concat([head, body]);
  };
  const run = name => {
    const out = execFileSync('python3', ['-I', HELPER], {
      input: Buffer.concat([
        msg({ type: 'begin', place: 'temp', root: 'x', folder: '', files: [{ name, size: 3 }] }),
        msg({ type: 'chunk', index: 0, data: Buffer.from('abc').toString('base64') }),
      ]),
      env: { ...process.env, TMPDIR: tmp, PATH: '/usr/bin:/bin' },
    });
    const n = out.readUInt32LE(0);
    return JSON.parse(out.subarray(4, 4 + n).toString('utf8'));
  };
  try {
    const r1 = run('a.pdf');
    assert(r1.ok, JSON.stringify(r1));
    eq(fs.readFileSync(r1.paths[0], 'utf8'), 'abc', '保存した中身');
    const base = path.dirname(path.dirname(r1.paths[0]));
    eq((fs.statSync(base).mode & 0o777).toString(8), '700', '一時フォルダの権限');
    await sleep(1100);
    const r2 = run('b.pdf');
    assert(r2.ok, JSON.stringify(r2));
    assert(!fs.existsSync(r1.paths[0]), '前のコピーが残っている');
    eq(fs.readFileSync(r2.paths[0], 'utf8'), 'abc', '2回目の中身');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D5: 設定の読み込みで、追加した項目(custom1 など)のページ役割も読み込む
// ---------------------------------------------------------------------------
await R.run('D5', '設定の書き出し・読み込み: 追加した項目(custom1 など)のページ役割も読み込める(書き出したものがそのまま戻る)', async () => {
  const key = `sha256:${'a'.repeat(64)}:1234`;
  const text = JSON.stringify({
    format: 'seihon-viewer-backup',
    formatVersion: 1,
    settings: { bindRoleItems: [{ id: 'cover', show: true, multi: false }, { id: 'custom1', label: '口絵', show: true, multi: true, use: 'obi' }] },
    roles: [
      { pdfKey: key, name: '本.pdf', pages: 10, roles: { 0: 'cover', 2: 'custom1', 3: 'custom1' } },
      { pdfKey: `sha256:${'b'.repeat(64)}:99`, name: '付録.pdf', pages: 4, roles: { 1: 'custom2' } },
    ],
  });
  const parsed = parseBackup(text);
  assert(parsed.ok, parsed.error);
  const r = parsed.roles.find(x => x.pdfKey === key);
  eq(r?.roles, { 0: 'cover', 2: 'custom1', 3: 'custom1' }, '追加した項目の役割');
  eq(parsed.roles.length, 2, '追加した項目だけの PDF も読み込む');
  eq(parsed.skippedRoles, 0, '読み込めなかったもの');
  // 壊れた役割名は、これまでどおり読み込まない
  const bad = parseBackup(JSON.stringify({ format: 'seihon-viewer-backup', formatVersion: 1, roles: [{ pdfKey: key, roles: { 0: 'custom', 1: 'evil<script>', 2: 'custom99999' } }] }));
  eq(bad.ok, false, '使えない役割名だけのファイル');
});

// ---------------------------------------------------------------------------
// D6: 速度ログ: 同じタブで2つ目に開いた PDF も、開いた時点から測る
// ---------------------------------------------------------------------------
await R.run('D6', '速度ログ: 同じタブで2つ目以降に開いた PDF の「最初のページまで」は、開いた時点からの時間', async () => {
  await setSettings(sw, { perfLog: true });
  try {
    const page = await open('/pdf/book-8.pdf');
    await page.waitForFunction(() => window.__seihonViewer.perf.done, null, { timeout: 30000 });
    const first = await page.evaluate(() => window.__seihonViewer.perf.summary().firstPageMs);
    await sleep(3000);
    await page.evaluate(src => window.__seihonViewer.app.open({ url: src, originalUrl: src }), `${BASE}/pdf/book-10.pdf`);
    await page.waitForFunction(() => window.__seihonViewer.perf.done && window.__seihonViewer.app.pagesCount === 10, null, { timeout: 30000 });
    const s = await page.evaluate(() => window.__seihonViewer.perf.summary());
    await page.close();
    assert(s.firstPageMs !== null && s.firstPageMs < 2500, `2つ目の PDF の最初のページまで: ${s.firstPageMs} ms(開いた時点からではない)`);
    assert(s.marks[0][1] < 100, `最初の記録(PDFの読み込み開始): ${s.marks[0][1]} ms`);
    return `1つ目 ${first} ms / 2つ目 ${s.firstPageMs} ms`;
  } finally {
    await setSettings(sw, { perfLog: false });
  }
});

if (errors.length) {
  console.log('ページのエラー:', errors.slice(0, 10).join('\n'));
}
R.summary();
await env.close();
process.exit(0);
