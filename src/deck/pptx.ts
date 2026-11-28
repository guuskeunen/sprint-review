import type { Review } from '../types.ts';
import { fill, labelsFor, localeOf, type Labels } from './i18n.ts';
import sharp from 'sharp';
// Types only: erased from the build, so pptxgenjs stays an optional peer.
type PptxClass = (typeof import('pptxgenjs'))['default'];
type Slide = ReturnType<InstanceType<PptxClass>['addSlide']>;
import { coverPicture, numbers, planDeck, roadmapMoves } from './plan.ts';
import type { DeckConfig } from '../config.ts';
import { readableOn } from './colors.ts';
import { imageSize } from './images.ts';
import { change } from './numbers.ts';

export class PptxError extends Error {}

export interface PptxOptions {
  color?: string | null;
  logo?: string | null;
  labels?: Record<string, string>;
  goal?: string | null;
  theme?: 'dark' | 'light';
  fonts?: { heading?: string | null; body?: string | null };
  deck?: DeckConfig;
}

/** Place a picture inside a box: whole and centered (fit), or filling it from the top (cover). */
function place(uri: string, box: { x: number; y: number; w: number; h: number }, mode: 'fit' | 'cover') {
  const size = imageSize(uri);
  if (!size) return { data: uri, ...box };
  const ratio = size.w / size.h;
  if (mode === 'cover') {
    const h = Math.min(box.h, box.w / ratio);
    return { data: uri, x: box.x, y: box.y, w: box.w, h: box.w / ratio, sizing: { type: 'crop' as const, x: 0, y: 0, w: box.w, h } };
  }
  const w = Math.min(box.w, box.h * ratio);
  const h = w / ratio;
  return { data: uri, x: box.x + (box.w - w) / 2, y: box.y, w, h };
}

const PALETTES = {
  dark: { bg: '0A0A0D', ink: 'F4EFE6', soft: 'B8B1A4', faint: '7D776D', panel: '15151A', line: '2A2A30', accent: 'D6B36A' },
  light: { bg: 'FFFFFF', ink: '0F172A', soft: '475569', faint: '94A3B8', panel: 'F8FAFC', line: 'E2E8F0', accent: '4F46E5' },
};

/**
 * The same review as an editable PowerPoint file, for teams that present from PowerPoint or
 * Keynote or want to add a slide by hand. Speaker notes go into the notes pane. Simpler than the
 * HTML deck (no motion), but every word and picture is there.
 */
