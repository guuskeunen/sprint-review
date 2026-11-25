import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../../src/config.ts';
import { planDeck } from '../../src/deck/plan.ts';
import { validReview } from '../../src/review/review.ts';
import type { Review } from '../../src/types.ts';
import { sample } from '../helpers.ts';

const kinds = (r: Review, deck = normalize({}, '/tmp').deck) => planDeck(r, deck).map((s) => (s.kind === 'theme' ? `theme-${s.index}:${s.layout}${s.flip ? ':flip' : ''}` : s.kind));

test('the story: cover, headline, three theme slides, cards for the rest, then before and after, the rest and questions', () => {
  assert.deepEqual(kinds(sample()), ['cover', 'headline', 'theme-0:icon', 'theme-1:icon', 'theme-2:icon', 'cards', 'screen', 'screen', 'screen', 'hood', 'roadmap', 'usage', 'closing']);
});

test('density sets how many themes get a slide of their own; one theme left over gets its own slide too', () => {
  const brief = normalize({ deck: { density: 'brief' } }, '/tmp').deck;
  assert.deepEqual(planDeck(sample(), brief).filter((s) => s.kind === 'theme').length, 2);
  const r = sample();
  r.themes = r.themes.slice(0, 4);
  assert.ok(!kinds(r).includes('cards'), 'a shared slide with one card is never made');
  assert.equal(kinds(r).filter((k) => k.startsWith('theme-')).length, 4);
});

test('the same picture layout twice in a row is mirrored; a layout picked by hand wins', () => {
  const r = sample();
  const shot = { name: 'x', device: 'desktop' as const, image: r.screens[0]!.after };
  r.themes[0]!.screen = shot;
  r.themes[1]!.screen = shot;
  r.themes[2]!.screen = shot;
  r.themes[2]!.layout = 'full';
  r.themes[3]!.layout = 'card';
  assert.deepEqual(kinds(r).slice(2, 5), ['theme-0:split', 'theme-1:split:flip', 'theme-2:full']);
  const cards = planDeck(r).find((s) => s.kind === 'cards');
  assert.deepEqual(cards && cards.kind === 'cards' && cards.indexes, [3, 4]);
});

test('sections can be left out, and executives get the numbers first and no work they cannot see', () => {
  const off = normalize({ deck: { sections: { hood: false, roadmap: false, headline: false } } }, '/tmp').deck;
  const k = kinds(sample(), off);
  assert.ok(!k.includes('hood') && !k.includes('roadmap') && !k.includes('headline'));
  const exec = normalize({ audience: 'executives' }, '/tmp').deck;
  assert.deepEqual(kinds(sample(), exec).slice(0, 3), ['cover', 'headline', 'usage']);
  assert.ok(!kinds(sample(), exec).includes('hood'));
  assert.throws(() => normalize({ deck: { sections: { agenda: true } } }, '/tmp'), /not a section/);
  assert.throws(() => normalize({ deck: { density: 'huge' } }, '/tmp'), /brief, standard, detailed/);
});

test('the roadmap shows six milestones around where the team is', () => {
  const r = sample();
  r.milestones = Array.from({ length: 12 }, (_, i) => ({ text: `M${i}`, done: i < 8 }));
  const road = planDeck(r).find((s) => s.kind === 'roadmap');
  assert.deepEqual(road && road.kind === 'roadmap' && road.milestones.map((m) => m.text), ['M5', 'M6', 'M7', 'M8', 'M9', 'M10']);
});

test('a review from an older version still opens: the first summary point becomes the headline', () => {
  const { headline, questions, ...old } = sample();
  void headline;
  void questions;
  const v = validReview({ ...old, summary: [{ text: 'One page per customer', icon: 'users' }], underTheHood: ['Faster builds'] });
  assert.equal(v.headline, 'One page per customer');
  assert.deepEqual(v.questions, []);
  assert.deepEqual(v.underTheHood, [{ text: 'Faster builds', kind: 'maintenance' }]);
  assert.throws(() => validReview({ ...sample(), themes: [{ ...sample().themes[0], layout: 'diagonal' }] }), /layout/);
});

test('the audience sets the default density and has aliases; deck.density still wins', () => {
  assert.equal(normalize({ audience: 'executives' }, '/tmp').deck.density, 'brief');
  assert.equal(normalize({ audience: 'engineers' }, '/tmp').deck.density, 'detailed');
  assert.equal(normalize({ audience: 'Marketing' }, '/tmp').audience, normalize({ audience: 'business' }, '/tmp').audience);
  assert.equal(normalize({}, '/tmp').deck.density, 'standard');
  assert.equal(normalize({ audience: 'Our sales team' }, '/tmp').deck.density, 'standard', 'a description of your own keeps the default');
  assert.equal(normalize({ audience: 'executives', deck: { density: 'detailed' } }, '/tmp').deck.density, 'detailed');
});

