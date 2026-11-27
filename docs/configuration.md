# Configuration reference

sprint-review works without a config. A config file makes the deck fit your product, audience and brand.

## Where the config lives

The CLI looks in the current folder for the first of:

1. `sprint-review.config.yml`
2. `sprint-review.config.yaml`
3. `sprint-review.config.json`

Or pass one: `sprint-review --config path/to/config.yml`. Relative paths inside the config (logo, screenshot folders, usage file) are resolved from the config's own folder.

`sprint-review init` writes a commented starting point. It never overwrites an existing file unless you add `--force`.

## A complete example

```yaml
repo: .
product:
  name: Spoke
  description: the planning and customer app of Northside Cycles, a chain of bike repair shops
organization: Northside Cycles
audience: business
presenter: The presenter is a developer who gives a short demo of each theme.
language: English
goal: One customer page for the front desk

sprint:
  days: 14

brand:
  color: "#ea580c"
  logo: ./assets/logo.png

productPaths: [src/, app/]
ignore: ["^chore\\(release\\)", "^Merge "]
nonProductTypes: [ci, build, test, docs, chore]
replace:
  client: customer
rules:
  - Call the mobile app "the app", never "the mobile client".

areas:
  customers: { icon: users, label: Customers, screen: customer-page }
  planner: { icon: calendar, label: Workshop planner, screen: planner }

screenshots:
  source: git
  dir: e2e/__screenshots__
  names:
    customer-page: Customer page
    planner: Workshop planner
  ignore: { left: 240, top: 64 }

roadmap: ROADMAP.md
usage: ./usage.json

labels:
  hoodTitle: Behind the curtain

limits:
  themes: 6
  themeScreens: 4
  changedScreens: 4
  commits: 3000

model:
  name: claude-opus-5-5
  fallback: claude-sonnet-5-5
  maxTokens: 16000

output:
  dir: sprint-reviews
  markdown: true
```

## Options

### `repo`
The git repository to read. Default: the config's folder.

### `product`

| Key | Default | Description |
|---|---|---|
| `name` | the folder or `package.json` name | How the product is called on the slides and in the prompt. |
| `description` | empty | One or two sentences on what the product is and who uses it. **The single most useful setting.** |

### `organization`
Your company or team name. Shown on the cover ("Sprint review Northside Cycles") and in "What Northside Cycles gains". Default empty.

### `audience`
Who watches the review. A preset, or a sentence of your own:

| Preset | Also called | Written for | Deck |
|---|---|---|---|
| `business` (default) | `marketing`, `sales`, `support` | Colleagues without a technical background. | standard |
| `executives` | `management` | Management: the few changes that matter most and what they bring. | brief, numbers first, no *Also shipped* |
| `customers` | | People who use the product: what they can do now. | standard |
| `team` | `engineers`, `developers` | The product team: plain words, a bit more detail. | detailed |

