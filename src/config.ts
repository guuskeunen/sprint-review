import { isLocal, PROVIDERS, type ProviderName } from './ai/providers.ts';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname, join } from 'node:path';
import YAML from 'yaml';
import type { FontFace } from './brand/fonts.ts';

/** Who the deck is for. A preset, or your own description. */
/** The product's name when the config gives none: words for the prompt, never a name on a slide. */
export const UNNAMED_PRODUCT = 'the product';

export const AUDIENCES = {
  business:
    'Colleagues without a technical background, such as marketing, sales and support. They need to understand what is new and why it matters, in plain words.',
  executives:
    'Management. They want the few changes that matter most and what they bring the business, without detail.',
  customers:
    'Customers who use the product. They want to know what they can do now that they could not before, and what got easier.',
  team: 'The product team itself. Plain words still, but they know the product well and like a bit more detail.',
} as const;
type Audience = keyof typeof AUDIENCES;

/** Other names people use for the same presets. */
const AUDIENCE_ALIASES: Record<string, Audience> = { marketing: 'business', sales: 'business', support: 'business', management: 'executives', engineers: 'team', developers: 'team' };

/** How much each audience gets on a slide unless deck.density says otherwise. */
const AUDIENCE_DENSITY: Record<Audience, Density> = { business: 'standard', customers: 'standard', executives: 'brief', team: 'detailed' };

/**
 * How much goes on the slides. brief: two points per theme, two theme slides; standard: three and
 * three; detailed: four and four. Themes past the theme slides share one slide of cards. words is
 * the glance test: a theme slide with more words than this gets a warning, it is never shrunk.
 */
export const DENSITY = {
  brief: { points: 2, themeSlides: 2, words: 30 },
  standard: { points: 3, themeSlides: 3, words: 40 },
  detailed: { points: 4, themeSlides: 4, words: 50 },
} as const;
export type Density = keyof typeof DENSITY;

/** The slides that can be left out. The cover and the theme slides always show. */
export const SECTIONS = ['headline', 'lastTime', 'answered', 'screens', 'hood', 'roadmap', 'usage', 'questions'] as const;
export type Section = (typeof SECTIONS)[number];

export interface DeckConfig {
  density: Density;
  /** Which optional slides show. */
  sections: Record<Section, boolean>;
  /** story: numbers near the end; numbers-first: right after the headline (the default for executives). */
  order: 'story' | 'numbers-first';
}

export interface Area {
  /** A key from the icon set (see `sprint-review icons`). */
  icon: string;
  /** How the area is called in the product, such as the menu label. */
  label: string;
  /** The screen key of a screenshot that shows this area. */
  screen?: string;
}

export interface Config {
  /** The folder the config was read from; relative paths resolve against it. */
  root: string;
  /** The git repository to read. Defaults to the config's folder. */
  repo: string;
  product: { name: string; description: string };
  organization: string;
  audience: string;
  presenter: string;
  /** The language of the slides, as a name or code: "English", "nl", "de-DE". */
  language: string;
  goal: string | null;
  brand: {
    color: string | null;
    logo: string | null;
    /** A .pptx whose theme color, fonts and logo fill in whatever is not set here. */
    from: string | null;
    /** light (default) or dark. */
    theme: 'dark' | 'light';
    fonts: { heading: string | null; body: string | null };
    /** Font files to put inside the deck, by family: { Inter: [path/to/inter-400.woff2] }. */
    fontFiles: Record<string, string[]>;
    /** Font files read from the website in brand.from, for families fontFiles leaves out. Never set in the config file. */
    fontFaces?: FontFace[];
  };
  /** branch: the branch the sprint is read from (its origin/ copy when there is one); null reads what is checked out. */
  sprint: { days: number; branch: string | null };
  /** Folders that hold product code. A commit outside them can only go under the hood. Empty: every commit counts. */
  productPaths: string[];
  /** Commits whose subject matches one of these patterns are left out entirely. */
  ignore: string[];
  /** Conventional Commit types that never count as product work (ci, build, test, docs, chore). Empty list: types are ignored. */
  nonProductTypes: string[];
  /** Words the model tends to get wrong, with what the team says instead. Whole words, case kept. */
  replace: Record<string, string>;
  /** Extra writing rules, one per line, in your own words. */
  rules: string[];
  /** Override any label on the slides, by key (see src/i18n.ts). */
  labels: Record<string, string>;
  /** Let the writer rewrite the lines the second reader flagged, once. The rewrites go through every check again. */
  revise: boolean;
  /** Pull request titles and descriptions as extra context, from the GitHub API. */
  github: { pullRequests: 'auto' | 'on' | 'off'; repo: string | null };
  areas: Record<string, Area>;
  screenshots: ScreenshotConfig;
  roadmap: string | null;
  /** A file in the repository with requests from users and stakeholders, one per line ("- ..."). */
  feedback: string | null;
  usage: string | null;
  limits: { themes: number; themeScreens: number; changedScreens: number; commits: number };
  model: ModelConfig;
  output: { dir: string; markdown: boolean; pptx: boolean };
  deck: DeckConfig;
  /** Post the summary to Slack after generating. The webhook URL comes from SLACK_WEBHOOK_URL. */
  slack: boolean;
}

