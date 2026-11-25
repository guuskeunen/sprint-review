import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { Config } from '../config.ts';
import type { ChangedScreen, Milestone, Review, ReviewScreen, ReviewTheme, UsageMetric, WrittenTheme } from '../types.ts';
import { History, type Range } from '../git/history.ts';
import { rangeDays, screens as openScreens, type Screens } from '../screens/screenshots.ts';
import { capture } from '../screens/capture.ts';
import { write } from '../ai/writer.ts';
import { githubRepo, withPullRequests } from '../git/github.ts';
import type { ModelClient } from '../ai/model.ts';
import { fill, labelsFor, longDate, shortDate } from '../deck/i18n.ts';
import { renderDeck } from '../deck/render.ts';
import { validReview } from './review.ts';
import { renderMarkdown } from '../deck/markdown.ts';
import { brandFromPptx, type Brand } from '../brand/brand.ts';
import { isWebsite, withWebsiteBrand } from '../brand/website.ts';
import { costOf, metered, type Cost } from '../ai/costs.ts';
import { lastTime, previousReview } from './previous.ts';
import { fontFaces } from '../brand/fonts.ts';

export class NothingToReview extends Error {}

export interface GenerateOptions {
  /** The range to cover. Default: the sprint ending today. */
  range?: Range;
  model: ModelClient;
  /** Called with a line for each step, for the CLI's progress output. */
  onStep?: (message: string) => void;
  /** For the GitHub API; tests pass a fake. */
  fetch?: typeof fetch;
}

export interface Generated {
  review: Review;
  html: string;
  markdown: string;
  usage: { input: number; output: number };
  /** The estimated price of the run, each call at the model that answered it. */
  cost: Cost;
  /** The models that answered: the fallback shows up here when it was needed. */
  models: string[];
}

/** A date range read on the configured branch (its origin/ copy when fetched), unless the range names its own. */
export function onBranch(range: Range, config: Config, history: History): Range {
  if (range.kind !== 'dates' || range.at || !config.sprint.branch) return range;
  const branch = config.sprint.branch;
  return { ...range, at: history.exists(`origin/${branch}`) ? `origin/${branch}` : branch };
}

/**
 * Work of the sprint on a main branch that what is read lacks: a feature branch behind develop.
 * Only when no branch was chosen; null when nothing is missing.
 */
export function missedWork(range: Range, config: Config, history: History): string | null {
  if (range.kind !== 'dates' || range.at || config.sprint.branch) return null;
  let most: { ref: string; n: number } | null = null;
  for (const ref of new Set([history.remoteDefault(), 'origin/develop', 'origin/development'])) {
    const n = ref ? history.missingFrom(range, ref) : null;
    if (ref && n && (!most || n > most.n)) most = { ref, n };
  }
  return most ? `${most.n} commit${most.n === 1 ? '' : 's'} of this sprint on ${most.ref} ${most.n === 1 ? 'is' : 'are'} not in what is checked out. Pass --to ${most.ref}, or set sprint.branch in the config.` : null;
}

/** The sprint that ends on a day (default today): `days` days, both ends included. */
export function sprintRange(days: number, until = today()): Range {
  const end = new Date(`${until}T00:00:00Z`);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { kind: 'dates', from: iso(start), until: iso(end) };
}

/**
 * Builds the review: reads the history, has the model write the words, puts every picture,
 * number and icon in place itself, and renders the deck. Nothing is published.
 */
