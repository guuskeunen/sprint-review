import sharp from 'sharp';
import type { Device, Focus } from '../types.ts';

/** How far one color channel may differ before a pixel counts as changed. */
const TOLERANCE = 40;
/** Every second pixel is compared, so this many changed ones is a visible change. */
const MIN_CHANGED_PIXELS = 40;
const FOCUS_HEIGHT = 560;
const FOCUS_MIN_WIDTH = 820;
const FOCUS_MARGIN = 28;

export interface Comparison {
  changed: boolean;
  /** The part to show: the same area of both pictures, or both whole for a phone. */
  before: Buffer;
  after: Buffer;
  /** The changed area on the pictures shown, when it is small enough to be worth pointing at. */
  focus?: Focus;
}

/** Past this share of the picture, a frame around the change points at nothing in particular. */
const MAX_FOCUS_AREA = 0.6;

/** Unchanged rows that end the band where a change starts. */
const GAP = 24;
/** The band never takes more than this share of the picture's height. */
const MAX_BAND = 0.4;
/** A band with less than this share of all changed pixels (an icon that lost a letter) is passed over for a bigger one. */
const MIN_BAND_SHARE = 0.05;
/** A phone screen's height over its width: a full-page phone picture is cut to one screen around the change. */
const PHONE_SHAPE = 844 / 390;

type Rows = Map<number, [number, number, number]>;

/**
 * The rows where the change starts: the first band of changed rows (ended by a gap of unchanged
 * rows) that holds a fair share of all changed pixels. A new element pushes everything below it
 * down, so every row under it differs too; the first big band is usually the new element itself.
 */
function mainBand(rows: Rows, area: { y: number; h: number }): { y0: number; y1: number } | undefined {
  const ys = [...rows.keys()].filter((y) => y >= area.y && y < area.y + area.h).sort((a, b) => a - b);
  if (!ys.length) return undefined;
  const bands: { y0: number; y1: number; count: number }[] = [];
  for (const y of ys) {
    const band = bands.at(-1);
    if (band && y - band.y1 <= GAP && y - band.y0 <= area.h * MAX_BAND) {
      band.y1 = y;
      band.count += rows.get(y)![2];
    } else bands.push({ y0: y, y1: y, count: rows.get(y)![2] });
  }
  const total = bands.reduce((n, b) => n + b.count, 0);
  const band = bands.find((b) => b.count >= total * MIN_BAND_SHARE) ?? bands[0]!;
  return { y0: band.y0, y1: band.y1 };
}

/** The box around where the change starts (see mainBand), as fractions of the area shown, with a little room. */
function focusIn(rows: Rows, area: { x: number; y: number; w: number; h: number }): Focus | undefined {
  const band = mainBand(rows, area);
  if (!band) return undefined;
  const { y0, y1 } = band;
  let x0 = Infinity, x1 = -Infinity;
  for (const [y, [from, until]] of rows) {
    if (y < y0 || y > y1) continue;
    x0 = Math.min(x0, Math.max(from, area.x));
    x1 = Math.max(x1, Math.min(until, area.x + area.w - 1));
  }
  if (x0 > x1) return undefined;
  const pad = 14;
  const fx = Math.max(0, x0 - pad - area.x) / area.w;
  const fy = Math.max(0, y0 - pad - area.y) / area.h;
  const fw = Math.min(1 - fx, (x1 - x0 + 2 * pad) / area.w);
  const fh = Math.min(1 - fy, (y1 - y0 + 2 * pad) / area.h);
  if (fw * fh > MAX_FOCUS_AREA) return undefined;
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { x: r(fx), y: r(fy), w: r(fw), h: r(fh) };
}

