# Privacy policy

sprint-review, the Claude Code plugin and the tool it uses, is open-source software that runs on
your own computer. Its author runs no service for it.

## What the author collects

Nothing. There is no sprint-review server, account, analytics or tracking. No data reaches the
author.

## What the tool handles on your computer

- The repository's commit messages and changed file paths for the sprint you choose. It does not
  read who wrote the commits: author names and emails are not read.
- `sprint-review.config.yml`, and screenshots of your app when you configure them.
- It writes the deck and its files in your repository, in `sprint-reviews/`.

## What it sends, and to whom

Only to services you choose and configure, with your own keys:

- **Your model provider** (Anthropic by default; Gemini, OpenAI, Mistral, OpenRouter, Azure or
  Amazon Bedrock, or a local model that sends nothing): the commit messages and file paths, pull
  request titles and descriptions, and your product description. When screenshots are set up, they
  are sent too (masked), to check each slide's picture; `screenshots.check: false` turns that off. What the provider does with it is governed by your agreement with that provider.
- **GitHub**, only when `GITHUB_TOKEN` is set: it reads the pull requests merged in the sprint.
- **Only when you set them up:** your Slack webhook (`--slack`) gets the summary, your own website
  is read for the logo and color (`brand.from`), and your app is opened in Chrome for screenshots.

Your API keys are used only to call these services, and are never stored or sent anywhere else.

## Code

The plugin itself contains no code: it is a skill (instructions for Claude) that runs the
`sprint-review` command you installed yourself.

## Contact

Questions: https://github.com/guuskeunen/sprint-review/issues
