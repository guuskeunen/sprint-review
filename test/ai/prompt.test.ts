import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitLog, commitLog, writerSystem, writerTool } from '../../src/ai/prompt.ts';
import { normalize } from '../../src/config.ts';
import { unread } from '../../src/ai/writer.ts';
import type { Commit } from '../../src/types.ts';

const commit = (n: number, product: boolean, date: string): Commit => ({
  hash: `c${String(n).padStart(6, '0')}`,
  date,
  subject: `${product ? 'feat' : 'docs'}: change ${n}`,
  body: 'Why and how. '.repeat(30),
  files: [product ? `src/area-${n}.ts` : `docs/page-${n}.md`],
  product,
});

test('a short sprint is read in full', () => {
  const commits = [commit(1, true, '2026-11-20'), commit(2, false, '2026-11-10')];
  assert.deepEqual(fitLog(commits), { log: commitLog(commits), skipped: [] });
});

test('a long sprint keeps all of it in view: a line per product commit first, details as far as they fit, docs and chores last', () => {
  // Newest first, as git gives them: the sprint's first days are at the end.
  const commits = Array.from({ length: 300 }, (_, n) => commit(n, n % 3 !== 0, `2026-11-${String(22 - Math.floor(n / 25)).padStart(2, '0')}`));
  const { log, skipped } = fitLog(commits, 14_000);
  assert.ok(log.length <= 14_000);
  for (const c of commits.filter((x) => x.product)) assert.ok(log.includes(c.hash), `product commit ${c.hash} from ${c.date} is read`);
  assert.ok(log.includes('2026-11-11'), 'the start of the sprint is in view, not only its last days');
  assert.ok(log.includes('Why and how.'), 'some product commits keep their details');
  assert.ok(skipped.length > 0 && skipped.every((c) => !c.product), 'what is left out has no product code');
  assert.equal(log.split('\n\n').length + skipped.length, commits.length);
});

test('what was left out is one line in the check log, not a line per commit', () => {
  const skipped = [commit(1, true, '2026-11-20'), commit(2, false, '2026-11-19'), commit(3, false, '2026-11-18')];
  const checks = unread(skipped, 900);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.text, '3 of 900 commits not read (1 with product code and 2 without)');
  assert.match(checks[0]!.reason, /model\.maxInputChars.*feat: change 1; docs: change 2/);
  assert.deepEqual(unread([], 10), []);
});

test('Dutch slides address the audience as je or jij, never u', () => {
  for (const language of ['Dutch', 'nl', 'Nederlands', 'nl-BE']) {
    const system = writerSystem(normalize({ language }, '/tmp'));
    assert.match(system, /"je" or "jij"/, language);
    assert.match(system, /never "u"/, language);
  }
  assert.doesNotMatch(writerSystem(normalize({ language: 'English' }, '/tmp')), /"jij"/);
});

test('the sprint headline sums up the whole sprint for a user, short, not one commit and not a list', () => {
  const system = writerSystem(normalize({}, '/tmp'));
  const rule = system.split('\n\n').find((p) => p.startsWith('The sprint headline'))!;
  assert.match(rule, /at most 10 words/);
  assert.match(rule, /the sprint as a whole/);
  assert.match(rule, /never a single commit or one theme/);
  assert.match(rule, /never a list of the themes/);
  assert.match(rule, /not how it works or where the data comes from/);
});

test('under the hood is one change per point, and the questions are ones the audience answers from its own work', () => {
  const tool = writerTool(normalize({}, '/tmp'), [], []);
  const props = tool.input_schema.properties as unknown as Record<string, { description: string }>;
  assert.match(props.under_the_hood!.description, /one change per point/);
  assert.match(props.under_the_hood!.description, /never two changes in one point/);
  assert.match(props.questions!.description, /from their own work/);
  assert.match(props.questions!.description, /never about how it is built/);
  const system = writerSystem(normalize({}, '/tmp'));
  assert.match(system, /answer from their own work/);
});