export type Provider = ProviderName;

export interface ModelConfig {
  provider: Provider;
  name: string;
  fallback: string | null;
  maxTokens: number;
  /** An OpenAI-compatible endpoint: Azure, a gateway, a local server. Defaults per provider. */
  baseUrl: string | null;
  /** tools: forced tool call (best). json: ask for JSON that matches a schema, for servers that don't force tools well. */
  mode: 'tools' | 'json';
  /** How much of the commit log the model gets, in characters. Small local models have small context windows. */
  maxInputChars: number;
  /** Bedrock: the AWS region. Default AWS_REGION. */
  region: string | null;
  /** US dollars per million input and output tokens, for the cost of a run. Default: the provider's list price, when known. */
  price: { input: number; output: number } | null;
}

export type ScreenshotConfig =
  | { source: 'none' }
  | ({ source: 'git'; dir: string } & ScreenCommon)
  | ({ source: 'folder'; before: string; after: string } & ScreenCommon)
  | ({ source: 'capture'; capture: CaptureConfig } & ScreenCommon);

interface ScreenCommon {
  names: Record<string, string>;
  /** What each picture shows, by screen key: the writer reads this to choose a picture, since it never sees one. */
  descriptions: Record<string, string>;
  /** Let the model look at the pictures: describe each one before writing, and check each theme's pick after. Sends the pictures to the model. On unless set to false. */
  check: boolean;
  ignore: { left: number; top: number };
  /** A short clip per screen key (an .mp4 or .webm of a few seconds), shown looping instead of its picture. */
  videos: Record<string, string>;
}

export interface CaptureConfig {
  /**
   * What to photograph, by screen key: a page, or one element on it (a card, a panel) when a
   * selector is given. Relative URLs are resolved against baseUrl.
   */
  pages: Record<string, { url: string; selector: string | null }>;
  baseUrl: string | null;
  devices: ('desktop' | 'phone')[];
  /** CSS selectors to black out before the picture is taken: a safety net for real data. */
  mask: string[];
  /** A Playwright storage state file with a logged-in session. */
  storageState: string | null;
  /**
   * Log in with the app's login form before photographing: field selectors to the names of the
   * environment variables that hold their values. Nothing expires, unlike a saved session.
   */
  login: { url: string; fields: Record<string, string>; submit: string } | null;
  /** Take today's pictures when a review is made, unless there are some already. Default true. */
  onReview: boolean;
  /** Milliseconds to wait after the page has loaded. */
  wait: number;
  /** Where the pictures are kept, one folder per day. Keep it between runs (commit it or cache it in CI). */
  dir: string;
  /** Also photograph every page in the app's dark mode, for the dark deck. Only useful when the app follows the system's dark mode. */
  darkMode: boolean;
}

const DEFAULT_FILES = ['sprint-review.config.yml', 'sprint-review.config.yaml', 'sprint-review.config.json'];

export class ConfigError extends Error {}

/**
 * The config file for a folder: in it, or in a folder above it up to the root of its git
 * repository, the way git finds .git. So a run from apps/web still reads the project's config.
 */
