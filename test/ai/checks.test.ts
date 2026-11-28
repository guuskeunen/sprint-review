import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, parse } from '../../src/ai/writer.ts';
import { normalize } from '../../src/config.ts';
import { commitType, touchesProduct, withoutTrailers } from '../../src/git/history.ts';
import { parseFile } from '../../src/screens/screenshots.ts';
import type { Commit } from '../../src/types.ts';

const config = normalize({ product: { name: 'Spoke' }, replace: { noot: 'notitie' } }, '/tmp');
const commits: Commit[] = [
  { hash: 'abc1234', date: '2026-11-04', subject: 'feat: timeline', body: '', files: ['src/a.ts'], product: true },
  { hash: 'def5678', date: '2026-11-05', subject: 'ci: cache', body: '', files: ['.github/x.yml'], product: false },
];

test('clean strips ticket numbers, PR numbers and hashes', () => {
  assert.equal(clean('Faster list (#42)', 10), 'Faster list');
  assert.equal(clean('Faster list SPOKE-81', 10), 'Faster list');
  assert.equal(clean('Fixed in abc1234f the overview', 10), 'Fixed in the overview');
});

test('clean rejects exclamation marks, emoji and long text', () => {
  assert.equal(clean('Great news!', 10), null);
  assert.equal(clean('Ship it 🚀', 10), null);
  assert.equal(clean('one two three four five', 4), null);
  assert.equal(clean('', 4), null);
});

test('clean turns long dashes into a comma and applies the team words with their case', () => {
  assert.equal(clean('Faster — and calmer', 10), 'Faster, and calmer');
  assert.equal(clean('Noot op de pagina, elke noot telt', 10, { noot: 'notitie' }), 'Notitie op de pagina, elke notitie telt');
});

test('parse drops points without a real commit and moves non-product points under the hood', () => {
  const w = parse(
    {
      themes: [
        {
          title: 'Timeline',
          icon: 'users',
          screen: 'none',
          value: 'quality',
          effect: 'One page.',
          points: [
            { text: 'One list', commits: ['abc1234'] },
            { text: 'Invented thing', commits: ['9999999'] },
            { text: 'CI is faster', commits: ['def5678'] },
          ],
          notes: 'Show it.',
        },
      ],
      headline: { text: 'One list', commits: ['abc1234'] },
      under_the_hood: [],
    },
    commits,
    [],
    [],
    config,
  );
  assert.deepEqual(w.themes[0]?.points, ['One list']);
  assert.equal(w.headline, 'One list');
  assert.deepEqual(w.underTheHood, [{ text: 'CI is faster', kind: 'maintenance' }]);
  assert.ok(w.checks.some((c) => c.kind === 'dropped' && c.text === 'Invented thing'));
  assert.ok(w.checks.some((c) => c.kind === 'moved' && c.text === 'CI is faster'));
});

test('parse keeps at most the configured number of themes and only screens that exist', () => {
  const theme = (title: string) => ({ title, icon: 'users', screen: 'Ghost (desktop)', value: 'faster', effect: 'x', points: [{ text: 'y', commits: ['abc1234'] }], notes: '' });
  const small = normalize({ limits: { themes: 2 } }, '/tmp');
  const w = parse({ themes: [theme('A'), theme('B'), theme('C')], under_the_hood: [] }, commits, [], ['Real (desktop)'], small);
  assert.equal(w.themes.length, 2);
  assert.equal(w.themes[0]?.screen, null);
  assert.ok(w.checks.some((c) => c.text === 'Theme C'));
});

test('a short hash may come back a character longer or shorter', () => {
  const w = parse({ themes: [], headline: { text: 'One list', commits: ['abc12345'] }, under_the_hood: [] }, commits, [], [], config);
  assert.equal(w.headline, 'One list');
});

test('product paths decide what counts as product work', () => {
  assert.equal(touchesProduct(['src/a.ts'], ['src/']), true);
  assert.equal(touchesProduct(['test/a.ts'], ['src/']), false);
  assert.equal(touchesProduct(['test/a.ts'], []), true);
  assert.equal(touchesProduct([], ['src/']), true);
});