test('a Now / Next roadmap shows two columns, only the lead of each item, and no other sections', async () => {
  const { parseRoadmap } = await import('../../src/git/history.ts');
  const { renderDeck } = await import('../../src/deck/render.ts');
  const items = parseRoadmap(`# Roadmap\n\n## Now\n\n### Area\n\n- **Weekly runs on a schedule.** Build it in this order: first...\n  1. *Automate.* details\n- Faster lead finder. With progress.\n\n## Next\n\n- **Tech stack from job posts**: more text\n\n## Tech debt\n\n- **Rename the module**\n`);
  assert.deepEqual(items, [
    { text: 'Weekly runs on a schedule', done: false, stage: 'now' },
    { text: 'Faster lead finder', done: false, stage: 'now' },
    { text: 'Tech stack from job posts', done: false, stage: 'next' },
  ]);
  const html = renderDeck({ ...sample(), milestones: items });
  assert.match(html, /What we are working on/);
  assert.match(html, /class="stage now[^"]*"/);
  assert.doesNotMatch(html, /milestones reached/);
  assert.equal(parseRoadmap('- [x] Done\n- [ ] Open\n## Now\n- **Ignored**').length, 2, 'a checklist wins');
});

test('you asked, we did comes before the themes, with the request quoted', async () => {
  const { renderDeck } = await import('../../src/deck/render.ts');
  const html = renderDeck({ ...sample(), answered: [{ ask: 'Can we see the phone number?', did: 'Leads now show a direct phone number' }] });
  assert.ok(html.indexOf('data-ref="answered"') < html.indexOf('data-ref="theme-0"'));
  assert.match(html, /<q>Can we see the phone number\?<\/q><span>Leads now show a direct phone number<\/span>/);
});

test('a small change gets a zoom step on its before and after slide; a wide one does not', async () => {
  const { renderDeck } = await import('../../src/deck/render.ts');
  const r = sample();
  r.screens[0]!.focus = { x: 0.6, y: 0.1, w: 0.25, h: 0.2 };
  r.screens[1]!.focus = { x: 0.02, y: 0.03, w: 0.96, h: 0.35 };
  const html = renderDeck(r);
  assert.match(html, /data-ref="screen-0" data-steps="1"/);
  assert.match(html, /--zx: 72.5%; --zy: 20%; --zs: 2.5; --tx: -22.5%; --ty: 30%;/);
  assert.doesNotMatch(html, /data-ref="screen-1" data-steps/);
});

/** The start of a PNG of this size: enough for the deck to read its shape. */
function pngOfSize(w: number, h: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return `data:image/png;base64,${b.toString('base64')}`;
}

test('a phone screen gets the frame, and a change across its whole row still zooms, from where the row starts', async () => {
  const { renderDeck } = await import('../../src/deck/render.ts');
  const r = sample();
  const phone = pngOfSize(390, 844);
  r.screens[0] = { ...r.screens[0]!, device: 'phone', before: phone, after: phone, focus: { x: 0.05, y: 0.23, w: 0.78, h: 0.06 } };
  const html = renderDeck(r);
  assert.match(html, /data-ref="screen-0" data-steps="1"/);
  assert.match(html, /<i class="focus" style="left: 5%; top: 23%; width: 78%; height: 6%">/);
  // Zoomed 2.13 times around the row's first 42%, not its middle, so its start stays in view.
  assert.match(html, /--zx: 26.1%; --zy: 26%; --zs: 2.13;/);
});

test('a full-page phone picture from an older review shows as before, without a frame or zoom', async () => {
  const { renderDeck } = await import('../../src/deck/render.ts');
  const r = sample();
  const tall = pngOfSize(390, 2400);
  r.screens[0] = { ...r.screens[0]!, device: 'phone', before: tall, after: tall, focus: { x: 0.05, y: 0.23, w: 0.78, h: 0.06 } };
  const html = renderDeck(r);
  assert.doesNotMatch(html, /data-ref="screen-0" data-steps/);
  assert.doesNotMatch(html, /data-ref="screen-0"[\s\S]*?class="focus"[\s\S]*?data-ref="screen-1"/);
});

