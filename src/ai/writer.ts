import { DENSITY, type Config } from '../config.ts';
import { HOOD_KINDS, type Check, type Commit, type HoodItem, type HoodKind, type WrittenReview, type WrittenTheme } from '../types.ts';
import type { ModelClient } from './model.ts';
import { isIcon, VALUE_KEYS } from '../deck/icons.ts';
import { fitLog, NO_SCREEN, readerSystem, readerTool, slideText, untrusted, writerSystem, writerTool } from './prompt.ts';

export const POINT_WORDS_MAX = 16;
/** A slide title: a theme's headline, the sprint headline, a before and after caption. */
export const EFFECT_WORDS_MAX = 16;
export const NOTES_WORDS_MAX = 70;
export const TITLE_WORDS_MAX = 4;
const HOOD_POINTS = 5;
const QUESTIONS = 3;
const MAX_COMPLAINTS = 30;

export class WriterError extends Error {}

export interface WriteResult {
  written: WrittenReview;
  usage: { input: number; output: number };
}

/**
 * Has the model turn the commits into the text of the slides, in two rounds. The model groups
 * and words; it never writes HTML, counts or picks pictures freely.
 *
 * Round one writes. Round two is a reader without context: it sees only the slide text and says
 * where the audience gets stuck. It only points; it never rewrites, so everything on the slides
 * still passed the checks below.
 *
 * What is mechanical is checked in code: every point names a commit from the list, a commit that
 * touched no product code cannot carry a theme, a text fits a slide and has no exclamation mark or
 * emoji. Ticket numbers and hashes come out. Everything corrected, moved or dropped is logged.
 */
export async function write(model: ModelClient, config: Config, commits: Commit[], changedScreens: string[], availableScreens: string[], roadmapItems: string[] = [], requests: string[] = []): Promise<WriteResult> {
  const { log, skipped } = fitLog(commits, config.model.maxInputChars);
  const screens = changedScreens.length ? `The screenshots of these screens changed during the sprint: ${changedScreens.join(', ')}. ` : '';
  const ask = () =>
    model.ask({
      system: writerSystem(config),
      tool: writerTool(config, changedScreens, availableScreens, roadmapItems.length, requests.length),
      maxTokens: config.model.maxTokens,
      messages: [
        untrusted(log, `the commits of the sprint: hash, date, subject, files and description, newest first${skipped.length ? '. The sprint is long: some commits show only their first line' : ''}`, config.model.maxInputChars),
        ...(roadmapItems.length ? [untrusted(roadmapItems.map((r, i) => `${i}. ${r}`).join('\n'), "the team's roadmap: what they work on now and next, numbered")] : []),
        ...(requests.length ? [untrusted(requests.map((r, i) => `${i}. ${r}`).join('\n'), 'requests from users and stakeholders, numbered')] : []),
        `${screens}Now create the content of the presentation.`,
      ],
    });
  let draft = await ask();
  let written = parse(draft.toolInput, commits, changedScreens, availableScreens, config, roadmapItems.length, requests.length);
  let retry = { input: 0, output: 0 };
  // The product changed but no theme came through (a malformed answer): ask once more rather than ship an empty deck.
  if (written.themes.length === 0 && commits.some((c) => c.product)) {
    retry = draft.usage;
    draft = await ask();
    written = parse(draft.toolInput, commits, changedScreens, availableScreens, config, roadmapItems.length, requests.length);
    if (written.themes.length === 0) written.checks.push({ kind: 'warning', text: 'No themes', reason: 'The model gave no usable themes twice although the product changed. Run it again, or check the commits in this range.' });
  }
  if (written.themes.length === 0 && written.headline === null) {
    throw new WriterError('The model returned nothing usable. Try again, or check the commits in this range.');
  }
  const read = await complaints(model, config, written);
  let readChecks = read.checks;
  let extra = { input: 0, output: 0 };
  if (config.revise && read.flagged.length) {
    const revised = await revise(model, config, written, read.flagged);
    extra = revised.usage;
    const fixed = new Set(revised.fixed);
    readChecks = [...readChecks.filter((c) => !fixed.has(c.text)), ...revised.checks];
  }
  written.checks = [...unread(skipped, commits.length), ...readChecks, ...written.checks];
  return {
    written,
    usage: { input: retry.input + draft.usage.input + read.usage.input + extra.input, output: retry.output + draft.usage.output + read.usage.output + extra.output },
  };
}