test('trailers are removed from commit bodies', () => {
  assert.equal(withoutTrailers('Real text\n\nCo-Authored-By: A <a@b.c>\nSigned-off-by: B'), 'Real text');
});

test('screenshot file names give a key and a device', () => {
  assert.deepEqual(parseFile('e2e/x/customer-page-desktop.png'), { key: 'customer-page', device: 'desktop', dark: false });
  assert.deepEqual(parseFile('repairs-phone.png'), { key: 'repairs', device: 'phone', dark: false });
  assert.deepEqual(parseFile('dashboard-mobile-chromium-linux.png'), { key: 'dashboard', device: 'phone', dark: false });
  assert.deepEqual(parseFile('settings.png'), { key: 'settings', device: 'desktop', dark: false });
  assert.deepEqual(parseFile('planner-desktop-dark.png'), { key: 'planner', device: 'desktop', dark: true });
  assert.deepEqual(parseFile('planner-dark-phone.png'), { key: 'planner', device: 'phone', dark: true });
  assert.equal(parseFile('notes.txt'), null);
});

test('conventional commit types are read from the subject', () => {
  assert.equal(commitType('feat(customers)!: one timeline'), 'feat');
  assert.equal(commitType('chore(deps): bump vite'), 'chore');
  assert.equal(commitType('CI: cache'), 'ci');
  assert.equal(commitType('Add a timeline'), null);
});

test('themes and points the model sent as JSON text are read, not silently lost', () => {
  const theme = { title: 'Customer page', icon: 'users', screen: 'none', value: null, effect: 'One page for every customer.', points: [{ text: 'One list for all purchases', commits: ['abc12345'] }] };
  const w = parse({ themes: [JSON.stringify(theme)], summary: [], under_the_hood: [] }, commits, [], [], config);
  assert.equal(w.themes.length, 1);
  assert.equal(w.themes[0]!.title, 'Customer page');
});

test('the default room for an answer fits models that think first', () => {
  assert.equal(normalize({}, '/tmp').model.maxTokens, 16000);
});

test('a theme slide over the glance-test word budget gets a warning, and density sets the points per theme', () => {
  const long = 'Every repair now shows its parts, its price, its mechanic and the day it is ready';
  const theme = { title: 'Repairs', icon: 'wrench', screen: 'none', value: 'faster', effect: 'Repairs show everything at once', points: [1, 2, 3, 4].map(() => ({ text: long, commits: ['abc1234'] })), notes: '' };
  const w = parse({ themes: [theme], under_the_hood: [], questions: ['What is still missing?', 'Is this great!'] }, commits, [], [], config);
  assert.equal(w.themes[0]!.points.length, 3, 'standard: three points');
  assert.ok(w.checks.some((c) => c.kind === 'warning' && /words on the slide besides the title; 40/.test(c.reason)));
  assert.deepEqual(w.questions, ['What is still missing?']);
  const brief = parse({ themes: [theme], under_the_hood: [] }, commits, [], [], normalize({ deck: { density: 'brief' } }, '/tmp'));
  assert.equal(brief.themes[0]!.points.length, 2);
});

test('a roadmap line must point at a real roadmap item, once', () => {
  const w = parse({ themes: [], under_the_hood: [], roadmap: [{ item: 1, text: 'Leads arrive every week by themselves' }, { item: 1, text: 'Twice' }, { item: 7, text: 'Invented plan' }] }, commits, [], [], config, 3);
  assert.deepEqual(w.roadmap, [{ item: 1, text: 'Leads arrive every week by themselves' }]);
  assert.ok(w.checks.some((c) => c.text === 'Invented plan' && c.kind === 'dropped'));
});

test('a headline that lists the themes gets a warning', () => {
  const w = parse({ themes: [], under_the_hood: [], headline: { text: 'Richer profiles, register signals, and phone lookups', commits: ['abc1234'] } }, commits, [], [], config);
  assert.ok(w.checks.some((c) => c.kind === 'warning' && /lists several things/.test(c.reason)));
  assert.ok(!parse({ themes: [], under_the_hood: [], headline: { text: 'The front desk sees a whole customer on one page', commits: ['abc1234'] } }, commits, [], [], config).checks.length);
});

