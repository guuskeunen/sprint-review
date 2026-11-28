import { loadPlaywright } from '../screens/capture.ts';
import { missedWork, onBranch, sprintRange } from '../review/generate.ts';
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
    const history = new History(config.repo);
    const range = onBranch(sprintRange(config.sprint.days), config, history);
    history.assertUsable(range);
    const at = range.kind === 'dates' && range.at ? `, sprint read on ${range.at}` : '';
    add(true, `Git history readable in ${relative(cwd, config.repo) || '.'}${at}`);
    const missed = missedWork(range, config, history);
    if (missed) add(false, missed.replace(/ Pass --to.*$/, ''), 'Set sprint.branch in the config, or pass --to with that branch.');
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
  // Not an error, but an unbranded deck is easy to miss until it's on the screen.
  if (!config.brand.from && !config.brand.color && !config.brand.logo) add(true, 'No brand set: the deck has the default look. Set brand.from to your website for your logo, color and fonts.');
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
    // Set is not working: ask the API about the model, which is free, so a wrong or old key shows here and not mid-run.
    if (env[keyEnv]) {
      if (provider === 'anthropic') lines.push(await anthropicKey(env[keyEnv]!, config.model.name, fetchImpl));
      else if (provider === 'openai' || provider === 'openrouter' || provider === 'gemini' || provider === 'mistral') {
        lines.push(await compatibleKey(provider, config.model.baseUrl ?? PRESETS[provider].baseUrl!, env[keyEnv]!, config.model.name, fetchImpl));
      }
    }
  }
  if (config.slack) add(!!env.SLACK_WEBHOOK_URL, 'SLACK_WEBHOOK_URL is set', 'Create an incoming webhook in Slack and export SLACK_WEBHOOK_URL=...');
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (config.github.pullRequests === 'on') add(!!token, 'GITHUB_TOKEN is set for pull requests', 'Export GITHUB_TOKEN, or set github.pullRequests: auto.');
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22, `Node ${process.versions.node}`, 'sprint-review needs Node 22 or newer.');
  return lines;
}

/** Whether Anthropic takes the key and knows the model: one free request, no tokens. */
async function anthropicKey(key: string, model: string, fetchImpl: typeof fetch): Promise<DoctorLine> {
  try {
    const res = await fetchImpl(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(8000) });
    if (res.ok) return { ok: true, text: `Anthropic accepts the key and knows ${model}` };
    if (res.status === 401 || res.status === 403) return { ok: false, text: 'Anthropic rejects ANTHROPIC_API_KEY', fix: 'The key is wrong, revoked or from another workspace: create one at https://console.anthropic.com. An MCP server reads the key from the environment it was started in; restart the client after changing it.' };
    if (res.status === 404) return { ok: false, text: `Anthropic doesn't know the model ${model}`, fix: 'Check model.name in the config.' };
    return { ok: false, text: `Anthropic answered ${res.status} when checking the key`, fix: 'Try again in a minute; https://status.anthropic.com shows outages.' };
  } catch {
    return { ok: false, text: 'Anthropic could not be reached to check the key', fix: 'Check the network. A VPN or proxy that blocks api.anthropic.com also stops a review.' };
  }
}

/**
 * Whether an OpenAI-compatible provider takes the key and lists the model: the model list costs
 * nothing. OpenRouter lists its models to anyone, so its key is checked at /key. Azure (an address
 * per deployment) and Bedrock (signed requests) are left at "is set".
 */
async function compatibleKey(provider: 'openai' | 'openrouter' | 'gemini' | 'mistral', base: string, key: string, model: string, fetchImpl: typeof fetch): Promise<DoctorLine> {
  const label = PRESETS[provider].label ?? provider;
  const url = base.replace(/\/+$/, '');
  const get = (path: string) => fetchImpl(`${url}${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
  try {
    if (provider === 'openrouter') {
      const res = await get('/key');
      if (res.status === 401 || res.status === 403) return rejected(label, PRESETS[provider].keyEnv!);
      if (!res.ok) return { ok: false, text: `${label} answered ${res.status} when checking the key`, fix: 'Try again in a minute.' };
    }
    const res = await get('/models');
    if (res.status === 401 || res.status === 403) return rejected(label, PRESETS[provider].keyEnv!);
    if (!res.ok) return { ok: false, text: `${label} answered ${res.status} when checking the key`, fix: 'Try again in a minute.' };
    const data = (await res.json()) as { data?: { id?: string }[] };
    const ids = (data.data ?? []).map((m) => (m.id ?? '').replace(/^models\//, ''));
    if (ids.length && !ids.includes(model.replace(/^models\//, ''))) return { ok: false, text: `${label} doesn't list the model ${model}`, fix: 'Check model.name in the config.' };
    return { ok: true, text: `${label} accepts the key and knows ${model}` };
  } catch {
    return { ok: false, text: `${label} could not be reached to check the key`, fix: `Check the network. A VPN or proxy that blocks ${new URL(url).host} also stops a review.` };
  }
}

function rejected(label: string, keyEnv: string): DoctorLine {
  return { ok: false, text: `${label} rejects ${keyEnv}`, fix: 'The key is wrong, revoked or from another account. An MCP server reads the key from the environment it was started in (or the key you gave the Claude Code plugin); restart the client after changing it.' };
}
