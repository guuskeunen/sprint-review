# Getting started

From zero to your first sprint review deck in about five minutes.

## What you need

- **Node 22 or newer.** Check with `node --version`.
- **A git repository** with the sprint's commits in it.
- **An Anthropic API key.** Create one at [console.anthropic.com](https://console.anthropic.com). You only pay for what you use, on your own account.

## 1. Try it without any setup

In the root of your repository:

```bash
npx @guuskeunen/sprint-review --dry-run
```

This reads the last 14 days of commits and shows what it would send to the AI, without sending anything. You see which commits count as product work and roughly how many tokens a review will use.

If that looks right:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx @guuskeunen/sprint-review
```

After about a minute:

```
● sprint-review v0.1.0

  › Reading the git history
  › Found 23 commits from 2026-11-03 to 2026-11-16
  › Writing the slides with claude-opus-5-5
  › Building the deck

✓ 5 themes, 0 before-and-after slides, 4 checks (48s, 9120 tokens)

  Deck     sprint-reviews/2026-11-16/deck.html
  Content  sprint-reviews/2026-11-16/review.json  edit this, then run sprint-review render
  Checks   sprint-reviews/2026-11-16/checks.md 1 to look at
  Summary  sprint-reviews/2026-11-16/review.md
```

Open `deck.html` in a browser. Use the arrow keys to move through the slides and press **P** for the presenter window.

> **Tip:** add `sprint-reviews/` to your `.gitignore`, unless you want to keep every review in the repository.

## 2. Tell it about your product

The deck gets much better once the AI knows what the product is and who's watching. Create a config:

```bash
npx @guuskeunen/sprint-review init
```

It asks for the product's name, what it is, your website and who watches. It reads the website right away and shows what the deck takes from it: the logo, brand color and fonts. Without a terminal (in CI, or from a script), it takes `--website`, `--description` and `--preset` instead, and guesses the website from `homepage` in `package.json`.

The answers go into `sprint-review.config.yml`, which looks like this:

```yaml
product:
  name: Spoke
  description: the planning and customer app of a chain of bike repair shops, used by front desk staff and mechanics
organization: Northside Cycles
audience: business
language: English
sprint:
  days: 14
brand:
  from: https://www.northsidecycles.example   # logo, color and fonts from the website
productPaths:
  - src/
```

The fields that matter most:

| Field | Why it matters |
|---|---|
| `product.description` | The AI explains changes in terms of what the product does for its users. |
| `audience` | `business` (default), `executives`, `customers` or `team`, or describe your audience in a sentence. |
| `productPaths` | Folders with product code. Commits that only touch other files (tests, CI, docs) can never become a theme. |
| `sprint.days` | How far back a review looks. Default 14. |
| `brand.from` | Your website: the deck gets its logo, color and fonts. Without a brand the deck has the default look, and the run and `doctor` say so. |

`init --preset executives` (or `customers`, `team`) starts from another audience.

Every option is in the [configuration reference](configuration.md).

## 3. Check your setup

```bash
npx @guuskeunen/sprint-review doctor
```

```
✓ Config read from .
✓ Git history readable in .
✓ ANTHROPIC_API_KEY is set
✓ Node 22.11.0

All set. Run sprint-review generate.
```

## 4. Review the draft

Before you present, open `checks.md`. It lists:

- **Look at:** lines the second reader got stuck on, titles that say two things, and in a very long sprint how many commits didn't fit (one line with a count and a few examples).
- **Dropped:** points that named no real commit, or broke a rule (too long, an exclamation mark, an emoji).
- **Moved under the hood:** points that came from tooling changes.

Most of the time you just present the deck as it is. To change something, edit `review.json` and rebuild:

```bash
npx @guuskeunen/sprint-review render sprint-reviews/2026-11-16/review.json
```

See [editing and presenting](editing.md).

## 5. Add before and after screenshots (optional)

If your project has visual tests (Playwright, Cypress, Storybook snapshots…), the tool can show the screens that changed during the sprint. Or point it at two folders of pictures. See [screenshots](screenshots.md).

## 6. Run it every sprint

Set it up as a GitHub Action, so the draft is ready before the meeting. See [the GitHub Action guide](github-action.md).

## Other ways to pick the range

```bash
sprint-review --since 2026-11-03 --until 2026-11-16   # two dates, both included
sprint-review --until 2026-11-16                      # the sprint (sprint.days) ending that day
sprint-review --from v1.4.0                           # since a tag, up to HEAD
sprint-review --from v1.4.0 --to v1.5.0               # between two tags or commits
sprint-review --since 2026-11-18 --to origin/develop   # the days, read on another branch
```

## Installing it for good

`npx` downloads it each time. To install it in your project instead:

```bash
npm install --save-dev @guuskeunen/sprint-review
npx sprint-review
```

Or globally: `npm install -g @guuskeunen/sprint-review`, then just `sprint-review`.
