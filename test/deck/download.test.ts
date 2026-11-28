import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderDeck } from '../../src/deck/render.ts';
import { sample } from '../helpers.ts';

/**
 * Download shows on a deck opened from a website, where viewers have no file of their own; Edit
 * shows on the deck opened from your own disk. Measured in Chrome; skipped where there is none.
 */

async function chrome() {
  try {
    const { chromium } = await import('playwright-core');
    return await chromium.launch({ channel: 'chrome' });
  } catch {
    return null;
  }
}

const SITE = 'https://decks.example/sprint/';

/** Opens the deck as a website would serve it, with or without a deck.pptx beside it. */
async function served(html: string, pptx: boolean, framed = false) {
  const browser = await chrome();
  if (!browser) return null;
  const page = await browser.newPage();
  await page.route('https://decks.example/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/sprint/' || path === '/sprint/index.html') return route.fulfill({ contentType: 'text/html', body: html });
    if (path === '/sprint/deck.pptx' && pptx) return route.fulfill({ contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', body: 'pptx' });
    if (path === '/frame.html') return route.fulfill({ contentType: 'text/html', body: `<iframe src="${SITE}" width="800" height="450"></iframe>` });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(framed ? 'https://decks.example/frame.html' : SITE);
  await page.waitForTimeout(300);
  return { browser, page };
}

const visible = (selector: string) => `(function () { var e = document.querySelector('${selector}'); return !!e && !e.hidden && e.getBoundingClientRect().width > 0; })()`;

test('a deck opened from a website offers PDF and HTML downloads, and no Edit', async (t) => {
  const s = await served(renderDeck(sample(), {}), false);
  if (!s) return t.skip('no Chrome');
  try {
    assert.equal(await s.page.evaluate(visible('.download-button')), true);
    assert.equal(await s.page.evaluate(visible('.edit-button')), false);
    await s.page.click('.download-button');
    assert.equal(await s.page.evaluate(visible('.download-menu')), true);
    const html = s.page.locator('.download-menu [data-get="html"]');
    assert.equal(await html.getAttribute('href'), `${SITE}`);
    assert.match((await html.getAttribute('download')) ?? '', /\.html$/);
    assert.equal(await s.page.evaluate(visible('.download-menu [data-get="pdf"]')), true);
    assert.equal(await s.page.evaluate(visible('.download-menu [data-get="pptx"]')), false);
    await s.page.keyboard.press('Escape');
    assert.equal(await s.page.evaluate(visible('.download-menu')), false);
  } finally {
    await s.browser.close();
  }
});

test('a deck.pptx beside the deck adds a PowerPoint download', async (t) => {
  const s = await served(renderDeck(sample(), {}), true);
  if (!s) return t.skip('no Chrome');
  try {
    await s.page.click('.download-button');
    const pptx = s.page.locator('.download-menu [data-get="pptx"]');
    assert.equal(await s.page.evaluate(visible('.download-menu [data-get="pptx"]')), true);
    assert.equal(await pptx.getAttribute('href'), `${SITE}deck.pptx`);
  } finally {
    await s.browser.close();
  }
});

test('the PDF download opens the print dialog with every slide as a page', async (t) => {
  const s = await served(renderDeck(sample(), {}), false);
  if (!s) return t.skip('no Chrome');
  try {
    await s.page.evaluate(() => { (window as unknown as { printed: number }).printed = 0; window.print = () => { (window as unknown as { printed: number }).printed++; }; });
    await s.page.click('.download-button');
    await s.page.click('.download-menu [data-get="pdf"]');
    assert.equal(await s.page.evaluate(() => (window as unknown as { printed: number }).printed), 1);
    assert.equal(await s.page.evaluate(visible('.download-menu')), false);
  } finally {
    await s.browser.close();
  }
});

test('the deck opened from your own disk offers Download beside Edit: PDF, a copy of itself, and PowerPoint when one was written', async (t) => {
  const browser = await chrome();
  if (!browser) return t.skip('no Chrome');
  try {
    for (const pptxBeside of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), 'sprint-review-download-'));
      const file = join(dir, 'deck.html');
      writeFileSync(file, renderDeck(sample(), { pptxBeside }));
      const page = await browser.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(visible('.edit-button')), true);
      assert.equal(await page.evaluate(visible('.download-button')), true);
      const [edit, download] = await Promise.all(['.edit-button', '.download-button'].map((sel) => page.locator(sel).boundingBox()));
      assert.ok(download!.x + download!.width <= edit!.x, 'Download sits left of Edit, not on top of it');
      await page.click('.download-button');
      assert.equal(await page.evaluate(visible('.download-menu [data-get="pdf"]')), true);
      assert.equal(await page.evaluate(visible('.download-menu [data-get="pptx"]')), pptxBeside);
      if (pptxBeside) assert.equal(await page.locator('.download-menu [data-get="pptx"]').getAttribute('href'), pathToFileURL(join(dir, 'deck.pptx')).href);
      const html = page.locator('.download-menu [data-get="html"]');
      const href = (await html.getAttribute('href')) ?? '';
      assert.match(href, /^blob:/);
      assert.match((await html.getAttribute('download')) ?? '', /\.html$/);
      // The copy is the deck as it was opened: Edit and Download still hidden, as in the file.
      const saved = await page.evaluate(async (url) => (await fetch(url)).text(), href);
      assert.match(saved, /^<!doctype html>/);
      assert.match(saved, /<button class="download-button"[^>]*hidden/);
      assert.match(saved, /<button class="edit-button"[^>]*hidden/);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('no Download inside another page', async (t) => {
  const framed = await served(renderDeck(sample(), {}), false, true);
  if (!framed) return t.skip('no Chrome');
  try {
    const frame = framed.page.frames().find((f) => f.url().startsWith(SITE))!;
    assert.equal(await frame.evaluate(visible('.download-button')), false);
  } finally {
    await framed.browser.close();
  }
});

test('downloads are named after the product, the review and its dates, and the buttons are icons', async (t) => {
  const { fileName } = await import('../../src/deck/plan.ts');
  const review = { ...sample(), product: 'Excalidraw', organization: '', title: 'Sprint review', from: '2026-11-09', until: '2026-11-27' };
  assert.equal(fileName(review), 'excalidraw-sprint-review-2026-11-09-to-2026-11-27');
  assert.equal(fileName({ ...review, organization: 'Café Zoë' }), 'cafe-zoe-sprint-review-2026-11-09-to-2026-11-27', 'accents become plain letters');
  assert.equal(fileName({ ...review, product: 'the product' }), 'sprint-review-2026-11-09-to-2026-11-27', 'no placeholder name');
  const s = await served(renderDeck(review, {}), true);
  if (!s) return t.skip('no Chrome');
  try {
    for (const sel of ['.download-button']) {
      assert.equal(await s.page.locator(sel).getAttribute('aria-label'), 'Download');
      assert.equal((await s.page.locator(sel).innerText()).trim(), '', 'an icon, no words');
      assert.equal(await s.page.locator(`${sel} svg`).count(), 1);
    }
    await s.page.click('.download-button');
    assert.equal(await s.page.locator('.download-menu [data-get="pptx"]').getAttribute('download'), 'excalidraw-sprint-review-2026-11-09-to-2026-11-27.pptx');
    assert.equal(await s.page.locator('.download-menu [data-get="html"]').getAttribute('download'), 'excalidraw-sprint-review-2026-11-09-to-2026-11-27.html');
    // Save as PDF takes the page title as the file name.
    const titles = await s.page.evaluate(() => { const before = document.title; window.dispatchEvent(new Event('beforeprint')); const during = document.title; window.dispatchEvent(new Event('afterprint')); return [before, during, document.title]; });
    assert.deepEqual(titles, ['Sprint review · Excalidraw', 'excalidraw-sprint-review-2026-11-09-to-2026-11-27', 'Sprint review · Excalidraw']);
  } finally {
    await s.browser.close();
  }
});
