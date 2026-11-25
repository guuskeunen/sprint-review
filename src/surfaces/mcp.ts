import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig, normalize, type Config } from '../config.ts';
import { withWebsiteBrand } from '../brand/website.ts';
import { costLine, recordRun } from '../ai/costs.ts';
import { generate, missedWork, onBranch, sprintRange } from '../review/generate.ts';
import { History, type Range } from '../git/history.ts';
import { clientFor } from '../ai/providers.ts';
import { commitLog } from '../ai/prompt.ts';
import { writeOutputs } from '../review/output.ts';
import { doctorChecks } from './doctor.ts';
import { validReview } from './editor.ts';
import type { Review } from '../types.ts';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string };
const PROTOCOL = '2025-06-18';

const DIR = { type: 'string', description: 'The project folder: a git repository, with or without sprint-review.config.yml. Default: the folder the server started in.' };
const DAY = '^\\d{4}-\\d{2}-\\d{2}$';
const RANGE = {
  since: { type: 'string', pattern: DAY, description: 'First day of the sprint, YYYY-MM-DD. Default: the configured sprint length (two weeks unless set) back from until.' },
  until: { type: 'string', pattern: DAY, description: 'Last day of the sprint, YYYY-MM-DD. Default: today.' },
  from: { type: 'string', description: 'Start after this tag or commit instead of a date, e.g. v1.4.0.' },
  to: { type: 'string', description: 'End at this tag, branch or commit (with from), or the branch the days are counted on (with dates), e.g. origin/develop. Default: sprint.branch from the config, else HEAD.' },
};

