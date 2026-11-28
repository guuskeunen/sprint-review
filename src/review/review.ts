import { HOOD_KINDS, THEME_LAYOUTS, type HoodItem, type Review } from '../types.ts';
import { IMAGE_DATA_URI, VIDEO_DATA_URI } from '../deck/render.ts';

/**
 * Enough of a check that a broken edit can't produce a broken deck. A review from an older version
 * still opens: its first summary point becomes the headline, plain lines under the hood become
 * maintenance.
 */
export function validReview(v: unknown): Review {
  const r = upgraded(v);
  const strings = (a: unknown) => Array.isArray(a) && a.every((x) => typeof x === 'string');
  if (!r || r.version !== 1) throw new Error('Not a review made by sprint-review.');
  if (typeof r.title !== 'string' || typeof r.period !== 'string') throw new Error('The review needs a title and a period.');
  if (r.headline !== null && typeof r.headline !== 'string') throw new Error('The headline must be text.');
  if (r.lastTime !== undefined && !(typeof r.lastTime?.until === 'string' && Array.isArray(r.lastTime.items) && r.lastTime.items.every((m) => typeof m?.text === 'string' && typeof m.done === 'boolean'))) throw new Error('lastTime needs until and a list of items with text and done.');
  if (r.answered !== undefined && !(Array.isArray(r.answered) && r.answered.every((a) => typeof a?.ask === 'string' && typeof a.did === 'string'))) throw new Error('answered must be a list of { ask, did }.');
  if (!strings(r.questions)) throw new Error('Questions must be a list of lines.');
  if (!Array.isArray(r.themes) || !r.themes.every((t) => typeof t?.title === 'string' && strings(t.points))) throw new Error('Every theme needs a title and a list of points.');
  if (!Array.isArray(r.underTheHood) || !r.underTheHood.every((x) => typeof x?.text === 'string' && (HOOD_KINDS as readonly string[]).includes(x.kind))) throw new Error(`Every line under the hood needs text and a kind (${HOOD_KINDS.join(', ')}).`);
  for (const k of ['screens', 'milestones', 'usage', 'checks'] as const) if (!Array.isArray(r[k])) throw new Error(`${k} must be a list.`);
  const text = (v: unknown) => v === null || v === undefined || typeof v === 'string';
  for (const t of r.themes) {
    for (const k of ['effect', 'notes', 'icon', 'value'] as const) if (!text(t[k])) throw new Error(`The ${k} of theme "${t.title}" must be text.`);
    if (t.milestone !== undefined && t.milestone !== null && !(Number.isInteger(t.milestone) && t.milestone >= 0 && t.milestone < r.milestones.length)) throw new Error(`The milestone of theme "${t.title}" must be the place of a milestone in milestones (from 0), or null.`);
    if (t.layout !== undefined && !(THEME_LAYOUTS as readonly string[]).includes(t.layout)) throw new Error(`The layout of theme "${t.title}" must be one of ${THEME_LAYOUTS.join(', ')}.`);
    if (t.screen?.video !== undefined && !VIDEO_DATA_URI.test(String(t.screen.video))) throw new Error(`The video of theme "${t.title}" must be a data:video/mp4 or data:video/webm URI.`);
    if (t.screen && !IMAGE_DATA_URI.test(String(t.screen.image))) throw new Error(`The picture of theme "${t.title}" must be an image (a data:image URI).`);
  }
  const fraction = (n: unknown) => typeof n === 'number' && n >= 0 && n <= 1;
  for (const s of r.screens) if (s?.focus !== undefined && !(['x', 'y', 'w', 'h'] as const).every((k) => fraction(s.focus?.[k]))) throw new Error(`The focus of "${s?.name}" must have x, y, w and h from 0 to 1.`);
  for (const s of r.screens) if (!IMAGE_DATA_URI.test(String(s?.before)) || !IMAGE_DATA_URI.test(String(s?.after))) throw new Error(`The before and after picture of "${s?.name}" must be images (data:image URIs).`);
  return {
    ...r,
    headline: r.headline?.trim() || null,
    questions: r.questions.filter((q) => q.trim()),
    themes: r.themes.map((t) => ({ ...t, points: t.points.filter((p) => p.trim()) })),
    underTheHood: r.underTheHood.filter((p) => p.text.trim()),
  };
}

/** A review in today's shape, whichever version of sprint-review wrote it. */
function upgraded(v: unknown): Review {
  if (!v || typeof v !== 'object') return v as Review;
  const { summary, ...r } = v as Review & { summary?: { text?: unknown }[] };
  const first = Array.isArray(summary) ? summary.find((p) => typeof p?.text === 'string') : undefined;
  return {
    ...r,
    headline: r.headline === undefined ? ((first?.text as string | undefined) ?? null) : r.headline,
    questions: r.questions ?? [],
    underTheHood: Array.isArray(r.underTheHood) ? r.underTheHood.map((x: HoodItem | string) => (typeof x === 'string' ? { text: x, kind: 'maintenance' as const } : x)) : r.underTheHood,
  };
}