export function findConfigFile(start = process.cwd()): string | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const file = DEFAULT_FILES.map((f) => join(dir, f)).find((f) => existsSync(f));
    if (file) return file;
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return null;
  }
}

/** Find and read the config: the given path, or the first default file in `cwd` or a folder above it in the repository. */
export function loadConfig(path: string | null, cwd = process.cwd()): Config {
  const file = path ? resolve(cwd, path) : findConfigFile(cwd);
  if (!file) {
    throw new ConfigError(`No config found. Run \`sprint-review init\` to create ${DEFAULT_FILES[0]}.`);
  }
  if (!existsSync(file)) throw new ConfigError(`Config not found: ${file}`);
  const text = readFileSync(file, 'utf8');
  let raw: unknown;
  try {
    raw = extname(file) === '.json' ? JSON.parse(text) : YAML.parse(text);
  } catch (e) {
    throw new ConfigError(`Could not parse ${file}: ${(e as Error).message}`);
  }
  return normalize(raw ?? {}, dirname(file));
}

/** Fill in defaults and check every field, so the rest of the code can trust the shape. */
export function normalize(raw: unknown, root: string): Config {
  const r = obj(raw, 'config');
  const product = obj(r.product ?? {}, 'product');
  const brand = obj(r.brand ?? {}, 'brand');
  const sprint = obj(r.sprint ?? {}, 'sprint');
  const limits = obj(r.limits ?? {}, 'limits');
  const model = obj(r.model ?? {}, 'model');
  const output = obj(r.output ?? {}, 'output');

  const audienceRaw = str(r.audience, 'audience') ?? 'business';
  const preset: Audience | null = audienceRaw in AUDIENCES ? (audienceRaw as Audience) : (AUDIENCE_ALIASES[audienceRaw.toLowerCase()] ?? null);
  const audience = preset ? AUDIENCES[preset] : audienceRaw;

  const color = str(brand.color, 'brand.color');
  if (color !== null && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new ConfigError('brand.color must be a hex color like #ea580c.');

  const areas: Record<string, Area> = {};
  for (const [key, value] of Object.entries(obj(r.areas ?? {}, 'areas'))) {
    const a = obj(value, `areas.${key}`);
    areas[key] = {
      icon: str(a.icon, `areas.${key}.icon`) ?? 'other',
      label: str(a.label, `areas.${key}.label`) ?? key,
      ...(str(a.screen, `areas.${key}.screen`) ? { screen: str(a.screen, `areas.${key}.screen`)! } : {}),
    };
  }

  return {
    root,
    repo: resolve(root, str(r.repo, 'repo') ?? '.'),
    product: {
      name: str(product.name, 'product.name') ?? UNNAMED_PRODUCT,
      description: str(product.description, 'product.description') ?? '',
    },
    organization: str(r.organization, 'organization') ?? '',
    audience,
    presenter:
      str(r.presenter, 'presenter') ??
      'The presenter is technical, knows the product and gives a short demo of each theme.',
    language: str(r.language, 'language') ?? 'English',
    goal: str(r.goal, 'goal'),
    brand: {
      color,
      logo: str(brand.logo, 'brand.logo'),
      from: str(brand.from, 'brand.from'),
      theme: themeOf(str(brand.theme, 'brand.theme')),
      fonts: {
        heading: str(obj(brand.fonts ?? {}, 'brand.fonts').heading, 'brand.fonts.heading'),
        body: str(obj(brand.fonts ?? {}, 'brand.fonts').body, 'brand.fonts.body'),
      },
      fontFiles: Object.fromEntries(Object.entries(obj(brand.fontFiles ?? {}, 'brand.fontFiles')).map(([family, v]) => [family, strList(typeof v === 'string' ? [v] : v, `brand.fontFiles.${family}`)])),
    },
    sprint: { days: int(sprint.days, 'sprint.days', 14, 1, 120), branch: str(sprint.branch, 'sprint.branch') ?? null },
    productPaths: strList(r.productPaths, 'productPaths'),
    ignore: strList(r.ignore, 'ignore'),
    nonProductTypes: r.nonProductTypes === undefined ? ['ci', 'build', 'test', 'docs', 'chore'] : strList(r.nonProductTypes, 'nonProductTypes').map((t) => t.toLowerCase()),
    replace: strMap(r.replace, 'replace'),
    rules: strList(r.rules, 'rules'),
    labels: strMap(r.labels, 'labels'),
    revise: r.revise === undefined ? true : bool(r.revise, 'revise'),
    github: github(r.github),
    areas,
    screenshots: screenshots(r.screenshots),
    roadmap: r.roadmap === false ? null : (str(r.roadmap, 'roadmap') ?? 'ROADMAP.md'),
    feedback: r.feedback === false ? null : (str(r.feedback, 'feedback') ?? 'FEEDBACK.md'),
    usage: str(r.usage, 'usage'),
    limits: {
      themes: int(limits.themes, 'limits.themes', 6, 1, 12),
      themeScreens: int(limits.themeScreens, 'limits.themeScreens', 4, 0, 12),
      changedScreens: int(limits.changedScreens, 'limits.changedScreens', 4, 0, 12),
      commits: int(limits.commits, 'limits.commits', 3000, 1, 100000),
    },
    model: modelConfig(model),
    output: {
      dir: str(output.dir, 'output.dir') ?? 'sprint-reviews',
      markdown: output.markdown === undefined ? true : bool(output.markdown, 'output.markdown'),
      pptx: output.pptx === undefined ? false : bool(output.pptx, 'output.pptx'),
    },
    deck: deckConfig(r.deck, preset),
    slack: r.slack === undefined ? false : bool(r.slack, 'slack'),
  };
}

/** The deck settings when there is no config, such as for a review rendered as a library call. */
export function defaultDeck(): DeckConfig {
  return deckConfig(undefined, null);
}

/**
 * The audience sets the defaults: executives get a brief deck with the numbers early and no slide
 * about work they can't see, the team a detailed one. Anything in deck overrides them.
 */
function deckConfig(value: unknown, audience: Audience | null): DeckConfig {
  const d = obj(value ?? {}, 'deck');
  const executives = audience === 'executives';
  const density = str(d.density, 'deck.density') ?? (audience ? AUDIENCE_DENSITY[audience] : 'standard');
  if (!(density in DENSITY)) throw new ConfigError(`deck.density must be ${Object.keys(DENSITY).join(', ')}.`);
  const order = str(d.order, 'deck.order') ?? (executives ? 'numbers-first' : 'story');
  if (order !== 'story' && order !== 'numbers-first') throw new ConfigError('deck.order must be story or numbers-first.');
  const given = obj(d.sections ?? {}, 'deck.sections');
  for (const k of Object.keys(given)) if (!(SECTIONS as readonly string[]).includes(k)) throw new ConfigError(`deck.sections.${k} is not a section: use ${SECTIONS.join(', ')}.`);
  const sections = Object.fromEntries(SECTIONS.map((k) => [k, given[k] === undefined ? !(executives && k === 'hood') : bool(given[k], `deck.sections.${k}`)])) as Record<Section, boolean>;
  return { density: density as Density, sections, order };
}

function screenshots(value: unknown): ScreenshotConfig {
  if (value === undefined || value === null || value === false) return { source: 'none' };
  const s = obj(value, 'screenshots');
  const source = str(s.source, 'screenshots.source') ?? (s.dir ? 'git' : s.before ? 'folder' : 'none');
  const names = strMap(s.names, 'screenshots.names');
  const descriptions = strMap(s.descriptions, 'screenshots.descriptions');
  const check = s.check === undefined ? true : bool(s.check, 'screenshots.check');
  const ig = obj(s.ignore ?? {}, 'screenshots.ignore');
  const ignore = { left: int(ig.left, 'screenshots.ignore.left', 0, 0, 4000), top: int(ig.top, 'screenshots.ignore.top', 0, 0, 4000) };
  const videos = strMap(s.videos, 'screenshots.videos');
  for (const [k, v] of Object.entries(videos)) if (!/\.(mp4|webm)$/i.test(v)) throw new ConfigError(`screenshots.videos.${k} must be an .mp4 or .webm file.`);
  if (source === 'none') return { source: 'none' };
  if (source === 'git') {
    const dir = str(s.dir, 'screenshots.dir');
    if (!dir) throw new ConfigError('screenshots.dir is required when screenshots.source is git.');
    return { source: 'git', dir: dir.replace(/\/+$/, ''), names, descriptions, check, ignore, videos };
  }
  if (source === 'folder') {
    const before = str(s.before, 'screenshots.before');
    const after = str(s.after, 'screenshots.after');
    if (!before || !after) throw new ConfigError('screenshots.before and screenshots.after are required when screenshots.source is folder.');
    return { source: 'folder', before, after, names, descriptions, check, ignore, videos };
  }
  if (source === 'capture') {
    const pages: CaptureConfig['pages'] = {};
    for (const [key, v] of Object.entries(obj(s.pages ?? {}, 'screenshots.pages'))) {
      if (typeof v === 'string') pages[key] = { url: v, selector: null };
      else {
        const page = obj(v, `screenshots.pages.${key}`);
        const url = str(page.url, `screenshots.pages.${key}.url`);
        if (!url) throw new ConfigError(`screenshots.pages.${key} needs a url.`);
        pages[key] = { url, selector: str(page.selector, `screenshots.pages.${key}.selector`) };
      }
    }
    if (!Object.keys(pages).length) throw new ConfigError('screenshots.pages is required when screenshots.source is capture: a screen key per URL.');
    const devices = s.devices === undefined ? (['desktop'] as ('desktop' | 'phone')[]) : strList(s.devices, 'screenshots.devices');
    for (const d of devices) if (d !== 'desktop' && d !== 'phone') throw new ConfigError('screenshots.devices can hold desktop and phone.');
    return {
      source: 'capture',
      names,
      descriptions,
      check,
      ignore,
      videos,
      capture: {
        pages,
        baseUrl: str(s.baseUrl, 'screenshots.baseUrl'),
        devices: devices as ('desktop' | 'phone')[],
        mask: strList(s.mask, 'screenshots.mask'),
        storageState: str(s.storageState, 'screenshots.storageState'),
        login: s.login === undefined ? null : login(s.login),
        onReview: s.onReview === undefined ? true : bool(s.onReview, 'screenshots.onReview'),
        wait: int(s.wait, 'screenshots.wait', 500, 0, 60000),
        dir: str(s.storage, 'screenshots.storage') ?? '.sprint-review/screenshots',
        darkMode: s.darkMode === undefined ? false : bool(s.darkMode, 'screenshots.darkMode'),
      },
    };
  }
  throw new ConfigError(`screenshots.source must be none, git, folder or capture, not "${source}".`);
}

function login(value: unknown): CaptureConfig['login'] {
  const l = obj(value, 'screenshots.login');
  const url = str(l.url, 'screenshots.login.url');
  const submit = str(l.submit, 'screenshots.login.submit');
  const fields = strMap(l.fields, 'screenshots.login.fields');
  if (!url || !submit || !Object.keys(fields).length) throw new ConfigError('screenshots.login needs url, fields and submit.');
  for (const [selector, name] of Object.entries(fields)) {
    // The name of a variable, never the value: a password does not belong in a config file.
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new ConfigError(`screenshots.login.fields."${selector}" must name an environment variable (like SCREENSHOT_PASSWORD), not hold the value.`);
  }
  return { url, fields, submit };
}

function themeOf(v: string | null): 'dark' | 'light' {
  if (v === null || v === 'light') return 'light';
  if (v === 'dark') return 'dark';
  throw new ConfigError('brand.theme must be dark or light.');
}

function github(value: unknown): Config['github'] {
  if (value === undefined || value === null) return { pullRequests: 'auto', repo: null };
  const g = obj(value, 'github');
  const pr = g.pullRequests;
  const pullRequests = pr === undefined || pr === 'auto' ? 'auto' : pr === true ? 'on' : pr === false ? 'off' : null;
  if (pullRequests === null) throw new ConfigError('github.pullRequests must be auto, true or false.');
  const repo = str(g.repo, 'github.repo');
  if (repo !== null && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ConfigError('github.repo must look like owner/name.');
  return { pullRequests, repo };
}

function modelConfig(model: Record<string, unknown>): ModelConfig {
  const provider = (str(model.provider, 'model.provider') ?? 'anthropic') as ProviderName;
  if (!PROVIDERS.includes(provider)) throw new ConfigError(`model.provider must be one of ${PROVIDERS.join(', ')}.`);
  const local = isLocal(provider);
  const name = str(model.name, 'model.name') ?? (provider === 'anthropic' ? 'claude-opus-5-5' : null);
  if (!name) throw new ConfigError(`model.name is required when model.provider is ${provider}: ${provider === 'bedrock' ? 'the Bedrock model or inference profile id' : local ? 'the model you pulled, such as qwen3:32b' : 'the model your account uses'}.`);
  const fallback = model.fallback === null ? null : (str(model.fallback, 'model.fallback') ?? (provider === 'anthropic' ? 'claude-sonnet-5-5' : null));
  const baseUrl = str(model.baseUrl, 'model.baseUrl');
  if (baseUrl !== null && !/^https?:\/\//.test(baseUrl)) throw new ConfigError('model.baseUrl must start with http:// or https://.');
  // The API key goes along: plain http only to this machine.
  if (baseUrl !== null && baseUrl.startsWith('http://') && !isLoopback(baseUrl)) throw new ConfigError('model.baseUrl must use https:// unless it is on this machine (localhost): the API key is sent with every request.');
  if ((provider === 'anthropic' || provider === 'bedrock') && baseUrl !== null) throw new ConfigError(`model.baseUrl is not used for ${provider}.`);
  if (provider === 'azure' && baseUrl === null) throw new ConfigError('model.baseUrl is required for azure: https://<resource>.openai.azure.com/openai/v1');
  const mode = str(model.mode, 'model.mode') ?? (local ? 'json' : 'tools');
  if (mode !== 'tools' && mode !== 'json') throw new ConfigError('model.mode must be tools or json.');
  if ((provider === 'anthropic' || provider === 'bedrock') && mode === 'json') throw new ConfigError(`model.mode json is not used for ${provider}: it always forces the tool.`);
  const region = str(model.region, 'model.region');
  if (region !== null && provider !== 'bedrock') throw new ConfigError('model.region is only for bedrock.');
  let price: ModelConfig['price'] = null;
  if (model.price !== undefined && model.price !== null) {
    const p = obj(model.price, 'model.price');
    if (typeof p.input !== 'number' || typeof p.output !== 'number' || p.input < 0 || p.output < 0) throw new ConfigError('model.price must be { input, output }: US dollars per million tokens, such as { input: 3, output: 15 }.');
    price = { input: p.input, output: p.output };
  }
  return {
    provider,
    name,
    fallback,
    maxTokens: int(model.maxTokens, 'model.maxTokens', 16000, 1000, 64000),
    baseUrl,
    mode,
    maxInputChars: int(model.maxInputChars, 'model.maxInputChars', local ? 24_000 : 120_000, 4_000, 400_000),
    region,
    price,
  };
}

function obj(v: unknown, at: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ConfigError(`${at} must be an object.`);
  return v as Record<string, unknown>;
}
function str(v: unknown, at: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new ConfigError(`${at} must be text.`);
  return v.trim() === '' ? null : v.trim();
}
function bool(v: unknown, at: string): boolean {
  if (typeof v !== 'boolean') throw new ConfigError(`${at} must be true or false.`);
  return v;
}
function int(v: unknown, at: string, fallback: number, min: number, max: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ConfigError(`${at} must be a whole number from ${min} to ${max}.`);
  return v;
}
function strList(v: unknown, at: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ConfigError(`${at} must be a list of text.`);
  return (v as string[]).map((x) => x.trim()).filter(Boolean);
}
function strMap(v: unknown, at: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  const o = obj(v, at);
  for (const [k, x] of Object.entries(o)) if (typeof x !== 'string') throw new ConfigError(`${at}.${k} must be text.`);
  return o as Record<string, string>;
}

/** localhost, 127.x or ::1: a server on this machine. */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** The commented template a new config starts from. */
export function configTemplate(): string {
  return readFileSync(new URL('../assets/config.template.yml', import.meta.url), 'utf8');
}
