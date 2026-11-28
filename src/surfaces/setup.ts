import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { brandFromWebsite, isWebsite } from '../brand/website.ts';

/** What `init` asks, or takes from flags and guesses when there is no one to ask. */
export interface SetupAnswers {
  name: string;
  description: string;
  website: string | null;
  audience: string;
  /** screenshots.check: the AI may look at the screenshots, once there are any. Yes unless you say no. */
  checkScreens?: boolean;
  /** Only from the MCP server's init_sprint_review; init leaves the template's defaults. */
  organization?: string;
  language?: string;
  branch?: string;
}

/** Asks one question with a default; an empty answer keeps the default. */
export type Ask = (question: string, fallback: string) => Promise<string>;

export const AUDIENCE_CHOICES = ['business', 'executives', 'customers', 'team'];

/** The product name from package.json, else the folder. */
export function guessName(dir: string): string {
  return packageJson(dir)?.name?.replace(/^@[^/]+\//, '') || basename(dir);
}

/** The product's website from package.json's homepage, unless that is only its repository or npm page. */
export function guessWebsite(dir: string): string | null {
  const home = packageJson(dir)?.homepage ?? '';
  if (!isWebsite(home) || /^https?:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org|npmjs\.com)\//i.test(home)) return null;
  return home;
}

/**
 * Walks through the setup: product, description, website and audience. A website is read right
 * away, so you see the color, logo and fonts the deck will get before the first review.
 */
export async function askSetup(ask: Ask, start: SetupAnswers, say: (line: string) => void, fetchImpl: typeof fetch = fetch): Promise<SetupAnswers> {
  const name = (await ask('Product name', start.name)).trim() || start.name;
  const description = (await ask('What it is and who uses it, in a sentence (the AI explains changes with it)', start.description)).trim();
  let website: string | null = null;
  for (let tries = 0; tries < 3; tries++) {
    const answer = (await ask('Your website, for the logo, color and fonts of the deck (- to skip)', start.website ?? '')).trim();
    if (!answer || answer === '-') break;
    const url = /^https?:\/\//i.test(answer) ? answer : `https://${answer}`;
    const found = await brandSummary(url, fetchImpl);
    if (found) {
      say(`  Found on ${url}: ${found}`);
      website = url;
      break;
    }
    say(`  Could not read a brand from ${url}. Try another address, or - to skip and set brand.color and brand.logo yourself.`);
  }
  const audience = (await ask(`Who watches the review: ${AUDIENCE_CHOICES.join(', ')}, or your own words`, start.audience)).trim() || start.audience;
  // Asked, since it sends your screenshots to the model provider; Enter says yes.
  const check = (await ask('Let the AI look at your screenshots, once you add them, so no slide gets the wrong one? It sends them to your model provider (y/n)', start.checkScreens === false ? 'n' : 'y')).trim();
  return { name, description, website, audience, checkScreens: !/^n/i.test(check) };
}

/** What a website gives the deck, in a few words: "color #6965db, logo, font Assistant". Null when it gives nothing. */
export async function brandSummary(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const site = await brandFromWebsite(url, fetchImpl);
    const fonts = [...new Set([site.fonts.heading, site.fonts.body].filter(Boolean))];
    const parts = [site.color && `color ${site.color}`, site.logo && 'logo', fonts.length && `font${fonts.length > 1 ? 's' : ''} ${fonts.join(', ')}`].filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  } catch {
    return null;
  }
}

/** The config file: the template with the answers filled in, as JSON strings so a colon or quote can't break the YAML. Shared by init and the MCP server. */
export function configText(template: string, a: SetupAnswers): string {
  return template
    .replace('{{name}}', JSON.stringify(a.name))
    .replace('{{description}}', JSON.stringify(a.description))
    .replace('{{audience}}', AUDIENCE_CHOICES.includes(a.audience) ? a.audience : JSON.stringify(a.audience))
    .replace('{{website}}', a.website ? `from: ${a.website}` : '# from: https://www.example.com      # your website')
    .replace('organization: ""', `organization: ${JSON.stringify(a.organization ?? '')}`)
    .replace('language: English', `language: ${a.language ? JSON.stringify(a.language) : 'English'}`)
    .replace(/ {2}# branch: develop .*/, (line) => (a.branch ? `  branch: ${JSON.stringify(a.branch)}` : line))
    .replace('{{screenshots}}', screenshotLines(a.checkScreens ?? true));
}

/** The start of the screenshots block: check is on by default, so a no writes a real block that keeps it off. */
function screenshotLines(check: boolean): string {
  const about = '# the AI looks at each picture, so no slide gets the wrong one (sends them to your model provider)';
  return check ? `# screenshots:\n#   check: true                        ${about}` : `screenshots:\n  check: false                         ${about}`;
}

function packageJson(dir: string): { name?: string; homepage?: string } | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; homepage?: string };
  } catch {
    return null;
  }
}
