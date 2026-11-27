import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize } from '../../src/config.ts';
import { startEditor, validReview } from '../../src/surfaces/editor.ts';
import type { Review } from '../../src/types.ts';
import { sample } from '../helpers.ts';

test('the editor serves the form, previews, saves and rebuilds, and refuses requests without its token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-'));
  const file = join(dir, 'review.json');
  writeFileSync(file, JSON.stringify(sample()));
  const editor = await startEditor(file, normalize({}, dir), 0);
  try {
    const page = await (await fetch(editor.url)).text();
    const token = /"token":"([^"]+)"/.exec(page)?.[1];
    assert.ok(token);
    assert.equal((await fetch(`${editor.url}api/review`)).status, 403);
    const headers = { 'x-sprint-review-token': token!, 'content-type': 'application/json' };
    const review = (await (await fetch(`${editor.url}api/review`, { headers })).json()) as Review;
    review.themes[0]!.title = 'Customer page';
    const preview = await (await fetch(`${editor.url}api/preview`, { method: 'POST', headers, body: JSON.stringify(review) })).text();
    assert.match(preview, /Customer page/);
    const saved = await fetch(`${editor.url}api/review`, { method: 'PUT', headers, body: JSON.stringify(review) });
    assert.equal(saved.status, 200);
    assert.equal((JSON.parse(readFileSync(file, 'utf8')) as Review).themes[0]!.title, 'Customer page');
    assert.match(readFileSync(join(dir, 'deck.html'), 'utf8'), /Customer page/);
    const bad = await fetch(`${editor.url}api/review`, { method: 'PUT', headers, body: '{"version":2}' });
    assert.equal(bad.status, 400);
  } finally {
    await editor.close();
  }
});

test('the live view shows each edit and the slide being edited, before anything is saved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-'));
  const file = join(dir, 'review.json');
  writeFileSync(file, JSON.stringify(sample()));
  const editor = await startEditor(file, normalize({}, dir), 0);
  const stop = new AbortController();
  try {
    const token = /"token":"([^"]+)"/.exec(await (await fetch(editor.url)).text())![1]!;
    assert.equal((await fetch(`${editor.url}live`)).status, 403);
    assert.match(await (await fetch(`${editor.url}live?token=${token}`)).text(), /EventSource/);
    assert.equal((await fetch(`${editor.url}api/events`)).status, 403);

    const events = await fetch(`${editor.url}api/events?token=${token}`, { signal: stop.signal });
    assert.match(events.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = events.body!.getReader();
    let seen = '';
    const until = async (re: RegExp) => {
      while (!re.test(seen)) seen += new TextDecoder().decode((await reader.read()).value);
    };
    await until(/event: deck/);
    const headers = { 'x-sprint-review-token': token, 'content-type': 'application/json' };
    const review = sample();
    review.themes[0]!.title = 'Typed just now';
    await fetch(`${editor.url}api/preview`, { method: 'POST', headers, body: JSON.stringify(review) });
    await until(/Typed just now/);
    await fetch(`${editor.url}api/slide`, { method: 'POST', headers, body: JSON.stringify({ n: 4 }) });
    await until(/event: slide\ndata: \{"n":4\}/);
    assert.notEqual((JSON.parse(readFileSync(file, 'utf8')) as Review).themes[0]!.title, 'Typed just now', 'nothing is saved');
  } finally {
    stop.abort();
    await editor.close();
  }
});

test('validReview drops empty lines and refuses a broken review', () => {
  const r = sample();
  r.themes[0]!.points.push('  ');
  r.underTheHood.push({ text: '', kind: 'speed' });
  const v = validReview(r);
  assert.ok(v.themes[0]!.points.every((p) => p.trim()));
  assert.ok(v.underTheHood.every((p) => p.text.trim()));
  assert.throws(() => validReview({ ...r, themes: [{ title: 1 }] }), /theme/);
});

test('the editor downloads the saved review as a PDF page, a PowerPoint and an HTML file, only with its token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-'));
  const file = join(dir, 'review.json');
  writeFileSync(file, JSON.stringify(sample()));
  const editor = await startEditor(file, normalize({}, dir), 0);
  try {
    const page = await (await fetch(editor.url)).text();
    assert.match(page, /id="download"/);
    const token = encodeURIComponent(/"token":"([^"]+)"/.exec(page)![1]!);
    for (const kind of ['pdf', 'pptx', 'html']) assert.equal((await fetch(`${editor.url}download/${kind}`)).status, 403, kind);
    const until = sample().until;
    const pptx = await fetch(`${editor.url}download/pptx?token=${token}`);
    assert.equal(pptx.status, 200);
    assert.match(pptx.headers.get('content-disposition') ?? '', new RegExp(`attachment; filename="sprint-review-${until}\\.pptx"`));
    assert.equal(Buffer.from(await pptx.arrayBuffer()).subarray(0, 2).toString(), 'PK', 'a PowerPoint is a zip');
    const html = await fetch(`${editor.url}download/html?token=${token}`);
    assert.match(html.headers.get('content-disposition') ?? '', /attachment; filename=".*\.html"/);
    assert.match(await html.text(), /<section class="slide/);
    const pdf = await (await fetch(`${editor.url}download/pdf?token=${token}`)).text();
    assert.match(pdf, /window\.print\(\)/);
  } finally {
    await editor.close();
  }
});
