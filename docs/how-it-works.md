# How it works

sprint-review splits the work between an AI, code and a person, and gives each the part it's best at.

| | Does |
|---|---|
| **The AI** | Groups the changes into themes and writes the words: the sprint headline, themes, points, captions, speaker notes and questions for the audience. Then a second call reads the slides like your audience would. |
| **Code** | Reads the history, checks every line the AI wrote, counts every number, picks and crops every picture, builds the page. |
| **A person** | Reads the draft, changes something if needed, presents it. |

The reason: AI is great at turning "optimize status count queries" into "the planner loads faster". It shouldn't be the one deciding what happened. Early versions of this tool let the AI do more, and it picked wrong screenshots and wrote things that weren't true. So now the AI only writes words, and everything that can be checked is checked in code.

## The pipeline

```
git history ──► commits (+ pull requests), changed screenshots, roadmap
                      │
                      ▼
          AI writer (one call, structured output)
                      │
                      ▼
          code checks ──► check log
                      │
                      ▼
          AI reader (one call, sees only the slide text)
                      │
                      ▼
          one rewrite of the flagged lines ──► the same checks again
                      │
                      ▼
          deck: pictures, numbers, icons, brand ──► deck.html, review.json, review.md, checks.md
```

### 1. Reading the history

- `git log` for the range, without merge commits: hash, date, subject, body and changed files.
- Trailer lines (`Co-authored-by:`, `Signed-off-by:`, "Generated with…") are removed from bodies, and bodies are cut at 600 characters.
- Commits matching `ignore` are left out.
- With a GitHub token, the pull request behind each product commit is looked up; its title (and, on its first commit, its description, cut at 800 characters and without HTML comments) is added to the log.
- Each commit is marked as product work or not: it must touch a file under `productPaths` (if set) and must not be a `ci:`, `build:`, `test:`, `docs:` or `chore:` commit (`nonProductTypes`).
- A long sprint is fitted to what the model can read (`model.maxInputChars`) without losing its first days: a line for every product commit first, then up to 15% of the room for lines of the other commits, then the details of product commits as far as they fit. What's still left out is counted in one warning in `checks.md`. A sprint of 1,300 commits (VS Code over two weeks) fits this way with every product commit in view.
- At most `limits.commits` commits are read (3,000), newest first; a sprint past it gets a warning that its first days are missing.
- A shallow clone is fine when its history reaches back to before the sprint starts.

### 2. The writer

One call with a fixed answer shape: the model fills in fields (headline, themes, under the hood, captions, questions) instead of writing free text. The prompt holds principles and examples, nothing about one particular sprint, so it never needs editing between reviews. It includes your product description, audience, language, team words and rules.

Commit messages are written by people, so they go in between unique markers, and the model is told that whatever is between them is data, never instructions. A commit that says "ignore your rules" is just a commit.

The model picks icons from a fixed set, values from a fixed list, and screenshots only from those that exist.

### 3. The checks

Every line the writer returned goes through code:

| Check | What happens |
|---|---|
| Each point names commit hashes, and they exist in this sprint | Otherwise the point is **dropped**. |
| A point only backed by non-product commits | **Moved** under the hood; a headline about one is dropped. |
| Points ≤ 16 words, effects and captions ≤ 25, notes ≤ 70, titles ≤ 4 | Otherwise **dropped**. |
| No `!`, no emoji | Otherwise **dropped**. |
| Ticket numbers (`#42`, `ABC-81`) and hashes | **Removed** from the text. |
| Long dashes | Become a comma. |
| Your `replace` words | **Applied**, keeping the capital. |
| At most `limits.themes` themes, 2 to 4 points per theme (`deck.density`), 5 under the hood, 3 questions | The rest is **dropped**. |
| A theme slide with more words than the audience reads at a glance | A **warning**: shorten it in the editor. |
| A theme with no points left | **Dropped**. |
| Unknown icon | Becomes `other`. |
| A screenshot that doesn't exist | Removed from the theme. |
| Commits past what the model can read in a very long sprint | Listed to **look at**. |

Everything that happened goes into `checks.md`. Nothing is fixed silently.

### 4. The reader

A second call gets only the slide text: no commits, no context, nothing it could use to fill a gap. It reads as your audience and lists every sentence it gets stuck on, as *unclear* or as an empty *promise*. The reader never rewrites anything itself. Its findings go into `checks.md`. If the call fails, the draft is kept, with a "Not proofread" warning at the top of the check log.

### 4b. One rewrite

The flagged lines go back to the writer, with the reader's reason, once. Each rewrite goes through the same checks as the first draft (word limits, references stripped, team words applied) and only replaces the original when it passes; it's logged as *corrected*, old and new side by side. A line that couldn't be fixed keeps its warning, so you know to look at it. `revise: false` turns this off.

### 5. The deck

Code builds the page from the checked content:

- **Screenshots:** before and after slides only for changed screens the writer could explain in a line (at most `limits.changedScreens`). Theme pictures at most `limits.themeScreens`, and a picture never shows twice: not on two themes, and not on a theme when it already has a desktop before and after slide.
- **Values:** the "What we gain" slide groups themes by the value the writer picked.
- **Numbers:** usage comes from your `usage` file, milestones from your roadmap file at the end of the sprint. The model never writes a number.
- **Brand:** your color (with lighter and darker shades mixed from it), your logo and fonts, or all three from a `.pptx` with `brand.from`. Light by default; `brand.theme: dark` for a dark deck.

The result is one HTML file with everything inline: styles, script, icons, pictures. No fonts, scripts or images are loaded from anywhere, so it works offline and keeps working.

## What is sent to the AI

- The writer gets: the system prompt (your product description, audience, language, rules), the commit log (hashes, dates, subjects, bodies, up to six file names per commit, pull request titles and descriptions when a token is set) and the names of the screens.
- The reader gets: the slide text.
- The rewrite gets: the slide text and the flagged lines with the reader's reasons.
- When you set up screenshots (unless `screenshots.check: false`): each screenshot, scaled down, to say what it shows; and each picked screenshot with its slide's text, to say whether it fits.

Never source code, never diffs, never usage numbers. Screenshots only for the picture check, which `screenshots.check: false` turns off.
