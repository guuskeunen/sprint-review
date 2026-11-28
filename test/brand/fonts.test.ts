import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fontFaceCss, fontFaces } from '../../src/brand/fonts.ts';
import { renderDeck } from '../../src/deck/render.ts';
import { sample } from '../helpers.ts';

test('brand font files go inside the deck, with their weight from the file name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprint-review-fonts-'));
  writeFileSync(join(dir, 'inter-latin-400-normal.woff2'), 'x');
  writeFileSync(join(dir, 'inter-latin-700-italic.woff2'), 'y');
  writeFileSync(join(dir, 'notes.txt'), 'z');
  const skipped: string[] = [];
  const faces = fontFaces({ Inter: ['inter-latin-400-normal.woff2', 'inter-latin-700-italic.woff2', 'notes.txt', 'gone.woff2'] }, dir, (m) => skipped.push(m));
  assert.deepEqual(faces.map((f) => [f.family, f.weight, f.style]), [['Inter', 400, 'normal'], ['Inter', 700, 'italic']]);
  assert.equal(skipped.length, 2);
  const html = renderDeck(sample(), { fonts: { body: 'Inter' }, fontFaces: faces });
  assert.match(html, /@font-face \{ font-family: "Inter"; font-weight: 700; font-style: italic; font-display: block; src: url\(data:font\/woff2;base64,/);
  assert.equal(fontFaceCss([{ family: 'X"}body{', weight: 400, style: 'normal', data: 'https://evil.test/f.woff2' }]), '', 'only font data URIs');
});

test('a variable font file covers its range of weights in one face', () => {
  const css = fontFaceCss([{ family: 'Inter', weight: 300, maxWeight: 800, style: 'normal', data: 'data:font/woff2;base64,AAAA' }]);
  assert.match(css, /font-weight: 300 800;/);
});
