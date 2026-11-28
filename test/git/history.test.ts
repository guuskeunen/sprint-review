import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { History } from '../../src/git/history.ts';
import { normalize } from '../../src/config.ts';
import { missedWork, onBranch } from '../../src/review/generate.ts';
import { demoRepo } from '../helpers.ts';

test('a shallow clone is fine when it reaches back to before the sprint; otherwise it says how far to fetch', () => {
  const source = demoRepo();
  const dates = execFileSync('git', ['log', '--format=%cs'], { cwd: source }).toString().trim().split('\n');
  const clone = join(mkdtempSync(join(tmpdir(), 'sprint-review-shallow-')), 'repo');
  execFileSync('git', ['clone', '-q', '--depth', '3', `file://${source}`, clone], { stdio: 'pipe' });
  const history = new History(clone);
  const cut = dates[2]!;
  const after = new Date(Date.parse(`${cut}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  assert.doesNotThrow(() => history.assertUsable({ kind: 'dates', from: after, until: dates[0]! }));
  assert.throws(() => history.assertUsable({ kind: 'dates', from: '2026-01-01', until: dates[0]! }), new RegExp(`starts on ${cut}.*git fetch --shallow-since=2025-12-25`));
  assert.throws(() => history.assertUsable(), /shallow history/);
  assert.throws(() => history.assertUsable({ kind: 'refs', from: 'v0.0.0-missing', to: 'HEAD' }), /not in this checkout's shallow history/);
  assert.doesNotThrow(() => new History(source).assertUsable({ kind: 'dates', from: '2000-01-01', until: dates[0]! }), 'a full history is always fine');
});

/** The demo repo with a develop branch one commit ahead in the sprint, fetched as origin/develop, and main checked out. */
function behindDevelop(): string {
  const dir = demoRepo();
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'D', GIT_AUTHOR_EMAIL: 'd@example.test', GIT_COMMITTER_NAME: 'D', GIT_COMMITTER_EMAIL: 'd@example.test', GIT_AUTHOR_DATE: '2026-11-14T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-14T10:00:00Z' } });
  run(['switch', '-q', '-c', 'develop']);
  writeFileSync(join(dir, 'src', 'sms.ts'), 'export const sms = 1;\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'feat(sms): a text message when the bike is ready']);
  run(['update-ref', 'refs/remotes/origin/develop', 'develop']);
  run(['switch', '-q', 'main']);
  return dir;
}

const sprint = { kind: 'dates' as const, from: '2026-11-03', until: '2026-11-16' };

test('dates are counted on the branch the range names, not on what is checked out', () => {
  const history = new History(behindDevelop());
  const subjects = (at?: string) => history.commits({ ...sprint, ...(at ? { at } : {}) }, ['src/'], [], 100).map((c) => c.subject);
  assert.ok(!subjects().some((s) => s.startsWith('feat(sms)')));
  assert.ok(subjects('origin/develop').some((s) => s.startsWith('feat(sms)')));
  assert.notEqual(history.ends({ ...sprint, at: 'origin/develop' }).end, history.ends(sprint).end);
  assert.throws(() => history.commits({ ...sprint, at: 'nope' }, [], [], 10), /No tag, branch or commit called "nope"/);
});

test('sprint.branch reads the sprint from origin/<branch>, and a checkout behind develop is reported', () => {
  const dir = behindDevelop();
  const history = new History(dir);
  const plain = normalize({}, dir);
  assert.match(missedWork(sprint, plain, history) ?? '', /^1 commit of this sprint on origin\/develop is not in what is checked out\. Pass --to origin\/develop/);
  const onDevelop = normalize({ sprint: { branch: 'develop' } }, dir);
  const range = onBranch(sprint, onDevelop, history);
  assert.deepEqual(range, { ...sprint, at: 'origin/develop' });
  assert.equal(missedWork(range, onDevelop, history), null);
  assert.equal(missedWork({ ...sprint, at: 'origin/develop' }, plain, history), null, 'a branch passed on purpose is not second-guessed');
});