export async function generate(config: Config, options: GenerateOptions): Promise<Generated> {
  config = await withWebsiteBrand(config, options.fetch);
  const step = options.onStep ?? (() => {});
  const history = new History(config.repo);
  const range = onBranch(options.range ?? sprintRange(config.sprint.days), config, history);
  history.assertUsable(range);
  const missed = missedWork(range, config, history);
  if (missed) step(missed);

  step('Reading the git history');
  let commits = history.commits(range, config.productPaths, config.ignore, config.limits.commits, config.nonProductTypes);
  if (!commits.length) throw new NothingToReview(`No commits found ${describe(range)}.`);
  // Nothing a user would notice: say so before paying for a model call.
  if (config.productPaths.length && !commits.some((c) => c.product)) {
    throw new NothingToReview(`None of the ${commits.length} commit${commits.length === 1 ? '' : 's'} ${describe(range)} touch the product code (productPaths: ${config.productPaths.join(', ')}). Check productPaths in the config, or pick another range.`);
  }
  step(`Found ${commits.length} commit${commits.length === 1 ? '' : 's'} ${describe(range)}`);

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  const wantPrs = config.github.pullRequests === 'on' || (config.github.pullRequests === 'auto' && token !== null);
  const repo = wantPrs ? githubRepo(history, config.github.repo) : null;
  if (repo) {
    step(`Reading pull requests from ${repo}`);
    const withPrs = await withPullRequests(commits, repo, token, options.fetch ?? fetch);
    commits = withPrs.commits;
    step(`${withPrs.found} pull request${withPrs.found === 1 ? '' : 's'} found`);
  }

  await captureToday(config, history, range, step);
  const t = labelsFor(config.language, config.labels);
  const shots = openScreens(config.screenshots, config.root, history, range, { phone: t.phone, desktop: t.desktop }, config.brand.theme);
  if (config.screenshots.source !== 'none') step('Comparing screenshots');
  const changed = await shots.changed();
  const available = shots.available();
  if (config.screenshots.source !== 'none') step(`${changed.length} screen${changed.length === 1 ? '' : 's'} changed, ${available.size} picture${available.size === 1 ? '' : 's'} available`);

  step(`Writing the slides with ${config.model.name}${config.model.provider === 'anthropic' ? '' : ` via ${config.model.provider}`}`);
  const meter = metered(options.model, step);
  const { end } = history.ends(range);
  const roadmap = history.milestones(end, config.roadmap);
  const staged = roadmap.filter((m) => m.stage);
  const requests = history.requests(end, config.feedback);
  const { written, usage } = await write(meter, config, commits, changed.map((c) => c.name), [...available.keys()], staged.map((m) => `${m.stage === 'now' ? 'Now' : 'Next'}: ${m.text}`), requests, staged.length ? [] : roadmap.map((m) => `${m.done ? '[x]' : '[ ]'} ${m.text}`));
  const cost = costOf(meter.calls, config.model, today());
  const models = [...new Set(meter.calls.map((c) => c.model))];

  const reviewScreens = explained(changed, written.screenCaptions, config.limits.changedScreens);
  const themes = withVideos(withScreens(written.themes, reviewScreens, available, shots, config.limits.themeScreens), config, step);
  const until = range.kind === 'dates' ? range.until : (commits[0]?.date ?? today());
  const from = range.kind === 'dates' ? range.from : (commits.at(-1)?.date ?? until);

  const milestones = staged.length ? plannedItems(staged, written.roadmap) : roadmap;
  const said = lastTime(previousReview(config, until), milestones);
  const review: Review = {
    version: 1,
    // The period sits right under the title, so the title doesn't repeat the date.
    title: t.sprintReview,
    period: fill(t.period, { from: shortDate(from, config.language), until: longDate(until, config.language) }),
    from,
    until,
    language: config.language,
    organization: config.organization,
    product: config.product.name,
    headline: written.headline,
    summaryNotes: written.summaryNotes,
    themes,
    underTheHood: written.underTheHood,
    questions: written.questions,
    screens: reviewScreens,
    milestones,
    usage: readUsage(config),
    // git gives the newest first: a sprint past the limit loses its first days, so say so.
    checks: [
      ...(missed ? [{ kind: 'warning' as const, text: 'Not the whole sprint', reason: missed }] : []),
      ...(commits.length >= config.limits.commits ? [{ kind: 'warning' as const, text: `Only the newest ${commits.length} commits were read`, reason: `The sprint has more commits than limits.commits, so its first days are missing. Raise limits.commits, or narrow ignore.` }] : []),
      ...written.checks,
    ],
    ...(said ? { lastTime: said } : {}),
    ...(written.answered.length ? { answered: written.answered.map((a) => ({ ask: requests[a.item]!, did: a.text })) } : {}),
  };
  step('Building the deck');
  return { review, ...render(review, config), usage, cost, models };
}

/** Render a stored review again: after editing review.json, or after a brand change. */
export function render(review: Review, config: Config): { html: string; markdown: string } {
  // A stored review may have been edited by hand: check it here too, for library users.
  review = validReview(review);
  const brand = resolvedBrand(config);
  return {
    html: renderDeck(review, { color: brand.color, logo: brand.logo, labels: config.labels, goal: config.goal, theme: config.brand.theme, fonts: brand.fonts, deck: config.deck, fontFaces: fontFaces(config.brand.fontFiles, config.root, (m) => console.error(m)) }),
    markdown: renderMarkdown(review, config.labels),
  };
}

/**
 * The brand as set in the config, with anything missing taken from brand.from (a .pptx). A website
 * in brand.from is read before this, by withWebsiteBrand, because reading it takes a request.
 */
export function resolvedBrand(config: Config): Brand {
  const own = { color: config.brand.color, logo: logoDataUri(config), fonts: config.brand.fonts };
  if (!config.brand.from) return own;
  if (isWebsite(config.brand.from)) throw new Error('brand.from is a website: read it first with withWebsiteBrand(config).');
  const file = resolve(config.root, config.brand.from);
  if (!existsSync(file)) throw new Error(`brand.from not found: ${file}`);
  const theirs = brandFromPptx(file);
  return {
    color: own.color ?? theirs.color,
    logo: own.logo ?? theirs.logo,
    fonts: { heading: own.fonts.heading ?? theirs.fonts.heading, body: own.fonts.body ?? theirs.fonts.body },
  };
}

/** The changed screens that get a slide: those the model could say in a sentence what changed on. */
function explained(changed: ChangedScreen[], captions: Record<string, string>, max: number): ReviewScreen[] {
  return changed
    .filter((s) => captions[s.name])
    .slice(0, max)
    .map((s) => ({ name: s.name, device: s.device, before: dataUri(s.before), after: dataUri(s.after), caption: captions[s.name] ?? null, ...(s.focus ? { focus: s.focus } : {}) }));
}