test('a theme name that joins two topics gets a warning', () => {
  const theme = (title: string) => ({ title, icon: 'users', screen: 'none', value: 'faster', effect: 'Teams see more', points: [{ text: 'One list', commits: ['abc1234'] }], notes: '' });
  const w = parse({ themes: [theme('Onboarding & Scoring'), theme('Customer page')], under_the_hood: [] }, commits, [], [], config);
  assert.deepEqual(w.checks.filter((c) => /joins two topics/.test(c.reason)).map((c) => c.text), ['Onboarding & Scoring']);
});

test('a title with two messages joined by a semicolon gets a warning', () => {
  const theme = (effect: string) => ({ title: 'Editor', icon: 'users', screen: 'none', value: 'faster', effect, points: [{ text: 'One list', commits: ['abc1234'] }], notes: '' });
  const w = parse({ themes: [theme('The editor accepts three settings; the panel is readable in dark mode.'), theme('The editor accepts three settings.')], under_the_hood: [] }, commits, [], [], config);
  assert.equal(w.checks.filter((c) => /says two things/.test(c.reason)).length, 1);
});

test('you asked, we did: the request must exist and a product commit must back what was done', () => {
  const w = parse({ themes: [], under_the_hood: [], answered: [
    { item: 0, text: 'Leads now show a direct phone number', commits: ['abc1234'] },
    { item: 4, text: 'Something nobody asked', commits: ['abc1234'] },
    { item: 1, text: 'Faster builds', commits: ['def5678'] },
    { item: 2, text: 'Made up', commits: [] },
  ] }, commits, [], [], config, 0, 3);
  assert.deepEqual(w.answered, [{ item: 0, text: 'Leads now show a direct phone number' }]);
  assert.equal(w.checks.filter((c) => c.kind === 'dropped').length, 3);
});

test('the writer is told which pictures are close-ups, and that no picture beats a wrong one', async () => {
  const { writerTool } = await import('../../src/ai/prompt.ts');
  const { normalize } = await import('../../src/config.ts');
  const c = normalize({ screenshots: { source: 'capture', pages: { companies: '/companies', contacts: { url: '/c/1', selector: 'section' } }, names: { contacts: 'Company contacts' } } }, '/tmp');
  const text = JSON.stringify(writerTool(c, [], ['Companies (desktop)', 'Company contacts (desktop)']));
  assert.match(text, /prefer them when one shows the change itself: Company contacts \(desktop\)\./);
  assert.match(text, /worse than none/);
});

test('the writer reads what each picture shows, since it never sees the pictures', async () => {
  const { writerTool } = await import('../../src/ai/prompt.ts');
  const { normalize } = await import('../../src/config.ts');
  const c = normalize({ screenshots: { source: 'capture', pages: { 'three-ws': { url: '/c/1', selector: 'section' }, gone: '/gone' }, names: { 'three-ws': 'The 3 Ws' }, descriptions: { 'three-ws': 'Why to contact a company now', gone: 'Not taken today' } } }, '/tmp');
  const text = JSON.stringify(writerTool(c, [], ['The 3 Ws (desktop)']));
  assert.match(text, /What each picture shows: The 3 Ws \(desktop\): Why to contact a company now\./);
  assert.doesNotMatch(text, /Not taken today/, 'only pictures there are');
  assert.throws(() => normalize({ screenshots: { source: 'capture', pages: { a: '/a' }, descriptions: { a: 3 } } }, '/tmp'), /screenshots.descriptions/);
});

test('screenshots.check is on unless turned off, and must be true or false', async () => {
  const { normalize } = await import('../../src/config.ts');
  const on = (check: unknown) => normalize({ screenshots: { source: 'git', dir: 'shots', ...(check === undefined ? {} : { check }) } }, '/tmp').screenshots;
  assert.equal((on(undefined) as { check: boolean }).check, true);
  assert.equal((on(false) as { check: boolean }).check, false);
  assert.equal((on(true) as { check: boolean }).check, true);
  assert.throws(() => on('yes'), /screenshots.check/);
});
