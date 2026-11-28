import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { costOf, metered, pastCosts, priceOf, recordCost } from '../../src/ai/costs.ts';
import { normalize } from '../../src/config.ts';
import { clientFor } from '../../src/ai/providers.ts';
import type { ModelAnswer, ModelClient } from '../../src/ai/model.ts';

const model = (provider: string, name: string, price?: unknown) => normalize({ model: { provider, name, ...(price ? { price } : {}) } }, '/tmp').model;

test('list prices: Claude and Gemini by date, nothing guessed for other providers', () => {
  assert.deepEqual(priceOf(model('anthropic', 'claude-opus-5-5'), 'claude-opus-5-5', '2026-11-21'), { input: 4, output: 20, source: 'list' });
  assert.deepEqual(priceOf(model('gemini', 'gemini-3.6-flash'), 'models/gemini-3.6-flash', '2026-11-21'), { input: 0.75, output: 3.75, source: 'list' });
  assert.deepEqual(priceOf(model('gemini', 'gemini-3.6-flash'), 'gemini-3.6-flash', '2027-02-01'), { input: 1.5, output: 7.5, source: 'list' });
  assert.equal(priceOf(model('bedrock', 'us.anthropic.claude-opus-5-5-v1:0'), 'us.anthropic.claude-opus-5-5-v1:0', '2026-11-21'), null, 'partner prices differ');
  assert.equal(priceOf(model('openai', 'gpt-x'), 'gpt-x', '2026-11-21'), null);
  assert.deepEqual(priceOf(model('openai', 'gpt-x', { input: 1, output: 4 }), 'gpt-x', '2026-11-21'), { input: 1, output: 4, source: 'config' });
});

test('each call is priced at the model that answered it, so a fallback costs what it costs', () => {
  const calls = [
    { model: 'claude-opus-5-5', input: 10_000, output: 2_000 },
    { model: 'claude-sonnet-5-5', input: 10_000, output: 2_000 },
  ];
  const cost = costOf(calls, model('anthropic', 'claude-opus-5-5'), '2026-11-21');
  assert.equal(cost.usd, (10_000 * 4 + 2_000 * 20 + 10_000 * 2 + 2_000 * 10) / 1e6);
  assert.deepEqual(cost.unpriced, []);
  const unknown = costOf([{ model: 'gpt-x', input: 5, output: 5 }], model('openai', 'gpt-x'), '2026-11-21');
  assert.equal(unknown.usd, null);
  assert.deepEqual(unknown.unpriced, ['gpt-x']);
});

test('the metered client records every answer without changing it', async () => {
  const answers: ModelAnswer[] = [
    { toolInput: { a: 1 }, model: 'm1', usage: { input: 5, output: 2 } },
    { toolInput: null, model: 'm2', usage: { input: 7, output: 3 } },
  ];
  const inner: ModelClient = { ask: async () => answers.shift()! };
  const m = metered(inner);
  assert.deepEqual((await m.ask({ system: '', messages: [], tool: { name: 't', description: '', input_schema: {} }, maxTokens: 1 })).toolInput, { a: 1 });
  await m.ask({ system: '', messages: [], tool: { name: 't', description: '', input_schema: {} }, maxTokens: 1 });
  assert.deepEqual(m.calls, [{ model: 'm1', input: 5, output: 2 }, { model: 'm2', input: 7, output: 3 }]);
});

test("Gemini's thinking counts as output, as Google bills it", async () => {
  const reply = { model: 'gemini-3.6-flash', usage: { prompt_tokens: 15_891, completion_tokens: 497, total_tokens: 23_887 }, choices: [{ finish_reason: 'stop', message: { tool_calls: [{ function: { name: 't', arguments: '{}' } }] } }] };
  const impl = (async () => new Response(JSON.stringify(reply))) as unknown as typeof fetch;
  const answer = await clientFor({ provider: 'gemini', name: 'gemini-3.6-flash', fallback: null }, { GEMINI_API_KEY: 'k' }, impl).ask({ system: '', messages: [], tool: { name: 't', description: '', input_schema: {} }, maxTokens: 100 });
  assert.deepEqual(answer.usage, { input: 15_891, output: 7_996 });
});

test('every run is added to a cost ledger with the total so far', () => {
  const dir = mkdtempSync(join(tmpdir(), 'costs-'));
  const config = normalize({ output: { dir: 'out' } }, dir);
  recordCost(config, { date: '2026-11-21', from: '2026-11-08', until: '2026-11-21', provider: 'anthropic', models: ['claude-opus-5-5'], input: 1000, output: 500, usd: 0.014 });
  const second = recordCost(config, { date: '2026-11-22', from: '2026-11-09', until: '2026-11-22', provider: 'anthropic', models: ['claude-opus-5-5'], input: 1000, output: 500, usd: null });
  const csv = readFileSync(join(dir, 'out', 'costs.csv'), 'utf8').trim().split('\n');
  assert.equal(csv[0], 'date,from,until,provider,models,input_tokens,output_tokens,usd');
  assert.equal(csv[1], '2026-11-21,2026-11-08,2026-11-21,anthropic,claude-opus-5-5,1000,500,0.014000');
  assert.equal(csv[2], '2026-11-22,2026-11-09,2026-11-22,anthropic,claude-opus-5-5,1000,500,');
  assert.deepEqual(second, { file: join(dir, 'out', 'costs.csv'), runs: 2, usd: 0.014, unpricedRuns: 1 });
});

test('model.price must be two non-negative numbers', () => {
  assert.throws(() => model('openai', 'gpt-x', { input: -1, output: 2 }), /model.price/);
  assert.throws(() => model('openai', 'gpt-x', { input: 1 }), /model.price/);
});

test('the dry run can show what the last runs cost: the last five priced runs from the ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprint-review-past-'));
  const config = normalize({}, dir);
  assert.deepEqual(pastCosts(config), []);
  mkdirSync(join(dir, 'sprint-reviews'));
  writeFileSync(join(dir, 'sprint-reviews', 'costs.csv'), ['date,from,until,provider,models,input_tokens,output_tokens,usd', ...[0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((usd, i) => `2026-11-0${i + 1},a,b,anthropic,m,1,1,${usd}`), '2026-11-08,a,b,ollama,m,1,1,'].join('\n') + '\n');
  assert.deepEqual(pastCosts(config), [0.2, 0.3, 0.4, 0.5, 0.6]);
});
