import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { Review } from '../types.ts';
import { render, resolvedBrand } from './generate.ts';
import { renderChecks } from '../deck/markdown.ts';
import { renderPptx } from '../deck/pptx.ts';

export interface Written {
  dir: string;
  deck: string;
  review: string;
  markdown: string | null;
  checks: string;
  pptx: string | null;
}

/** Writes everything for one review into a folder: the deck, the content, the summary, the check log and, when asked for, the .pptx. */
export async function writeOutputs(review: Review, config: Config, dir: string, options: { pptx?: boolean } = {}): Promise<Written> {
  mkdirSync(dir, { recursive: true });
  const pptx = options.pptx ?? config.output.pptx;
  const { html, markdown } = render(review, config, { pptxBeside: pptx });
  const files: Written = {
    dir,
    deck: join(dir, 'deck.html'),
    review: join(dir, 'review.json'),
    markdown: config.output.markdown ? join(dir, 'review.md') : null,
    checks: join(dir, 'checks.md'),
    pptx: pptx ? join(dir, 'deck.pptx') : null,
  };
  writeFileSync(files.deck, html);
  writeFileSync(files.review, JSON.stringify(review, null, 2) + '\n');
  if (files.markdown) writeFileSync(files.markdown, markdown);
  writeFileSync(files.checks, renderChecks(review));
  if (files.pptx) writeFileSync(files.pptx, await pptxOf(review, config));
  return files;
}

/** The review as a PowerPoint, in the config's brand: for deck.pptx and the editor's download. */
export function pptxOf(review: Review, config: Config): Promise<Buffer> {
  const brand = resolvedBrand(config);
  return renderPptx(review, { color: brand.color, logo: brand.logo, fonts: brand.fonts, labels: config.labels, goal: config.goal, theme: config.brand.theme, deck: config.deck });
}
