import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelClient, ModelRequest, ModelAnswer } from '../src/ai/model.ts';
import type { Review } from '../src/types.ts';

const SCREENS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'screens');
const SHOTS = 'e2e/__screenshots__';

/** A git repo for a fictional bike-shop app, Spoke, with one sprint of work from 3 to 16 November 2026. */
export function demoRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sprint-review-demo-'));
  const git = (args: string[], date?: string) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.test', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.test', ...(date ? { GIT_AUTHOR_DATE: `${date}T10:00:00Z`, GIT_COMMITTER_DATE: `${date}T10:00:00Z` } : {}) },
    }).toString();
  const file = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const shot = (name: string, which: 'before' | 'after') => {
    mkdirSync(join(dir, SHOTS), { recursive: true });
    copyFileSync(join(SCREENS, `${name}.${which}.png`), join(dir, SHOTS, `${name}.png`));
  };
  const commit = (date: string, message: string) => {
    git(['add', '-A']);
    git(['commit', '-q', '-m', message], date);
  };

  git(['init', '-q', '-b', 'main']);
  file('src/app.ts', 'export const app = 1;\n');
  file('ROADMAP.md', '# Roadmap\n\n- [x] Book a repair online\n- [x] Workshop planner per branch\n- [ ] One customer page for online store, register and workshop\n- [ ] Read repair tickets from a photo\n- [ ] Text message when the bike is ready\n- [ ] Reorder parts automatically\n');
  for (const s of ['customer-page-desktop', 'customer-page-phone', 'repairs-phone', 'planner-desktop']) shot(s, 'before');
  commit('2026-10-20', 'feat: first version of Spoke');

  file('src/customers/timeline.ts', 'export const timeline = [];\n');
  shot('customer-page-desktop', 'after');
  shot('customer-page-phone', 'after');
  commit('2026-11-04', 'feat(customers): merge online store, register and workshop history into one timeline\n\nEach line shows where it came from.\n\nCo-Authored-By: Someone <x@example.test>');
  file('src/bikes/card.ts', 'export const card = 1;\n');
  commit('2026-11-05', 'feat(bikes): per-bike service card with the next due date');
  file('src/tickets/ocr.ts', 'export const ocr = 1;\n');
  commit('2026-11-06', 'feat(tickets): read handwritten repair tickets from a photo (#42)');
  file('src/planner/counts.ts', 'export const counts = 1;\n');
  shot('planner-desktop', 'after');
  commit('2026-11-09', 'refactor(planner): optimize status count queries and add progress bar');
  file('src/dedupe.ts', 'export const dedupe = 1;\n');
  commit('2026-11-10', 'fix(dedupe): exclude merged customers from duplicate alerts');
  file('src/ui/badge.ts', 'export const badge = 1;\n');
  shot('repairs-phone', 'after');
  commit('2026-11-11', 'style(ui): unify source badge colors, tables scroll sideways on phones');
  file('package-lock.json', '{}\n');
  commit('2026-11-12', 'chore(deps): bump vite to 5.4.11');
  file('.github/workflows/ci.yml', 'name: ci\n');
  commit('2026-11-13', 'ci: cache playwright browsers');
  file('ROADMAP.md', '# Roadmap\n\n- [x] Book a repair online\n- [x] Workshop planner per branch\n- [x] One customer page for online store, register and workshop\n- [x] Read repair tickets from a photo\n- [ ] Text message when the bike is ready\n- [ ] Reorder parts automatically\n');
  commit('2026-11-14', 'docs: update roadmap');
  return dir;
}

/** A model that answers like a good writer, using the real hashes from the commit log it is sent. */
export class FakeModel implements ModelClient {
  requests: ModelRequest[] = [];
  private readonly options: { failReader?: boolean; revision?: string; misfit?: string };

  /**
   * revision: what the writer answers when asked to rewrite a flagged line. Without it the rewrite call fails, as a model outage would.
   * misfit: the theme whose picked picture the model, looking at it, says does not fit.
   */
  constructor(options: { failReader?: boolean; revision?: string; misfit?: string } = {}) {
    this.options = options;
  }

