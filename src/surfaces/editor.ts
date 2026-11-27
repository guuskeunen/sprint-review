import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.ts';
import { HOOD_KINDS, THEME_LAYOUTS, type Review, type ThemeLayout } from '../types.ts';
import { render } from '../review/generate.ts';
import { validReview } from '../review/review.ts';

export { validReview };
import { pptxOf, writeOutputs } from '../review/output.ts';
import { ICONS } from '../deck/icons-data.ts';
import { VALUE_KEYS } from '../deck/icons.ts';
import { labelsFor } from '../deck/i18n.ts';
import { EFFECT_WORDS_MAX, NOTES_WORDS_MAX, POINT_WORDS_MAX, TITLE_WORDS_MAX } from '../ai/writer.ts';

const PAGE = readFileSync(fileURLToPath(new URL('../../assets/editor.html', import.meta.url)), 'utf8');
const LIVE = readFileSync(fileURLToPath(new URL('../../assets/live.html', import.meta.url)), 'utf8');
const MAX_BODY = 60 * 1024 * 1024;

export interface EditorServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

/**
 * A small editor for review.json on this computer: a form beside the live deck. It listens on
 * 127.0.0.1 only and every API call must carry a random token that only the opened page knows,
 * so other websites in the same browser can't read or change the review.
 *
 * The live view (/live) is the deck on its own, for a second screen or a shared window: every
 * edit and the slide being edited reach it as they happen, before anything is saved.
 */
/** The layouts as the editor offers them. */
const LAYOUT_NAMES: Record<ThemeLayout, string> = { auto: 'Automatic', split: 'Text beside the picture', full: 'Large picture', icon: 'Icon, no picture', card: 'A card on the shared slide' };

export async function startEditor(file: string, config: Config, port = 4321): Promise<EditorServer> {
  const token = randomBytes(18).toString('base64url');
  const read = () => JSON.parse(readFileSync(file, 'utf8')) as Review;
  read(); // fail now, not in the browser, when the file is not JSON
  const t = labelsFor(config.language, config.labels);
  const boot = {
    token,
    file,
    icons: Object.entries(ICONS).map(([k, v]) => [k, v.label]),
    values: VALUE_KEYS.map((k) => [k, t[`value_${k}` as keyof typeof t]]),
    limits: { point: POINT_WORDS_MAX, effect: EFFECT_WORDS_MAX, notes: NOTES_WORDS_MAX, title: TITLE_WORDS_MAX },
    kinds: HOOD_KINDS.map((k) => [k, t[`kind_${k}` as keyof typeof t]]),
    layouts: THEME_LAYOUTS.map((k) => [k, LAYOUT_NAMES[k]]),
  };
  const page = PAGE.replace('__BOOT__', JSON.stringify(boot).replace(/</g, '\\u003c'));
  const livePage = LIVE.replace('__TOKEN__', JSON.stringify(token).replace(/</g, '\\u003c'));

  // What the live view shows: the deck as last previewed (the saved one until the first edit) and the slide.
  const live = { html: null as string | null, slide: 1 };
  const watchers = new Set<ServerResponse>();
  const tell = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event: string, data: unknown) => watchers.forEach((w) => tell(w, event, data));

  const server = createServer(async (req, res) => {
    const send = (status: number, type: string, body: string) => {
      // No framing by other sites (clickjacking: tricking clicks on Save) and no Referer with the token.
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'no-referrer' });
      res.end(body);
    };
    try {
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(403, 'text/plain', 'Wrong host.');
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      if (url.pathname === '/' && req.method === 'GET') {
        return send(200, 'text/html; charset=utf-8', page);
      }
      // The live view can't send headers (a link, an EventSource), so it carries the token in the address.
      const queryToken = url.searchParams.get('token') === token;
      if (url.pathname === '/live' && req.method === 'GET') return queryToken ? send(200, 'text/html; charset=utf-8', livePage) : send(403, 'text/plain', 'Missing token.');
      // Downloads of the saved review, as links (no headers there either): the editor saves before it asks.
      const get = /^\/download\/(pdf|pptx|html)$/.exec(url.pathname)?.[1];
      if (get && req.method === 'GET') {
        if (!queryToken) return send(403, 'text/plain', 'Missing token.');
        const review = read();
        const name = `sprint-review-${review.until}`;
        if (get === 'pptx') {
          const pptx = await pptxOf(review, config);
          res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'content-disposition': `attachment; filename="${name}.pptx"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
          res.end(pptx);
          return;
        }
        const html = render(review, config).html;
        if (get === 'html') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `attachment; filename="${name}.html"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
          res.end(html);
          return;
        }
        // PDF: the deck on its own, which opens the print dialog with every slide as a page.
        return send(200, 'text/html; charset=utf-8', html.replace('</body>', '<script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 400); });</script>\n</body>'));
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        if (!queryToken) return send(403, 'text/plain', 'Missing token.');
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
        live.html ??= render(read(), config).html;
        tell(res, 'deck', { html: live.html });
        tell(res, 'slide', { n: live.slide });
        watchers.add(res);
        req.on('close', () => watchers.delete(res));
        return;
      }
      if (!url.pathname.startsWith('/api/')) return send(404, 'text/plain', 'Not found.');
      if (req.headers['x-sprint-review-token'] !== token) return send(403, 'text/plain', 'Missing token.');

      if (url.pathname === '/api/review' && req.method === 'GET') return send(200, 'application/json', JSON.stringify(read()));
      if (url.pathname === '/api/preview' && req.method === 'POST') {
        const review = validReview(await body(req));
        live.html = render(review, config).html;
        broadcast('deck', { html: live.html });
        return send(200, 'text/html; charset=utf-8', live.html);
      }
      if (url.pathname === '/api/slide' && req.method === 'POST') {
        const n = Number((await body(req) as { n?: unknown })?.n);
        if (!Number.isInteger(n) || n < 1) return send(400, 'text/plain', 'n must be a slide number.');
        if (n !== live.slide) broadcast('slide', { n });
        live.slide = n;
        return send(200, 'application/json', '{"ok":true}');
      }
      if (url.pathname === '/api/review' && req.method === 'PUT') {
        const review = validReview(await body(req));
        await writeOutputs(review, config, dirname(file));
        return send(200, 'application/json', '{"ok":true}');
      }
      return send(404, 'text/plain', 'Not found.');
    } catch (e) {
      return send(400, 'text/plain', (e as Error).message);
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  return { url: `http://127.0.0.1:${actual}/`, server, close: () => new Promise((ok) => { watchers.forEach((w) => w.end()); server.close(() => ok()); server.closeAllConnections(); }) };
}

function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error('Too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        fail(new Error('Not JSON.'));
      }
    });
    req.on('error', fail);
  });
}

