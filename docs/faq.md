# FAQ

### Can I run it without sending anything outside our network?
Yes: use a local model with Ollama or LM Studio. The slides are plainer than with Claude, but nothing leaves your machine. See [models](models.md#ollama-local) and [security and privacy](security.md).

### Does it send my code to an AI?
No. It sends commit messages and file names of the sprint, pull request titles and descriptions when a GitHub token is set, plus your product description. Never source code, diffs, screenshots or usage numbers. See [what is sent](how-it-works.md#what-is-sent-to-the-ai).

### Which AI does it use?
Anthropic's Claude by default, through your own API key. Also Amazon Bedrock, Azure OpenAI, OpenAI, OpenRouter, Gemini, Mistral, and local models with Ollama or LM Studio: see [models and providers](models.md). With the library you can plug in any model yourself ([custom model client](library.md#your-own-model-client)).

### What does it cost?
Two or three API calls per review (the third only when the second reader flagged lines to rewrite), on your own account. `--dry-run` shows the token estimate before you spend anything.

### Can it make things up?
It's built so it can't get away with it. Every point must name real commits from the sprint, or it's dropped. Numbers come from your files, never from the AI. Pictures can only be screenshots that exist. And a second AI reads the result like your audience would. A person still reads the draft before it's presented.

### My commit messages are bad. Will it still work?
Better messages give better slides, but it copes: it also reads the changed file names, and Conventional Commit prefixes help it sort tooling from product work. With a GitHub token it also reads the pull request descriptions, which usually say why.

### Do I need Conventional Commits?
No. They help (a `ci:` commit is never a theme), but anything works.

### Does it work with monorepos?
Yes. Set `productPaths` to the folders that hold product code, such as `apps/web/src/`.

### Can I use it for release notes instead of sprints?
Yes: `--from v1.4.0 --to v1.5.0`. `review.md` works well as release notes.

### Which languages?
The AI writes the content in any language. Slide labels ship in English, Dutch, German, French and Spanish; override them for others.

### Can I use my company's slide template?
Partly. Point `brand.from` at your PowerPoint and the deck takes its accent color, fonts and logo. The layout stays sprint-review's own; exporting into your own slide layouts is on the roadmap.

### Is there a hosted version?
No, on purpose. It runs where your code is, with your key, and produces a file. Nothing to sign up for, nothing to host.

### What does the deck need to open?
Any modern browser. No internet: everything is inside the one file.

### Can I edit the deck in PowerPoint or Keynote?
Yes: with `pptxgenjs` installed, every review also writes `deck.pptx` (`--pptx` for one run, `output.pptx: false` to turn it off), editable, with the speaker notes in the notes pane. Keynote opens it too.

### Is it free?
The tool is free and open source (MIT). You pay your model provider for the API calls.

### Why not just ask an AI to write the review?
You can, once. sprint-review does it every sprint with no one in the loop: it reads exactly the sprint's range, drops lines it can't trace to commits, diffs real screenshots, rewrites what a fresh reader didn't understand, and logs every correction. It also runs inside your AI assistant: see the [MCP server](integrations.md#claude-code-cursor-and-other-mcp-clients).

### Can I use it from Claude Code or Cursor?
Yes. `sprint-review mcp` is an MCP server, and there's a Claude Code skill. See [integrations](integrations.md).
