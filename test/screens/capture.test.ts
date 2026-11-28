import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalize } from '../../src/config.ts';
import { History } from '../../src/git/history.ts';
import { screens } from '../../src/screens/screenshots.ts';
import { demoRepo } from '../helpers.ts';

const range = { kind: 'dates' as const, from: '2026-11-03', until: '2026-11-16' };

test('captured screenshots are compared between the last day before the sprint and its end', async () => {
  const dir = demoRepo();
  const fixtures = new URL('../fixtures/screens/', import.meta.url).pathname;
  const store = join(dir, '.sprint-review/screenshots');
  for (const [day, kind] of [['2026-11-01', 'before'], ['2026-11-16', 'after']] as const) {
    mkdirSync(join(store, day), { recursive: true });
    writeFileSync(join(store, day, 'planner-desktop.png'), readFileSync(join(fixtures, `planner-desktop.${kind}.png`)));
  }
  const c = normalize({ screenshots: { source: 'capture', pages: { planner: '/planner' }, baseUrl: 'http://localhost:3000' } }, dir);
  assert.equal(c.screenshots.source, 'capture');
  const shots = screens(c.screenshots, dir, new History(dir), range, { phone: 'phone', desktop: 'desktop' });
  const changed = await shots.changed();
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.device, 'desktop');
  assert.throws(() => normalize({ screenshots: { source: 'capture' } }, dir), /screenshots.pages is required/);
  assert.equal(shots.note, undefined);
});

test('captures taken only after the sprint ended are left out, and the run says why', () => {
  const dir = demoRepo();
  const fixtures = new URL('../fixtures/screens/', import.meta.url).pathname;
  const day = join(dir, '.sprint-review/screenshots/2026-11-20');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'planner-desktop.png'), readFileSync(join(fixtures, 'planner-desktop.after.png')));
  const c = normalize({ screenshots: { source: 'capture', pages: { planner: '/planner' }, baseUrl: 'http://localhost:3000' } }, dir);
  const shots = screens(c.screenshots, dir, new History(dir), range, { phone: 'phone', desktop: 'desktop' });
  assert.equal(shots.available().size, 0);
  assert.match(shots.note ?? '', /from 2026-11-20 are left out.*after the sprint's end \(2026-11-16\)/);
});


