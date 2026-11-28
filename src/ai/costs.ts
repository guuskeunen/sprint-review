import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Config, ModelConfig } from '../config.ts';
import type { ModelAnswer, ModelClient, ModelRequest } from './model.ts';

/**
 * List prices in US dollars per million tokens, on the provider's own API. A price applies from
 * its date; add a row when a provider changes it. Output includes thinking: both providers bill
 * it as output. Sources, checked 2026-11-21:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * - Google: https://ai.google.dev/gemini-api/docs/pricing (standard paid tier)
 * Through Bedrock, Azure, OpenRouter or a gateway the price is theirs: set model.price.
 */
const LIST_PRICES: Record<'anthropic' | 'gemini', Record<string, [from: string, input: number, output: number][]>> = {
  anthropic: {
    'claude-fable-5-2': [['2026-01-01', 8, 40]],
    'claude-opus-5-5': [['2026-01-01', 4, 20]],
    'claude-opus-5': [['2026-01-01', 5, 25]],
    'claude-sonnet-5-5': [['2026-01-01', 2, 10]],
    'claude-sonnet-5': [['2026-01-01', 2, 10]],
    'claude-haiku-5-5': [['2026-01-01', 0.1, 0.5]],
  },
  gemini: {
    'gemini-3.6-flash': [['2026-01-01', 0.75, 3.75], ['2027-01-01', 1.5, 7.5]],
    'gemini-3.8-flash': [['2026-01-01', 0.75, 3.75], ['2027-01-01', 1.5, 7.5]],
    'gemini-3.5-flash-lite': [['2026-01-01', 0.3, 2.5]],
    'gemini-3.1-pro-preview': [['2026-01-01', 2, 12]],
  },
};

export interface Price {
  input: number;
  output: number;
  source: 'list' | 'config';
}

export interface Call {
  model: string;
  input: number;
  output: number;
}

export interface Cost {
  /** Estimated US dollars, or null when a model that answered has no known price. */
  usd: number | null;
  /** Models without a price: set model.price for them. */
  unpriced: string[];
}

/** The price of one model on a day: model.price from the config first, then the list prices. */
export function priceOf(config: ModelConfig, model: string, on: string): Price | null {
  if (config.price) return { ...config.price, source: 'config' };
  if (config.provider !== 'anthropic' && config.provider !== 'gemini') return null;
  const rows = LIST_PRICES[config.provider][model.replace(/^models\//, '')] ?? [];
  const row = rows.filter(([from]) => from <= on).at(-1);
  return row ? { input: row[1], output: row[2], source: 'list' } : null;
}

/** What the calls of one run cost, each at the price of the model that answered it. */
export function costOf(calls: Call[], config: ModelConfig, on: string): Cost {
  let usd = 0;
  const unpriced = new Set<string>();
  for (const c of calls) {
    const p = priceOf(config, c.model, on);
    if (p) usd += (c.input * p.input + c.output * p.output) / 1_000_000;
    else unpriced.add(c.model);
  }
  return { usd: unpriced.size ? null : usd, unpriced: [...unpriced] };
}

/** A model client that writes down every answer's model and tokens, for the cost of the run. */
export function metered(model: ModelClient, progress?: (message: string) => void): ModelClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async ask(request: ModelRequest): Promise<ModelAnswer> {
      const answer = await model.ask(progress ? { ...request, progress } : request);
      calls.push({ model: answer.model, input: answer.usage.input, output: answer.usage.output });
      return answer;
    },
  };
}

export interface LedgerEntry {
  date: string;
  from: string;
  until: string;
  provider: string;
  models: string[];
  input: number;
  output: number;
  usd: number | null;
}

const HEADER = 'date,from,until,provider,models,input_tokens,output_tokens,usd';

/**
 * Adds a run to <output.dir>/costs.csv and returns the total so far. The file is plain CSV, so a
 * spreadsheet opens it; runs without a known price are counted but not added up.
 */
export function recordCost(config: Config, e: LedgerEntry): { file: string; runs: number; usd: number; unpricedRuns: number } {
  const file = resolve(config.root, config.output.dir, 'costs.csv');
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) appendFileSync(file, `${HEADER}\n`);
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  appendFileSync(file, `${[e.date, e.from, e.until, e.provider, e.models.join(' '), e.input, e.output, e.usd === null ? '' : e.usd.toFixed(6)].map((v) => cell(String(v))).join(',')}\n`);
  let runs = 0;
  let usd = 0;
  let unpricedRuns = 0;
  for (const line of readFileSync(file, 'utf8').trim().split('\n').slice(1)) {
    runs++;
    const last = line.slice(line.lastIndexOf(',') + 1);
    if (last === '') unpricedRuns++;
    else usd += Number(last);
  }
  return { file, runs, usd: Math.round(usd * 1e6) / 1e6, unpricedRuns };
}

/** What the ledger needs from a finished run (a Generated result has it). */
export interface Run {
  review: { from: string; until: string };
  models: string[];
  usage: { input: number; output: number };
  cost: Cost;
}

/** What the last runs in the ledger cost, oldest first, at most five; empty without a ledger. */
export function pastCosts(config: Config): number[] {
  const file = resolve(config.root, config.output.dir, 'costs.csv');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').slice(1).map((line) => line.slice(line.lastIndexOf(',') + 1)).filter((v) => v !== '').map(Number).slice(-5);
}

/** Adds a finished run to the ledger. */
export function recordRun(config: Config, result: Run, date = new Date().toISOString().slice(0, 10)) {
  return recordCost(config, { date, from: result.review.from, until: result.review.until, provider: config.model.provider, models: result.models, input: result.usage.input, output: result.usage.output, usd: result.cost.usd });
}

/** One line on what a run cost, for the CLI and the MCP server. */
export function costLine(result: Run, total: { runs: number; usd: number; unpricedRuns: number }): string {
  const run = result.cost.usd === null
    ? `cost unknown: no price for ${result.cost.unpriced.join(', ')} (set model.price)`
    : `about ${dollars(result.cost.usd)}`;
  const priced = total.runs - total.unpricedRuns;
  return `${run} · ${priced ? `${dollars(total.usd)} over ${priced} priced run${priced === 1 ? '' : 's'} so far` : 'no priced runs yet'}`;
}

/** "$0.03", "<$0.01" or "$1.24": what a person reads, not a float. */
export function dollars(usd: number): string {
  return usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}
