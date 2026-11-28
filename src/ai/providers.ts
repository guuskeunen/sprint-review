import { createHash, createHmac } from 'node:crypto';
import { isLoopback } from '../config.ts';
import { AnthropicClient, cutOff, extractJson, unpackStrings, withToolInstruction, ModelError, OpenAIClient, sleep, type CompatibleOptions, type ModelAnswer, type ModelClient, type ModelRequest } from './model.ts';

export type ProviderName = 'anthropic' | 'openai' | 'openrouter' | 'gemini' | 'mistral' | 'azure' | 'ollama' | 'lmstudio' | 'bedrock';

export const PROVIDERS: ProviderName[] = ['anthropic', 'openai', 'openrouter', 'gemini', 'mistral', 'azure', 'ollama', 'lmstudio', 'bedrock'];

interface Preset extends CompatibleOptions {
  /** The environment variable with the key. */
  keyEnv?: string;
  /** Default base URL; null means the user must give one. */
  baseUrl?: string;
  local?: boolean;
}

/** Every OpenAI-compatible service is the same client with a different address, key and way to force the tool. */
export const PRESETS: Record<Exclude<ProviderName, 'anthropic' | 'bedrock'>, Preset> = {
  openai: { label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1' },
  openrouter: { label: 'OpenRouter', keyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' },
  gemini: { label: 'Gemini', keyEnv: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', toolChoice: 'required', reasoningEffort: 'low' },
  mistral: { label: 'Mistral', keyEnv: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', toolChoice: 'any' },
  azure: { label: 'Azure OpenAI', keyEnv: 'AZURE_OPENAI_API_KEY', keyHeader: 'api-key' },
  ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', mode: 'json', keyRequired: false, local: true, timeoutMs: 900_000 },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', mode: 'json', keyRequired: false, local: true, timeoutMs: 900_000 },
};

export interface ClientConfig {
  provider: ProviderName;
  name: string;
  fallback: string | null;
  baseUrl?: string | null;
  mode?: 'tools' | 'json';
  region?: string | null;
}

/** The environment variable that holds the key for a provider, for doctor and error messages. */
export function keyEnvFor(provider: ProviderName): string | null {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (provider === 'bedrock') return 'AWS_BEARER_TOKEN_BEDROCK';
  return PRESETS[provider].keyEnv ?? null;
}

export function isLocal(provider: ProviderName): boolean {
  return provider !== 'anthropic' && provider !== 'bedrock' && PRESETS[provider].local === true;
}

/** The client for the configured provider, with its key from the environment. */
export function clientFor(config: ClientConfig, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): ModelClient {
  if (config.provider === 'anthropic') return new AnthropicClient(env.ANTHROPIC_API_KEY ?? '', config.name, config.fallback, fetchImpl);
  if (config.provider === 'bedrock') return new BedrockClient(config.name, config.fallback, bedrockAuth(env), config.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? '', fetchImpl);
  const preset = PRESETS[config.provider];
  const baseUrl = config.baseUrl ?? (config.provider === 'openai' ? env.OPENAI_BASE_URL : undefined) ?? preset.baseUrl;
  if (!baseUrl) throw new ModelError(`model.baseUrl is required for ${preset.label}: your endpoint, such as https://my-resource.openai.azure.com/openai/v1.`);
  // A local server borrows OPENAI_API_KEY (some need one) only when it really is on this machine.
  const key = (preset.keyEnv ? env[preset.keyEnv] : undefined) ?? (preset.local && isLoopback(baseUrl) ? env.OPENAI_API_KEY : undefined) ?? '';
  return new OpenAIClient(key, config.name, config.fallback, fetchImpl, baseUrl, { ...preset, ...(config.mode ? { mode: config.mode } : {}) });
}

// ---------------------------------------------------------------- Bedrock

export type BedrockAuth =
  | { kind: 'token'; token: string }
  | { kind: 'keys'; accessKeyId: string; secretAccessKey: string; sessionToken: string | null }
  | { kind: 'none' };

/** A Bedrock API key wins; otherwise the usual AWS access keys (which is what CI roles hand out). */
export function bedrockAuth(env: NodeJS.ProcessEnv): BedrockAuth {
  if (env.AWS_BEARER_TOKEN_BEDROCK) return { kind: 'token', token: env.AWS_BEARER_TOKEN_BEDROCK };
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return { kind: 'keys', accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN ?? null };
  return { kind: 'none' };
}

const RETRIES = 3;

/**
 * Amazon Bedrock's Converse API: Claude (and other models) through an AWS account. The prompt
 * asks for the tool, like with Anthropic directly: current Claude models refuse a forced one. Signs with a Bedrock API key, or with
 * AWS Signature Version 4 from access keys.
 */
export class BedrockClient implements ModelClient {
  private readonly model: string;
  private readonly fallback: string | null;
  private readonly auth: BedrockAuth;
  private readonly region: string;
  private readonly fetchImpl: typeof fetch;

  constructor(model: string, fallback: string | null, auth: BedrockAuth, region: string, fetchImpl: typeof fetch = fetch) {
    this.model = model;
    this.fallback = fallback;
    this.auth = auth;
    this.region = region;
    this.fetchImpl = fetchImpl;
    if (auth.kind === 'none') throw new ModelError('No AWS credentials: set AWS_BEARER_TOKEN_BEDROCK (a Bedrock API key), or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new ModelError('Set the AWS region: AWS_REGION, or model.region in the config (such as us-east-1).');
  }

  async ask(request: ModelRequest): Promise<ModelAnswer> {
    try {
      return await this.call(this.model, request);
    } catch (e) {
      if (!this.fallback || this.fallback === this.model || (e instanceof ModelError && /Bedrock API (401|403)/.test(e.message))) throw e;
      return this.call(this.fallback, request);
    }
  }

  private async call(model: string, request: ModelRequest): Promise<ModelAnswer> {
    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    const path = `/model/${encodeURIComponent(model)}/converse`;
    const body = JSON.stringify({
      system: [{ text: withToolInstruction(request) }],
      messages: [{ role: 'user', content: [...(request.images ?? []).map((i) => ({ image: { format: i.mediaType === 'image/png' ? 'png' : 'jpeg', source: { bytes: i.data } } })), ...request.messages.map((text) => ({ text }))] }],
      inferenceConfig: { maxTokens: request.maxTokens },
      toolConfig: {
        tools: [{ toolSpec: { name: request.tool.name, description: request.tool.description, inputSchema: { json: request.tool.input_schema } } }],
        toolChoice: { auto: {} },
      },
    });
    let last: unknown;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      if (this.auth.kind === 'token') headers.authorization = `Bearer ${this.auth.token}`;
      else if (this.auth.kind === 'keys') Object.assign(headers, signV4({ method: 'POST', host, path, body, region: this.region, service: 'bedrock', ...this.auth }));
      try {
        const res = await this.fetchImpl(`https://${host}${path}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(180_000) });
        const text = await res.text();
        if (!res.ok) {
          const err = new ModelError(`Bedrock API ${res.status}: ${text.slice(0, 300)}`);
          if (res.status === 429 || res.status >= 500) {
            last = err;
            await sleep(2 ** attempt * 2000);
            continue;
          }
          throw err;
        }
        const data = JSON.parse(text) as {
          output?: { message?: { content?: { text?: string; toolUse?: { name?: string; input?: unknown } }[] } };
          stopReason?: string;
          usage?: { inputTokens?: number; outputTokens?: number };
        };
        const content = data.output?.message?.content ?? [];
        const use = content.find((c) => c.toolUse?.name === request.tool.name)?.toolUse;
        const input = use && typeof use.input === 'object' && use.input !== null ? (use.input as Record<string, unknown>) : extractJson(content.map((c) => c.text ?? '').join('\n'));
        if (data.stopReason === 'max_tokens') throw cutOff(request.maxTokens);
        return { toolInput: unpackStrings(input), model, usage: { input: data.usage?.inputTokens ?? 0, output: data.usage?.outputTokens ?? 0 } };
      } catch (e) {
        if (e instanceof ModelError && !/Bedrock API (429|5\d\d)/.test(e.message)) throw e;
        last = e;
        if (attempt < RETRIES - 1) await sleep(2 ** attempt * 2000);
      }
    }
    throw last instanceof Error ? last : new ModelError(String(last));
  }
}

export interface SignInput {
  method: string;
  host: string;
  /** The path as sent, already URI-encoded once. */
  path: string;
  query?: string;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
  /** For tests: the moment to sign for. */
  now?: Date;
  /** Extra headers to sign, lowercase names. */
  headers?: Record<string, string>;
}

const hex = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding, as Signature Version 4 wants it. */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * AWS Signature Version 4: the headers to add to a request. Path segments are encoded again for
 * the canonical request, as every service but S3 expects (Bedrock model ids contain ":").
 */
export function signV4(input: SignInput): Record<string, string> {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: input.host, 'x-amz-date': amzDate, ...(input.headers ?? {}) };
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken;
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => `${h}:${String(headers[h]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalUri = input.path.split('/').map((seg) => rfc3986(seg)).join('/') || '/';
  const canonicalQuery = (input.query ?? '')
    .split('&')
    .filter(Boolean)
    .map((p) => p.split('='))
    .sort(([a = ''], [b = '']) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k = '', v = '']) => `${k}=${v}`)
    .join('&');
  const canonical = [input.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, hex(input.body)].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const out: Record<string, string> = {
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (input.sessionToken) out['x-amz-security-token'] = input.sessionToken;
  return out;
}
