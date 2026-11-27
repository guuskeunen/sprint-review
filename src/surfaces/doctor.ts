import { loadPlaywright } from '../screens/capture.ts';
import { sprintRange } from '../review/generate.ts';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { History } from '../git/history.ts';
import { bedrockAuth, isLocal, keyEnvFor, PRESETS } from '../ai/providers.ts';
import { brandFromWebsite, isWebsite } from '../brand/website.ts';

export interface DoctorLine {
  ok: boolean;
  text: string;
  fix?: string;
}

/** Everything that has to be right before generate can work, as a list the CLI and the MCP server both show. */
export async function doctorChecks(config: Config, cwd = process.cwd(), env = process.env, fetchImpl: typeof fetch = fetch): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  const add = (ok: boolean, text: string, fix?: string) => lines.push({ ok, text, ...(ok || !fix ? {} : { fix }) });
  try {
    // The sprint a review would cover now: a shallow clone that reaches back far enough is fine.
    new History(config.repo).assertUsable(sprintRange(config.sprint.days));
    add(true, `Git history readable in ${relative(cwd, config.repo) || '.'}`);
  } catch (e) {
    add(false, (e as Error).message, 'Run inside a git repository, or set repo in the config.');
  }
  const s = config.screenshots;
  if (s.source === 'folder') add(existsSync(resolve(config.root, s.before)) && existsSync(resolve(config.root, s.after)), 'Screenshot folders exist', 'Check screenshots.before and screenshots.after.');
  if (s.source === 'capture') {
    // The same check capture makes: playwright-core with the installed Chrome counts too.
    const found = await loadPlaywright();
    add(found !== null, `Playwright is installed for screenshots${found?.core ? ' (playwright-core, with your Chrome)' : ''}`, 'npm install --save-dev playwright-core (uses your installed Chrome), or playwright && npx playwright install chromium');
  }
  if (config.output.pptx === true) {
    let pptx = false;
    try {
      await import('pptxgenjs' as string);
      pptx = true;
    } catch {}
    add(pptx, 'pptxgenjs is installed for PowerPoint export', 'npm install --save-dev pptxgenjs');
  }
  if (config.brand.logo && !config.brand.logo.startsWith('data:')) add(existsSync(resolve(config.root, config.brand.logo)), 'Logo file exists', `Check brand.logo: ${config.brand.logo}`);
  if (isWebsite(config.brand.from)) {
    let found: string | null = null;
    try {
      const site = await brandFromWebsite(config.brand.from, fetchImpl);
      found = [site.color && `color ${site.color}`, site.logo && 'logo', (site.fonts.heading || site.fonts.body) && `fonts ${[site.fonts.heading, site.fonts.body].filter(Boolean).join(', ')}`].filter(Boolean).join(', ') || 'nothing';
    } catch {}
    add(found !== null && found !== 'nothing', `Brand website read${found ? `: ${found}` : ''}`, `Check brand.from: ${config.brand.from}, or set brand.color and brand.logo yourself`);
  } else if (config.brand.from) add(existsSync(resolve(config.root, config.brand.from)), 'Brand presentation exists', `Check brand.from: ${config.brand.from}`);
  const provider = config.model.provider;
  if (isLocal(provider)) {
    const base = config.model.baseUrl ?? PRESETS[provider as 'ollama' | 'lmstudio'].baseUrl!;
    let models: string[] | null = null;
    try {
      const res = await fetchImpl(`${base.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(3000) });
      const data = (await res.json()) as { data?: { id?: string }[] };
      models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    } catch {}
    add(models !== null, `${provider === 'ollama' ? 'Ollama' : 'LM Studio'} answers at ${base}`, provider === 'ollama' ? 'Start it with: ollama serve' : 'Start the local server in LM Studio (Developer tab).');
    if (models) add(models.includes(config.model.name), `Model ${config.model.name} is available`, provider === 'ollama' ? `ollama pull ${config.model.name}` : 'Load the model in LM Studio.');
    if (provider === 'ollama') add(true, 'Tip: give Ollama a large context window, e.g. OLLAMA_CONTEXT_LENGTH=32768 ollama serve');
  } else if (provider === 'bedrock') {
    const auth = bedrockAuth(env);
    add(auth.kind !== 'none', auth.kind === 'token' ? 'Bedrock API key is set' : 'AWS credentials are set', 'export AWS_BEARER_TOKEN_BEDROCK=... (a Bedrock API key), or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
    add(!!(config.model.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION), 'AWS region is set', 'export AWS_REGION=us-east-1, or set model.region');
  } else {
    const keyEnv = keyEnvFor(provider)!;
    add(!!env[keyEnv], `${keyEnv} is set`, provider === 'anthropic' ? 'Create a key at https://console.anthropic.com and export ANTHROPIC_API_KEY=...' : `export ${keyEnv}=...`);
  }
  if (config.slack) add(!!env.SLACK_WEBHOOK_URL, 'SLACK_WEBHOOK_URL is set', 'Create an incoming webhook in Slack and export SLACK_WEBHOOK_URL=...');
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (config.github.pullRequests === 'on') add(!!token, 'GITHUB_TOKEN is set for pull requests', 'Export GITHUB_TOKEN, or set github.pullRequests: auto.');
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22, `Node ${process.versions.node}`, 'sprint-review needs Node 22 or newer.');
  return lines;
}
