#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, findConfigFile, loadConfig, normalize, type Config } from './config.ts';
import { generate, missedWork, NothingToReview, onBranch, rangeFor } from './review/generate.ts';
import { GitError, History, type Range } from './git/history.ts';
import { ModelError } from './ai/model.ts';
import { clientFor } from './ai/providers.ts';
import { writeOutputs } from './review/output.ts';
import { doctorChecks } from './surfaces/doctor.ts';
import { startEditor, validReview } from './surfaces/editor.ts';
import { serveMcp } from './surfaces/mcp.ts';
import { capture, CaptureError } from './screens/capture.ts';
import { postToSlack } from './surfaces/slack.ts';
import { PptxError } from './deck/pptx.ts';
import { withWebsiteBrand } from './brand/website.ts';
import { costLine, dollars, pastCosts, priceOf, recordRun } from './ai/costs.ts';
import { fitLog, writerSystem } from './ai/prompt.ts';
import { ICONS } from './deck/icons-data.ts';
import { WriterError } from './ai/writer.ts';
import type { Review } from './types.ts';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string };
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1');
const dim = c('2');
const green = c('32');
const red = c('31');
const yellow = c('33');
const orange = c('38;5;208');

const HELP = `${bold('sprint-review')} ${dim(`v${pkg.version}`)}
Turn a sprint's git history into a sprint review deck that anyone can follow.

${bold('Usage')}
  sprint-review <command> [options]

${bold('Commands')}
  generate        Write the review for a sprint (default command)
  init            Create sprint-review.config.yml in this folder
  render <file>   Rebuild the deck from an edited review.json
  edit <file>     Edit a review.json in your browser, with the deck beside it
  capture         Take today's screenshots of the pages in the config
  doctor          Check that everything is set up
  mcp             Run as an MCP server (for Claude Code, Cursor and others)
  icons           List the icons themes can use

${bold('Options for generate')}
  --since <date>    First day of the sprint (YYYY-MM-DD)
  --until <date>    Last day of the sprint (default: today)
  --from <ref>      Start at a tag or commit instead of a date
  --to <ref>        End at a tag or commit, or with dates the branch to read
                    (default: sprint.branch, else HEAD)
  --out <dir>       Where to write (default: sprint-reviews/<date>)
  --pptx            Also write deck.pptx (needs pptxgenjs)
  --slack           Post the summary to SLACK_WEBHOOK_URL
  --deck-url <url>  Link to the published deck, for the Slack message
  --dry-run         Show what would be sent to the AI, without calling it
  --no-edit         Don't open the editor afterwards (it never opens in CI or without a terminal)
  -c, --config      Path to the config file
  -q, --quiet       Only print the paths of what was written
  --json            Print the result as JSON

${bold('Environment')}
  ANTHROPIC_API_KEY   Your Anthropic API key. Other providers (model.provider in the config):
                      OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY,
                      AZURE_OPENAI_API_KEY, AWS_BEARER_TOKEN_BEDROCK; none for ollama or lmstudio
  GITHUB_TOKEN        Optional: adds pull request descriptions as context
  SLACK_WEBHOOK_URL   Optional: where --slack posts

Docs: https://github.com/guuskeunen/sprint-review#readme`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      out: { type: 'string' },
      pptx: { type: 'boolean' },
      slack: { type: 'boolean' },
      'deck-url': { type: 'string' },
      port: { type: 'string' },
      config: { type: 'string', short: 'c' },
      'dry-run': { type: 'boolean' },
      'no-edit': { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      json: { type: 'boolean' },
      force: { type: 'boolean' },
      preset: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.version) return out(pkg.version), 0;
  const command = positionals[0] ?? 'generate';
  if (values.help || command === 'help') return out(HELP), 0;

  switch (command) {
    case 'init':
      return init(values.force ?? false, values.preset);
    case 'icons':
      return icons();
    case 'doctor':
      return doctor(values.config);
    case 'render':
      return rerender(positionals[1], values.config, values.pptx);
    case 'edit':
      return edit(positionals[1], values.config, values.port);
    case 'capture':
      return shoot(values.config);
    case 'mcp':
      serveMcp();
      return new Promise<number>(() => {});
    case 'generate':
      return run(values);
    default:
      err(`Unknown command "${command}". Run ${bold('sprint-review --help')} to see what it can do.`);
      return 2;
  }
}