/**
 * One rewrite of the lines the reader got stuck on. The writer returns a new line per flagged
 * line; each goes through the same checks as the first draft and only replaces the old line
 * when it passes. A line that can't be fixed keeps its warning.
 */
async function revise(model: ModelClient, config: Config, written: WrittenReview, flagged: { text: string; why: string }[]): Promise<{ checks: Check[]; fixed: string[]; usage: { input: number; output: number } }> {
  let answer;
  try {
    answer = await model.ask({
      system: writerSystem(config),
      tool: reviseTool(),
      maxTokens: config.model.maxTokens,
      messages: [
        untrusted(slideText(written), 'the text of the slides'),
        `A reader from the audience got stuck on these lines:\n${flagged.map((f) => `- "${f.text}" (${f.why})`).join('\n')}\n\nRewrite only these lines so this audience understands them. Keep every fact, add none, stay within the same word limits. Give each original line exactly as written.`,
      ],
    });
  } catch {
    return { checks: [], fixed: [], usage: { input: 0, output: 0 } };
  }
  const checks: Check[] = [];
  const fixed: string[] = [];
  for (const item of list(answer.toolInput?.revisions)) {
    const original = str(item.original)?.trim();
    if (!original) continue;
    const reason = flagged.find((f) => f.text === original)?.why ?? '';
    if (replaceLine(written, original, item.revised, config.replace)) {
      fixed.push(original);
      checks.push({ kind: 'corrected', text: `${original} → ${lineAfter(written, original, item.revised, config.replace)}`, reason: `Rewritten because the reader got stuck${reason ? `: ${reason}` : ''}` });
    }
  }
  return { checks, fixed, usage: answer.usage };
}

/** Swap one line of the slides for its rewrite, if the rewrite passes the checks for that kind of line. */
function replaceLine(w: WrittenReview, original: string, revised: unknown, replace: Record<string, string>): boolean {
  const ok = (max: number) => {
    const text = clean(revised, max, replace);
    return text && text !== original ? text : null;
  };
  if (w.headline === original) { const t = ok(EFFECT_WORDS_MAX); if (t) return (w.headline = t), true; }
  const q = w.questions.indexOf(original);
  if (q !== -1) { const t = ok(EFFECT_WORDS_MAX); if (t) return (w.questions[q] = t), true; }
  for (const th of w.themes) {
    if (th.title === original) { const t = ok(TITLE_WORDS_MAX); if (t) return (th.title = t), true; }
    if (th.effect === original) { const t = ok(EFFECT_WORDS_MAX); if (t) return (th.effect = t), true; }
    const i = th.points.indexOf(original);
    if (i !== -1) { const t = ok(POINT_WORDS_MAX); if (t) return (th.points[i] = t), true; }
  }
  const h = w.underTheHood.find((x) => x.text === original);
  if (h) { const t = ok(POINT_WORDS_MAX); if (t) return (h.text = t), true; }
  for (const [screen, caption] of Object.entries(w.screenCaptions)) {
    if (caption === original) { const t = ok(EFFECT_WORDS_MAX); if (t) return (w.screenCaptions[screen] = t), true; }
  }
  return false;
}

function lineAfter(_w: WrittenReview, _original: string, revised: unknown, replace: Record<string, string>): string {
  return clean(revised, EFFECT_WORDS_MAX, replace) ?? String(revised);
}

function reviseTool() {
  return {
    name: 'revisions',
    description: 'Deliver a rewrite for each flagged line.',
    input_schema: {
      type: 'object',
      properties: {
        revisions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              original: { type: 'string', description: 'The flagged line, exactly as it was written.' },
              revised: { type: 'string', description: 'The rewrite.' },
            },
            required: ['original', 'revised'],
            additionalProperties: false,
          },
        },
      },
      required: ['revisions'],
      additionalProperties: false,
    },
  };
}

