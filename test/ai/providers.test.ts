import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, OpenAIClient, AnthropicClient, type ModelRequest } from '../../src/ai/model.ts';
import { BedrockClient, bedrockAuth, clientFor, PRESETS, signV4 } from '../../src/ai/providers.ts';
import { normalize, ConfigError } from '../../src/config.ts';
import { doctorChecks } from '../../src/surfaces/doctor.ts';
import { generate } from '../../src/review/generate.ts';
import { execFileSync } from 'node:child_process';
import { demoRepo, FakeModel } from '../helpers.ts';

const request: ModelRequest = { system: 'sys', messages: ['a', 'b'], tool: { name: 'presentation', description: 'Deliver it.', input_schema: { type: 'object', properties: { summary: { type: 'array' } } } }, maxTokens: 100 };

function recorder(reply: unknown, status = 200) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, impl };
}
const chat = (message: unknown) => ({ model: 'm', usage: { prompt_tokens: 3, completion_tokens: 2 }, choices: [{ message }] });

test('JSON is found in plain text, a fenced block or prose around it', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":2}\n```\nThanks'), { a: 2 });
  assert.deepEqual(extractJson('Sure! {"a":{"b":3}} Hope that helps.'), { a: { b: 3 } });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('[1,2]'), null);
  assert.equal(extractJson(null), null);
});

test('a model that answers in text instead of through the tool still works', async () => {
  const r = recorder(chat({ content: 'Here is the presentation:\n```json\n{"summary":[]}\n```' }));
  const answer = await new OpenAIClient('k', 'm', null, r.impl).ask(request);
  assert.deepEqual(answer.toolInput, { summary: [] });
});

test('the Anthropic client also falls back to JSON in a text block', async () => {
  const r = recorder({ model: 'm', usage: {}, content: [{ type: 'text', text: '{"summary":[1]}' }] });
  const answer = await new AnthropicClient('k', 'm', null, r.impl).ask(request);
  assert.deepEqual(answer.toolInput, { summary: [1] });
});

