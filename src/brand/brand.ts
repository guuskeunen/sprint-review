import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { readZip } from './zip.ts';
import type { FontFace } from './fonts.ts';

export interface Brand {
  color: string | null;
  fonts: { heading: string | null; body: string | null };
  /** A data URI. */
  logo: string | null;
  /** The files of the heading and body fonts, from a website. */
  fontFaces?: FontFace[];
}

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif' };
const FONT_FALLBACK = /^\+|^$/;

/**
 * Takes the look of an existing presentation: the theme's first accent color, its heading and
 * body fonts, and the logo (the picture that appears on the slide master). Nothing else is
 * copied: the layout of the deck stays its own.
 */
export function brandFromPptx(file: string): Brand {
  if (extname(file).toLowerCase() !== '.pptx' && extname(file).toLowerCase() !== '.potx') throw new Error('brand.from must be a .pptx or .potx file, or a website starting with https://.');
  const zip = readZip(readFileSync(file));
  const text = (name: string) => zip.get(name)?.().toString('utf8') ?? '';

  const themeName = [...zip.keys()].filter((k) => /^ppt\/theme\/theme\d+\.xml$/.test(k)).sort()[0];
  const theme = themeName ? text(themeName) : '';
  const accent = theme.match(/<a:accent1>\s*<a:(?:srgbClr val="([0-9A-Fa-f]{6})"|sysClr[^>]*lastClr="([0-9A-Fa-f]{6})")/);
  const color = accent ? `#${(accent[1] ?? accent[2] ?? '').toLowerCase()}` : null;
  const font = (tag: 'majorFont' | 'minorFont') => {
    const m = theme.match(new RegExp(`<a:${tag}>[\\s\\S]*?<a:latin typeface="([^"]*)"`));
    return m && !FONT_FALLBACK.test(m[1] ?? '') ? (m[1] ?? null) : null;
  };

  return { color, fonts: { heading: font('majorFont'), body: font('minorFont') }, logo: masterLogo(zip, text) };
}

/** The smallest-area picture on the first slide master or its layouts: logos are small, backgrounds are not. */
function masterLogo(zip: Map<string, () => Buffer>, text: (n: string) => string): string | null {
  const sources = ['ppt/slideMasters/slideMaster1.xml', ...[...zip.keys()].filter((k) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(k)).sort()];
  let best: { area: number; target: string } | null = null;
  for (const src of sources) {
    const xml = text(src);
    if (!xml) continue;
    const rels = text(src.replace(/([^/]+)$/, '_rels/$1.rels'));
    for (const pic of xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) ?? []) {
      const embed = pic.match(/r:embed="([^"]+)"/)?.[1];
      const ext = pic.match(/<a:ext cx="(\d+)" cy="(\d+)"/);
      if (!embed || !ext) continue;
      const target = rels.match(new RegExp(`Id="${embed}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${embed}"`))?.[1];
      if (!target) continue;
      const area = Number(ext[1]) * Number(ext[2]);
      const path = new URL(target, `file:///${src}`).pathname.slice(1);
      if (!best || area < best.area) best = { area, target: path };
    }
    if (best) break;
  }
  if (!best) return null;
  const mime = IMAGE_MIME[extname(best.target).toLowerCase()];
  const data = zip.get(best.target);
  return mime && data ? `data:${mime};base64,${data().toString('base64')}` : null;
}
