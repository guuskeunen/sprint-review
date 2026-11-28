import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sample } from './helpers.ts';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { renderDeck } from '../src/deck/render.ts';
import { validReview } from '../src/surfaces/editor.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('a picture that is not an image data URI never reaches the deck', () => {
  const r = sample();
  r.screens = [{ name: 'X', device: 'desktop', before: '"><script>alert(1)</script>', after: 'javascript:alert(1)', caption: 'c' }];
  r.themes[0]!.screen = { name: 'Y', device: 'desktop', image: 'x" onerror="alert(1)' } as never;
  const html = renderDeck(r, {});
  assert.doesNotMatch(html, /<script>alert|onerror="alert|javascript:alert/);
  r.screens = [{ name: 'X', device: 'desktop', before: PNG, after: PNG, caption: 'c' }];
  assert.match(renderDeck(r, {}), new RegExp(`src="${PNG.replace(/[+/=]/g, '\\$&')}"`));
});

test('validReview refuses a bad picture and a theme without its fields', () => {
  const r = sample();
  assert.throws(() => validReview({ ...r, screens: [{ name: 'X', device: 'desktop', before: 'javascript:alert(1)', after: PNG, caption: null }] }), /picture/);
  assert.throws(() => validReview({ ...r, themes: [{ ...r.themes[0]!, screen: { name: 'Y', device: 'desktop', image: 'https://evil.example/x.png' } }] }), /picture/);
  assert.throws(() => validReview({ ...r, themes: [{ ...r.themes[0]!, effect: 5 }] }), /effect/);
});

test('render refuses a broken review.json with a clear message, not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'broken-'));
  writeFileSync(join(dir, 'review.json'), JSON.stringify({ version: 1 }));
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  let err = '';
  try {
    execFileSync('node', [cli, 'render', join(dir, 'review.json')], { stdio: 'pipe' });
  } catch (e) {
    err = String((e as { stderr: Buffer }).stderr);
  }
  assert.match(err, /title and a period/);
  assert.doesNotMatch(err, /TypeError|\n\s+at /);
});

test('an API key never goes to another host in plain text, nor to a remote "local" server', async () => {
  const { clientFor } = await import('../src/ai/providers.ts');
  const { normalize } = await import('../src/config.ts');
  const sent: { url: string; auth?: string }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), auth: (init.headers as Record<string, string>).authorization });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
  }) as unknown as typeof fetch;
  const request = { system: 's', messages: ['m'], tool: { name: 't', description: 'd', input_schema: {} }, maxTokens: 10 };
  assert.throws(() => normalize({ model: { provider: 'openai', name: 'g', baseUrl: 'http://evil.example/v1' } }, '/tmp'), /https/);
  await clientFor({ provider: 'ollama', name: 'q', fallback: null, baseUrl: 'https://evil.example/v1' }, { OPENAI_API_KEY: 'secret' }, impl).ask(request);
  assert.equal(sent[0]!.auth, undefined, 'a "local" server elsewhere gets no key');
  await clientFor({ provider: 'ollama', name: 'q', fallback: null }, { OPENAI_API_KEY: 'secret' }, impl).ask(request);
  assert.equal(sent[1]!.auth, 'Bearer secret', 'a local server on this machine still gets one');
});

test('a made-up hash does not count as a commit, and Markdown output carries no links or HTML from the text', async () => {
  const { parse } = await import('../src/ai/writer.ts');
  const { normalize } = await import('../src/config.ts');
  const { renderMarkdown, renderChecks } = await import('../src/deck/markdown.ts');
  const commits = [{ hash: 'abc1234', date: '2026-11-10', subject: 'feat: x', body: '', files: ['src/a.ts'], product: true }];
  const w = parse({ themes: [{ title: 'Pay', icon: 'wallet', screen: 'none', value: null, effect: 'e', points: [{ text: 'Pay with a new partner', commits: ['abc1234zzzz'] }] }], summary: [], under_the_hood: [] }, commits as never, [], [], normalize({}, '/tmp'));
  assert.equal(w.themes.length, 0, 'the point cites no real commit');
  const r = sample();
  r.themes[0]!.points = ['Sign in at [the new portal](https://evil.example/login) <img src=https://evil.example/p.gif>'];
  r.checks = [{ kind: 'warning', text: '[x](https://evil.example)', reason: '<b>r</b>' }];
  for (const md of [renderMarkdown(r), renderChecks(r)]) assert.doesNotMatch(md, /(?<!\\)\]\(https:|(?<!\\)<img|(?<!\\)<b>/);
});

test('the editor cannot be framed by another site, and sends no referrer', async () => {
  const { startEditor } = await import('../src/surfaces/editor.ts');
  const { normalize } = await import('../src/config.ts');
  const dir = mkdtempSync(join(tmpdir(), 'frame-'));
  writeFileSync(join(dir, 'review.json'), JSON.stringify(sample()));
  const editor = await startEditor(join(dir, 'review.json'), normalize({}, dir), 0);
  try {
    const res = await fetch(editor.url);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await editor.close();
  }
});

test('labels from the config cannot break out into HTML or CSS', () => {
  const evil = '</style><script>alert(1)</script><img src=x onerror=alert(2)>';
  const html = renderDeck(sample(), { labels: { notesLabel: evil, presenter: evil, previousSlide: evil, nextSlide: evil } as never });
  assert.doesNotMatch(html, /<\/style><script>alert|<img src=x onerror/);
  assert.doesNotMatch(html, /\+ L\.(presenter|prev|next) \+/, 'the presenter window escapes its labels');
});

test('the MCP server only reads and writes inside the project', async () => {
  const { callTool } = await import('../src/surfaces/mcp.ts');
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'review.json'), JSON.stringify(sample()));
  await assert.rejects(callTool('render_sprint_review', { file: '../../etc/review.json' }, dir), /inside the project/);
  await assert.rejects(callTool('render_sprint_review', { file: 'review.json', directory: '/' }, dir), /in no project/);
  assert.match(await callTool('render_sprint_review', { file: 'review.json' }, dir), /Rebuilt/);
});

test('a .pptx that unpacks to more than its limit is refused', async () => {
  const { readZip } = await import('../src/brand/zip.ts');
  const { deflateRawSync } = await import('node:zlib');
  const big = deflateRawSync(Buffer.alloc(80_000_000));
  const name = Buffer.from('ppt/x.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(big.length, 18); local.writeUInt32LE(80_000_000, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(big.length, 20); central.writeUInt32LE(80_000_000, 24); central.writeUInt16LE(name.length, 28);
  const cdOffset = 30 + name.length + big.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(cdOffset, 16);
  const zip = Buffer.concat([local, name, big, central, name, end]);
  const entries = readZip(zip);
  assert.throws(() => entries.get('ppt/x.xml')!(), /too large/);
});

test('the library render function refuses a broken review with a clear error too', async () => {
  const { render } = await import('../src/review/generate.ts');
  const { normalize } = await import('../src/config.ts');
  for (const bad of [{ version: 1 }, { ...sample(), themes: 'x' }, { ...sample(), themes: [{ title: null, points: null }] }]) {
    assert.throws(() => render(bad as never, normalize({}, '/tmp')), (e: Error) => !(e instanceof TypeError));
  }
});
