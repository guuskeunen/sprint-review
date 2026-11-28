/**
 * Reads a streamed Anthropic Messages answer back into the message a non-streamed call returns.
 *
 * A review answer takes minutes to write. Without streaming nothing flows back until it is done,
 * and a VPN or proxy that drops a quiet connection after a minute ends the call with
 * "fetch failed". A stream sends text and ping events the whole time, so the connection stays busy.
 */

export interface AnthropicMessage {
  model?: string;
  stop_reason?: string | null;
  content?: Record<string, unknown>[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface StreamEvent {
  type: string;
  index: number;
  message?: AnthropicMessage;
  content_block?: Record<string, unknown>;
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; stop_reason?: string | null };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

/** An error event inside the stream, with the HTTP status the same error gets without streaming. */
export class StreamError extends Error {
  readonly status: number;
  constructor(type: string, message: string) {
    super(`${type}: ${message}`);
    this.status = type === 'overloaded_error' ? 529 : type === 'rate_limit_error' ? 429 : type === 'api_error' ? 500 : 400;
  }
}

/** Reads an event stream, or a plain JSON body as it is. Throws StreamError for an error event. */
export function readMessage(body: string): AnthropicMessage {
  if (!/^\s*(event|data):/.test(body)) return JSON.parse(body) as AnthropicMessage;
  const message: AnthropicMessage = { content: [] };
  const content = message.content!;
  const json: string[] = [];
  for (const chunk of body.split(/\r?\n\r?\n/)) {
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    const event = JSON.parse(data) as StreamEvent;
    switch (event.type) {
      case 'message_start':
        Object.assign(message, event.message, { content });
        break;
      case 'content_block_start':
        content[event.index] = { ...event.content_block };
        json[event.index] = '';
        break;
      case 'content_block_delta': {
        const block = content[event.index] ?? (content[event.index] = {});
        const delta = event.delta ?? {};
        if (delta.type === 'text_delta') block.text = String(block.text ?? '') + delta.text;
        else if (delta.type === 'input_json_delta') json[event.index] = (json[event.index] ?? '') + delta.partial_json;
        else if (delta.type === 'thinking_delta') block.thinking = String(block.thinking ?? '') + delta.thinking;
        else if (delta.type === 'signature_delta') block.signature = delta.signature;
        break;
      }
      case 'content_block_stop': {
        const block = content[event.index];
        const partial = json[event.index];
        if (block && partial) {
          // A tool call cut off by max_tokens is broken JSON; the stop reason reports that.
          try {
            block.input = JSON.parse(partial);
          } catch {
            block.input = {};
          }
        }
        break;
      }
      case 'message_delta':
        if (event.delta?.stop_reason !== undefined) message.stop_reason = event.delta.stop_reason;
        message.usage = { ...message.usage, ...event.usage };
        break;
      case 'error':
        throw new StreamError(String(event.error?.type ?? 'error'), String(event.error?.message ?? ''));
    }
  }
  return message;
}

/** Reads a response body, calling `alive` on every chunk, so an idle timer can be reset. */
export async function readBody(res: Response, alive: () => void): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    alive();
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