async function complaints(model: ModelClient, config: Config, written: WrittenReview): Promise<{ checks: Check[]; flagged: { text: string; why: string }[]; usage: { input: number; output: number } }> {
  try {
    const answer = await model.ask({
      system: readerSystem(config),
      tool: readerTool(),
      maxTokens: config.model.maxTokens,
      messages: [untrusted(slideText(written), 'the text of the slides'), 'Read the text and point out where you get stuck.'],
    });
    const checks: Check[] = [];
    const flagged: { text: string; why: string }[] = [];
    const items = Array.isArray(answer.toolInput?.complaints) ? (answer.toolInput.complaints as unknown[]) : [];
    for (const v of items) {
      const c = v as Record<string, unknown>;
      if (typeof c?.text === 'string' && c.text.trim() && checks.length < MAX_COMPLAINTS) {
        const why = typeof c.why === 'string' ? c.why.trim() : '';
        flagged.push({ text: c.text.trim(), why });
        checks.push({ kind: 'warning', text: c.text.trim(), reason: `The reader got stuck here: ${why}`.trim() });
      }
    }
    return { checks, flagged, usage: answer.usage };
  } catch {
    return { checks: [{ kind: 'warning', text: 'Not proofread', reason: 'The second reader gave no answer. Read the slides extra carefully.' }], flagged: [], usage: { input: 0, output: 0 } };
  }
}

