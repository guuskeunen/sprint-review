# sprint-review for Claude Code

A skill that has Claude write a sprint review deck from your repository's git history: themes in
business language, every line checked against the real commits, with before-and-after screenshots.

Ask Claude: *"Make our sprint review for the last two weeks"*, or *"What would the sprint review read
for v1.4.0 to v1.5.0?"*.

The skill uses the sprint-review tool. Install it first, following the instructions at
https://github.com/guuskeunen/sprint-review#quick-start (it needs Node 22 or newer). For the MCP
server as well, add the plugin from the repository's own marketplace, described in
https://github.com/guuskeunen/sprint-review/blob/main/docs/integrations.md.

## What it reads and sends

- **Reads**, on your computer: the repository's commit messages and changed file paths for the
  sprint, `sprint-review.config.yml`, and screenshots when you configure them. Not who wrote the
  commits: author names and emails are not read.
- **Sends to the model provider you choose** (Anthropic by default; Gemini, OpenAI, Mistral,
  OpenRouter, Azure, Amazon Bedrock, or a local model that sends nothing): those commit messages
  and file paths, pull request titles and descriptions, and your product description, with your own
  API key.
  Screenshots set up in the config are sent too, to check each slide's picture, unless `screenshots.check: false`.
- **Reads from GitHub**, only when `GITHUB_TOKEN` is set: the pull requests merged in the sprint.
- **Only when you set them up:** posts the summary to your Slack webhook (`--slack`),
  reads your own website for the logo and color (`brand.from`), and opens your app in Chrome to
  take screenshots (`screenshots.source: capture`).
- **Writes**, in your repository: the deck and its files in `sprint-reviews/`.
- **Keeps nothing elsewhere.** There is no sprint-review service: nothing goes to the author, and
  there is no tracking.

The plugin contains no code: the skill runs only the `sprint-review` command you installed. Full
privacy policy: [PRIVACY.md](PRIVACY.md).

Screenshots show whatever your app shows. Photograph demo data, or black out fields with
`screenshots.mask`, before you share a deck.

MIT license. Not made by or affiliated with Anthropic.
