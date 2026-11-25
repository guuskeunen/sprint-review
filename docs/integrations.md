# Integrations

sprint-review is a command-line tool first. Everything else here builds on it.

## The Claude Code plugin

The skill and the MCP server in one install:

```
/plugin marketplace add guuskeunen/sprint-review
/plugin install sprint-review@sprint-review
```

Then ask Claude Code for a sprint review, or type `/sprint-review`. The plugin runs `npx @guuskeunen/sprint-review@0 mcp`, so it picks up new releases by itself. When you enable it, Claude Code asks for an API key and keeps it in the system's credential store; change it later under `/plugin`, Installed, Configure options. It is the key of the provider your config names (`model.provider`: Anthropic by default, or OpenAI, Gemini, Mistral, OpenRouter and others), and wins over that provider's key in the environment. Leave it empty to use the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...), or for a local model.

The plugin needs no approval: installing from this repository works for everyone. To give a whole team the plugin, register it in the repository's `.claude/settings.json` with `claude plugin marketplace add guuskeunen/sprint-review --scope project`; each person then runs `claude plugin install sprint-review@sprint-review --scope project` once.

## Claude Code, Cursor and other MCP clients

`sprint-review mcp` runs an [MCP](https://modelcontextprotocol.io) server over stdio. An AI assistant in your editor can then check the setup, preview a sprint's commits, write the review and rebuild it after an edit, and tell you what the checks did.

**Claude Code**

```bash
claude mcp add sprint-review -- npx -y @guuskeunen/sprint-review mcp
```

**Cursor, Windsurf, Claude Desktop and others** (their MCP config file):

```json
{
  "mcpServers": {
    "sprint-review": {
      "command": "npx",
      "args": ["-y", "@guuskeunen/sprint-review", "mcp"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

**As a bundle:** every [release](https://github.com/guuskeunen/sprint-review/releases/latest) has `sprint-review.mcpb` attached. Open it in Claude Desktop (or another client that installs MCP bundles) to install the server with a form for your API key. The bundle starts that release's npm package, so Node 22 or newer must be installed. The server is also in the [MCP registry](https://registry.modelcontextprotocol.io) as `io.github.guuskeunen/sprint-review`, and listed on [mcpservers.org](https://mcpservers.org/servers/guuskeunen/sprint-review).

Then ask: *"Make our sprint review for the last two weeks"*, or *"What would the sprint review read for v1.4.0 to v1.5.0?"*.

| Tool | Does | Changes files |
|---|---|---|
| `init_sprint_review` | Creates `sprint-review.config.yml` from the product name, description, audience, language, brand website and branch the assistant asked you for. Never replaces a config. | Yes, the config only |
| `check_sprint_review_setup` | Runs the same checks as `doctor`. | No |
| `preview_sprint_commits` | Lists the commits for a range, without a model call. | No |
| `generate_sprint_review` | Writes the deck and returns the paths, the themes, every check and the cost. Replaces an earlier deck in the same folder. | Yes |
| `render_sprint_review` | Rebuilds the deck from an edited `review.json`. | Yes, the deck only |

Every tool takes `directory` (a folder in the project; default where the server started). `preview_sprint_commits` and `generate_sprint_review` also take the range arguments `since`, `until`, `from` and `to`. Each tool tells the client whether it only reads, changes files or calls outside services (MCP tool annotations), so clients can ask before the ones that do.

## The Claude Code skill on its own

[`plugin/skills/sprint-review/SKILL.md`](../plugin/skills/sprint-review/SKILL.md) teaches Claude Code the workflow: check, preview, generate, report the checks, edit. The plugin includes it; without the plugin, copy the folder into your project's `.claude/skills/` (or `~/.claude/skills/` for all projects).

[`plugin/`](../plugin/) is the same skill as a plugin of its own, without the MCP server: that is the version for Anthropic's plugin directory, which takes plugins with a local MCP server, a `package.json` or scripts only from verified organizations. It uses the `sprint-review` command, so install the tool first. The plugin at the repository root has the skill and the MCP server.

## Pull request descriptions

Commit subjects say *what*; pull requests often say *why*. With `GITHUB_TOKEN` or `GH_TOKEN` set, the title and description of the pull request behind each commit go to the writer as extra context. In GitHub Actions this is on by default. Locally:

```bash
GITHUB_TOKEN=$(gh auth token) npx @guuskeunen/sprint-review
```

See [`github`](configuration.md#github) for the options. Pull request text is treated as untrusted input, like commit messages: wrapped and marked as data in the prompt.

## Other models

Claude by default; Bedrock, Azure OpenAI, OpenAI, OpenRouter, Gemini, Mistral, and local models with Ollama or LM Studio are a config line away. See [models and providers](models.md) for setup and an honest table of what's been tested.

## Slack

```bash
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
npx @guuskeunen/sprint-review --slack --deck-url https://acme.github.io/spoke/review/
```

Or `slack: true` in the config. See [posting to Slack from CI](github-action.md#posting-to-slack).

## GitLab, Bitbucket, Jenkins…

Anywhere with Node 22 and a git history that reaches back to before the sprint: `npx --yes @guuskeunen/sprint-review generate --json`. A GitLab job is in [`examples/gitlab-ci.yml`](../examples/gitlab-ci.yml).

## As a library

All of it is importable from TypeScript or JavaScript. See [the library guide](library.md).