The preset sets the defaults of [`deck`](#deck); set `deck.density`, `deck.order` or `deck.sections` only to change them. A sentence of your own gets the standard deck.

```yaml
audience: Store managers who use Spoke every day but never see the code.
```

### `presenter`
Who presents. The speaker notes are written for them. Default: a technical presenter who knows the product and gives a short demo per theme.

### `language`
The language of the slide content, as a name (`English`, `Dutch`, `German`) or a code (`nl`, `de-DE`). The AI writes in any language. The fixed labels ("Also shipped", "Before", "After"…) ship in English, Dutch, German, French and Spanish. Other languages fall back to English labels; override them with [`labels`](#labels). Dates follow the language too: `November 16, 2026` in English, `16 november 2026` in Dutch. Dutch slides address the audience as *je* or *jij*, never *u*, the way Dutch teams speak to each other.

### `goal`
The sprint goal. Shown on the cover, and the AI puts the work that served it first. Default none.

### `sprint.days`
How many days a review covers when you don't pass `--since` or `--from`. Both ends are included, so `14` with today being the 16th covers the 3rd to the 16th. Default `14`.

### `brand`

| Key | Description |
|---|---|
| `color` | Accent color as `#rrggbb`. Lighter and darker shades are mixed from it. Default indigo `#4f46e5`. A color too light for a light deck or too dark for a dark one is darkened or lightened just enough to read (WCAG 3:1, as for large text and icons); a color that reads keeps its exact value. |
| `logo` | Path to a PNG, JPG, SVG, WebP or GIF, or a `data:image/...` URI. Shown on the cover, on a white plate. |
| `from` | A website (`https://...`) or the path to a `.pptx` or `.potx`. From a website: its brand color (a `--brand` or `--primary` color in its stylesheet, or its `theme-color`; grays are skipped), its heading and body fonts (`--font-heading`/`--font-display`, `--font-sans`/`--font-body`) and its logo (a logo image or SVG in the header first, then elsewhere on the page, passing over walls of client or partner logos; else its largest icon). From a presentation: its theme's first accent color, fonts and the logo on its slide master. Either way it fills in only what you didn't set here, and only the look is taken, not the layout. `sprint-review doctor` shows what it found. |
| `theme` | `light` (default) or `dark`: near-black with warm ivory text and a champagne accent. |
| `fonts.heading`, `fonts.body` | Font families for headings and text. The theme's own fonts are the fallback. |
| `fontFiles` | Font files to put inside the deck, by family, so it looks the same on any laptop: `{ Inter: [fonts/inter-400.woff2, fonts/inter-700.woff2] }`. The weight comes from the file name (400, 700). Open fonts are on npm as `@fontsource/<name>`. Keep to a few weights: 2 MB at most. Without them, the fonts must be installed where the deck is shown. |

```yaml
brand:
  from: https://www.example.com            # color, fonts and logo from our website
  color: "#0b7a75"                         # ...but this color wins
```

The website is read once per run. When it can't be reached the run stops with a clear error; set `color` and `logo` yourself to not depend on it.

### `productPaths`
Folders (path prefixes) that hold product code. A commit that only touches files outside them can't carry a theme or the headline; whatever the AI writes about it moves under the hood. Default: empty, meaning every commit counts. Strongly recommended for monorepos.

```yaml
productPaths: [apps/web/src/, apps/api/app/, packages/ui/]
```

### `ignore`
Regular expressions, matched case-insensitively against commit subjects. Matching commits are left out entirely, as if they never happened. Default none.

### `nonProductTypes`
[Conventional Commit](https://www.conventionalcommits.org) types that never count as product work, whatever files they touch. Default `[ci, build, test, docs, chore]`. Set `[]` to turn this off.

### `replace`
Words the AI tends to get wrong, mapped to the word your team uses. Whole words only. A capital first letter stays a capital.

```yaml
replace:
  client: customer
  noot: notitie
```

### `rules`
Extra writing rules, one per line, in your own words. They're added to the AI's instructions.

### `areas`
The main parts of your product, so themes get the right icon (and screenshot) consistently. Each key maps to:

| Key | Description |
|---|---|
| `icon` | An icon key. Run `sprint-review icons` for the list. |
| `label` | How the area is called in the product, such as its menu label. |
| `screen` | Optional: the screenshot key that shows this area. |

### `screenshots`
Before and after slides, and pictures on theme slides. See the [screenshots guide](screenshots.md).

| Key | Description |
|---|---|
| `source` | `none` (default), `git`, `folder` or `capture`. |
| `dir` | `git`: the folder in the repository with the pictures, from the repository root. |
| `before`, `after` | `folder`: two folders with the pictures at the start and end of the sprint. |
| `pages`, `baseUrl`, `devices`, `mask`, `storageState`, `login`, `wait`, `storage`, `onReview` | `capture`: the tool takes the pictures itself. See [taking screenshots](screenshots.md#option-3-the-tool-takes-them-capture). |
| `names` | Readable names per screen key. Also sets the order. |
| `ignore.left` | Pixels on the left to skip when comparing desktop pictures (a side menu). |
| `ignore.top` | Pixels at the top to skip (a top bar). |

### `revise`
After the second reader flags lines it got stuck on, the writer rewrites just those lines, once. A rewrite only replaces the original if it passes every check again; `checks.md` lists it as *corrected*. Lines that couldn't be fixed stay as warnings. Default `true`. Set `false` to only flag them.

### `github`
Pull request titles and descriptions as extra context: teams often write *why* in a pull request and only *what* in a commit.

| Key | Default | Description |
|---|---|---|
| `pullRequests` | `auto` | `auto`: when `GITHUB_TOKEN` or `GH_TOKEN` is set (always true in GitHub Actions). `true`: always try. `false`: never. |
| `repo` | from the environment | `owner/name`. Default: `GITHUB_REPOSITORY`, or the `origin` remote when it points at github.com. |

One API request per commit with product code (at most 150). Any failure leaves the commits as they were: it never breaks a run.

### `slack`
`true` to post the summary to Slack after every run. The webhook URL comes from the `SLACK_WEBHOOK_URL` environment variable, never the config. Set `SPRINT_REVIEW_DECK_URL` (or pass `--deck-url`) to add an *Open the deck* button. Default `false`; `--slack` does the same for one run.

### `roadmap`
A Markdown file in the repository, read as it was at the end of the sprint. Default `ROADMAP.md`. Set `false` to skip it. No file: no roadmap slide. Two ways to write it:

- **A checklist:** every line `- [x] text` is a reached milestone, `- [ ] text` an open one. The slide shows how many are reached and marks the next one, and the next review shows whether what was next got done (*Last sprint*).
- **`## Now` and `## Next` sections**, as many teams keep a roadmap. Only the lead of each top-level item counts (its bold opening, or its first sentence); other sections such as tech debt or ideas are left out. The AI picks up to three per section that your audience would notice and rewords them for it; each line must point at a real item of the file, or it is dropped. The slide shows Now and Next side by side, without a percentage.

```yaml
roadmap: docs/development/ROADMAP.md
```

### `feedback`
A Markdown file in the repository with requests from users and stakeholders, one per line (`- Can we see the direct phone number?`). Default `FEEDBACK.md`; `false` to skip it. The AI matches the requests this sprint's commits answered, three at most, and says what was done; each must point at a real request and be backed by a product commit, or it is dropped. They show on a *You asked* slide before the themes.

### `usage`
A JSON file with usage numbers you produce (from your analytics, database or a script):

```json
[
  { "label": "repairs booked", "value": 312, "previous": 268, "history": [190, 221, 240, 268] },
  { "label": "minutes until a bike is ready", "value": 52, "previous": 61, "better": "down" },
  { "label": "repair tickets read", "value": 41 }
]
```

The slide shows four at most, one big number each. Numbers of zero are left out. With `previous` the number shows how much it changed ("+16%"), green when it went the better way: up, or down for a number with `"better": "down"` (errors, waiting time). `history` holds earlier sprints, oldest first; with two or more, a small trend line shows under the number. The AI never sees or makes up these numbers.

### `labels`
Override any fixed label on the slides. Keys:

`sprintReview`, `period`, `goalLabel`, `usageLabel`, `usageTitle`, `previous`, `summaryTitle`, `moreLabel`, `moreTitle`, `screensLabel`, `before`, `after`, `beforeAlt`, `afterAlt`, `onPhone`, `roadmapLabel`, `roadmapReached`, `roadmapNext`, `hoodLabel`, `hoodTitle`, `kind_security`, `kind_reliability`, `kind_speed`, `kind_maintenance`, `questions`, `feedbackTitle`, `notesLabel`, `hintBrowse`, `hintFullscreen`, `hintPresenter`, `hintNotes`, `presenter`, `previousSlide`, `nextSlide`, `slideOf`, `noNotes`, `upNext`, `lastSlide`, `edit`, `editStart`, `copy`, `copied`, `phone`, `desktop`, `value_faster`, `value_quality`, `value_less_manual_work`, `value_less_risk`, `value_insight`.

Placeholders in curly braces are filled in: `{org}`, `{product}`, `{n}`, `{total}`, `{name}`, `{from}`, `{until}`, `{title}`.

```yaml
language: German
labels:
  sprintReview: Sprint-Review
  hoodTitle: Außerdem geliefert
  before: Vorher
  after: Nachher
```

### `deck`
What goes on the slides and in which order. See [How the deck is designed](design.md) for the rules behind it.

| Key | Default | Description |
|---|---|---|
| `density` | by [audience](#audience) | `brief`: two points per theme and two theme slides. `standard`: three and three. `detailed`: four and four. Themes past that share a slide of cards. A slide with more words than the audience reads at a glance (30, 40 or 50) gets a warning in `checks.md`. |
| `order` | `story` | `story` puts the numbers near the end. `numbers-first` puts them right after the headline, and is the default for `audience: executives`. |
| `sections` | all on | Turn optional slides off: `headline`, `lastTime` (what the last review said was next), `answered` (you asked, we did), `screens` (before and after), `hood` (also shipped), `roadmap`, `usage`, `questions`. Executives get `hood: false` by default. |

```yaml
deck:
  density: brief
  sections:
    roadmap: false
```

A theme's layout (beside its screenshot, a large screenshot, the icon, or a card) is picked per theme from its content. Change it in the editor or with `"layout"` in `review.json`.

### `limits`

| Key | Default | Description |
|---|---|---|
| `themes` | `6` | The most themes. The first ones get a slide each (see [`deck.density`](#deck)), the rest share a slide of cards. |
| `themeScreens` | `4` | The most theme slides with a screenshot. |
| `changedScreens` | `4` | The most before and after slides. |
| `commits` | `3000` | The most commits read, newest first; past it, `checks.md` says the sprint's first days are missing. What the AI reads is fitted to `model.maxInputChars`: a line for every product commit first, then details as far as they fit; `checks.md` counts what was left out. |

### `model`

| Key | Default | Description |
|---|---|---|
| `provider` | `anthropic` | `anthropic`, `bedrock`, `openai`, `azure`, `openrouter`, `gemini`, `mistral`, `ollama` or `lmstudio`. See [models and providers](models.md). |
| `name` | `claude-opus-5-5` | The model for every call. Required for every provider but `anthropic`. |
| `fallback` | `claude-sonnet-5-5` | Used when the first model fails after retries. `null` to turn off. Default none for other providers. |
| `maxTokens` | `16000` | Room for each answer. Thinking models count their thinking against it too; when it runs out, the error says so. |
| `baseUrl` | per provider | The endpoint, for `azure` (required), a gateway or a local server on another port. |
| `mode` | `tools` | `json` asks for JSON matching the schema instead of forcing a tool call. Default `json` for `ollama` and `lmstudio`. |
| `maxInputChars` | `120000` | How much of the commit log the model gets. `24000` for local models. A longer sprint is fitted to it: a line for every product commit first, then details as far as they fit; `checks.md` counts what was left out. |
| `region` | `AWS_REGION` | `bedrock` only. |
| `price` | list price | `{ input, output }`: US dollars per million tokens, for the cost of each run. Built in for Claude on the Anthropic API and for Gemini; set it for Bedrock, Azure, OpenRouter, a gateway, or a model the list doesn't know. |

The key always comes from the environment, never from the config, so the config can be committed: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, or `AWS_BEARER_TOKEN_BEDROCK` (or AWS access keys) for Bedrock. Local models need none.

```yaml
model:
  provider: bedrock
  name: us.anthropic.claude-opus-5-5-v1:0
  region: eu-central-1
```

### `output`

| Key | Default | Description |
|---|---|---|
| `dir` | `sprint-reviews` | Each review goes in `<dir>/<last day of the sprint>/`. `--out` overrides the whole path. |
| `markdown` | `true` | Also write `review.md`. |
| `pptx` | `auto` | Also write `deck.pptx`, an editable PowerPoint with speaker notes. `auto` writes it whenever `pptxgenjs` is installed (`npm i -D pptxgenjs`); `true` requires it, `false` turns it off. `--pptx` asks for it for one run. |

Every run also adds a line to `<dir>/costs.csv`: the dates, the models that answered, the tokens and the estimated cost in US dollars. The CLI prints the run's cost and the total so far.