export const TOOLS = [
  {
    name: 'check_sprint_review_setup',
    title: 'Check the setup',
    description:
      'Check that a project is ready for a sprint review: git history, the model and its API key, screenshots and brand files. Returns one line per check, each marked ok or with what to fix. Reads only; no model call. Use it first in a new project.',
    inputSchema: { type: 'object', properties: { directory: DIR }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'preview_sprint_commits',
    title: 'Preview the commits',
    description:
      'List the commits a sprint review would be written from, with how many touch product code. Reads only; no model call, no cost. Use it to check the range before generate_sprint_review.',
    inputSchema: { type: 'object', properties: { directory: DIR, ...RANGE }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'generate_sprint_review',
    title: 'Generate a sprint review',
    description:
      'Write a sprint review deck from the git history: themes in business language, each point checked against the real commits, with screenshots when configured. Writes deck.html, review.json, review.md and checks.md (and deck.pptx when asked) and returns their paths, the check log and the cost. Replaces an earlier deck in the same folder. Calls the configured model, so it needs that provider\'s key in the server environment (ANTHROPIC_API_KEY by default, or GEMINI_API_KEY, OPENAI_API_KEY and others); a review costs about $0.02 to $0.30. Reads pull requests from GitHub when GITHUB_TOKEN is set. Takes 20 seconds to 3 minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: DIR,
        ...RANGE,
        out: { type: 'string', description: 'Folder to write to. Default: sprint-reviews/<last day of the sprint>.' },
        pptx: { type: 'boolean', description: 'Also write deck.pptx, an editable PowerPoint with speaker notes. Default: false.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'render_sprint_review',
    title: 'Rebuild an edited deck',
    description:
      'Rebuild deck.html and review.md from a review.json that was edited by hand, with the current brand settings. Returns the path of the deck. No model call, no cost. Use it after changing review.json instead of generating again.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Path to the review.json to render, e.g. sprint-reviews/2026-11-22/review.json.' }, directory: DIR }, required: ['file'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

type Args = Record<string, unknown>;

function configIn(dir: string): Config {
  try {
    return loadConfig(null, dir);
  } catch (e) {
    if (/No config found/.test((e as Error).message)) return normalize({}, dir);
    throw e;
  }
}

function rangeOf(a: Args, config: Config): Range {
  const s = (k: string) => (typeof a[k] === 'string' && a[k] ? (a[k] as string) : undefined);
  if (s('from')) return { kind: 'refs', from: s('from')!, to: s('to') ?? 'HEAD' };
  for (const k of ['since', 'until']) if (s(k) && !/^\d{4}-\d{2}-\d{2}$/.test(s(k)!)) throw new Error(`${k} must be a date like 2026-11-10.`);
  // With dates, to is the branch the days are counted on.
  const at = s('to') ? { at: s('to')! } : {};
  if (s('since')) return { kind: 'dates', from: s('since')!, until: s('until') ?? new Date().toISOString().slice(0, 10), ...at };
  return { ...sprintRange(config.sprint.days, s('until')), ...at };
}

/** The folder, when it is a project: it has a sprint-review config or is a git repository. */
function project(dir: string): string {
  const marks = ['.git', 'sprint-review.config.yml', 'sprint-review.config.yaml', 'sprint-review.config.json'];
  if (!marks.some((m) => existsSync(join(dir, m)))) throw new Error(`${dir} is not inside the project: give the project folder, with a sprint-review config or a git repository.`);
  return dir;
}

/** The path, when it lies inside root (the project); anything else is refused. */
function inside(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${path} is not inside the project (${root}): the MCP server only reads and writes there.`);
  return path;
}

/** Runs one tool call. Exported for tests. */
export async function callTool(name: string, a: Args, cwd = process.cwd()): Promise<string> {
  // An assistant chooses these arguments, and text it read can steer it: the folder must be a
  // project (a config or a git repository), and files are read and written only inside it.
  const dir = project(resolve(cwd, typeof a.directory === 'string' ? a.directory : '.'));
  if (name === 'check_sprint_review_setup') {
    const lines = await doctorChecks(configIn(dir), dir);
    return lines.map((l) => `${l.ok ? '✓' : '✗'} ${l.text}${l.fix ? `\n  fix: ${l.fix}` : ''}`).join('\n');
  }
  if (name === 'preview_sprint_commits') {
    const config = await withWebsiteBrand(configIn(dir));
    const history = new History(config.repo);
    const range = onBranch(rangeOf(a, config), config, history);
    history.assertUsable(range);
    const commits = history.commits(range, config.productPaths, config.ignore, config.limits.commits, config.nonProductTypes);
    const missed = missedWork(range, config, history);
    const read = range.kind === 'dates' ? ` on ${range.at ?? 'HEAD'}` : '';
    return `${commits.length} commits${read} (${commits.filter((c) => c.product).length} touch product code)${missed ? `\n\nWarning: ${missed}` : ''}\n\n${commitLog(commits).slice(0, 20000)}`;
  }
  if (name === 'render_sprint_review') {
    if (typeof a.file !== 'string') throw new Error('file is required.');
    const file = inside(dir, resolve(dir, a.file));
    const review = validReview(JSON.parse(readFileSync(file, 'utf8')) as Review);
    const out = await writeOutputs(review, await withWebsiteBrand(configIn(dir)), dirname(file));
    return `Rebuilt ${out.deck}`;
  }
  if (name === 'generate_sprint_review') {
    const config = await withWebsiteBrand(configIn(dir));
    const result = await generate(config, { model: clientFor(config.model), range: rangeOf(a, config) });
    const outDir = inside(dir, resolve(config.root, typeof a.out === 'string' ? a.out : join(config.output.dir, result.review.until)));
    const files = await writeOutputs(result.review, config, outDir, { pptx: a.pptx === true ? true : undefined });
    const ledger = recordRun(config, result);
    const checks = result.review.checks.map((c) => `- ${c.kind}: ${c.text}${c.reason ? ` (${c.reason})` : ''}`).join('\n') || '- none';
    return [
      `Wrote ${result.review.themes.length} themes and ${result.review.screens.length} before-and-after slides.`,
      `Deck: ${files.deck}`,
      `Content (edit, then render): ${files.review}`,
      files.pptx ? `PowerPoint: ${files.pptx}` : '',
      `Checks: ${files.checks}`,
      `Cost: ${costLine(result, ledger)} (${ledger.file})`,
      '',
      'Themes:',
      ...result.review.themes.map((t) => `- ${t.title}: ${t.effect ?? ''}`),
      '',
      'What the checks did:',
      checks,
    ].filter((l) => l !== '').join('\n');
  }
  throw new Error(`Unknown tool ${name}.`);
}

/** Answers one JSON-RPC message; null for notifications. */
export async function handle(msg: { id?: number | string | null; method?: string; params?: Record<string, unknown> }, cwd = process.cwd()): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null;
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'sprint-review', version: pkg.version },
        instructions: 'Generates sprint review decks from git history. Check the setup first, preview the commits, then generate. Report the checks to the user.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool ${name}`);
      try {
        const text = await callTool(name, (msg.params?.arguments as Args) ?? {}, cwd);
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** The MCP server over stdio: one JSON message per line in, one per line out. Logs go to stderr. */
export function serveMcp(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    handle(msg).then((answer) => {
      if (answer) process.stdout.write(JSON.stringify(answer) + '\n');
    });
  });
}
