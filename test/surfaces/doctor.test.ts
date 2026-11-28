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
  assert.match(await texts({}), /screenshots.check is on: .* they are sent to anthropic\. Set screenshots.check: false to keep them here/);
  assert.match(await texts({ model: { provider: 'ollama', name: 'qwen2.5vl' } }), /they stay on this machine$/m);
  const off = await doctorChecks(normalize({ screenshots: { source: 'git', dir: 'shots', check: false } }, dir), dir, {});
  assert.ok(off.some((l) => l.ok && /screenshots.check is off: the model chooses pictures by name only/.test(l.text)));
  assert.doesNotMatch((await doctorChecks(normalize({}, dir), dir, {})).map((l) => l.text).join('\n'), /screenshots.check/, 'nothing without screenshots');
});
