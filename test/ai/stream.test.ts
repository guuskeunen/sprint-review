import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicClient } from '../../src/ai/model.ts';
import { readMessage } from '../../src/ai/stream.ts';

const tool = { name: 'presentation', description: 'x', input_schema: { type: 'object' } };
const request = { system: 's', messages: ['m'], tool, maxTokens: 100 };

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

const streamed = (model: string, stopReason = 'tool_use') =>
  sse([
    { type: 'message_start', message: { model, content: [], usage: { input_tokens: 12, output_tokens: 1 } } },
    { type: 'ping' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'it is.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'presentation', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"themes":[{"ti' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'tle":"T"}]}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 40 } },
    { type: 'message_stop' },
  ]);

const eventStream = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/event-stream', 'retry-after': '0.01' } });

test('a streamed answer is put back together: text, tool input, stop reason and usage', () => {
  const message = readMessage(streamed('m1'));
  assert.equal(message.model, 'm1');
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.usage, { input_tokens: 12, output_tokens: 40 });
  assert.deepEqual(message.content, [
    { type: 'text', text: 'Here it is.' },
    { type: 'tool_use', name: 'presentation', input: { themes: [{ title: 'T' }] } },
  ]);
});

test('a plain JSON answer is still read as it is', () => {
  assert.deepEqual(readMessage('{"model":"m1","content":[]}'), { model: 'm1', content: [] });
});

test('Claude is asked to stream, so a slow answer keeps the connection busy', async () => {
  const sent: { stream?: boolean }[] = [];
  const impl = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return eventStream(streamed('m1'));
  }) as unknown as typeof fetch;
  const answer = await new AnthropicClient('key', 'm1', null, impl).ask(request);
  assert.equal(sent[0]!.stream, true);
  assert.deepEqual(answer.toolInput, { themes: [{ title: 'T' }] });
  assert.deepEqual(answer.usage, { input: 12, output: 40 });
});

test('an overloaded error in the middle of the stream is retried, then the fallback answers', async () => {
  const overloaded = sse([
    { type: 'message_start', message: { model: 'm1', content: [], usage: { input_tokens: 1 } } },
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  ]);
  const models: string[] = [];
  const impl = (async (_url: string, init: { body: string }) => {
    const model = (JSON.parse(init.body) as { model: string }).model;
    models.push(model);
    return eventStream(model === 'm2' ? streamed('m2') : overloaded);
  }) as unknown as typeof fetch;
  const answer = await new AnthropicClient('key', 'm1', 'm2', impl).ask(request);
  assert.equal(answer.model, 'm2');
  assert.deepEqual(models, ['m1', 'm1', 'm1', 'm2']);
});

test('a streamed answer cut off at maxTokens is an error', async () => {
  const impl = (async () => eventStream(streamed('m1', 'max_tokens'))) as unknown as typeof fetch;
  await assert.rejects(new AnthropicClient('key', 'm1', null, impl).ask(request), /cut off/);
});
