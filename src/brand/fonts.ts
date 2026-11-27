import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

/** A font file inside the deck, so it looks the same on any laptop, whatever is installed. */
export interface FontFace {
  family: string;
  weight: number;
  /** The top of the weight range a variable font file covers (300 to 800); absent for one weight. */
  maxWeight?: number;
  style: 'normal' | 'italic';
  /** A data URI. */
  data: string;
}

const MIME: Record<string, string> = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };
/** The fonts ride inside every deck: keep them to a few weights. */
export const MAX_FONT_BYTES = 2 * 1024 * 1024;

/**
 * The font files from brand.fontFiles, by family: `{ Inter: [inter-latin-400-normal.woff2, ...] }`.
 * The weight comes from the file name (400, 700) and is 400 when it has none; "italic" in the name
 * makes it italic. Missing files and files past 2 MB in all are left out, with a message.
 */
export function fontFaces(files: Record<string, string[]>, root: string, onSkip: (message: string) => void = () => {}): FontFace[] {
  const out: FontFace[] = [];
  let total = 0;
  for (const [family, paths] of Object.entries(files)) {
    for (const path of paths) {
      const file = resolve(root, path);
      const mime = MIME[extname(file).toLowerCase()];
      if (!mime || !existsSync(file)) {
        onSkip(`Font file not found or not a font: ${path}`);
        continue;
      }
      const data = readFileSync(file);
      if (total + data.length > MAX_FONT_BYTES) {
        onSkip(`Font file left out, the fonts pass 2 MB: ${path}`);
        continue;
      }
      total += data.length;
      const name = basename(file).toLowerCase();
      const weight = Number(/(?:^|[-_ ])([1-9]00)(?=[-_ .]|$)/.exec(name)?.[1] ?? 400);
      out.push({ family, weight, style: /italic/.test(name) ? 'italic' : 'normal', data: `data:${mime};base64,${data.toString('base64')}` });
    }
  }
  return out;
}

/** The @font-face rules for the deck. Family names are cleaned like the font stacks are. */
export function fontFaceCss(faces: FontFace[]): string {
  return faces
    .filter((f) => /^data:font\/(woff2|woff|ttf|otf);base64,[A-Za-z0-9+/=]+$/.test(f.data))
    .map((f) => `@font-face { font-family: "${f.family.replace(/[^\p{L}\p{N} ._-]/gu, '')}"; font-weight: ${Math.round(f.weight)}${f.maxWeight && f.maxWeight > f.weight ? ` ${Math.round(f.maxWeight)}` : ''}; font-style: ${f.style === 'italic' ? 'italic' : 'normal'}; font-display: block; src: url(${f.data}); }`)
    .join('\n');
}

/** The font type of a file by its first bytes: woff2, woff, ttf or otf; null for anything else. */
export function fontMime(data: Buffer): string | null {
  const head = data.subarray(0, 4).toString('latin1');
  if (head === 'wOF2') return 'font/woff2';
  if (head === 'wOFF') return 'font/woff';
  if (head === 'OTTO') return 'font/otf';
  if (data.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) || head === 'true') return 'font/ttf';
  return null;
}