  async ask(request: ModelRequest): Promise<ModelAnswer> {
    this.requests.push(request);
    const usage = { input: 1000, output: 500 };
    if (request.tool.name === 'reading_report') {
      if (this.options.failReader) throw new Error('reader down');
      return { model: 'fake', usage, toolInput: { complaints: [{ text: 'Status counts load with less work', kind: 'unclear', why: 'What is a status count?' }] } };
    }
    if (request.tool.name === 'picture_description') {
      const name = /"([^"]+)"/.exec(request.messages[0] ?? '')?.[1] ?? '?';
      return { model: 'fake', usage, toolInput: { shows: `The ${name.toLowerCase()} as it looks now` } };
    }
    if (request.tool.name === 'picture_fit') {
      const misfit = this.options.misfit !== undefined && (request.messages[0] ?? '').includes(`Theme: ${this.options.misfit}`);
      return { model: 'fake', usage, toolInput: { fits: !misfit, why: misfit ? 'It shows a list of repairs, not the colors.' : '' } };
    }
    if (request.tool.name === 'revisions') {
      if (!this.options.revision) throw new Error('no revision');
      return { model: 'fake', usage, toolInput: { revisions: [{ original: 'Status counts load with less work', revised: this.options.revision }] } };
    }
    const log = request.messages[0] ?? '';
    const h = (word: string) => new RegExp(`^([0-9a-f]{7,}) \\S+ [^\\n]*${word}`, 'm').exec(log)?.[1] ?? 'deadbee';
    const screenEnum = ((request.tool.input_schema as any).properties.themes.items.properties.screen.enum as string[]) ?? [];
    const pick = (label: string) => (screenEnum.includes(label) ? label : 'none');
    return {
      model: 'fake',
      usage,
      toolInput: {
        headline: { text: 'The front desk sees a whole customer on one page', commits: [h('timeline')] },
        questions: ['Which repairs would you still type in by hand?', 'What is missing on the customer page?', 'Is this amazing!'],
        summary_notes: 'Open with the customer page: it is what the front desk asked for most.',
        themes: [
          {
            title: 'Customer profile',
            icon: 'users',
            screen: pick('Customer page (desktop)'),
            value: 'quality',
            effect: 'Front desk staff see everything a customer bought or had repaired on one page.',
            points: [
              { text: 'Purchases, repairs and services sit in one list with their source', commits: [h('timeline')] },
              { text: 'Every bike has its own card with the next service', commits: [h('card')] },
              { text: 'Caches playwright browsers in CI', commits: [h('playwright')] },
            ],
            notes: 'Open the customer page for Sarah Mitchell and point at the source labels.',
          },
          {
            title: 'Repair ticket scanning',
            icon: 'clipboard-list',
            screen: 'none',
            value: 'less_manual_work',
            effect: 'A photo of a handwritten repair ticket becomes a repair, with no retyping.',
            points: [
              { text: 'Fields that are hard to read are flagged (#42)', commits: [h('tickets')] },
              { text: 'This is amazing!', commits: [h('tickets')] },
            ],
            notes: 'Show a photo of a ticket, then the repair it became.',
          },
          {
            title: 'Workshop planner',
            icon: 'calendar',
            screen: pick('Workshop planner (desktop)'),
            value: 'faster',
            effect: 'The planner shows at a glance how many jobs are done and where work is stuck.',
            points: [
              { text: 'A bar shows how much of today is done', commits: [h('planner')] },
              { text: 'Status counts load with less work', commits: [h('planner')] },
            ],
            notes: 'Open the planner and point at the progress bar.',
          },
          {
            title: 'Duplicate customers',
            icon: 'copy',
            screen: 'none',
            value: 'less_risk',
            effect: 'Merged customers stop coming back as duplicates.',
            points: [{ text: 'A merged customer no longer shows up in duplicate alerts', commits: [h('dedupe')] }],
            notes: 'Show the compare screen after a merge.',
          },
          {
            title: 'Look and feel',
            icon: 'palette',
            screen: pick('Repairs (phone)'),
            value: 'quality',
            effect: 'Labels look the same everywhere, and tables work on a phone.',
            points: [
              { text: 'Each source has a fixed color', commits: [h('badge')] },
              { text: 'Tables on a phone scroll sideways', commits: [h('badge')] },
            ],
            notes: 'Open the repairs list on a phone and scroll the table.',
          },
          { title: 'A theme without points', icon: 'other', screen: 'none', value: 'insight', effect: 'x', points: [{ text: 'Invented', commits: ['0000000'] }], notes: '' },
        ],
        under_the_hood: [{ text: 'Vite is up to date', commits: [h('vite')], kind: 'maintenance' }],
        screen_changes: [
          { screen: 'Customer page', text: 'Look at the source label on each line and the bike cards on the right.', commits: [h('timeline')] },
          { screen: 'Workshop planner', text: 'Look at the progress bar and the counts per status.', commits: [h('planner')] },
          { screen: 'Repairs (phone)', text: 'The table now scrolls sideways instead of squeezing its columns.', commits: [h('badge')] },
        ],
      },
    };
  }
}

/** A complete review to render, edit and check (test/fixtures/sample-review.json, once the demo deck's content). */
export const sample = (): Review => JSON.parse(readFileSync(new URL('./fixtures/sample-review.json', import.meta.url), 'utf8')) as Review;
