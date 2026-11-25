import { execFileSync } from 'node:child_process';
import type { Commit, Milestone } from '../types.ts';

export class GitError extends Error {}

/**
 * The stretch of history a review covers: two dates (both days included), or two git refs
 * such as tags, where the review covers what `to` has and `from` does not.
 */
export type Range =
  /** The days from and until, counted on a branch or commit (at), HEAD when it is not set. */
  | { kind: 'dates'; from: string; until: string; at?: string }
  | { kind: 'refs'; from: string; to: string };

const MAX_BODY = 600;

export class History {
  private readonly repo: string;

  constructor(repo: string) {
    this.repo = repo;
  }

  git(args: string[], allowFail = false): string {
    try {
      return execFileSync('git', args, { cwd: this.repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (allowFail) return '';
      const err = e as { stderr?: string; message: string };
      throw new GitError(`git ${args[0]} failed in ${this.repo}: ${(err.stderr ?? err.message).trim()}`);
    }
  }

  gitBytes(args: string[]): Buffer | null {
    try {
      const out = execFileSync('git', args, { cwd: this.repo, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      return out.length === 0 ? null : out;
    } catch {
      return null;
    }
  }

  /**
   * Throws a readable error when the folder is no git repository, or when its history is cut off
   * (a shallow clone) after the range starts. A shallow clone that reaches back far enough is fine.
   */
  assertUsable(range?: Range): void {
    try {
      this.git(['rev-parse', '--git-dir']);
      if (!this.git(['rev-parse', '--verify', '--quiet', 'HEAD'], true).trim()) throw new GitError(`${this.repo} has no commits yet: there is nothing to review.`);
    } catch (e) {
      if (!/not a git repository/i.test((e as Error).message)) throw e;
      // Usually a config file kept outside the repository: the repository is taken from where the config is.
      throw new GitError(`${this.repo} is not a git repository. Run sprint-review inside the repository, or set repo: in the config to its folder.`);
    }
    if (this.git(['rev-parse', '--is-shallow-repository']).trim() !== 'true') return;
    const fetchMore = 'In GitHub Actions, use actions/checkout with fetch-depth: 0.';
    if (!range) throw new GitError(`This checkout has a shallow history, so older commits may be missing. ${fetchMore}`);
    // Where the history is cut off: the oldest commit that is still there.
    const starts = this.git(['log', '--format=%cs', '--max-parents=0', 'HEAD']).split('\n').filter(Boolean).sort();
    const cut = starts[0] ?? '';
    if (range.kind === 'dates') {
      if (cut && cut >= range.from) throw new GitError(`This checkout's history starts on ${cut}, but the sprint starts on ${range.from}. Fetch more: git fetch --shallow-since=${earlier(range.from)}. ${fetchMore}`);
      return;
    }
    if (!this.resolve(range.from)) throw new GitError(`"${range.from}" is not in this checkout's shallow history. Fetch more: git fetch --unshallow. ${fetchMore}`);
  }

  /** The commits of the range, newest first, without merges. */
  commits(range: Range, productPaths: string[], ignore: string[], max: number, nonProductTypes: string[] = NON_PRODUCT_TYPES): Commit[] {
    for (const ref of range.kind === 'refs' ? [range.from, range.to] : range.at ? [range.at] : []) if (!this.resolve(ref)) throw new GitError(`No tag, branch or commit called "${ref}" in ${this.repo}.`);
    const args = ['log', '--no-merges', '--date=short', `--max-count=${max}`, '--name-only', '--format=%x1d%h%x1f%ad%x1f%s%x1f%b%x1e'];
    args.push(...rangeArgs(range));
    const patterns = ignore.map((p) => new RegExp(p, 'i'));

    const commits: Commit[] = [];
    for (const record of this.git(args).split('\x1d')) {
      const [meta = '', names = ''] = record.split('\x1e');
      const parts = meta.trim().split('\x1f');
      const subject = (parts[2] ?? '').trim();
      if (parts.length < 3 || subject === '' || patterns.some((p) => p.test(subject))) continue;
      const files = names.split('\n').map((n) => n.trim()).filter(Boolean);
      commits.push({
        hash: parts[0]!,
        date: parts[1]!,
        subject,
        body: clip(withoutTrailers(parts[3] ?? '')),
        files,
        product: touchesProduct(files, productPaths) && !nonProductTypes.includes(commitType(subject) ?? ''),
      });
    }
    return commits;
  }

  /** The commit at the start and at the end of the range: the before and after of the screenshots. */
  ends(range: Range): { start: string | null; end: string | null } {
    if (range.kind === 'refs') return { start: this.resolve(range.from), end: this.resolve(range.to) };
    return { start: this.revisionAt(`${range.from} 00:00:00`, range.at), end: this.revisionAt(`${range.until} 23:59:59`, range.at) };
  }

  /** The files that changed in the range under a folder. */
  changedPaths(range: Range, dir: string): string[] {
    const args = ['log', '--format=', '--name-only'];
    args.push(...rangeArgs(range));
    args.push('--', `:(top)${dir}`);
    return [...new Set(this.git(args).split('\n').map((l) => l.trim()).filter(Boolean))];
  }

  /** The first version of a file added inside the range: the only "before" a new picture has. */
  oldestInRange(range: Range, path: string): Buffer | null {
    const args = ['log', '--reverse', '--format=%H'];
    args.push(...rangeArgs(range));
    args.push('--', `:(top)${path}`);
    const first = this.git(args, true).split('\n')[0]?.trim();
    return first ? this.show(first, path) : null;
  }

  /** How many commits of a date range `ref` holds that the range's own branch lacks; null when `ref` doesn't exist. */
  missingFrom(range: Range, ref: string): number | null {
    if (range.kind !== 'dates' || !this.resolve(ref)) return null;
    const args = ['rev-list', '--count', '--no-merges', `--since=${range.from} 00:00:00`, `--until=${range.until} 23:59:59`, '--end-of-options', safeRef(ref), `^${safeRef(range.at ?? 'HEAD')}`];
    return Number(this.git(args, true).trim()) || 0;
  }

  /** The branch a remote's HEAD points at (origin/main), null when there is no remote. */
  remoteDefault(remote = 'origin'): string | null {
    const ref = this.git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], true).trim();
    return ref || null;
  }

  /** A ref when it exists, else null. */
  exists(ref: string): boolean {
    return this.resolve(ref) !== null;
  }

  listFiles(revision: string, dir: string): string[] {
    return this.git(['ls-tree', '-r', '--full-tree', '--name-only', revision, `${dir}/`], true).split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /** A file as it was at a revision, null when it did not exist then. */
  show(revision: string, path: string): Buffer | null {
    return this.gitBytes(['show', `${revision}:${path}`]);
  }

  /** The milestones of a roadmap file at the end of the range: every `- [x] text` and `- [ ] text`. */
  milestones(end: string | null, file: string | null): Milestone[] {
    if (!end || !file) return [];
    const text = this.show(end, file)?.toString('utf8');
    if (!text) return [];
    return parseRoadmap(text);
  }

  /** The requests in the feedback file at the end of the range: every list item, without checkboxes. */
  requests(end: string | null, file: string | null): string[] {
    if (!end || !file) return [];
    const text = this.show(end, file)?.toString('utf8') ?? '';
    return text
      .split(/\r?\n/)
      .map((l) => /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(l)?.[1])
      .filter((x): x is string => !!x)
      .slice(0, 40)
      .map((x) => x.slice(0, 200));
  }

  private revisionAt(moment: string, at = 'HEAD'): string | null {
    const hash = this.git(['rev-list', '-1', `--before=${moment}`, '--end-of-options', safeRef(at)], true).trim();
    return hash === '' ? null : hash;
  }

  private resolve(ref: string): string | null {
    const hash = this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${safeRef(ref)}^{commit}`], true).trim();
    return hash === '' ? null : hash;
  }
}

/**
 * The git arguments for a range. Refs come from the CLI, the GitHub Action's inputs and the MCP
 * server's tool arguments, so one that starts with "-" is refused: git would read it as an
 * option (--output=<file> writes anywhere). --end-of-options guards the rest.
 */
function rangeArgs(range: Range): string[] {
  if (range.kind === 'dates') return [`--since=${range.from} 00:00:00`, `--until=${range.until} 23:59:59`, ...(range.at ? ['--end-of-options', safeRef(range.at)] : [])];
  return ['--end-of-options', `${safeRef(range.from)}..${safeRef(range.to)}`];
}

function safeRef(ref: string): string {
  if (!ref || ref.startsWith('-') || /[\s\0]/.test(ref)) throw new GitError(`"${ref}" is not a valid git ref: use a tag, branch or commit.`);
  return ref;
}

/** Conventional Commit types that never change the product a user sees. `chore(deps)` counts as `chore`. */
export const NON_PRODUCT_TYPES = ['ci', 'build', 'test', 'docs', 'chore'];

/** The type of a Conventional Commit subject (`feat(scope)!: …` gives `feat`), or null. */
export function commitType(subject: string): string | null {
  return /^([a-z]+)(\([^)]*\))?!?:\s/i.exec(subject)?.[1]?.toLowerCase() ?? null;
}

/** Without a file list nothing is known, so the commit counts. No product paths set: every commit counts. */
export function touchesProduct(files: string[], productPaths: string[]): boolean {
  if (productPaths.length === 0 || files.length === 0) return true;
  return files.some((f) => productPaths.some((p) => f.startsWith(p)));
}

/** Co-authored-by and similar trailer lines say nothing about the change. */
export function withoutTrailers(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^\s*[\w-]+-by:/i.test(line) && !line.includes('Generated with') && !/^\s*[\w-]+-Session:/i.test(line))
    .join('\n')
    .trim();
}

function clip(text: string): string {
  return text.length <= MAX_BODY ? text : `${text.slice(0, MAX_BODY).trimEnd()}…`;
}

/** Items per section of a Now / Next roadmap: the first ones are what matters. */
const STAGE_ITEMS = 6;

/**
 * The milestones in a roadmap file. A checklist (`- [x] done`, `- [ ] open`) gives every item and
 * whether it is done. A roadmap written as `## Now` and `## Next` sections gives the lead of each
 * top-level item there (its bold opening, or its first sentence), without the rest of the
 * paragraph and without other sections such as tech debt or ideas.
 */
export function parseRoadmap(text: string): Milestone[] {
  const out: Milestone[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ text: m[2]!.slice(0, 120), done: m[1]!.toLowerCase() === 'x' });
  }
  if (out.length) return out;
  let stage: 'now' | 'next' | null = null;
  const count = { now: 0, next: 0 };
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      const name = h[1]!.toLowerCase().replace(/[^a-z ]/g, '').trim();
      stage = /^(now|current|in progress|doing)\b/.test(name) ? 'now' : /^(next|up next|soon)\b/.test(name) ? 'next' : null;
      continue;
    }
    const item = stage && /^[-*]\s+(.+)$/.exec(line);
    if (!stage || !item || count[stage] >= STAGE_ITEMS) continue;
    const bold = /^\*\*(.+?)\*\*/.exec(item[1]!);
    const lead = (bold ? bold[1]! : item[1]!.split(/(?<=[.!?])\s/)[0]!).replace(/[*_`]/g, '').replace(/[.:]\s*$/, '').trim();
    if (lead) {
      out.push({ text: lead.slice(0, 120), done: false, stage });
      count[stage]++;
    }
  }
  return out;
}

/** A week before a day, so a shallow fetch also has the commit the sprint starts from. */
function earlier(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
}
