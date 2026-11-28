import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../src/ai/writer.ts';
import { writerTool } from '../../src/ai/prompt.ts';
import { normalize } from '../../src/config.ts';
import type { Commit } from '../../src/types.ts';

const config = normalize({}, '/tmp');
const commits: Commit[] = [{ hash: 'abc1234', date: '2026-11-04', subject: 'feat: timeline', body: '', files: ['src/a.ts'], product: true }];
const theme = (title: string, milestone: unknown) => ({ title, icon: 'users', screen: 'none', value: 'faster', effect: 'x', points: [{ text: 'y', commits: ['abc1234'] }], notes: '', milestone });
type Props = { properties: Record<string, unknown>; required: string[] };
const themeSchema = (tool: ReturnType<typeof writerTool>) => (tool.input_schema.properties as unknown as { themes: { items: Props } }).themes.items;

test('with a checklist roadmap, every theme is asked which milestone it moves', () => {
  const asked = themeSchema(writerTool(config, [], [], 0, 0, 6));
  assert.ok('milestone' in asked.properties);
  assert.ok(asked.required.includes('milestone'));
  const notAsked = themeSchema(writerTool(config, [], [], 0, 0, 0));
  assert.ok(!('milestone' in notAsked.properties));
  assert.ok(!notAsked.required.includes('milestone'));
});

test('a theme keeps a milestone that exists, -1 is outside the roadmap, any other number is reported', () => {
  const w = parse({ themes: [theme('Search', 2), theme('Sync', -1), theme('Docs', 9)], under_the_hood: [] }, commits, [], [], config, 0, 0, 6);
  assert.deepEqual(w.themes.map((t) => t.milestone), [2, null, null]);
  assert.ok(w.checks.some((c) => c.text === 'Docs' && /not on the roadmap/.test(c.reason)));
  assert.ok(!w.checks.some((c) => c.text === 'Sync'));
});

test('without a roadmap, a theme carries no milestone at all', () => {
  const w = parse({ themes: [theme('Search', 2)], under_the_hood: [] }, commits, [], [], config);
  assert.equal('milestone' in w.themes[0]!, false);
});