type Flags = { 'no-edit'?: boolean; since?: string; until?: string; from?: string; to?: string; out?: string; config?: string; 'dry-run'?: boolean; quiet?: boolean; json?: boolean; pptx?: boolean; slack?: boolean; 'deck-url'?: string };

async function run(flags: Flags): Promise<number> {
  const config = await withWebsiteBrand(configOrDefaults(flags.config));
  const range = rangeFrom(flags, config);
  const quiet = flags.quiet || flags.json;

  if (flags['dry-run']) return dryRun(config, range);

  const model = clientFor(config.model);
  if (!quiet) out(`${orange('●')} ${bold('sprint-review')} ${dim(`v${pkg.version}`)}\n`);
  const started = Date.now();
  const result = await generate(config, { model, range, onStep: quiet ? undefined : (m) => out(`  ${dim('›')} ${m}`) });

  const dir = resolve(config.root, flags.out ?? join(config.output.dir, result.review.until));
  const written = await writeOutputs(result.review, config, dir, { pptx: flags.pptx ? true : undefined });
  const files = Object.fromEntries(Object.entries({ deck: written.deck, review: written.review, markdown: written.markdown, checks: written.checks, pptx: written.pptx }).filter(([, v]) => v)) as Record<string, string>;

  let slack: string | null = null;
  if (flags.slack || config.slack) {
    const hook = process.env.SLACK_WEBHOOK_URL;
    if (!hook) slack = 'SLACK_WEBHOOK_URL is not set: nothing posted';
    else {
      try {
        await postToSlack(hook, result.review, flags['deck-url'] ?? process.env.SPRINT_REVIEW_DECK_URL ?? null);
        slack = 'posted';
      } catch (e) {
        slack = (e as Error).message;
      }
    }
  }

  const ledger = recordRun(config, result);

  if (flags.json) {
    out(JSON.stringify({ ...files, dir, themes: result.review.themes.length, checks: result.review.checks.length, usage: result.usage, cost: { ...result.cost, models: result.models, ledger: ledger.file, totalUsd: ledger.usd, runs: ledger.runs }, ...(slack ? { slack } : {}) }, null, 2));
    return 0;
  }
  if (flags.quiet) {
    out(Object.values(files).join('\n'));
    return 0;
  }
  const rel = shown;
  const warnings = result.review.checks.filter((x) => x.kind === 'warning').length;
  out(`\n${green('✓')} ${bold(`${result.review.themes.length} themes`)}, ${result.review.screens.length} before-and-after slides, ${result.review.checks.length} checks ${dim(`(${((Date.now() - started) / 1000).toFixed(0)}s, ${(result.usage.input + result.usage.output).toLocaleString('en-US')} tokens)`)}\n`);
  out(`  ${bold('Deck')}     ${rel(files.deck!)}`);
  out(`  ${bold('Content')}  ${rel(files.review!)} ${dim('edit this, then run sprint-review render')}`);
  out(`  ${bold('Checks')}   ${rel(files.checks!)}${warnings ? yellow(` ${warnings} to look at`) : ''}`);
  if (files.markdown) out(`  ${bold('Summary')}  ${rel(files.markdown)}`);
  if (files.pptx) out(`  ${bold('PowerPoint')} ${rel(files.pptx)}`);
  if (slack) out(`  ${bold('Slack')}    ${slack === 'posted' ? green('posted') : yellow(slack)}`);
  out(`  ${bold('Cost')}     ${costLine(result, ledger)} ${dim(rel(ledger.file))}`);
  // In a terminal the review opens in the editor: click a text to change it, saving rebuilds the deck.
  if (process.stdout.isTTY && !process.env.CI && !flags['no-edit']) {
    out('');
    return edit(files.review, flags.config, undefined);
  }
  out(`\n  ${dim('Change anything:')} sprint-review edit ${rel(files.review!)}`);
  out('');
  return 0;
}

