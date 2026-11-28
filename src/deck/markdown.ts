import type { Review } from '../types.ts';
import { fill, labelsFor } from './i18n.ts';
import { roadmapMoves } from './plan.ts';

/**
 * Text from the model or from commits, safe in Markdown: brackets and angle brackets are escaped,
 * so it can't become a link, an image or HTML in review.md, checks.md or a job summary.
 */
function md(text: string | null | undefined): string {
  return (text ?? '').replace(/[\\[\]<>]/g, (c) => `\\${c}`);
}

/** A short Markdown version of the review: for a pull request, Slack, an email or a changelog. */
export function renderMarkdown(review: Review, labels: Record<string, string> = {}): string {
  const t = labelsFor(review.language, labels);
  const out: string[] = [`# ${md(review.title)}`, '', `_${md(review.period)}${review.organization ? ` · ${md(review.organization)}` : ''}_`, ''];
  if (review.headline) out.push(`**${md(review.headline)}**`, '');
  if (review.answered?.length) out.push(`## ${t.answeredLabel}`, '', ...review.answered.map((a) => `- "${md(a.ask)}": ${md(a.did)}`), '');
  if (review.lastTime?.items.length) out.push(`## ${t.lastTimeLabel}`, '', ...review.lastTime.items.map((m) => `- [${m.done ? 'x' : ' '}] ${md(m.text)}`), '');
  for (const th of review.themes) {
    out.push(`## ${md(th.title)}`, '');
    if (th.effect) out.push(md(th.effect), '');
    out.push(...th.points.map((p) => `- ${md(p)}`), '');
  }
  if (review.screens.length) {
    out.push(`## ${t.screensLabel}`, '', ...review.screens.map((s) => `- **${md(s.name)}**${s.caption ? `: ${md(s.caption)}` : ''}`), '');
  }
  if (review.underTheHood.length) {
    out.push(`## ${t.hoodTitle}`, '', ...review.underTheHood.map((p) => `- ${md(t[`kind_${p.kind}` as keyof typeof t] ?? p.kind)}: ${md(p.text)}`), '');
  }
  if (review.milestones.some((m) => m.stage)) {
    for (const [stage, label] of [['now', t.roadmapNow], ['next', t.roadmapNext]] as const) {
      const items = review.milestones.filter((m) => m.stage === stage);
      if (items.length) out.push(`## ${t.roadmapLabel}: ${label}`, '', ...items.map((m) => `- ${md(m.text)}`), '');
    }
  } else if (review.milestones.length) {
    const reached = review.milestones.filter((m) => m.done).length;
    const { moved, outside } = roadmapMoves(review);
    out.push(`## ${t.roadmapLabel}`, '');
    if (moved.length) out.push(`${t.roadmapMoved}:`, '', ...moved.map((x) => `- ${md(x.milestone.text)}: ${md(x.themes.join(', '))}`), '');
    if (outside.length) out.push(`${t.roadmapOutside}: ${md(outside.join(', '))}`, '');
    out.push(fill(t.roadmapReached, { n: reached, total: review.milestones.length }), '', ...review.milestones.map((m) => `- [${m.done ? 'x' : ' '}] ${md(m.text)}`), '');
  }
  if (review.questions.length) out.push(`## ${t.feedbackTitle}`, '', ...review.questions.map((q) => `- ${md(q)}`), '');
  return out.join('\n');
}

/** What the checks did, for the person who reads the draft. */
export function renderChecks(review: Review): string {
  if (!review.checks.length) return 'All checks passed. Nothing was corrected, moved or dropped.\n';
  const kinds: Record<string, string> = { warning: 'Look at', dropped: 'Dropped', moved: 'Moved under the hood', corrected: 'Corrected' };
  return review.checks.map((c) => `- **${kinds[c.kind] ?? c.kind}:** ${md(c.text)} (${md(c.reason)})`).join('\n') + '\n';
}
