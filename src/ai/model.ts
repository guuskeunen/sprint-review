import { readBody, readMessage, StreamError, type AnthropicMessage } from './stream.ts';

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: string[];
  tool: ToolSpec;
  maxTokens: number;
}

export interface ModelAnswer {
  toolInput: Record<string, unknown> | null;
  model: string;
  usage: { input: number; output: number };
}

/** What the writer needs from a model. Swap it for a fake in tests, or for another provider. */
export interface ModelClient {
  ask(request: ModelRequest): Promise<ModelAnswer>;
}

export class ModelError extends Error {}

/**
 * The system prompt with the one tool named, for models that can't be forced to use it. An
 * answer in plain text still works: the JSON is taken from it.
 */
export function withToolInstruction(request: ModelRequest): string {
  return `${request.system}\n\nAnswer by calling the ${request.tool.name} tool once, with the complete answer. Write nothing else.`;
}

/**
 * The answer stopped at the token limit before it held the slides. Thinking models count their
 * thinking against the same limit, so a long sprint can use it up before a word is written.
 */
export function cutOff(maxTokens: number): ModelError {
  return new ModelError(`The model's answer was cut off at ${maxTokens} tokens, before it was complete. Raise model.maxTokens in the config (thinking models count their thinking too), or review a shorter range.`);
}

/**
 * The answer as JSON when a model wrote it as text instead of through the tool: the whole text,
 * a fenced block, or the outermost object in it. Whatever comes out still goes through every check.
 */
/**
 * A tool answer with any top-level list or object that came as JSON text unpacked: models that
 * aren't forced to use the tool sometimes send "themes": "[...]". Plain text stays text.
 */
export function unpackStrings(input: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!input) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
      try {
        const parsed = JSON.parse(v) as unknown;
        out[k] = parsed !== null && typeof parsed === 'object' ? parsed : v;
        continue;
      } catch {}
    }
    out[k] = v;
  }
  return out;
}

export function extractJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const tries = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) tries.push(fenced[1].trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) tries.push(text.slice(start, end + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {}
  }
  return null;
}

const API = 'https://api.anthropic.com/v1/messages';
/** Time limit of a call that does not stream (the OpenAI-compatible endpoints). */
const TIMEOUT_MS = 180_000;
/** The Anthropic answer streams, so a long one is fine as long as bytes keep coming. */
const IDLE_MS = 90_000;
const TOTAL_MS = 900_000;
const RETRIES = 3;

/** The Anthropic Messages API, asked to answer through one tool, with retries and a fallback model. */
export class AnthropicClient implements ModelClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fallback: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, model: string, fallback: string | null, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.model = model;
    this.fallback = fallback;
    this.fetchImpl = fetchImpl;
    if (!apiKey) throw new ModelError('ANTHROPIC_API_KEY is not set. Create a key at https://console.anthropic.com and set it as an environment variable (in GitHub: a repository secret).');
  }

  async ask(request: ModelRequest): Promise<ModelAnswer> {
    try {
      return await this.call(this.model, request);
    } catch (e) {
      if (!this.fallback || this.fallback === this.model || (e instanceof ModelError && /401|403|invalid x-api-key/i.test(e.message))) throw e;
      return this.call(this.fallback, request);
    }
  }

  private async call(model: string, request: ModelRequest): Promise<ModelAnswer> {
    const body = JSON.stringify({
      model,
      max_tokens: request.maxTokens,
      system: withToolInstruction(request),
      messages: [{ role: 'user', content: request.messages.map((text) => ({ type: 'text', text })) }],
      // Strict: the arguments always match the schema. Without it, a large answer sometimes came
      // back with a list as broken JSON text.
      tools: [{ ...request.tool, strict: true }],
      // Claude Opus 5.5, Sonnet 5.5 and later refuse a forced tool (400), so the prompt asks for it.
      tool_choice: { type: 'auto' },
      // Streamed, so the connection is never quiet while the answer is written: a VPN or proxy
      // that drops an idle connection after a minute otherwise ends the call with "fetch failed".
      stream: true,
    });
    let last: unknown;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const abort = new AbortController();
      const total = setTimeout(() => abort.abort(new Error(`Anthropic API: no answer within ${TOTAL_MS / 60_000} minutes`)), TOTAL_MS);
      let idle = setTimeout(() => {}, 0);
      const alive = () => {
        clearTimeout(idle);
        idle = setTimeout(() => abort.abort(new Error(`Anthropic API: the connection was silent for ${IDLE_MS / 1000} seconds`)), IDLE_MS);
      };
      try {
        alive();
        const res = await this.fetchImpl(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
          body,
          signal: abort.signal,
        });
        const text = await readBody(res, alive);
        let failure: ModelError | null = null;
        let status = res.status;
        let data: AnthropicMessage = {};
        if (!res.ok) failure = new ModelError(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
        else {
          try {
            data = readMessage(text);
          } catch (e) {
            if (!(e instanceof StreamError)) throw e;
            status = e.status;
            failure = new ModelError(`Anthropic API ${e.status}: ${e.message.slice(0, 300)}`);
          }
        }
        if (failure) {
          if (status === 429 || status >= 500) {
            last = failure;
            await sleep(retryAfter(res) ?? 2 ** attempt * 2000);
            continue;
          }
          throw failure;
        }
        const block = data.content?.find((b) => b.type === 'tool_use' && b.name === request.tool.name);
        const answerText = data.content?.filter((b) => b.type === 'text').map((b) => (b as { text?: string }).text ?? '').join('\n') ?? '';
        const toolInput = block && typeof block.input === 'object' && block.input !== null ? (block.input as Record<string, unknown>) : extractJson(answerText);
        // A half-written tool call is no answer: report it, so the fallback model can take over.
        if (data.stop_reason === 'max_tokens') throw cutOff(request.maxTokens);
        return {
          toolInput: unpackStrings(toolInput),
          model: data.model ?? model,
          usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
        };
      } catch (e) {
        if (e instanceof ModelError && !/Anthropic API (429|5\d\d)/.test(e.message)) throw e;
        last = e;
        if (attempt < RETRIES - 1) await sleep(2 ** attempt * 2000);
      } finally {
        clearTimeout(total);
        clearTimeout(idle);
      }
    }
    throw last instanceof Error ? last : new ModelError(String(last));
  }
}