/**
 * Each theme with the screenshot it chose. A picture shows once: not on a second theme, and not
 * on a theme when it already has a desktop before-and-after slide.
 */
function withScreens(themes: WrittenTheme[], shown: ReviewScreen[], available: Map<string, { key: string; device: 'desktop' | 'phone' }>, shots: Screens, max: number): ReviewTheme[] {
  const used = new Set(shown.filter((s) => s.device === 'desktop').map((s) => `${s.name}|desktop`));
  let added = 0;
  return themes.map((th) => {
    const chosen = th.screen ? available.get(th.screen) : undefined;
    let screen: ReviewTheme['screen'] = null;
    if (chosen && added < max) {
      const name = shots.name(chosen.key);
      const id = `${name}|${chosen.device}`;
      const image = shots.picture(chosen.key, chosen.device);
      if (image && !used.has(id)) {
        used.add(id);
        added++;
        screen = { name, device: chosen.device, image: dataUri(image) };
      }
    }
    return { ...th, screen, screenKey: chosen?.key ?? null };
  });
}

/**
 * A Now / Next roadmap on the slide: the items the writer picked, in its words, three per section.
 * Without an answer, the first three of each section as the team wrote them.
 */
function plannedItems(staged: Milestone[], picked: { item: number; text: string }[]): Milestone[] {
  const chosen = picked.length ? picked.map((p) => ({ ...staged[p.item]!, text: p.text })) : staged;
  return (['now', 'next'] as const).flatMap((stage) => chosen.filter((m) => m.stage === stage).slice(0, 3));
}

/** A video is embedded in the deck, so it stays short: a few seconds of screen. */
const MAX_VIDEO_BYTES = 8 * 1024 * 1024;

/** A theme's screenshot gets the clip of the same screen from screenshots.videos, when there is one. */
function withVideos(themes: ReviewTheme[], config: Config, step: (m: string) => void): ReviewTheme[] {
  if (config.screenshots.source === 'none') return themes;
  const videos = config.screenshots.videos;
  return themes.map((th) => {
    const path = th.screen && th.screenKey ? videos[th.screenKey] : undefined;
    if (!path || !th.screen) return th;
    const file = resolve(config.root, path);
    if (!existsSync(file)) return step(`Video not found: ${path}`), th;
    const data = readFileSync(file);
    if (data.length > MAX_VIDEO_BYTES) return step(`Video left out, over 8 MB: ${path}`), th;
    const type = extname(file).toLowerCase() === '.webm' ? 'video/webm' : 'video/mp4';
    return { ...th, screen: { ...th.screen, video: `data:${type};base64,${data.toString('base64')}` } };
  });
}

/** Usage numbers come from the team, as a JSON file: `[{ "label": "orders placed", "value": 312, "previous": 268 }]`. */
function readUsage(config: Config): UsageMetric[] {
  if (!config.usage) return [];
  const file = resolve(config.root, config.usage);
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((u): u is { label: string; value: number; previous?: unknown; history?: unknown; better?: unknown } => typeof u?.label === 'string' && typeof u?.value === 'number')
    .slice(0, 6)
    .map((u) => {
      const history = Array.isArray(u.history) ? u.history.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(-11) : [];
      return {
        label: u.label,
        value: u.value,
        ...(typeof u.previous === 'number' ? { previous: u.previous } : {}),
        ...(history.length ? { history } : {}),
        ...(u.better === 'down' ? { better: 'down' as const } : {}),
      };
    });
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif' };

function logoDataUri(config: Config): string | null {
  if (!config.brand.logo) return null;
  if (config.brand.logo.startsWith('data:image/')) return config.brand.logo;
  const file = resolve(config.root, config.brand.logo);
  const mime = MIME[extname(file).toLowerCase()];
  if (!mime || !existsSync(file)) return null;
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

function dataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}

function describe(range: Range): string {
  return range.kind === 'dates' ? `from ${range.from} to ${range.until}` : `in ${range.from}..${range.to}`;
}

/**
 * Takes today's pictures for a sprint that ends today, unless there are some already. They are
 * this review's "after" and the next review's "before", so nobody has to remember to take them.
 * A failure is reported and the review goes on with the pictures there are.
 */
export async function captureToday(config: Config, history: History, range: Range, step: (m: string) => void, take = capture): Promise<void> {
  const s = config.screenshots;
  if (s.source !== 'capture' || !s.capture.onReview) return;
  const day = today();
  if (rangeDays(range, history).until < day) return;
  const folder = resolve(config.root, s.capture.dir, day);
  if (existsSync(folder) && readdirSync(folder).some((f) => f.endsWith('.png'))) return;
  step("Taking today's screenshots");
  try {
    const files = await take(s.capture, config.root, day, step);
    step(`${files.length} screenshot${files.length === 1 ? '' : 's'} taken`);
  } catch (e) {
    step(`Screenshots not taken: ${(e as Error).message.split('\n')[0]}`);
  }
}

function today(): string {
  return iso(new Date());
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
