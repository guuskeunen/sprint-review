import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../../src/config.ts';
import { doctorChecks } from '../../src/surfaces/doctor.ts';
import { demoRepo } from '../helpers.ts';

test('doctor counts playwright-core with the installed Chrome as Playwright, as capture does', async () => {
  const dir = demoRepo();
  const lines = await doctorChecks(normalize({ screenshots: { source: 'capture', pages: { app: '/' } } }, dir), dir, {});
  const line = lines.find((l) => /Playwright is installed/.test(l.text));
  assert.ok(line?.ok, `doctor says: ${line?.text} ${line?.fix ?? ''}`);
  assert.match(line.text, /playwright-core, with your Chrome/);
});

test('doctor says whether the model looks at the pictures, and where they go', async () => {
  const dir = demoRepo();
  const texts = async (extra: Record<string, unknown>) => (await doctorChecks(normalize({ screenshots: { source: 'git', dir: 'shots' }, ...extra }, dir), dir, {})).map((l) => l.text).join('\n');
  assert.match(await texts({}), /Tip: screenshots.check: true lets the model look at the pictures.*they are sent to anthropic/);
  assert.match(await texts({ model: { provider: 'ollama', name: 'qwen2.5vl' } }), /they stay on this machine/);
  const on = await doctorChecks(normalize({ screenshots: { source: 'git', dir: 'shots', check: true } }, dir), dir, {});
  assert.ok(on.some((l) => l.ok && /screenshots.check is on/.test(l.text)));
  assert.doesNotMatch((await doctorChecks(normalize({}, dir), dir, {})).map((l) => l.text).join('\n'), /screenshots.check/, 'nothing without screenshots');
});