test('a page entry with a selector photographs just that element; one that is missing is skipped', async (t) => {
  const { capture } = await import('../../src/screens/capture.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const sharp = (await import('sharp')).default;
  const dir = mkdtempSync(join(tmpdir(), 'sprint-review-capture-'));
  writeFileSync(join(dir, 'app.html'), '<body style="margin:0"><div style="height:300px">header</div><section class="card" style="width:320px;height:180px;background:#eef">Signals <span class="email">a@b.test</span></section></body>');
  const c = normalize({ screenshots: { source: 'capture', pages: { app: `file://${join(dir, 'app.html')}`, signals: { url: `file://${join(dir, 'app.html')}`, selector: 'section.card' }, gone: { url: `file://${join(dir, 'app.html')}`, selector: '.nothing' } }, mask: ['.email'], wait: 0 } }, dir);
  if (c.screenshots.source !== 'capture') throw new Error('capture expected');
  const steps: string[] = [];
  let files: string[];
  try {
    files = await capture(c.screenshots.capture, dir, '2026-11-22', (m) => steps.push(m), 1000);
  } catch (e) {
    return t.skip(`no browser: ${(e as Error).message.slice(0, 60)}`);
  }
  assert.deepEqual(files.map((f) => f.split('/').pop()), ['app-desktop.png', 'signals-desktop.png']);
  const { width, height } = await sharp(readFileSync(files[1]!)).metadata();
  assert.deepEqual([width, height], [640, 360], 'only the element, at twice the sharpness');
  assert.ok(steps.some((m) => m.includes('Not found on gone')));
});

test('a login takes its values from the environment, never from the config', async () => {
  const { isLoginPage } = await import('../../src/screens/capture.ts');
  const base = { source: 'capture', pages: { app: '/app' } };
  const c = normalize({ screenshots: { ...base, login: { url: '/login', fields: { 'input[type=email]': 'SHOT_EMAIL' }, submit: 'button' } } }, '/tmp');
  assert.ok(c.screenshots.source === 'capture' && c.screenshots.capture.login?.fields['input[type=email]'] === 'SHOT_EMAIL');
  assert.ok(c.screenshots.source === 'capture' && c.screenshots.capture.onReview, 'pictures are taken on review by default');
  assert.throws(() => normalize({ screenshots: { ...base, login: { url: '/login', fields: { 'input[type=password]': 'hunter2!' }, submit: 'button' } } }, '/tmp'), /must name an environment variable/);
  assert.throws(() => normalize({ screenshots: { ...base, login: { url: '/login' } } }, '/tmp'), /needs url, fields and submit/);
  assert.ok(isLoginPage('https://app.test/login') && isLoginPage('https://app.test/auth/sign-in') && isLoginPage('file:///x/login/index.html'));
  assert.ok(!isLoginPage('https://app.test/app/demo/feed') && !isLoginPage('https://app.test/blogin'));
});

test('capture logs in with the form, and stops when a page sends it to the login', async (t) => {
  const { capture, CaptureError } = await import('../../src/screens/capture.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'sprint-review-login-'));
  mkdirSync(join(dir, 'login'));
  writeFileSync(join(dir, 'login', 'index.html'), `<form action="../app.html"><input type="email" name="e"><input type="password" name="p"><button type="submit">Sign in</button></form>`);
  writeFileSync(join(dir, 'app.html'), '<body>the app</body>');
  writeFileSync(join(dir, 'gone.html'), `<script>location.href = 'login/index.html'</script>`);
  const url = (f: string) => `file://${join(dir, f)}`;
  const login = { url: url('login/index.html'), fields: { 'input[type=email]': 'SHOT_EMAIL', 'input[type=password]': 'SHOT_PASSWORD' }, submit: 'button' };
  const config = (pages: Record<string, string>) => {
    const c = normalize({ screenshots: { source: 'capture', pages, wait: 0, login } }, dir);
    if (c.screenshots.source !== 'capture') throw new Error('capture expected');
    return c.screenshots.capture;
  };
  process.env.SHOT_EMAIL = 'shots@app.test';
  process.env.SHOT_PASSWORD = 'secret';
  try {
    const steps: string[] = [];
    let files: string[];
    try {
      files = await capture(config({ app: url('app.html') }), dir, '2026-11-22', (m) => steps.push(m));
    } catch (e) {
      if (e instanceof CaptureError && /browser|Playwright/.test(e.message)) return t.skip('no browser');
      throw e;
    }
    assert.deepEqual(steps.slice(0, 2), ['Logging in', 'Photographing app on desktop']);
    assert.equal(files.length, 1);
    await assert.rejects(capture(config({ gone: url('gone.html') }), dir, '2026-11-22'), /Not logged in: gone went to .*login/);
    delete process.env.SHOT_PASSWORD;
    await assert.rejects(capture(config({ app: url('app.html') }), dir, '2026-11-22'), /needs SHOT_PASSWORD in the environment/);
  } finally {
    delete process.env.SHOT_EMAIL;
    delete process.env.SHOT_PASSWORD;
  }
});

test("a review takes today's pictures when its sprint ends today and there are none yet", async () => {
  const { captureToday } = await import('../../src/review/generate.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'sprint-review-today-'));
  const c = normalize({ screenshots: { source: 'capture', pages: { app: '/app' } } }, dir);
  const today = new Date().toISOString().slice(0, 10);
  const now = { kind: 'dates' as const, from: '2026-01-01', until: today };
  const history = {} as History;
  const calls: string[] = [];
  const steps: string[] = [];
  const take = async (_c: unknown, _r: string, day = '') => { calls.push(day); return [join(dir, `${day}/app-desktop.png`)]; };
  await captureToday(c, history, range, (m) => steps.push(m), take);
  assert.deepEqual(calls, [], 'a sprint that ended earlier: today is not its end');
  await captureToday(c, history, now, (m) => steps.push(m), take);
  assert.deepEqual(calls, [today]);
  mkdirSync(join(dir, '.sprint-review/screenshots', today), { recursive: true });
  writeFileSync(join(dir, '.sprint-review/screenshots', today, 'app-desktop.png'), '');
  await captureToday(c, history, now, (m) => steps.push(m), take);
  assert.equal(calls.length, 1, 'pictures of today already there');
  const off = normalize({ screenshots: { source: 'capture', pages: { app: '/app' }, onReview: false } }, dir);
  await captureToday(off, history, now, () => {}, take);
  assert.equal(calls.length, 1, 'onReview: false');
  const failing = async () => { throw new Error('Not logged in: app went to /login'); };
  const other = normalize({ screenshots: { source: 'capture', pages: { app: '/app' }, storage: 'elsewhere' } }, dir);
  await captureToday(other, history, now, (m) => steps.push(m), failing);
  assert.match(steps.at(-1)!, /^Screenshots not taken: Not logged in/);
});
