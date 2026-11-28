import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { normalize } from '../../src/config.ts';
import { askSetup, configText, guessWebsite, type SetupAnswers } from '../../src/surfaces/setup.ts';
import { doctorChecks } from '../../src/surfaces/doctor.ts';
import { demoRepo } from '../helpers.ts';

const template = readFileSync(new URL('../../assets/config.template.yml', import.meta.url), 'utf8');
const start: SetupAnswers = { name: 'acme', description: '', website: null, audience: 'business' };

/** A website with a brand color, a logo and a font, on any host but bad.test. */
const site = (async (url: string) => {
  if (String(url).includes('bad.test')) return new Response('nope', { status: 404 });
  if (new URL(String(url)).pathname === '/') return new Response('<style>:root{--brand:#6965db;--ui-font:Assistant, sans-serif}</style><header><a href="/"><img class="logo" src="/logo.svg" alt="Acme"></a></header>', { status: 200 });
  return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#6965db"/></svg>', { status: 200 });
}) as unknown as typeof fetch;

function answering(...replies: string[]) {
  const asked: string[] = [];
  return { asked, ask: async (q: string, d: string) => (asked.push(q), replies.length ? replies.shift()! || d : d) };
}

test('init asks for the website, reads its brand right away and asks again when it finds nothing', async () => {
  const said: string[] = [];
  const { ask, asked } = answering('Acme Planner', 'Planning for repair shops.', 'bad.test', 'acme.test', 'team');
  const a = await askSetup(ask, start, (l) => said.push(l), site);
  assert.deepEqual(a, { name: 'Acme Planner', description: 'Planning for repair shops.', website: 'https://acme.test', audience: 'team' });
  assert.equal(asked.filter((q) => /website/i.test(q)).length, 2);
  assert.match(said.join('\n'), /Could not read a brand from https:\/\/bad\.test/);
  assert.match(said.join('\n'), /Found on https:\/\/acme\.test: color #6965db, logo/);
});

test('a website can be skipped, also when one was guessed', async () => {
  const { ask } = answering('', '', '-', '');
  const a = await askSetup(ask, { ...start, website: 'https://acme.test' }, () => {}, site);
  assert.equal(a.website, null);
  assert.equal(a.name, 'acme');
});

test('the config init writes takes its brand from the website, not from a default color', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprint-review-init-'));
  const text = configText(template, { name: 'Acme: "Planner"', description: 'Planning for repair shops.', website: 'https://acme.test', audience: 'a room of shop owners' });
  const raw = parse(text);
  assert.equal(raw.brand.from, 'https://acme.test');
  assert.equal(raw.brand.color, undefined, 'a color here would win over the website');
  const c = normalize(raw, dir);
  assert.equal(c.product.name, 'Acme: "Planner"');
  assert.equal(c.product.description, 'Planning for repair shops.');
  assert.equal(c.audience, 'a room of shop owners');
  const none = normalize(parse(configText(template, start)), dir);
  assert.deepEqual([none.brand.from, none.brand.color], [null, null]);
});

test('the website is guessed from package.json, but not when that is the repository page', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprint-review-init-'));
  const homepage = (h: string) => (writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'acme', homepage: h })), guessWebsite(dir));
  assert.equal(homepage('https://acme.example'), 'https://acme.example');
  assert.equal(homepage('https://github.com/acme/acme#readme'), null);
  assert.equal(homepage('.'), null);
});

test('doctor says when the deck will have the default look', async () => {
  const dir = demoRepo();
  const plain = await doctorChecks(normalize({}, dir), dir, {});
  assert.ok(plain.some((l) => /No brand set/.test(l.text)));
  const branded = await doctorChecks(normalize({ brand: { color: '#ea580c' } }, dir), dir, {});
  assert.ok(!branded.some((l) => /No brand set/.test(l.text)));
});