export async function renderPptx(review: Review, options: PptxOptions = {}): Promise<Buffer> {
  let PptxGenJS: PptxClass;
  try {
    PptxGenJS = ((await import('pptxgenjs' as string)) as { default: PptxClass }).default;
  } catch {
    throw new PptxError('PowerPoint export needs pptxgenjs: npm install --save-dev pptxgenjs');
  }
  const t = labelsFor(review.language, options.labels);
  const pal = { ...PALETTES[options.theme === 'dark' ? 'dark' : 'light'] };
  if (options.color && /^#[0-9a-fA-F]{6}$/.test(options.color)) pal.accent = readableOn(options.color, `#${pal.bg}`).slice(1).toUpperCase();
  const heading = options.fonts?.heading ?? (options.theme === 'dark' ? 'Georgia' : 'Calibri');
  const body = options.fonts?.body ?? 'Calibri';
  const nf = new Intl.NumberFormat(localeOf(review.language));

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.title = review.title;
  if (review.organization) pptx.company = review.organization;
  pptx.theme = { headFontFace: heading, bodyFontFace: body };

  // The deck's type scale in points (1 pt is 2 px at 1920 x 1080) and its margins.
  const SIZE = { display: 60, title: 32, body: 18, small: 12 };
  const W = 13.33;
  const X = 1.07;
  const TOP = 0.68;
  const BODY_Y = 2.55;
  const BODY_H = 7.5 - BODY_Y - 0.8;
  const CW = W - 2 * X;
  const newSlide = (notes?: string | null) => {
    const s = pptx.addSlide();
    s.background = { color: pal.bg };
    if (notes) s.addNotes(notes);
    return s;
  };
  const eyebrow = (s: Slide, text: string, y = TOP) =>
    s.addText(text.toUpperCase(), { x: X, y, w: CW, h: 0.35, fontFace: body, fontSize: SIZE.small, bold: true, color: pal.accent, charSpacing: 3, margin: 0 });
  const head = (s: Slide, label: string, title: string) => {
    eyebrow(s, label);
    s.addText(title, { x: X, y: TOP + 0.4, w: Math.min(CW, 10.5), h: 1.3, fontFace: heading, fontSize: SIZE.title, bold: true, color: pal.ink, valign: 'top', margin: 0 });
  };
  const points = (s: Slide, items: string[], x: number, y: number, w: number, h = BODY_H) =>
    items.length &&
    s.addText(
      items.map((text, i) => ({ text, options: { breakLine: i < items.length - 1, paraSpaceAfter: 14 } })),
      { x, y, w, h, fontFace: body, fontSize: SIZE.body, color: pal.ink, valign: 'top', margin: 0 },
    );
  const logoAt = async (s: Slide) => {
    if (options.logo) s.addImage({ data: options.logo, x: X, y: TOP, ...(await logoBox(options.logo, 2.2, 0.7)) });
  };

  for (const p of planDeck(review, options.deck)) {
    switch (p.kind) {
      case 'cover': {
        const s = newSlide();
        const hero = coverPicture(review);
        if (hero) s.addImage(place(hero, { x: 7.0, y: 1.2, w: 6.33, h: 5.0 }, 'cover'));
        await logoAt(s);
        if (review.organization) eyebrow(s, review.organization, 2.2);
        s.addText(review.title, { x: X, y: 2.6, w: hero ? 5.6 : CW, h: 2.6, fontFace: heading, fontSize: hero ? SIZE.title + 12 : SIZE.display, bold: true, color: pal.ink, valign: 'top', margin: 0 });
        s.addText(review.period, { x: X, y: 4.75, w: CW, h: 0.5, fontFace: body, fontSize: SIZE.body, color: pal.soft, margin: 0 });
        if (options.goal) s.addText(`${t.goalLabel.toUpperCase()}   ${options.goal}`, { x: X, y: 5.5, w: 8, h: 0.5, fontFace: body, fontSize: SIZE.small, color: pal.ink, fill: { color: pal.panel }, line: { color: pal.line } });
        break;
      }
      case 'headline': {
        const s = newSlide(review.summaryNotes);
        eyebrow(s, t.summaryTitle, 1.4);
        s.addText(review.headline ?? '', { x: X, y: 1.85, w: 10.5, h: 3.2, fontFace: heading, fontSize: SIZE.display, bold: true, color: pal.ink, valign: 'top', margin: 0 });
        s.addText(review.themes.map((th) => th.title).join('     '), { x: X, y: 5.5, w: CW, h: 0.5, fontFace: body, fontSize: SIZE.small, color: pal.soft, margin: 0 });
        break;
      }
      case 'answered': {
        const s = newSlide();
        head(s, t.answeredLabel, t.answeredTitle);
        review.answered!.forEach((a, i) => {
          const y = BODY_Y + i * 1.3;
          s.addText(`“${a.ask}”`, { x: X, y, w: 10, h: 0.45, fontFace: body, fontSize: SIZE.small, color: pal.faint, margin: 0 });
          s.addText(a.did, { x: X, y: y + 0.45, w: 10, h: 0.7, fontFace: body, fontSize: SIZE.body, color: pal.ink, valign: 'top', margin: 0 });
        });
        break;
      }
      case 'lastTime': {
        const said = review.lastTime!;
        const s = newSlide();
        head(s, t.lastTimeLabel, fill(t.lastTimeTitle, { n: said.items.filter((m) => m.done).length, total: said.items.length }));
        said.items.forEach((m, i) => {
          const y = BODY_Y + i * 0.85;
          s.addText((m.done ? t.statusDone : t.statusOpen).toUpperCase(), { x: X, y, w: 1.7, h: 0.8, fontFace: body, fontSize: SIZE.small, bold: true, color: m.done ? '059669' : pal.faint, charSpacing: 2, valign: 'top', margin: 0 });
          s.addText(m.text, { x: X + 1.8, y, w: Math.min(CW - 1.8, 8.5), h: 0.8, fontFace: body, fontSize: SIZE.body, color: pal.ink, valign: 'top', margin: 0 });
        });
        break;
      }
      case 'theme': {
        const th = review.themes[p.index]!;
        const s = newSlide(th.notes);
        const chip = th.value ? `   ·   ${t[`value_${th.value}` as keyof Labels] ?? th.value}` : '';
        head(s, `${th.title}${chip}`, th.effect ?? th.title);
        const pic = th.screen;
        if (!pic || p.layout === 'icon') points(s, th.points, X, BODY_Y, Math.min(CW, 9));
        else if (p.layout === 'full') {
          s.addImage(place(pic.image, { x: X, y: BODY_Y, w: CW, h: BODY_H - 0.9 }, 'cover'));
          const n = th.points.length;
          const w = (CW - 0.3 * (n - 1)) / Math.max(1, n);
          th.points.forEach((text, i) => s.addText(text, { x: X + i * (w + 0.3), y: 7.5 - 0.8 - 0.75, w, h: 0.75, fontFace: body, fontSize: SIZE.small, color: pal.soft, valign: 'top', margin: 0 }));
        } else {
          const textW = p.layout === 'phone' ? 6.6 : 4.5;
          const picW = CW - textW - 0.5;
          const [tx, px] = p.flip ? [X + picW + 0.5, X] : [X, X + textW + 0.5];
          points(s, th.points, tx, BODY_Y, textW);
          s.addImage(place(pic.image, { x: px, y: BODY_Y, w: picW, h: BODY_H }, p.layout === 'phone' ? 'fit' : 'cover'));
        }
        break;
      }
      case 'cards': {
        const themes = p.indexes.map((i) => review.themes[i]!);
        const s = newSlide(themes.map((th) => [th.title, ...th.points].join(': ')).join('\n'));
        head(s, t.moreLabel, t.moreTitle);
        const perRow = Math.min(3, themes.length);
        const rows = Math.ceil(themes.length / perRow);
        const w = (CW - 0.3 * (perRow - 1)) / perRow;
        const h = (BODY_H - 0.3 * (rows - 1)) / rows;
        themes.forEach((th, i) => {
          const x = X + (i % perRow) * (w + 0.3);
          const y = BODY_Y + Math.floor(i / perRow) * (h + 0.3);
          s.addShape('roundRect', { x, y, w, h, fill: { color: pal.panel }, line: { color: pal.line }, rectRadius: 0.12 });
          s.addText(th.title, { x: x + 0.3, y: y + 0.3, w: w - 0.6, h: 0.5, fontFace: heading, fontSize: SIZE.body, bold: true, color: pal.ink, margin: 0 });
          if (th.effect) s.addText(th.effect, { x: x + 0.3, y: y + 0.85, w: w - 0.6, h: h - 1.1, fontFace: body, fontSize: SIZE.small, color: pal.soft, valign: 'top', margin: 0 });
        });
        break;
      }
      case 'screen': {
        const sc = review.screens[p.index]!;
        const s = newSlide();
        head(s, sc.name, sc.caption ?? sc.name);
        const w = (CW - 0.4) / 2;
        for (const [i, side] of (['before', 'after'] as const).entries()) {
          const x = X + i * (w + 0.4);
          s.addText((side === 'before' ? t.before : t.after).toUpperCase(), { x, y: BODY_Y, w, h: 0.3, fontFace: body, fontSize: SIZE.small, bold: true, color: side === 'after' ? pal.accent : pal.faint, charSpacing: 3, margin: 0 });
          const pic = place(sc[side], { x, y: BODY_Y + 0.45, w, h: BODY_H - 0.45 }, sc.device === 'phone' ? 'fit' : 'cover');
          s.addImage(pic);
          // The change, framed on the after picture where it falls inside what is shown.
          const f = side === 'after' ? sc.focus : undefined;
          const shown = 'sizing' in pic && pic.sizing ? pic.sizing.h : pic.h;
          // A phone picture is shown whole, so the frame lands on the change there too.
          if (f && (f.y + f.h) * pic.h <= shown) {
            s.addShape('roundRect', { x: pic.x + f.x * pic.w, y: pic.y + f.y * pic.h, w: f.w * pic.w, h: f.h * pic.h, fill: { type: 'none' }, line: { color: pal.accent, width: 2.25 }, rectRadius: 0.06 });
          }
        }
        break;
      }
      case 'hood': {
        const s = newSlide();
        head(s, t.hoodLabel, t.hoodTitle);
        const rowH = Math.min(0.85, BODY_H / review.underTheHood.length);
        const kindOf = (x: (typeof review.underTheHood)[number]) => (t[`kind_${x.kind}` as keyof Labels] ?? x.kind).toUpperCase();
        // The label column is as wide as the longest label (about 0.13 inch a letter at this size and spacing).
        const labelW = Math.min(3.2, Math.max(1.9, Math.max(...review.underTheHood.map((x) => kindOf(x).length)) * 0.13 + 0.2));
        review.underTheHood.forEach((x, i) => {
          const y = BODY_Y + i * rowH;
          s.addText(kindOf(x), { x: X, y, w: labelW, h: rowH, fontFace: body, fontSize: SIZE.small, bold: true, color: pal.faint, charSpacing: 2, valign: 'top', margin: 0 });
          s.addText(x.text, { x: X + labelW + 0.1, y, w: Math.min(CW - labelW - 0.1, 8.5), h: rowH, fontFace: body, fontSize: SIZE.body, color: pal.ink, valign: 'top', margin: 0 });
        });
        break;
      }
      case 'roadmap': {
        const s = newSlide();
        if (p.milestones.some((m) => m.stage)) {
          head(s, t.roadmapLabel, t.roadmapPlanTitle);
          (['now', 'next'] as const).forEach((stage, i) => {
            const items = p.milestones.filter((m) => m.stage === stage);
            if (!items.length) return;
            const x = X + i * 5.2;
            s.addText((stage === 'now' ? t.roadmapNow : t.roadmapNext).toUpperCase(), { x, y: BODY_Y, w: 4.8, h: 0.35, fontFace: body, fontSize: SIZE.small, bold: true, color: stage === 'now' ? pal.accent : pal.faint, charSpacing: 3, margin: 0 });
            s.addText(
              items.map((m, j) => ({ text: m.text, options: { breakLine: j < items.length - 1, paraSpaceAfter: 14 } })),
              { x, y: BODY_Y + 0.5, w: 4.8, h: BODY_H - 0.5, fontFace: body, fontSize: SIZE.body, color: pal.ink, valign: 'top', margin: 0 },
            );
          });
          break;
        }
        const reached = review.milestones.filter((m) => m.done).length;
        const count = fill(t.roadmapReached, { n: reached, total: review.milestones.length });
        const { moved, outside } = roadmapMoves(review);
        const small = { fontFace: body, fontSize: SIZE.small, color: pal.faint, margin: 0 } as const;
        const outsideAt = (y: number) => {
          if (!outside.length) return;
          s.addText(t.roadmapOutside.toUpperCase(), { ...small, x: X, y, w: 2.6, h: 0.35, bold: true, charSpacing: 2 });
          s.addText(outside.join(' · '), { ...small, x: X + 2.7, y, w: CW - 2.7, h: 0.35 });
        };
        if (moved.length) {
          // What the sprint moved: each milestone with the themes that moved it, then the rest and the count.
          head(s, t.roadmapLabel, t.roadmapMoved);
          const rowH = Math.min(0.95, (BODY_H - 1.1) / moved.length);
          moved.forEach((x, i) => {
            const y = BODY_Y + i * rowH;
            s.addShape('ellipse', { x: X, y: y + 0.07, w: 0.22, h: 0.22, fill: { color: x.milestone.done ? pal.accent : pal.bg }, line: { color: pal.accent, width: 2 } });
            s.addText(x.milestone.text, { x: X + 0.45, y, w: CW - 0.45, h: 0.38, fontFace: body, fontSize: SIZE.body, color: pal.ink, margin: 0 });
            s.addText(x.themes.join(' · '), { ...small, x: X + 0.45, y: y + 0.4, w: CW - 0.45, h: 0.3 });
          });
          const after = BODY_Y + moved.length * rowH + 0.25;
          outsideAt(after);
          s.addText(count, { ...small, x: X, y: after + (outside.length ? 0.55 : 0), w: CW, h: 0.35 });
          break;
        }
        head(s, t.roadmapLabel, count);
        outsideAt(BODY_Y + 2.9);
        const n = p.milestones.length;
        const w = CW / n;
        const next = p.milestones.findIndex((m) => !m.done);
        const lineY = BODY_Y + 0.4;
        s.addShape('line', { x: X, y: lineY, w: CW, h: 0, line: { color: pal.line, width: 1.5 } });
        p.milestones.forEach((m, i) => {
          const x = X + i * w;
          const color = m.done ? pal.accent : i === next ? pal.accent : pal.line;
          s.addShape('ellipse', { x, y: lineY - 0.11, w: 0.22, h: 0.22, fill: { color: m.done ? color : pal.bg }, line: { color, width: 2 } });
          if (i === next) s.addText(t.roadmapNext.toUpperCase(), { x, y: lineY + 0.3, w: w - 0.2, h: 0.3, fontFace: body, fontSize: SIZE.small, bold: true, color: pal.accent, charSpacing: 2, margin: 0 });
          s.addText(m.text, { x, y: lineY + (i === next ? 0.65 : 0.3), w: w - 0.2, h: 1.8, fontFace: body, fontSize: SIZE.small, color: m.done || i === next ? pal.ink : pal.faint, valign: 'top', margin: 0 });
        });
        break;
      }
      case 'usage': {
        const s = newSlide();
        head(s, t.usageLabel, fill(t.usageTitle, { product: review.product }));
        const tiles = numbers(review);
        const w = (CW - 0.4 * (tiles.length - 1)) / tiles.length;
        tiles.forEach((u, i) => {
          const x = X + i * (w + 0.4);
          s.addText(nf.format(u.value), { x, y: BODY_Y, w, h: 1.1, fontFace: heading, fontSize: SIZE.display, bold: true, color: pal.accent, margin: 0 });
          s.addText(u.label, { x, y: BODY_Y + 1.2, w, h: 0.6, fontFace: body, fontSize: SIZE.body, color: pal.ink, valign: 'top', margin: 0 });
          const c = change(u, localeOf(review.language));
          const before = u.previous ?? u.history?.at(-1);
          if (c && before !== undefined)
            s.addText(
              [
                { text: c.text, options: { bold: true, color: c.good ? '059669' : 'DC2626' } },
                { text: ` · ${t.previous}: ${nf.format(before)}`, options: { color: pal.faint } },
              ],
              { x, y: BODY_Y + 1.85, w, h: 0.4, fontFace: body, fontSize: SIZE.small, margin: 0 },
            );
        });
        break;
      }
      case 'closing': {
        const s = newSlide();
        await logoAt(s);
        if (review.questions.length) {
          eyebrow(s, t.questions, 1.9);
          s.addText(t.feedbackTitle, { x: X, y: 2.3, w: CW, h: 1, fontFace: heading, fontSize: SIZE.title, bold: true, color: pal.ink, valign: 'top', margin: 0 });
          s.addText(
            review.questions.map((q, i) => ({ text: q, options: { bullet: { type: 'number' as const }, breakLine: i < review.questions.length - 1, paraSpaceAfter: 14 } })),
            { x: X, y: 3.5, w: 9.5, h: 3, fontFace: body, fontSize: SIZE.body, color: pal.ink, valign: 'top', margin: 0 },
          );
        } else {
          s.addText(t.questions, { x: X, y: 2.8, w: CW, h: 1.2, fontFace: heading, fontSize: SIZE.display, bold: true, color: pal.ink, margin: 0 });
          s.addText(review.headline ?? review.title, { x: X, y: 4.1, w: CW, h: 0.6, fontFace: body, fontSize: SIZE.body, color: pal.soft, margin: 0 });
        }
        break;
      }
    }
  }

  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer | Uint8Array;
  return Buffer.from(out);
}

/** The logo's size within a box, in its own proportions: a square icon stays square. */
async function logoBox(dataUri: string, maxW: number, maxH: number): Promise<{ w: number; h: number }> {
  let ratio = maxW / maxH;
  try {
    const { width, height } = await sharp(Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64')).metadata();
    if (width && height) ratio = width / height;
  } catch {}
  return ratio > maxW / maxH ? { w: maxW, h: maxW / ratio } : { w: maxH * ratio, h: maxH };
}