/** How an OpenAI-compatible endpoint is called. Presets for known services are in providers.ts. */
export interface CompatibleOptions {
  /** Base URL up to /v1 (or the service's equivalent). */
  baseUrl?: string;
  /** tools: forced function call. json: ask for JSON matching the schema, for servers that don't force tools well. */
  mode?: 'tools' | 'json';
  /** How the one tool is forced: the OpenAI object form, or "required"/"any" for services that only take a word. */
  toolChoice?: 'function' | 'required' | 'any';
  /** Header for the key: Authorization: Bearer (default) or Azure's api-key. */
  keyHeader?: 'bearer' | 'api-key';
  /** A key is not needed for local servers. */
  keyRequired?: boolean;
  /** How hard a thinking model thinks (reasoning_effort), for services whose thinking eats the answer's tokens. */
  reasoningEffort?: 'low' | 'medium' | 'high' | null;
  /** Name in error messages. */
  label?: string;
  /** The environment variable for the key, for the error message. */
  keyEnv?: string;
  timeoutMs?: number;
}

const OPENAI_API = 'https://api.openai.com/v1';

/**
 * OpenAI's Chat Completions API and everything that speaks it: OpenRouter, Gemini, Mistral, Azure,
 * Ollama, LM Studio. Forced to answer through one function, with the same retries and fallback
 * as the Anthropic client. A model that answers in text instead still works: the JSON is taken
 * from the text, and checked like any other answer.
 */
