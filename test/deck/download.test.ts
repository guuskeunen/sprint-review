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

test('the deck opened from your own disk offers Download beside Edit: PDF, and PowerPoint when one was written', async (t) => {
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
      assert.equal(await page.evaluate(visible('.download-menu [data-get="html"]')), false, 'the open file is the HTML already');
      assert.equal(await page.evaluate(visible('.download-menu [data-get="pptx"]')), pptxBeside);
      if (pptxBeside) assert.equal(await page.locator('.download-menu [data-get="pptx"]').getAttribute('href'), pathToFileURL(join(dir, 'deck.pptx')).href);
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
