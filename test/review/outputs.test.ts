import { test } from 'node:test';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize } from '../../src/config.ts';
import { renderDeck } from '../../src/deck/render.ts';
import { readZip } from '../../src/brand/zip.ts';
import { renderPptx } from '../../src/deck/pptx.ts';
import { planDeck } from '../../src/deck/plan.ts';
import { writeOutputs } from '../../src/review/output.ts';
import { sample } from '../helpers.ts';

test('the review exports to an editable PowerPoint with speaker notes', async () => {
  const review = sample();
  const buf = await renderPptx(review, { color: '#ea580c' });
  const entries = readZip(buf);
  const slides = [...entries.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
  assert.equal(slides.length, planDeck(review).length, 'the same slides as the HTML deck');
  const all = slides.map((k) => entries.get(k)!().toString('utf8')).join('');
  for (const t of review.themes) assert.ok(all.includes(t.title.replace(/&/g, '&amp;')), t.title);
  const notes = [...entries.keys()].filter((k) => /notesSlide\d+\.xml$/.test(k)).map((k) => entries.get(k)!().toString('utf8')).join('');
  assert.ok(notes.includes(review.themes[0]!.notes!.slice(0, 30)));
});

test('a brand font falls back to a sans-serif stack, never to a variable that points at itself', () => {
  const html = renderDeck(sample(), { fonts: { heading: 'Space Grotesk', body: 'Inter' } });
  const body = /--font-body: ([^;]+);/.exec(html.slice(html.indexOf('html[data-theme] {')))![1]!;
  assert.ok(body.startsWith('"Inter", '));
  assert.doesNotMatch(body, /var\(--font-body/);
  assert.match(body, /sans-serif$/);
});

test('the deck has an Edit button, shown only when opened from disk, in the deck\'s language', () => {
  const html = renderDeck(sample(), {});
  assert.match(html, /<button class="edit-button" type="button" aria-label="Edit" title="Edit" hidden><svg class="icon"/);
  assert.match(html, /location\.protocol === 'file:' && window\.parent === window/);
  assert.match(renderDeck({ ...sample(), language: 'Dutch' }, {}), /class="edit-button" type="button" aria-label="Bewerken"/);
  for (const script of html.match(/<script>([\s\S]*?)<\/script>/g) ?? []) assert.doesNotThrow(() => new Function(script.slice(8, -9)), 'the deck script compiles');
});

test('a square logo stays square on the PowerPoint cover', async () => {
  const square = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#123456' } }).png().toBuffer();
  const buf = await renderPptx(sample(), { logo: `data:image/png;base64,${square.toString('base64')}` });
  const cover = readZip(buf).get('ppt/slides/slide1.xml')!().toString('utf8');
  // The cover also carries the product screenshot; the logo is the small picture.
  const pics = [...cover.matchAll(/<p:pic>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
  const logo = pics.reduce((a, b) => (b[0] < a[0] ? b : a));
  assert.equal(logo[0], logo[1]);
});

test('render --pptx rebuilds the PowerPoint too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rerender-'));
  writeFileSync(join(dir, 'review.json'), JSON.stringify(sample()));
  const cli = new URL('../../src/cli.ts', import.meta.url).pathname;
  const out = execFileSync('node', [cli, 'render', join(dir, 'review.json'), '--pptx'], { cwd: dir }).toString();
  assert.ok(existsSync(join(dir, 'deck.pptx')), out);
  assert.match(out, /deck\.pptx/);
});

test('writeOutputs writes the .pptx by default when pptxgenjs is installed, and not when it is turned off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'out-'));
  const c = normalize({}, dir);
  assert.equal(c.output.pptx, 'auto');
  assert.equal(normalize({ output: { pptx: 'auto' } }, dir).output.pptx, 'auto');
  assert.throws(() => normalize({ output: { pptx: 'sometimes' } }, dir), /output\.pptx/);
  const a = await writeOutputs(sample(), c, join(dir, 'a'));
  assert.ok(a.pptx && existsSync(a.pptx), 'pptxgenjs is a dev dependency here, so auto writes it');
  assert.match(readFileSync(a.deck, 'utf8'), /role="menu"[^>]*data-pptx-beside/, 'the deck offers the PowerPoint it was written with');
  const off = await writeOutputs(sample(), normalize({ output: { pptx: false } }, dir), join(dir, 'off'));
  assert.equal(off.pptx, null);
  assert.doesNotMatch(readFileSync(off.deck, 'utf8'), /role="menu"[^>]*data-pptx-beside/);
  const asked = await writeOutputs(sample(), normalize({ output: { pptx: false } }, dir), join(dir, 'asked'), { pptx: true });
  assert.ok(asked.pptx && existsSync(asked.pptx), '--pptx wins over the config');
});

test('without an organization the PowerPoint cover and the summary name the product too', async () => {
  const { renderMarkdown } = await import('../../src/deck/markdown.ts');
  const review = { ...sample(), organization: '', product: 'Excalidraw' };
  const cover = readZip(await renderPptx(review)).get('ppt/slides/slide1.xml')!().toString('utf8');
  assert.match(cover, /<a:t>EXCALIDRAW<\/a:t>|<a:t>Excalidraw<\/a:t>/);
  assert.match(renderMarkdown(review), /^_.* · Excalidraw_$/m);
});

/** The text of each slide of a PowerPoint, in order. */
async function slideTexts(review: ReturnType<typeof sample>): Promise<string[]> {
  const entries = readZip(await renderPptx(review));
  const n = [...entries.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).length;
  return Array.from({ length: n }, (_, i) => entries.get(`ppt/slides/slide${i + 1}.xml`)!().toString('utf8'));
}

test('the PowerPoint roadmap shows what the sprint moved and the work outside the roadmap, as the deck does', async () => {
  const r = sample();
  r.themes = r.themes.map((th, i) => ({ ...th, milestone: i === 0 || i === 3 ? 4 : i === 1 ? 2 : null }));
  const roadmap = (await slideTexts(r)).find((x) => x.includes('>Roadmap<') || x.includes('>ROADMAP<'))!;
  assert.match(roadmap, /What this sprint moved/);
  assert.match(roadmap, /Text message when the bike is ready/);
  assert.match(roadmap, /Customer profile · Duplicate customers/);
  assert.match(roadmap, /Outside the roadmap/i);
  assert.match(roadmap, /Workshop planner · Look and feel/);
  assert.match(roadmap, /4 of 6 milestones reached/);
});

test('the PowerPoint frames the change on a phone picture too', async () => {
  const r = sample();
  const phone = `data:image/png;base64,${(await sharp({ create: { width: 390, height: 844, channels: 3, background: '#ffffff' } }).png().toBuffer()).toString('base64')}`;
  r.screens = [{ ...r.screens[0]!, device: 'phone', before: phone, after: phone, focus: { x: 0.05, y: 0.23, w: 0.78, h: 0.06 } }];
  const slide = (await slideTexts(r)).find((x) => x.includes(r.screens[0]!.caption ?? r.screens[0]!.name))!;
  assert.match(slide, /prst="roundRect"[\s\S]*?<a:ln w="28575">/);
});
