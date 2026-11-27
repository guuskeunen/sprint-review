import sharp from 'sharp';
import type { Brand } from './brand.ts';
import { fontMime, MAX_FONT_BYTES, type FontFace } from './fonts.ts';
import type { Config } from '../config.ts';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 3_000_000;
const MAX_SHEETS = 5;
const MAX_PARSE = 500_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; sprint-review; +https://github.com/guuskeunen/sprint-review)';
/** Google Fonts sends woff2 only to a browser it knows. */
const BROWSER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const GENERIC_FONTS = /^(ui-[\w-]+|system-ui|-apple-system|BlinkMacSystemFont|sans-serif|serif|monospace|cursive|fantasy|inherit|initial|var\(.*)$/i;

/** brand.from is a website when it starts with http:// or https://. */
export function isWebsite(from: string | null): from is string {
  return !!from && /^https?:\/\//i.test(from);
}

const cache = new Map<string, Promise<Brand>>();

/**
 * The config with what it leaves out of the brand taken from the website in brand.from: color,
 * logo, fonts and font files the config sets itself win. The site is read once per run; a config without a
 * website comes back unchanged.
 */
export async function withWebsiteBrand(config: Config, fetchImpl: typeof fetch = fetch): Promise<Config> {
  const from = config.brand.from;
  if (!isWebsite(from)) return config;
  if (!cache.has(from) || fetchImpl !== fetch) cache.set(from, brandFromWebsite(from, fetchImpl));
  const site = await cache.get(from)!;
  return {
    ...config,
    brand: {
      ...config.brand,
      from: null,
      color: config.brand.color ?? site.color,
      logo: config.brand.logo ?? site.logo,
      fonts: { heading: config.brand.fonts.heading ?? site.fonts.heading, body: config.brand.fonts.body ?? site.fonts.body },
      fontFaces: (site.fontFaces ?? []).filter((f) => !config.brand.fontFiles[f.family]),
    },
  };
}

/**
 * Takes the look of a website: its brand color from the stylesheet (a --brand or --primary
 * variable, or the theme-color), its heading and body fonts from --font-heading/--font-display
 * and --font-sans/--font-body/--ui-font (either way round, with a prefix or not) with their files (so the deck carries them), and its logo (a logo image or SVG, in the header first, never from a wall of client logos; else its largest
 * icon). Grays, white and black are passed over as brand colors.
 */
export async function brandFromWebsite(url: string, fetchImpl: typeof fetch = fetch): Promise<Brand> {
  const page = await get(url, fetchImpl);
  if (!page) throw new Error(`brand.from: could not read the website ${url}. Check the address, or set brand.color and brand.logo yourself.`);
  // Parse at most the first 500 KB: the brand is in the head and header, and hostile HTML can make
  // regular expressions slow (quadratic) on megabytes.
  const html = page.body.subarray(0, MAX_PARSE).toString('utf8');
  const base = page.url;
  const css = elements(html, 'style').map((e) => e.inner);
  for (const href of stylesheets(html, base).slice(0, MAX_SHEETS)) {
    const sheet = await get(href, fetchImpl);
    if (sheet) css.push(sheet.body.subarray(0, MAX_PARSE).toString('utf8'));
  }
  const styles = css.join('\n');
  const fonts = { heading: font(styles, ['heading', 'display']), body: font(styles, ['body', 'sans', 'ui']) };
  return { color: brandColor(html, styles), fonts, logo: await logo(html, base, fetchImpl), fontFaces: await fontFiles(html, base, styles, fonts, fetchImpl) };
}

// ---------------------------------------------------------------- color

function brandColor(html: string, css: string): string | null {
  const vars = (names: string[]) => names.flatMap((n) => matches(css, new RegExp(`--${n}\\s*:\\s*([^;}]+)`, 'gi')).map((m) => m[1] ?? ''));
  const themeColor = attr(tags(html, 'meta').find((t) => /name=["']?theme-color/i.test(t)) ?? '', 'content');
  const candidates = [...vars(['brand', 'brand-color', 'color-brand', 'brand-primary']), ...(themeColor ? [themeColor] : []), ...vars(['primary', 'color-primary', 'accent', 'color-accent', 'ring'])];
  for (const c of candidates) {
    const hex = toHex(c.trim());
    if (hex && colorful(hex)) return hex;
  }
  return null;
}

/** #rgb, #rrggbb, rgb(), hsl() and the bare "222 47% 11%" that shadcn themes use. */
export function toHex(value: string): string | null {
  const v = value.replace(/\s*!important$/i, '').trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (m) return `#${(m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!).toLowerCase()}`;
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
  if (m) return hex(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(?:hsla?\(\s*)?(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i.exec(v);
  if (m) return hslHex(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
  return null;
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;
}

function hslHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return hex(f(0) * 255, f(8) * 255, f(4) * 255);
}

/** Not a gray, not near white or black: a color a deck can use as its accent. */
function colorful(h: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return s >= 0.15 && l > 0.05 && l < 0.92;
}

// ---------------------------------------------------------------- fonts

/**
 * A font family from a CSS variable, named either way round and with an optional prefix:
 * --font-sans, --body-font, --ui-font (excalidraw.com), --bs-body-font-family (Bootstrap).
 */
function font(css: string, names: string[]): string | null {
  for (const n of names) {
    for (const m of matches(css, new RegExp(`--(?:[a-z0-9]+-)*(?:font-${n}|${n}-font)(?:-family)?\\s*:\\s*([^;}]+)`, 'gi'))) {
      const family = (m[1] ?? '').split(',').map((f) => f.trim().replace(/^["']|["']$/g, '')).find((f) => f && !GENERIC_FONTS.test(f) && !f.startsWith('var('));
      if (family) return family;
    }
  }
  return null;
}

/**
 * The files of the heading and body fonts: the @font-face rules in the site's own stylesheets and
 * in the Google Fonts stylesheets of those families. Only upright Latin files, one face per file (a
 * variable font covers its weight range), 2 MB in all.
 */
async function fontFiles(html: string, base: string, styles: string, fonts: Brand['fonts'], fetchImpl: typeof fetch): Promise<FontFace[]> {
  const families = [...new Set([fonts.heading, fonts.body].filter((f): f is string => !!f))];
  if (!families.length) return [];
  const wanted = (family: string) => families.find((f) => f.toLowerCase() === family.toLowerCase());
  const sheets: { css: string; base: string }[] = [{ css: styles, base }];
  for (const href of googleFontSheets(html, base)) {
    const named = new URL(href).searchParams.getAll('family').map((f) => f.split(':')[0]!.trim());
    if (!named.some((f) => wanted(f))) continue;
    const sheet = await get(href, fetchImpl, BROWSER_AGENT);
    if (sheet) sheets.push({ css: sheet.body.subarray(0, MAX_PARSE).toString('utf8'), base: sheet.url });
  }
  const byFile = new Map<string, { family: string; weight: number; maxWeight: number }>();
  for (const sheet of sheets) {
    for (const rule of elementsBetween(sheet.css, '@font-face', '}')) {
      const family = wanted(prop(rule, 'font-family')?.replace(/^["']|["']$/g, '') ?? '');
      if (!family || /italic|oblique/i.test(prop(rule, 'font-style') ?? '')) continue;
      const range = prop(rule, 'unicode-range');
      if (range && !/U\+0+-0*FF\b/i.test(range)) continue;
      const src = /url\(\s*["']?([^"')]+\.woff2?(?:[?#][^"')]*)?)["']?\s*\)/i.exec(prop(rule, 'src') ?? '')?.[1];
      if (!src) continue;
      const weights = (prop(rule, 'font-weight') ?? '400').replace('normal', '400').replace('bold', '700').split(/\s+/).map(Number).filter((w) => w >= 1 && w <= 1000);
      const file = absolute(src, sheet.base);
      const now = byFile.get(file) ?? { family, weight: Math.min(...weights, 1000), maxWeight: 0 };
      byFile.set(file, { family, weight: Math.min(now.weight, ...weights), maxWeight: Math.max(now.maxWeight, ...weights) });
    }
  }
  const faces: FontFace[] = [];
  let total = 0;
  for (const [file, face] of byFile) {
    const got = await get(file, fetchImpl, BROWSER_AGENT);
    const mime = got ? fontMime(got.body) : null;
    if (!got || !mime || total + got.body.length > MAX_FONT_BYTES) continue;
    total += got.body.length;
    faces.push({ family: face.family, weight: face.weight, ...(face.maxWeight > face.weight ? { maxWeight: face.maxWeight } : {}), style: 'normal', data: `data:${mime};base64,${got.body.toString('base64')}` });
  }
  return faces;
}

function googleFontSheets(html: string, base: string): string[] {
  return tags(html, 'link')
    .filter((t) => /rel=["']?stylesheet/i.test(t))
    .map((t) => attr(t, 'href'))
    .filter((h): h is string => !!h && /^https:\/\/fonts\.googleapis\.com\/css2?\?/i.test(absolute(h, base)))
    .map((h) => absolute(h, base))
    .slice(0, MAX_SHEETS);
}

/** The text from each start to the next end, found with indexOf: linear, like tags(). */
function elementsBetween(text: string, start: string, end: string): string[] {
  const out: string[] = [];
  for (let at = text.indexOf(start); at !== -1; at = text.indexOf(start, at + 1)) {
    const close = text.indexOf(end, at);
    if (close === -1) break;
    out.push(text.slice(at + start.length, close));
  }
  return out;
}

/** One property of a CSS rule body. */
function prop(rule: string, name: string): string | null {
  const m = new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+)`, 'i').exec(rule);
  return m ? m[1]!.trim() : null;
}

// ---------------------------------------------------------------- logo

async function logo(html: string, base: string, fetchImpl: typeof fetch): Promise<string | null> {
  // The site's own logo sits in its header; further down, logos are usually clients or partners.
  const header = elements(html, 'header')[0]?.whole ?? elements(html, 'nav')[0]?.whole ?? '';
  const own = siteName(base);
  const found = markedLogo(header, own) ?? markedLogo(html, own);
  if (found?.svg) return `data:image/svg+xml;base64,${Buffer.from(found.svg.includes('xmlns=') ? found.svg : found.svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')).toString('base64')}`;
  const candidates: string[] = found?.src ? [found.src] : [];
  const icons = tags(html, 'link')
    .filter((t) => /rel=["']?[^"'>]*icon/i.test(t))
    .map((t) => ({ href: attr(t, 'href'), size: Number(/sizes=["']?(\d+)/i.exec(t)?.[1] ?? 0) + (/apple-touch-icon/i.test(t) ? 1000 : 0) }))
    .filter((i): i is { href: string; size: number } => !!i.href)
    .sort((a, b) => b.size - a.size);
  candidates.push(...icons.map((i) => i.href), '/favicon.ico');
  for (const c of candidates) {
    const file = await get(absolute(c, base), fetchImpl);
    const uri = file ? await imageUri(file.body) : null;
    if (uri) return uri;
  }
  return null;
}

/** The first word of the host: essentium for www.essentium.nl. */
function siteName(base: string): string | null {
  const host = new URL(base).hostname.replace(/^www\./, '');
  return host.split('.')[0]?.toLowerCase() || null;
}

/**
 * An image or inline SVG marked as a logo. Three or more logo images from one folder are a wall of
 * clients or partners and are passed over; among the rest, one that names the site wins.
 */
function markedLogo(html: string, own: string | null): { src?: string; svg?: string } | null {
  const images = tags(html, 'img')
    .filter((t) => /logo/i.test(t))
    .map((tag) => ({ tag, src: attr(tag, 'src') }))
    .filter((i): i is { tag: string; src: string } => !!i.src);
  const folder = (src: string) => src.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
  const perFolder = new Map<string, number>();
  for (const i of images) perFolder.set(folder(i.src), (perFolder.get(folder(i.src)) ?? 0) + 1);
  const single = images.filter((i) => (perFolder.get(folder(i.src)) ?? 0) < 3);
  const image = (own ? single.find((i) => i.tag.toLowerCase().includes(own)) : undefined) ?? single[0];
  if (image) return { src: image.src };
  const svg = elements(html, 'svg').find((e) => /logo/i.test(e.open))?.whole;
  return svg ? { svg } : null;
}

/** A data URI the deck and PowerPoint can both show: PNG, JPEG and SVG as they are, the rest as PNG. */
async function imageUri(data: Buffer): Promise<string | null> {
  if (data.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) {
    const png = icoPng(data);
    return png ? imageUri(png) : null;
  }
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return `data:image/png;base64,${data.toString('base64')}`;
  if (data[0] === 0xff && data[1] === 0xd8) return `data:image/jpeg;base64,${data.toString('base64')}`;
  const head = data.subarray(0, 300).toString('utf8');
  if (/<svg[\s>]/i.test(head) || (/^\s*<\?xml/.test(head) && data.toString('utf8').includes('<svg'))) return `data:image/svg+xml;base64,${data.toString('base64')}`;
  if (head.startsWith('GIF8') || (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP')) {
    try {
      return `data:image/png;base64,${(await sharp(data).png().toBuffer()).toString('base64')}`;
    } catch {
      return null;
    }
  }
  return null;
}

/** The largest PNG inside a .ico; icons with only bitmap images give nothing. */
function icoPng(ico: Buffer): Buffer | null {
  const count = ico.readUInt16LE(4);
  let best: { size: number; data: Buffer } | null = null;
  for (let i = 0; i < count && 6 + 16 * (i + 1) <= ico.length; i++) {
    const at = 6 + 16 * i;
    const width = ico[at] || 256;
    const length = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    const data = ico.subarray(offset, offset + length);
    if (data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) && (!best || width > best.size)) best = { size: width, data };
  }
  return best?.data ?? null;
}

// ---------------------------------------------------------------- html and http

function stylesheets(html: string, base: string): string[] {
  return tags(html, 'link')
    .filter((t) => /rel=["']?stylesheet/i.test(t))
    .map((t) => attr(t, 'href'))
    .filter((h): h is string => !!h && !/fonts\.googleapis\.com/i.test(h))
    .map((h) => absolute(h, base));
}

/** The opening tags of an element, found with indexOf: linear, so hostile HTML can't stall it. */
function tags(html: string, name: string): string[] {
  const lower = html.toLowerCase();
  const out: string[] = [];
  for (let at = lower.indexOf(`<${name}`); at !== -1; at = lower.indexOf(`<${name}`, at + 1)) {
    if (/[a-z0-9-]/.test(lower[at + name.length + 1] ?? '')) continue;
    const end = lower.indexOf('>', at);
    if (end === -1) break;
    out.push(html.slice(at, end + 1));
  }
  return out;
}

/** Whole elements with their content (style, svg), in linear time; an unclosed one ends the search. */
function elements(html: string, name: string): { open: string; inner: string; whole: string }[] {
  const lower = html.toLowerCase();
  const out: { open: string; inner: string; whole: string }[] = [];
  let at = lower.indexOf(`<${name}`);
  while (at !== -1) {
    const openEnd = lower.indexOf('>', at);
    if (openEnd === -1) break;
    const close = lower.indexOf(`</${name}>`, openEnd);
    if (close === -1) break;
    if (!/[a-z0-9-]/.test(lower[at + name.length + 1] ?? '')) {
      out.push({ open: html.slice(at, openEnd + 1), inner: html.slice(openEnd + 1, close), whole: html.slice(at, close + name.length + 3) });
    }
    at = lower.indexOf(`<${name}`, close);
  }
  return out;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&') : null;
}

function matches(text: string, re: RegExp): RegExpMatchArray[] {
  return [...text.matchAll(re)];
}

function absolute(href: string, base: string): string {
  return new URL(href, base).toString();
}

async function get(url: string, fetchImpl: typeof fetch, agent = USER_AGENT): Promise<{ url: string; body: Buffer } | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': agent }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok || !res.body) return null;
    // Read in chunks and stop at the limit: a hostile site could send gigabytes (or a gzip bomb).
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        await res.body.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(chunk));
    }
    return { url: res.url || url, body: Buffer.concat(chunks) };
  } catch {
    return null;
  }
}