test('a very wide picture (a strip of cards) gets the width of the slide; a layout picked by hand wins', async () => {
  const sharp = (await import('sharp')).default;
  const strip = `data:image/png;base64,${(await sharp({ create: { width: 1200, height: 100, channels: 3, background: '#eee' } }).png().toBuffer()).toString('base64')}`;
  const r = sample();
  r.themes[0]!.screen = { name: 'Contacts', device: 'desktop', image: strip };
  r.themes[1]!.screen = { name: 'Contacts', device: 'desktop', image: strip };
  r.themes[1]!.layout = 'split';
  assert.deepEqual(kinds(r).slice(2, 4), ['theme-0:full', 'theme-1:split']);
});

test('the cover title is the review, the period under it has the date, the product is the eyebrow', async () => {
  const { renderDeck } = await import('../../src/deck/render.ts');
  const html = renderDeck({ ...sample(), title: 'Sprint review', organization: 'Northside Cycles' });
  assert.match(html, /<p class="eyebrow rise">Northside Cycles<\/p>\s*<h1 class="rise"[^>]*>Sprint review<\/h1>/);
  assert.match(html, /<title>Sprint review · Northside Cycles<\/title>/);
});

test('a strip never goes on the cover, and keeps its points right under it', async () => {
  const sharp = (await import('sharp')).default;
  const png = async (width: number, height: number) => `data:image/png;base64,${(await sharp({ create: { width, height, channels: 3, background: '#eee' } }).png().toBuffer()).toString('base64')}`;
  const { coverPicture } = await import('../../src/deck/plan.ts');
  const { renderDeck } = await import('../../src/deck/render.ts');
  const r = sample();
  const strip = await png(1200, 100);
  const page = await png(1440, 900);
  r.themes[0]!.screen = { name: 'Contacts', device: 'desktop', image: strip };
  r.themes[1]!.screen = { name: 'Companies', device: 'desktop', image: page };
  assert.equal(coverPicture(r), page);
  assert.match(renderDeck(r), /class="slide theme layout-full strip" data-ref="theme-0"/);
  r.themes[1]!.screen = null;
  r.screens = [];
  assert.equal(coverPicture(r), null, 'only strips: the cover keeps its rings');
});

test('the roadmap slide shows what the sprint moved: each milestone with its themes, then the rest outside the roadmap', async () => {
  const { renderDeck } = await import('../../src/deck/render.ts');
  const { renderMarkdown } = await import('../../src/deck/markdown.ts');
  const r = sample();
  r.themes = r.themes.map((th, i) => ({ ...th, milestone: i === 0 || i === 3 ? 4 : i === 1 ? 2 : null }));
  const html = renderDeck(r);
  const slide = html.slice(html.indexOf('data-ref="roadmap"'));
  assert.match(slide, /<h2[^>]*>What this sprint moved<\/h2>/);
  assert.match(slide, /<li class="rise done"[^>]*><span>One customer page for online store, register and workshop<\/span><small>Repair ticket scanning<\/small><\/li>/);
  assert.match(slide, /<li class="rise "[^>]*><span>Text message when the bike is ready<\/span><small>Customer profile · Duplicate customers<\/small><\/li>/);
  assert.match(slide, /Outside the roadmap<\/span><span>Workshop planner · Look and feel<\/span>/);
  assert.match(slide, /4 of 6 milestones reached/);
  const text = renderMarkdown(r);
  assert.match(text, /What this sprint moved:\n\n- One customer page for online store, register and workshop: Repair ticket scanning\n- Text message when the bike is ready: Customer profile, Duplicate customers/);
  assert.match(text, /Outside the roadmap: Workshop planner, Look and feel/);
});

test('a sprint that moved no milestone keeps the timeline, and names its work outside the roadmap', async () => {
  const { renderDeck } = await import('../../src/deck/render.ts');
  const r = sample();
  r.themes = r.themes.map((th) => ({ ...th, milestone: null }));
  const html = renderDeck(r);
  const slide = html.slice(html.indexOf('data-ref="roadmap"'));
  assert.match(slide, /<ol class="timeline"/);
  assert.match(slide, /Outside the roadmap<\/span><span>Customer profile · Repair ticket scanning/);
});

test('an older review without milestones on its themes shows the roadmap as before', async () => {
  const { renderDeck } = await import('../../src/deck/render.ts');
  const html = renderDeck(sample());
  const slide = html.slice(html.indexOf('data-ref="roadmap"'));
  assert.match(slide, /<ol class="timeline"/);
  assert.doesNotMatch(slide.slice(0, slide.indexOf('</section>')), /Outside the roadmap/);
});