test('json mode sends the schema in the prompt and response_format, without tools', async () => {
  const r = recorder(chat({ content: '{"summary":[]}' }));
  await new OpenAIClient('', 'qwen3', null, r.impl, 'http://localhost:11434/v1', { ...PRESETS.ollama }).ask(request);
  const body = r.calls[0]!.body;
  assert.equal(r.calls[0]!.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(body.tools, undefined);
  assert.equal(body.response_format.type, 'json_schema');
  assert.match(body.messages[0].content, /must match this JSON schema/);
  assert.equal((r.calls[0]!.init.headers as Record<string, string>).authorization, undefined, 'no key for a local server');
});

test('each preset gets its address, key and way to force the tool', async () => {
  const cases = [
    ['openrouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1/chat/completions', { type: 'function', function: { name: 'presentation' } }],
    ['gemini', 'GEMINI_API_KEY', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'required'],
    ['mistral', 'MISTRAL_API_KEY', 'https://api.mistral.ai/v1/chat/completions', 'any'],
  ] as const;
  await Promise.all(
    cases.map(async ([provider, env, url, choice]) => {
      const r = recorder(chat({ tool_calls: [{ function: { name: 'presentation', arguments: '{}' } }] }));
      await clientFor({ provider, name: 'x', fallback: null }, { [env]: 'secret' }, r.impl).ask(request);
      assert.equal(r.calls[0]!.url, url, provider);
      assert.deepEqual(r.calls[0]!.body.tool_choice, choice, provider);
      assert.equal((r.calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer secret');
      assert.throws(() => clientFor({ provider, name: 'x', fallback: null }, {}), new RegExp(env));
    }),
  );
});

test('Gemini thinks at low effort, so its thinking leaves room for the answer', async () => {
  const r = recorder(chat({ tool_calls: [{ function: { name: 'presentation', arguments: '{}' } }] }));
  await clientFor({ provider: 'gemini', name: 'g', fallback: null }, { GEMINI_API_KEY: 'k' }, r.impl).ask(request);
  assert.equal(r.calls[0]!.body.reasoning_effort, 'low');
  const o = recorder(chat({ tool_calls: [{ function: { name: 'presentation', arguments: '{}' } }] }));
  await clientFor({ provider: 'openai', name: 'g', fallback: null }, { OPENAI_API_KEY: 'k' }, o.impl).ask(request);
  assert.equal(o.calls[0]!.body.reasoning_effort, undefined);
});

test('an answer cut off at maxTokens is a clear error, for every client', async () => {
  const openai = recorder({ model: 'm', usage: { prompt_tokens: 3, completion_tokens: 2 }, choices: [{ finish_reason: 'length', message: { content: '' } }] });
  await assert.rejects(clientFor({ provider: 'gemini', name: 'g', fallback: null }, { GEMINI_API_KEY: 'k' }, openai.impl).ask(request), /cut off.*maxTokens/);
  const anthropic = recorder({ model: 'm', stop_reason: 'max_tokens', content: [{ type: 'text', text: '' }], usage: {} });
  await assert.rejects(new AnthropicClient('k', 'm', null, anthropic.impl).ask(request), /cut off.*maxTokens/);
  const bedrock = recorder({ stopReason: 'max_tokens', output: { message: { content: [] } }, usage: {} });
  await assert.rejects(clientFor({ provider: 'bedrock', name: 'm', fallback: null }, { AWS_BEARER_TOKEN_BEDROCK: 't', AWS_REGION: 'us-east-1' }, bedrock.impl).ask(request), /cut off.*maxTokens/);
});

test('Azure uses the api-key header and needs a base URL', async () => {
  const r = recorder(chat({ tool_calls: [{ function: { name: 'presentation', arguments: '{}' } }] }));
  await clientFor({ provider: 'azure', name: 'my-deployment', fallback: null, baseUrl: 'https://acme.openai.azure.com/openai/v1' }, { AZURE_OPENAI_API_KEY: 'az' }, r.impl).ask(request);
  assert.equal(r.calls[0]!.url, 'https://acme.openai.azure.com/openai/v1/chat/completions');
  assert.equal((r.calls[0]!.init.headers as Record<string, string>)['api-key'], 'az');
  assert.throws(() => normalize({ model: { provider: 'azure', name: 'd' } }, '/tmp'), /baseUrl is required/);
});

test('local providers default to json mode, a small input and no key', () => {
  const c = normalize({ model: { provider: 'ollama', name: 'qwen3:32b' } }, '/tmp');
  assert.equal(c.model.mode, 'json');
  assert.equal(c.model.maxInputChars, 24000);
  assert.doesNotThrow(() => clientFor(c.model, {}));
  assert.throws(() => normalize({ model: { provider: 'ollama' } }, '/tmp'), /model.name is required/);
  assert.throws(() => normalize({ model: { provider: 'nope', name: 'x' } }, '/tmp'), ConfigError);
  assert.throws(() => normalize({ model: { provider: 'anthropic', mode: 'json' } }, '/tmp'), /not used for anthropic/);
});

test('a smaller input limit cuts what the model reads, and the check log names what it skipped', async () => {
  const dir = demoRepo();
  for (let i = 0; i < 40; i++) {
    execFileSync('git', ['-C', dir, '-c', 'user.name=Bench', '-c', 'user.email=bench@example.test', 'commit', '--allow-empty', '-q', '-m', `feat: extra change ${i}`, '-m', 'A long description. '.repeat(20)]);
  }
  const config = normalize({ product: { name: 'Spoke' }, github: { pullRequests: false }, model: { provider: 'ollama', name: 'qwen3', maxInputChars: 4000 } }, dir);
  const model = new FakeModel();
  await generate(config, { model, range: { kind: 'dates', from: '2026-01-01', until: '2099-01-01' } }).catch(() => {});
  const sent = model.requests[0]!.messages[0]!;
  assert.ok(sent.length < 4300, `sent ${sent.length} characters`);
});

test('AWS Signature Version 4 matches the official get-vanilla test vector', () => {
  const h = signV4({ method: 'GET', host: 'example.amazonaws.com', path: '/', body: '', region: 'us-east-1', service: 'service', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: new Date('2015-08-30T12:36:00Z') });
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(h['x-amz-date'], '20150830T123600Z');
});

test('Bedrock: Converse with a forced tool, signed with a key or an API token', async () => {
  const reply = { output: { message: { content: [{ toolUse: { name: 'presentation', input: { summary: [] } } }] } }, usage: { inputTokens: 7, outputTokens: 4 } };
  const r = recorder(reply);
  const signed = new BedrockClient('us.anthropic.claude-opus-5-5-v1:0', null, { kind: 'keys', accessKeyId: 'AKID', secretAccessKey: 'secret', sessionToken: 'session' }, 'eu-west-1', r.impl);
  const answer = await signed.ask(request);
  assert.deepEqual(answer.toolInput, { summary: [] });
  assert.deepEqual(answer.usage, { input: 7, output: 4 });
  const call = r.calls[0]!;
  assert.equal(call.url, 'https://bedrock-runtime.eu-west-1.amazonaws.com/model/us.anthropic.claude-opus-5-5-v1%3A0/converse');
  assert.deepEqual(call.body.toolConfig.toolChoice, { auto: {} });
  const headers = call.init.headers as Record<string, string>;
  assert.match(headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  assert.equal(headers['x-amz-security-token'], 'session');

  const t = recorder(reply);
  await clientFor({ provider: 'bedrock', name: 'm', fallback: null }, { AWS_BEARER_TOKEN_BEDROCK: 'tok', AWS_REGION: 'us-east-1' }, t.impl).ask(request);
  assert.equal((t.calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer tok');

  assert.equal(bedrockAuth({}).kind, 'none');
  assert.throws(() => clientFor({ provider: 'bedrock', name: 'm', fallback: null }, {}), /AWS credentials/);
  assert.throws(() => clientFor({ provider: 'bedrock', name: 'm', fallback: null }, { AWS_BEARER_TOKEN_BEDROCK: 'tok' }), /region/);
});

test('doctor checks the key per provider and whether a local server answers', async () => {
  const dir = demoRepo();
  const gem = await doctorChecks(normalize({ model: { provider: 'gemini', name: 'g' } }, dir), dir, {});
  assert.ok(gem.some((l) => !l.ok && l.text === 'GEMINI_API_KEY is set'));
  const up = (async () => new Response(JSON.stringify({ data: [{ id: 'qwen3:32b' }] }))) as unknown as typeof fetch;
  const ok = await doctorChecks(normalize({ model: { provider: 'ollama', name: 'qwen3:32b' } }, dir), dir, {}, up);
  assert.ok(ok.some((l) => l.ok && /Ollama answers/.test(l.text)));
  assert.ok(ok.some((l) => l.ok && /qwen3:32b is available/.test(l.text)));
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  const bad = await doctorChecks(normalize({ model: { provider: 'ollama', name: 'qwen3:32b' } }, dir), dir, {}, down);
  assert.ok(bad.some((l) => !l.ok && /ollama serve/.test(l.fix ?? '')));
});

test('a model that refuses tool calls is asked again in JSON mode, once', async () => {
  const bodies: any[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (body.tools) {
      return new Response(JSON.stringify({ error: { message: "Function tools with reasoning_effort are not supported for gpt-x in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.", type: 'invalid_request_error' } }), { status: 400 });
    }
    return new Response(JSON.stringify(chat({ content: '{"summary":[]}' })), { status: 200 });
  }) as unknown as typeof fetch;
  const client = clientFor({ provider: 'openai', name: 'gpt-x', fallback: null }, { OPENAI_API_KEY: 'k' }, impl);
  assert.deepEqual((await client.ask(request)).toolInput, { summary: [] });
  assert.ok(bodies[1].response_format, 'the second request is in JSON mode');
  assert.equal(bodies[1].max_completion_tokens, 100, 'hosted APIs get max_completion_tokens');
  assert.equal(bodies[1].max_tokens, undefined);
  await client.ask(request);
  assert.equal(bodies.length, 3, 'later calls go straight to JSON mode');
});

test('doctor asks Anthropic whether the key works and the model exists, without spending tokens', async () => {
  const dir = demoRepo();
  const config = normalize({ model: { provider: 'anthropic', name: 'claude-sonnet-5-5' } }, dir);
  const seen: { url: string; key: string | null }[] = [];
  const answer = (status: number) =>
    (async (url: string, init: RequestInit) => {
      seen.push({ url, key: new Headers(init.headers).get('x-api-key') });
      return new Response('{}', { status });
    }) as unknown as typeof fetch;
  const line = async (f: typeof fetch) => (await doctorChecks(config, dir, { ANTHROPIC_API_KEY: 'sk-test' }, f)).find((l) => /Anthropic/.test(l.text))!;
  assert.deepEqual(await line(answer(200)), { ok: true, text: 'Anthropic accepts the key and knows claude-sonnet-5-5' });
  assert.deepEqual(seen[0], { url: 'https://api.anthropic.com/v1/models/claude-sonnet-5-5', key: 'sk-test' });
  const rejected = await line(answer(401));
  assert.equal(rejected.ok, false);
  assert.match(rejected.fix ?? '', /restart the client/);
  assert.match((await line(answer(404))).text, /doesn't know the model claude-sonnet-5-5/);
  const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  assert.match((await line(offline)).fix ?? '', /VPN or proxy/);
  assert.equal((await doctorChecks(config, dir, {}, answer(200))).some((l) => /Anthropic accepts/.test(l.text)), false, 'no key, no request');
});