function dryRun(config: Config, asked: Range): number {
  const history = new History(config.repo);
  const range = onBranch(asked, config, history);
  history.assertUsable(range);
  const missed = missedWork(range, config, history);
  const commits = history.commits(range, config.productPaths, config.ignore, config.limits.commits, config.nonProductTypes);
  const prompt = writerSystem(config);
  const log = fitLog(commits, config.model.maxInputChars).log;
  const tokens = Math.round((prompt.length + log.length) / 3.5) + 3000;
  out(`${bold('Dry run')} ${dim('nothing is sent')}\n`);
  out(`${bold('Range')}     ${range.kind === 'dates' ? `${range.from} to ${range.until} on ${range.at ?? 'HEAD'}` : `${range.from}..${range.to}`}`);
  if (missed) out(`${orange('Warning')}   ${missed}`);
  out(`${bold('Commits')}   ${commits.length} (${commits.filter((x) => x.product).length} touch product code)`);
  out(`${bold('Model')}     ${config.model.name} ${dim(`via ${config.model.provider}`)}${config.model.fallback ? dim(` (fallback ${config.model.fallback})`) : ''}`);
  out(`${bold('Estimate')}  about ${tokens.toLocaleString('en-US')} input tokens for the writer and the reader`);
  const price = priceOf(config.model, config.model.name, new Date().toISOString().slice(0, 10));
  // The writer and the reader both read the commits (and a revision reads the draft again), so the
  // input counts about twice. Output grows with the sprint: about 600 tokens a product commit, at
  // most 30,000 (a sprint of 42 product commits wrote 25,000), and a third of that at least.
  const most = Math.min(30000, 4000 + 600 * commits.filter((x) => x.product).length);
  if (price) out(`${bold('Cost')}      about ${dollars((2 * tokens * price.input + (most / 3) * price.output) / 1e6)} to ${dollars((2 * tokens * price.input + most * price.output) / 1e6)} ${dim(price.source === 'config' ? '(model.price)' : '(list price)')}`);
  else out(`${bold('Cost')}      ${dim('unknown for this provider: set model.price to see it')}`);
  const past = pastCosts(config);
  if (past.length) out(`${bold('Last runs')} ${past.map((usd) => dollars(usd)).join(', ')} ${dim(`(${shown(resolve(config.root, config.output.dir, 'costs.csv'))})`)}`);
  out('');
  for (const cm of commits.slice(0, 40)) out(`  ${dim(cm.hash)} ${cm.subject}${cm.product ? '' : dim(' [no product code]')}`);
  if (commits.length > 40) out(dim(`  … and ${commits.length - 40} more`));
  return 0;
}

async function rerender(file: string | undefined, configPath: string | undefined, pptx: boolean | undefined): Promise<number> {
  if (!file) {
    err('Give the path of a review.json: sprint-review render sprint-reviews/2026-11-10/review.json');
    return 2;
  }
  const path = resolve(file);
  if (!existsSync(path)) {
    err(`No file at ${file}. Give the review.json in a review's folder, such as sprint-reviews/2026-11-10/review.json.`);
    return 2;
  }
  let review: Review;
  try {
    review = validReview(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    err(`${file}: ${(e as Error).message}`);
    return 2;
  }
  // The review's own project: its config is found from the review's folder, wherever render runs.
  const config = await withWebsiteBrand(configOrDefaults(configPath, dirname(path)));
  const written = await writeOutputs(review, config, dirname(path), { pptx: pptx ? true : undefined });
  out(`${green('✓')} Rebuilt ${shown(written.deck)}${written.pptx ? ` and ${shown(written.pptx)}` : ''}`);
  return 0;
}

async function edit(file: string | undefined, configPath: string | undefined, port: string | undefined): Promise<number> {
  if (!file) {
    err('Give the path of a review.json: sprint-review edit sprint-reviews/2026-11-10/review.json');
    return 2;
  }
  const config = await withWebsiteBrand(configOrDefaults(configPath));
  const editor = await startEditor(resolve(file), config, port ? Number(port) : 4321);
  out(`${orange('●')} ${bold('Editor')} running at ${bold(editor.url)}`);
  out(dim('  Save rebuilds deck.html next to the review. Ctrl+C stops the editor.'));
  openBrowser(editor.url);
  return new Promise<number>((done) => process.on('SIGINT', () => editor.close().then(() => done(0))));
}

async function shoot(configPath: string | undefined): Promise<number> {
  const config = configOrDefaults(configPath);
  if (config.screenshots.source !== 'capture') {
    err('capture needs screenshots.source: capture in the config, with the pages to photograph. See docs/screenshots.md.');
    return 2;
  }
  const files = await capture(config.screenshots.capture, config.root, undefined, (m) => out(`  ${dim('›')} ${m}`));
  out(`${green('✓')} ${files.length} screenshot${files.length === 1 ? '' : 's'} in ${shown(dirname(files[0] ?? config.screenshots.capture.dir)) || '.'}`);
  return 0;
}

function openBrowser(url: string): void {
  if (process.env.CI || !process.stdout.isTTY) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  import('node:child_process').then(({ spawn }) => {
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    } catch {}
  });
}