export class OpenAIClient implements ModelClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fallback: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;
  private readonly options: Required<Omit<CompatibleOptions, 'baseUrl'>>;

  constructor(apiKey: string, model: string, fallback: string | null, fetchImpl: typeof fetch = fetch, baseUrl = process.env.OPENAI_BASE_URL, options: Omit<CompatibleOptions, 'baseUrl'> = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.fallback = fallback;
    this.fetchImpl = fetchImpl;
    this.url = `${(baseUrl || OPENAI_API).replace(/\/+$/, '')}/chat/completions`;
    this.options = {
      mode: options.mode ?? 'tools',
      toolChoice: options.toolChoice ?? 'function',
      keyHeader: options.keyHeader ?? 'bearer',
      keyRequired: options.keyRequired ?? true,
      label: options.label ?? 'OpenAI',
      keyEnv: options.keyEnv ?? 'OPENAI_API_KEY',
      timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
      reasoningEffort: options.reasoningEffort ?? null,
    };
    if (!apiKey && this.options.keyRequired) throw new ModelError(`${this.options.keyEnv} is not set. Set it as an environment variable with your ${this.options.label} API key.`);
  }

  async ask(request: ModelRequest): Promise<ModelAnswer> {
    try {
      return await this.callWithJsonFallback(this.model, request);
    } catch (e) {
      if (!this.fallback || this.fallback === this.model || (e instanceof ModelError && / API (401|403)/.test(e.message))) throw e;
      return this.callWithJsonFallback(this.fallback, request);
    }
  }

  /**
   * Some models refuse tool calls on this endpoint (a reasoning model on Chat Completions, a
   * server without tools). Then the client switches to JSON mode, once and for the rest of the run.
   */
  private async callWithJsonFallback(model: string, request: ModelRequest): Promise<ModelAnswer> {
    try {
      return await this.call(model, request);
    } catch (e) {
      if (this.options.mode !== 'tools' || !(e instanceof ModelError) || !refusesTools(e.message)) throw e;
      this.options.mode = 'json';
      return this.call(model, request);
    }
  }

  private body(model: string, request: ModelRequest): string {
    const { mode, toolChoice, reasoningEffort } = this.options;
    const effort = reasoningEffort ? { reasoning_effort: reasoningEffort } : {};
    if (mode === 'json') {
      // No tools: the schema goes in the prompt and, for servers that support it, in response_format.
      return JSON.stringify({
        model,
        // Hosted APIs (OpenAI's newer models) take only max_completion_tokens; local servers take max_tokens.
        ...(this.options.keyRequired ? { max_completion_tokens: request.maxTokens } : { max_tokens: request.maxTokens }),
        messages: [
          { role: 'system', content: `${request.system}\n\n${request.tool.description}\nAnswer with one JSON object and nothing else. It must match this JSON schema:\n${JSON.stringify(request.tool.input_schema)}` },
          { role: 'user', content: request.messages.join('\n\n') },
        ],
        response_format: { type: 'json_schema', json_schema: { name: request.tool.name, schema: request.tool.input_schema, strict: false } },
        ...effort,
      });
    }
    return JSON.stringify({
      model,
      max_completion_tokens: request.maxTokens,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.messages.join('\n\n') },
      ],
      tools: [{ type: 'function', function: { name: request.tool.name, description: request.tool.description, parameters: request.tool.input_schema } }],
      tool_choice: toolChoice === 'function' ? { type: 'function', function: { name: request.tool.name } } : toolChoice,
      ...effort,
    });
  }

  private async call(model: string, request: ModelRequest): Promise<ModelAnswer> {
    const body = this.body(model, request);
    const label = this.options.label;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) {
      if (this.options.keyHeader === 'api-key') headers['api-key'] = this.apiKey;
      else headers.authorization = `Bearer ${this.apiKey}`;
    }
    let last: unknown;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        const res = await this.fetchImpl(this.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.options.timeoutMs) });
        const text = await res.text();
        if (!res.ok) {
          const err = new ModelError(`${label} API ${res.status}: ${text.slice(0, 300)}`);
          if (res.status === 429 || res.status >= 500) {
            last = err;
            await sleep(retryAfter(res) ?? 2 ** attempt * 2000);
            continue;
          }
          throw err;
        }
        const data = JSON.parse(text) as {
          choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
          model?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const message = data.choices?.[0]?.message;
        const call = message?.tool_calls?.find((t) => t.function?.name === request.tool.name) ?? message?.tool_calls?.[0];
        const input = extractJson(call?.function?.arguments) ?? extractJson(message?.content);
        if (data.choices?.[0]?.finish_reason === 'length') throw cutOff(request.maxTokens);
        // Gemini leaves its thinking out of completion_tokens but bills it as output: total minus prompt has it.
        const prompt = data.usage?.prompt_tokens ?? 0;
        const output = Math.max(data.usage?.completion_tokens ?? 0, (data.usage?.total_tokens ?? 0) - prompt);
        return { toolInput: unpackStrings(input), model: data.model ?? model, usage: { input: prompt, output } };
      } catch (e) {
        if (e instanceof ModelError && !new RegExp(`${label} API (429|5\\d\\d)`).test(e.message)) throw e;
        if (e instanceof Error && e.name === 'TypeError' && /fetch failed/.test(e.message)) {
          last = new ModelError(`Could not reach ${label} at ${this.url}. ${this.options.keyRequired ? 'Check your network.' : 'Is the server running?'}`);
        } else last = e;
        if (attempt < RETRIES - 1) await sleep(2 ** attempt * 2000);
      }
    }
    throw last instanceof Error ? last : new ModelError(String(last));
  }
}

/** A 400 that says the endpoint or model takes no tool calls (or not with its settings). */
function refusesTools(message: string): boolean {
  return / API 400/.test(message) && /\btools?\b|function|tool_choice/i.test(message) && /not supported|unsupported|does not support/i.test(message);
}

function retryAfter(res: Response): number | null {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 60) * 1000 : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
