import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool, handle, TOOLS } from '../../src/surfaces/mcp.ts';
import { demoRepo } from '../helpers.ts';

test('the MCP server answers initialize, lists its tools and runs them', async () => {
  const dir = demoRepo();
  const init = await handle({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal((init!.result as any).serverInfo.name, 'sprint-review');
  assert.equal(await handle({ method: 'notifications/initialized' }), null);
  const list = await handle({ id: 2, method: 'tools/list' });
  assert.deepEqual((list!.result as any).tools.map((t: any) => t.name), TOOLS.map((t) => t.name));
  const preview = await handle({ id: 3, method: 'tools/call', params: { name: 'preview_sprint_commits', arguments: { directory: dir, since: '2026-11-03', until: '2026-11-16' } } });
  assert.match((preview!.result as any).content[0].text, /commits on HEAD \(\d+ touch product code\)/);
  const bad = await handle({ id: 4, method: 'tools/call', params: { name: 'preview_sprint_commits', arguments: { directory: dir, since: 'last week' } } });
  assert.equal((bad!.result as any).isError, true);
  const unknown = await handle({ id: 5, method: 'nope' });
  assert.equal((unknown!.error as any).code, -32601);
});

test('the MCP server speaks JSON lines over stdio', () => {
  const cli = new URL('../../src/cli.ts', import.meta.url).pathname;
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ].join('\n') + '\n';
  const out = execFileSync('node', [cli, 'mcp'], { input, timeout: 15000, killSignal: 'SIGTERM' }).toString();
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].result.tools.length, TOOLS.length);
});

test('every tool has a title, behavior hints and a described input', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.title, `${tool.name} needs a title`);
    const a = tool.annotations;
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) assert.equal(typeof a[hint], 'boolean', `${tool.name}: ${hint}`);
    for (const [key, p] of Object.entries(tool.inputSchema.properties)) assert.ok((p as { description?: string }).description, `${tool.name}.${key} needs a description`);
  }
  const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
  assert.equal(tool('preview_sprint_commits').annotations.readOnlyHint, true);
  assert.equal(tool('check_sprint_review_setup').annotations.readOnlyHint, true);
  assert.equal(tool('generate_sprint_review').annotations.openWorldHint, true);
  assert.doesNotMatch(tool('generate_sprint_review').description, /OPENAI_API_KEY in the server environment\)/);
});

test('a folder inside the project works as the project, a folder in none is refused, and a missing review is named', async () => {
  const repo = demoRepo();
  const sub = join(repo, 'src', 'customers');
  const preview = await callTool('preview_sprint_commits', { directory: 'src/customers', since: '2026-11-03', until: '2026-11-16' }, repo);
  assert.match(preview, /^\d+ commits on HEAD/);
  assert.match(await callTool('preview_sprint_commits', { since: '2026-11-03', until: '2026-11-16' }, sub), /^\d+ commits on HEAD/);
  await assert.rejects(callTool('preview_sprint_commits', {}, mkdtempSync(join(tmpdir(), 'sprint-review-none-'))), /is in no project/);
  await assert.rejects(callTool('render_sprint_review', { file: 'nope.json' }, repo), /No file at nope\.json/);
  await assert.rejects(callTool('preview_sprint_commits', { since: '2026-02-30' }, repo), /since must be a real date/);
});

test('init_sprint_review writes a config the tool reads back, with tricky values intact, and never replaces one', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'sprint-review-init-'));
  execFileSync('git', ['init', '-q', repo]);
  const said = await callTool('init_sprint_review', { name: 'Vector: AI', description: 'Recruiters find "the right" candidate.', organization: 'Essentium', audience: 'business', language: 'Dutch', website: 'https://essentium.nl', branch: 'develop' }, repo);
  assert.match(said, /^Created .*sprint-review\.config\.yml/);
  const { loadConfig } = await import('../../src/config.ts');
  const config = loadConfig(null, repo);
  assert.equal(config.product.name, 'Vector: AI');
  assert.equal(config.product.description, 'Recruiters find "the right" candidate.');
  assert.equal(config.organization, 'Essentium');
  assert.equal(config.language, 'Dutch');
  assert.equal(config.brand.from, 'https://essentium.nl');
  assert.equal(config.sprint.branch, 'develop');
  await assert.rejects(callTool('init_sprint_review', { name: 'Other' }, repo), /There is a config already/);
  const empty = mkdtempSync(join(tmpdir(), 'sprint-review-init-'));
  execFileSync('git', ['init', '-q', empty]);
  await assert.rejects(callTool('init_sprint_review', { name: 'X', website: 'essentium.nl' }, empty), /website must start with https:\/\//);
  assert.ok(TOOLS.some((t) => t.name === 'init_sprint_review'));
});

test('the key typed into the Claude Code plugin goes to the configured provider and wins over the shell one', async () => {
  const { withPluginKey } = await import('../../src/surfaces/mcp.ts');
  assert.equal(withPluginKey({ ANTHROPIC_API_KEY: 'old', SPRINT_REVIEW_API_KEY: 'sk-new' }, 'anthropic').ANTHROPIC_API_KEY, 'sk-new');
  assert.equal(withPluginKey({ SPRINT_REVIEW_API_KEY: 'sk-oa' }, 'openai').OPENAI_API_KEY, 'sk-oa');
  assert.equal(withPluginKey({ SPRINT_REVIEW_API_KEY: 'g' }, 'gemini').GEMINI_API_KEY, 'g');
  assert.equal(withPluginKey({ ANTHROPIC_API_KEY: 'shell', SPRINT_REVIEW_API_KEY: '' }, 'anthropic').ANTHROPIC_API_KEY, 'shell');
  assert.equal(withPluginKey({ ANTHROPIC_API_KEY: 'shell', SPRINT_REVIEW_API_KEY: '${user_config.api_key}' }, 'anthropic').ANTHROPIC_API_KEY, 'shell');
  assert.deepEqual(withPluginKey({ SPRINT_REVIEW_API_KEY: 'k' }, 'ollama'), { SPRINT_REVIEW_API_KEY: 'k' }, 'a local model needs no key');
});
