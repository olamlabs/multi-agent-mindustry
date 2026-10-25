import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export const GAME_OVER = 'Every game of the series is over. The results are at GET /update.';
const STILL_ANSWERED = new Set(['GET /update']);

export class ApiError extends Error {
  constructor(status, message, fields = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export class Reply {
  constructor(status, value) {
    this.status = status;
    this.value = value;
  }
}

const KEEPALIVE_AFTER_MS = 5_000;
const KEEPALIVE_EVERY_MS = 15_000;

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'The body is not JSON');
  }
}

export function serveApi({ port, tokens, routes, ready = () => true, over = () => false, statusOf = null, onRequest = () => {}, onError = (error) => console.error(error) }) {
  const known = Object.entries(tokens).map(([seat, token]) => [seat, Buffer.from(String(token))]);
  function seatOf(header) {
    const match = /^Bearer (.+)$/.exec(header ?? '');
    if (!match) return null;
    const supplied = Buffer.from(match[1]);
    let found = null;
    for (const [seat, token] of known) if (supplied.length === token.length && timingSafeEqual(supplied, token)) found = seat;
    return found;
  }

  const server = createServer({ requestTimeout: 0, headersTimeout: 0 }, (request, response) => {

    let url = null;
    try {
      url = new URL(request.url, 'http://game');
    } catch {}
    const route = `${request.method} ${url?.pathname ?? request.url}`;
    const began = Date.now();
    let caller = null;
    const controller = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) controller.abort();
    });
    let streaming = false;
    let keepalive = setTimeout(function beat() {
      if (response.writableEnded || response.destroyed) return;
      if (!streaming) {
        streaming = true;
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      }
      response.write(' ');
      keepalive = setTimeout(beat, KEEPALIVE_EVERY_MS);
    }, KEEPALIVE_AFTER_MS);
    const send = (status, body) => {
      clearTimeout(keepalive);
      console.log(`${caller ?? '-'} ${route} ${status} ${Date.now() - began}ms`);
      if (response.writableEnded || response.destroyed) return;
      if (body === undefined && !streaming) return response.writeHead(status).end();
      const text = JSON.stringify(body ?? null);
      if (streaming) return response.end(text);
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }).end(text);
    };
    const answer = async () => {
      if (url == null) throw new ApiError(400, `Invalid request path ${JSON.stringify(request.url)}`);
      if (route === 'GET /health') {
        if (!(await ready())) throw new ApiError(503, 'The game is not ready');
        return { ready: true, game_over: over() };
      }
      const seat = seatOf(request.headers.authorization);
      caller = seat;
      if (seat == null) throw new ApiError(401, 'Send Authorization: Bearer <token from /run/mindustry/token>');
      if (over() && !STILL_ANSWERED.has(route)) return new Reply(410, { game_over: true, error: GAME_OVER });
      const handler = routes[route];
      if (handler == null) {
        const methods = Object.keys(routes).filter((key) => key.endsWith(` ${url.pathname}`)).map((key) => key.split(' ')[0]);
        throw new ApiError(methods.length ? 405 : 404, methods.length ? `${url.pathname} is ${methods.join(' or ')}, not ${request.method}` : `No endpoint ${url.pathname}; GET / lists them`);
      }
      const body = request.method === 'POST' ? await readBody(request) : {};
      onRequest(seat);
      return handler({ seat, body, query: url.searchParams, signal: controller.signal });
    };
    (async () => {
      let status = 200;
      let body;
      try {
        body = await answer();
        if (body instanceof Reply) [status, body] = [body.status, body.value];
      } catch (error) {
        if (error instanceof ApiError) [status, body] = [error.status, { error: error.message, ...error.fields }];
        else {
          onError(error);
          [status, body] = [500, { error: String(error?.message ?? error) }];
        }
      }
      if (statusOf && caller != null && body?.constructor === Object && !('status' in body)) body = { ...body, status: await statusOf(caller) };
      send(status, body);
    })().catch((error) => {

      onError(error);
      send(500, { error: String(error?.message ?? error) });
    });
  });
  server.timeout = 0;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

export function waitForChange(waiters, signal) {
  return new Promise((resolve) => {
    if(signal?.aborted){resolve();return;}
    const done = () => {
      waiters.delete(done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    waiters.add(done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function notify(waiters) {
  for (const done of [...waiters]) done();
}