/** The answer of the writer, with only what holds up. Exported for tests. */
export function parse(input: Record<string, unknown> | null, commits: Commit[], changedScreens: string[], availableScreens: string[], config: Config, roadmapItems = 0, requests = 0): WrittenReview {
  const checks: Check[] = [];
  const moved: HoodItem[] = [];
  const replace = config.replace;
  const density = DENSITY[config.deck.density];
  const phoneLabel = (label: string) => /\((phone|telefoon|mobile)\)$/i.test(label);

  const themes: WrittenTheme[] = [];
  for (const t of list(input?.themes)) {
    if (themes.length === config.limits.themes) {
      checks.push({ kind: 'dropped', text: `Theme ${str(t.title) ?? ''}`.trim(), reason: `More than ${config.limits.themes} themes.` });
      continue;
    }
    const points: string[] = [];
    for (const v of list(t.points)) {
      const p = point(v, commits, checks, replace);
      if (!p || points.length === density.points) continue;
      if (p.product) points.push(p.text);
      else {
        moved.push({ text: p.text, kind: 'maintenance' });
        checks.push({ kind: 'moved', text: p.text, reason: 'No change to the product itself: moved under the hood.' });
      }
    }
    const title = clean(t.title, TITLE_WORDS_MAX, replace);
    if (title === null || points.length === 0) {
      checks.push({ kind: 'dropped', text: `Theme ${str(t.title) ?? ''}`.trim(), reason: title === null ? 'Title too long.' : 'No points left.' });
      continue;
    }
    const screen = typeof t.screen === 'string' && t.screen !== NO_SCREEN && availableScreens.includes(t.screen) ? t.screen : null;
    const effect = optional(t.effect, EFFECT_WORDS_MAX, checks, replace);
    // "Onboarding & Scoring" is two themes on one slide: two messages, and neither gets its title.
    if (/\s(&|\+|and|en|und|et|y)\s|\//i.test(title)) checks.push({ kind: 'warning', text: title, reason: 'This theme name joins two topics. One topic per slide reads better: split it, or name what they share.' });
    // A semicolon joins two sentences: two messages under one title.
    if (effect && effect.includes(';')) checks.push({ kind: 'warning', text: effect, reason: 'This title says two things. One message per slide: keep the one that matters most, and move the other to a point.' });
    // The glance test: what the audience reads besides the title. Flagged, never cut or shrunk.
    const words = [title, ...points].join(' ').split(/\s+/).length;
    if (words > density.words) checks.push({ kind: 'warning', text: effect ?? title, reason: `${words} words on the slide besides the title; ${density.words} is what the audience reads at a glance. Shorten a point in the editor.` });
    themes.push({
      title,
      icon: isIcon(t.icon) ? t.icon : 'other',
      screen,
      device: screen !== null && phoneLabel(screen) ? 'phone' : 'desktop',
      value: typeof t.value === 'string' && (VALUE_KEYS as readonly string[]).includes(t.value) ? t.value : null,
      effect,
      points,
      notes: optional(t.notes, NOTES_WORDS_MAX, checks, replace),
    });
  }

  let headline: string | null = null;
  const h = item(input?.headline);
  if (h) {
    const p = point({ ...h, text: typeof h.text === 'string' ? h.text : '' }, commits, checks, replace, EFFECT_WORDS_MAX);
    if (p && !p.product) checks.push({ kind: 'dropped', text: p.text, reason: 'The headline is about no change to the product itself.' });
    else if (p) headline = p.text;
    // One outcome reads at a glance; a list of the themes repeats the slides that follow.
    if (headline && (headline.match(/[,;]/g) ?? []).length >= 2) checks.push({ kind: 'warning', text: headline, reason: 'The headline lists several things. One outcome reads better: say what the sprint as a whole changed for a user.' });
  }

  const hood: HoodItem[] = [];
  const add = (x: HoodItem) => {
    if (!hood.some((y) => y.text === x.text)) hood.push(x);
  };
  for (const v of list(input?.under_the_hood)) {
    const p = point(v, commits, checks, replace);
    if (p) add({ text: p.text, kind: hoodKind(v.kind) });
  }
  moved.forEach(add);
  for (const x of hood.slice(HOOD_POINTS)) checks.push({ kind: 'dropped', text: x.text, reason: `More than ${HOOD_POINTS} points under the hood.` });

  const questions: string[] = [];
  for (const v of Array.isArray(input?.questions) ? (input.questions as unknown[]) : []) {
    const q = optional(v, EFFECT_WORDS_MAX, checks, replace);
    if (q && questions.length < QUESTIONS) questions.push(q);
  }

  const screenCaptions: Record<string, string> = {};
  for (const v of list(input?.screen_changes)) {
    if (typeof v.screen !== 'string' || !changedScreens.includes(v.screen)) continue;
    const text = clean(v.text, EFFECT_WORDS_MAX, replace);
    if (text !== null && named(v.commits, commits).length) screenCaptions[v.screen] = text;
    else checks.push({ kind: 'dropped', text: `Before and after: ${v.screen}`, reason: 'No usable sentence about what changed.' });
  }

  // A roadmap line must point at a real item of the roadmap, once.
  const roadmap: { item: number; text: string }[] = [];
  for (const v of list(input?.roadmap)) {
    const item = typeof v.item === 'number' ? v.item : Number(v.item);
    const text = clean(v.text, EFFECT_WORDS_MAX, replace);
    if (Number.isInteger(item) && item >= 0 && item < roadmapItems && text && !roadmap.some((r) => r.item === item)) roadmap.push({ item, text });
    else checks.push({ kind: 'dropped', text: String(v.text ?? ''), reason: 'A roadmap line that points at no item of the roadmap.' });
  }

  // "You asked, we did" is a claim about the sprint: the request must exist and a product commit must back it.
  const answered: { item: number; text: string }[] = [];
  for (const v of list(input?.answered)) {
    const item = typeof v.item === 'number' ? v.item : Number(v.item);
    const p = point(v, commits, checks, replace, EFFECT_WORDS_MAX);
    if (!p) continue;
    if (!Number.isInteger(item) || item < 0 || item >= requests || answered.some((a) => a.item === item)) checks.push({ kind: 'dropped', text: p.text, reason: 'An answered request that is not in the feedback list.' });
    else if (!p.product) checks.push({ kind: 'dropped', text: p.text, reason: 'An answered request backed by no change to the product.' });
    else if (answered.length < 3) answered.push({ item, text: p.text });
  }

  return {
    answered,
    roadmap,
    headline,
    summaryNotes: optional(input?.summary_notes, NOTES_WORDS_MAX, checks, replace),
    themes,
    underTheHood: hood.slice(0, HOOD_POINTS),
    questions,
    screenCaptions,
    checks,
  };
}

/** A point that holds up: a text that fits, naming a commit from the list. */
function point(value: Record<string, unknown>, commits: Commit[], checks: Check[], replace: Record<string, string>, maxWords = POINT_WORDS_MAX): { text: string; product: boolean } | null {
  if (typeof value.text !== 'string') return null;
  const text = clean(value.text, maxWords, replace);
  if (text === null) {
    checks.push({ kind: 'dropped', text: value.text, reason: 'Too long, or has an exclamation mark or emoji.' });
    return null;
  }
  const hits = named(value.commits, commits);
  if (!hits.length) {
    checks.push({ kind: 'dropped', text, reason: 'Names no change from this sprint.' });
    return null;
  }
  return { text, product: hits.some((c) => c.product) };
}

function optional(value: unknown, maxWords: number, checks: Check[], replace: Record<string, string>): string | null {
  const text = clean(value, maxWords, replace);
  if (text === null && typeof value === 'string' && value.trim()) checks.push({ kind: 'dropped', text: value, reason: 'Too long, or has an exclamation mark or emoji.' });
  return text;
}

// A reference is #12, ABC-81 or a hash (seven or more hex characters with a digit and a letter).
const REF = String.raw`(?:#\d+|\b[A-Z][A-Z0-9]+-\d+\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b)`;
const REFS = new RegExp(String.raw`\s*\(?\s*${REF}(?:\s*[,/]\s*${REF})*\s*\)?`, 'g');

/**
 * A text as it may go on a slide, or null when it's too long or has an exclamation mark or emoji.
 * Ticket numbers and hashes come out, long dashes become a comma, the team's words go in.
 * Exported for tests.
 */
export function clean(value: unknown, maxWords: number, replace: Record<string, string> = {}): string | null {
  if (typeof value !== 'string') return null;
  let text = value
    .replace(REFS, ' ')
    .replace(/\s*[—―]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .trim();
  if (text === '' || text.includes('!') || /\p{Extended_Pictographic}/u.test(text) || text.split(/\s+/).length > maxWords) return null;
  for (const [wrong, right] of Object.entries(replace)) {
    text = text.replace(new RegExp(`(?<!\\p{L})${escape(wrong)}(?!\\p{L})`, 'giu'), (m) =>
      m[0] === m[0]!.toUpperCase() && m[0] !== m[0]!.toLowerCase() ? right.charAt(0).toUpperCase() + right.slice(1) : right,
    );
  }
  return text;
}

/** The commits the model named. A short hash may come back a character longer or shorter, so a prefix match of seven counts. */
function named(hashes: unknown, commits: Commit[]): Commit[] {
  if (!Array.isArray(hashes)) return [];
  const out = new Map<string, Commit>();
  for (const h of hashes) {
    if (typeof h !== 'string') continue;
    const hash = h.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(hash)) continue;
    for (const c of commits) if (c.hash.startsWith(hash) || hash.startsWith(c.hash)) out.set(c.hash, c);
  }
  return [...out.values()];
}

/** One line in the check log for the commits that didn't fit, with a few of them, rather than a line each. */
export function unread(skipped: Commit[], total: number): Check[] {
  if (!skipped.length) return [];
  const product = skipped.filter((c) => c.product).length;
  const kinds = product ? `${product} with product code and ${skipped.length - product} without` : 'all without product code';
  const examples = skipped.filter((c) => c.product).concat(skipped.filter((c) => !c.product)).slice(0, 5).map((c) => c.subject);
  return [{
    kind: 'warning',
    text: `${skipped.length} of ${total} commits not read (${kinds})`,
    reason: `The sprint was too long for the model's input (model.maxInputChars). Narrow productPaths or ignore, or raise model.maxInputChars. For example: ${examples.join('; ')}`,
  }];
}

/** The objects in a list; an item sent as JSON text is read too, so nothing is lost silently. */
function list(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.map(item).filter((x): x is Record<string, unknown> => x !== null);
}
/** One object, or the same sent as JSON text. */
function item(x: unknown): Record<string, unknown> | null {
  if (typeof x === 'string' && x.trim().startsWith('{')) {
    try {
      x = JSON.parse(x) as unknown;
    } catch {
      return null;
    }
  }
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}
function hoodKind(v: unknown): HoodKind {
  return typeof v === 'string' && (HOOD_KINDS as readonly string[]).includes(v) ? (v as HoodKind) : 'maintenance';
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