async function doctor(configPath: string | undefined): Promise<number> {
  out(`${bold('sprint-review doctor')}\n`);
  const show = (good: boolean, text: string, fix?: string) => out(`${good ? green('✓') : red('✗')} ${text}${!good && fix ? `\n    ${dim(fix)}` : ''}`);
  let config: Config;
  try {
    config = configOrDefaults(configPath);
    show(true, configPath || findConfigFile() ? `Config read from ${shown(config.root) || '.'}` : 'No config file: using defaults');
  } catch (e) {
    show(false, (e as Error).message);
    return 1;
  }
  const lines = await doctorChecks(config);
  for (const l of lines) show(l.ok, l.text, l.fix);
  const ok = lines.every((l) => l.ok);
  out(ok ? `\n${green('All set.')} Run ${bold('sprint-review generate')}.` : `\n${yellow('Fix the items above, then run doctor again.')}`);
  return ok ? 0 : 1;
}

function icons(): number {
  const keys = Object.entries(ICONS);
  const width = Math.max(...keys.map(([k]) => k.length));
  for (const [k, v] of keys) out(`  ${k.padEnd(width)}  ${dim(v.label)}`);
  return 0;
}

function init(force: boolean, preset: string | undefined): number {
  const file = resolve('sprint-review.config.yml');
  if (existsSync(file) && !force) {
    err(`${basename(file)} already exists. Use --force to replace it.`);
    return 1;
  }
  const template = readFileSync(fileURLToPath(new URL('../assets/config.template.yml', import.meta.url)), 'utf8');
  const name = guessName();
  const audience = preset && ['business', 'executives', 'customers', 'team'].includes(preset) ? preset : 'business';
  writeFileSync(file, template.replace('{{name}}', name).replace('{{audience}}', audience));
  out(`${green('✓')} Created ${basename(file)}\n`);
  out(`Next:\n  1. Fill in the product description and audience\n  2. export ANTHROPIC_API_KEY=...\n  3. ${bold('npx @guuskeunen/sprint-review --dry-run')} to see what it will read\n  4. ${bold('npx @guuskeunen/sprint-review')} to write the review`);
  return 0;
}

/** Works without a config: sensible defaults, the product named after the folder or package.json. */
/** The config given, else the one found from `from` upward in the repository (the current folder, or a review's folder). */
function configOrDefaults(path: string | undefined, from = process.cwd()): Config {
  if (path) return loadConfig(path);
  const found = findConfigFile(from);
  if (found) return loadConfig(found);
  return normalize({ product: { name: guessName() } }, process.cwd());
}

function guessName(): string {
  try {
    const p = JSON.parse(readFileSync('package.json', 'utf8')) as { name?: string };
    if (p.name) return p.name.replace(/^@[^/]+\//, '');
  } catch {}
  return basename(process.cwd());
}

function rangeFrom(flags: Flags, config: Config): Range {
  try {
    return rangeFor(flags, config.sprint.days, (option) => `--${option}`);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
}

function out(s: string): void {
  process.stdout.write(s + '\n');
}
function err(s: string): void {
  process.stderr.write(`${red('error')} ${s}\n`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    // A mistyped option is the user's to fix, not a crash: no stack trace, a pointer to the options.
    const badOption = e instanceof Error && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS');
    const known = badOption || e instanceof ConfigError || e instanceof GitError || e instanceof ModelError || e instanceof WriterError || e instanceof NothingToReview || e instanceof CaptureError || e instanceof PptxError;
    err(badOption ? `${(e as Error).message.split('. ')[0]}. Run sprint-review --help to see the options.` : e instanceof Error ? e.message : String(e));
    if (!known && e instanceof Error && e.stack) process.stderr.write(dim(e.stack) + '\n');
    process.exit(1);
  },
);

/** A path as the user can follow it: relative to where they are, absolute when it lies outside. */
function shown(p: string): string {
  const r = relative(process.cwd(), p);
  return r === '' ? '.' : r.startsWith('..') || isAbsolute(r) ? p : r;
}
