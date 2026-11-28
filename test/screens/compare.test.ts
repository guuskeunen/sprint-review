import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareScreens } from '../../src/screens/compare.ts';

const png = (name: string) => readFileSync(new URL(`../fixtures/screens/${name}.png`, import.meta.url));

test('the comparison finds where a change starts: the new progress bar, not the rows it pushed down', async () => {
  const cmp = await compareScreens(png('planner-desktop.before'), png('planner-desktop.after'), 'desktop', { left: 0, top: 0 });
  assert.ok(cmp?.changed && cmp.focus);
  assert.ok(cmp.focus.y < 0.1 && cmp.focus.h < 0.4, `framed ${JSON.stringify(cmp.focus)}`);
  for (const k of ['x', 'y', 'w', 'h'] as const) assert.ok(cmp.focus[k] >= 0 && cmp.focus[k] <= 1);
});

test('the same picture twice has nothing to frame', async () => {
  const cmp = await compareScreens(png('planner-desktop.after'), png('planner-desktop.after'), 'desktop', { left: 0, top: 0 });
  assert.equal(cmp?.changed, false);
  assert.equal(cmp?.focus, undefined);
});

test('a picture taken at twice the sharpness is not a change', async () => {
  const sharp = (await import('sharp')).default;
  const before = png('planner-desktop.before');
  const { width } = await sharp(before).metadata();
  const sharper = await sharp(before).resize({ width: width! * 2 }).png().toBuffer();
  const cmp = await compareScreens(before, sharper, 'desktop', { left: 0, top: 0 });
  assert.equal(cmp?.changed, false);
});

/** A white page with dark boxes on it, as a PNG. */
async function page(width: number, height: number, boxes: { x: number; y: number; w: number; h: number }[]): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/>${boxes.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#123"/>`).join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

test('a tiny change above the real one (an icon that lost a letter) is passed over', async () => {
  const before = await page(1440, 1600, []);
  const after = await page(1440, 1600, [{ x: 300, y: 60, w: 6, h: 6 }, { x: 200, y: 700, w: 500, h: 160 }]);
  const cmp = await compareScreens(before, after, 'desktop', { left: 0, top: 0 });
  assert.ok(cmp?.changed && cmp.focus, 'a frame');
  // The crop starts at the big change, which sits at its top, framed whole.
  const sharp = (await import('sharp')).default;
  const shown = await sharp(cmp.after).metadata();
  const top = 700 - 28;
  const y = (700 - 14 - top) / shown.height!;
  assert.ok(Math.abs(cmp.focus.y - y) < 0.02, `framed ${JSON.stringify(cmp.focus)}`);
  assert.ok(cmp.focus.h > 0.25, `framed ${JSON.stringify(cmp.focus)}`);
});

test('a phone shows one phone screen around the change, with the frame on it', async () => {
  const before = await page(390, 2400, []);
  const after = await page(390, 2400, [{ x: 40, y: 1500, w: 300, h: 60 }]);
  const cmp = await compareScreens(before, after, 'phone', { left: 0, top: 0 });
  assert.ok(cmp?.changed && cmp.focus, 'a frame');
  const sharp = (await import('sharp')).default;
  for (const shot of [cmp.before, cmp.after]) {
    const m = await sharp(shot).metadata();
    assert.deepEqual([m.width, m.height], [390, 844]);
  }
  // The change sits a quarter down the screen, where the frame is.
  assert.ok(Math.abs(cmp.focus.y - (211 - 14) / 844) < 0.02, `framed ${JSON.stringify(cmp.focus)}`);
  assert.ok(cmp.focus.w < 1 && cmp.focus.h < 0.2, `framed ${JSON.stringify(cmp.focus)}`);
});