export async function compareScreens(before: Buffer, after: Buffer, device: Device, ignore: { left: number; top: number }): Promise<Comparison | null> {
  // Taken at another sharpness (1x before, 2x after): compare at the after picture's scale.
  before = await sameScale(before, after);
  const [a, b] = await Promise.all([decode(before), decode(after)]);
  if (!a || !b) return null;

  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const left = device === 'desktop' ? ignore.left : 0;
  const top = ignore.top;

  let changed = 0;
  const rows: Rows = new Map();
  for (let y = top; y < height; y += 2) {
    for (let x = left; x < width; x += 2) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      if (
        Math.abs(a.data[i]! - b.data[j]!) > TOLERANCE ||
        Math.abs(a.data[i + 1]! - b.data[j + 1]!) > TOLERANCE ||
        Math.abs(a.data[i + 2]! - b.data[j + 2]!) > TOLERANCE
      ) {
        changed++;
        const row = rows.get(y);
        rows.set(y, row ? [Math.min(row[0], x), Math.max(row[1], x), row[2] + 1] : [x, x, 1]);
      }
    }
  }

  // A page that only grew or shrank below what both show did change, at its end.
  const grew = a.height !== b.height;
  if (changed < MIN_CHANGED_PIXELS && !grew) return { changed: false, before, after };
  const band = changed >= MIN_CHANGED_PIXELS ? mainBand(rows, { y: 0, h: b.height }) : undefined;
  if (!band) return { changed: true, before, after };

  if (device !== 'desktop') {
    // One phone screen around the change: it starts a little above it, and never runs past either picture.
    const height = Math.min(a.height, b.height, Math.round(width * PHONE_SHAPE));
    const windowTop = Math.max(0, Math.min(band.y0 - Math.round(height / 4), Math.min(a.height, b.height) - height));
    const [cropBefore, cropAfter] = await Promise.all([crop(before, a.height, 0, windowTop, width, height), crop(after, b.height, 0, windowTop, width, height)]);
    const shown = cropBefore && cropAfter ? { x: 0, y: windowTop, w: width, h: height } : { x: 0, y: 0, w: b.width, h: b.height };
    const focus = focusIn(rows, shown);
    return { changed: true, before: cropBefore && cropAfter ? cropBefore : before, after: cropBefore && cropAfter ? cropAfter : after, ...(focus ? { focus } : {}) };
  }

  const focusTop = Math.max(top, band.y0 - FOCUS_MARGIN);
  let from = width;
  let until = left;
  for (const [y, [rowFrom, rowUntil]] of rows) {
    if (y < focusTop + FOCUS_HEIGHT) {
      from = Math.min(from, rowFrom);
      until = Math.max(until, rowUntil);
    }
  }
  let x = Math.max(left, from - FOCUS_MARGIN);
  const focusWidth = Math.min(width - x, Math.max(FOCUS_MIN_WIDTH, until - x + FOCUS_MARGIN));
  if (x + focusWidth > width) x = Math.max(left, width - focusWidth);

  const [cropBefore, cropAfter] = await Promise.all([crop(before, a.height, x, focusTop, focusWidth), crop(after, b.height, x, focusTop, focusWidth)]);
  const shown = cropAfter ? { x, y: focusTop, w: focusWidth, h: Math.min(FOCUS_HEIGHT, b.height - focusTop) } : { x: 0, y: 0, w: b.width, h: b.height };
  const focus = focusIn(rows, shown);
  return { changed: true, before: cropBefore ?? before, after: cropAfter ?? after, ...(focus ? { focus } : {}) };
}

async function sameScale(before: Buffer, after: Buffer): Promise<Buffer> {
  try {
    const [m, n] = await Promise.all([sharp(before).metadata(), sharp(after).metadata()]);
    if (!m.width || !n.width || m.width === n.width) return before;
    const ratio = n.width / m.width;
    // Only a change of sharpness (about 2x or 0.5x), not a picture of another size.
    if (Math.abs(ratio - 2) > 0.05 && Math.abs(ratio - 0.5) > 0.02) return before;
    return await sharp(before).resize({ width: n.width }).png().toBuffer();
  } catch {
    return before;
  }
}

async function decode(png: Buffer): Promise<{ data: Buffer; width: number; height: number } | null> {
  try {
    const { data, info } = await sharp(png).removeAlpha().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

async function crop(png: Buffer, imageHeight: number, x: number, top: number, width: number, tall = FOCUS_HEIGHT): Promise<Buffer | null> {
  const height = Math.min(tall, imageHeight - top);
  if (height <= 0 || width <= 0) return null;
  try {
    return await sharp(png).extract({ left: x, top, width, height }).png({ compressionLevel: 9 }).toBuffer();
  } catch {
    return null;
  }
}
