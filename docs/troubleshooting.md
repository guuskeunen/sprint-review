# Troubleshooting

Start with `npx @guuskeunen/sprint-review doctor`. It checks the config, the git history (and whether the checkout misses commits of the sprint that `origin/main` or `origin/develop` has), the API key (with Anthropic it asks the API whether the key works and the model exists, which costs nothing) and your Node version, and says how to fix each one.

**`fetch failed` after a few minutes:** the answer streams, so a VPN or proxy that drops quiet connections no longer ends a run. If it still happens, the output says which try failed and why; check that `api.anthropic.com` is reachable.

### "This checkout's history starts on …" or "has a shallow history"
The repository was cloned with only part of its history, which is common in CI. A shallow clone is fine as long as it reaches back to before the sprint started (`git clone --shallow-since=<a week before the sprint>`); the error names the date to fetch from. To be safe, fetch everything. In GitHub Actions:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```

In GitLab CI set `GIT_DEPTH: 0`. Locally: `git fetch --unshallow`.

### "No commits found from … to …"
- Check the dates: `sprint.days` counts back from today, both days included.
- Merge commits are skipped. With squash or rebase merges that's fine. With merge commits, the work is in the merged branch's commits, which are included.
- Commits matching `ignore` are left out.
- In CI, make sure the branch you want is checked out, usually your main branch.

### "… of … commits not read" in checks.md
The sprint is longer than the model reads at once (`model.maxInputChars`). Every product commit still gets a line, so what's left out is usually docs and chores. If product commits are left out too, narrow `productPaths` or `ignore`, or raise `model.maxInputChars` when your model takes more.

### "Only the newest … commits were read"
The sprint has more commits than `limits.commits` (3,000), so its first days are missing. Raise the limit, or leave noise out with `ignore`.

### "ANTHROPIC_API_KEY is not set"
Create a key at [console.anthropic.com](https://console.anthropic.com), then `export ANTHROPIC_API_KEY=sk-ant-...` in your shell or add it as a repository secret in CI.

### "Anthropic API 401"
The key is wrong or revoked. The tool doesn't try the fallback model for this.

### "Anthropic API 429" or "529"
Rate limited or overloaded. The tool retries three times with a pause, then tries the fallback model. Run it again a little later if it still fails.

### "The model returned nothing usable"
Every theme and the headline failed the checks, usually because the sprint has only tooling commits. Run with `--dry-run` to see which commits count as product work, and check `productPaths` and `nonProductTypes`.

### A theme I expected is missing
Look in `checks.md`. A point that named no real commit, or broke a rule, was dropped there. A theme that lost all its points was dropped too.

### Everything is under the hood
Your `productPaths` probably don't match. They're path prefixes from the repository root, such as `src/` or `apps/web/src/`. Run `--dry-run`: commits marked `[no product code]` didn't match.

### No before and after slides
- `screenshots.source` must be `git` or `folder`.
- With `git`, `dir` is a path from the repository root, and the PNGs must have changed during the sprint.
- A screen only gets a slide when the AI could say what changed. Tiny changes are skipped.
- Every screen looks changed because of the menu? Set `ignore.left` and `ignore.top`.

### The labels are in English but my content isn't
The fixed labels ship in English, Dutch, German, French and Spanish. For other languages, override them with `labels`. See [configuration](configuration.md#labels).

### The logo doesn't show
`brand.logo` must point to a PNG, JPG, SVG, WebP or GIF, relative to the config file. `doctor` checks that it exists.

### Still stuck?
[Open an issue](https://github.com/guuskeunen/sprint-review/issues) with the output of `doctor` and `--dry-run`. Leave out anything private.
