// The half the game talks to.
//
// Every route is POST with a JSON body, and the shared secret travels IN THAT
// BODY rather than in a header — DayZ's RestContext.SetHeader controls only
// Content-Type, so an Authorization header is not available to it. That is
// also why the endpoint must be HTTPS in production: plain http would hand the
// secret to anyone watching the wire.
//
// /v1/poll is a LONG poll. The game has no inbound connections — a DayZ server
// listens to nobody, and Discord cannot knock on its door. So the game asks,
// and we hold the answer until there is something to say or the hold expires.
// DayZ's read timeout goes up to 120 s, which makes this behave like a push.

import { createServer } from 'node:http';

const MAX_BODY = 1 << 20; // 1 MiB: a chat batch is never near this

export class HttpSide {
  constructor(cfg, handlers) {
    this.cfg = cfg;
    this.handlers = handlers;
    this.waiters = [];
    this.server = createServer((req, res) => this.#route(req, res));
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(this.cfg.port, () => {
        console.log(`[http] listening on ${this.cfg.port}`);
        resolve();
      });
    });
  }

  // Something happened in Discord: release every held poll at once.
  wake() {
    const held = this.waiters;
    this.waiters = [];
    for (const w of held) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  async #route(req, res) {
    if (req.method === 'GET' && req.url.startsWith('/oauth/callback')) {
      return this.handlers.oauthCallback(req, res);
    }

    if (req.method !== 'POST') {
      return this.#json(res, 405, { error: 'post only' });
    }

    let body;
    try {
      body = await this.#read(req);
    } catch (err) {
      return this.#json(res, 400, { error: err.message });
    }

    // The secret is checked before anything else looks at the payload.
    if (!body || body.Secret !== this.cfg.secret) {
      // Deliberately vague: a precise answer helps whoever is guessing.
      return this.#json(res, 403, { error: 'refused' });
    }

    const path = req.url.split('?')[0];

    try {
      if (path === '/v1/poll') return await this.#poll(res, body);

      const fn = this.handlers.routes[path];
      if (!fn) return this.#json(res, 404, { error: 'no such route' });

      const out = await fn(body);
      return this.#json(res, 200, out ?? { ok: true });
    } catch (err) {
      console.error(`[http] ${path}: ${err.stack || err.message}`);
      return this.#json(res, 500, { error: 'bridge failed' });
    }
  }

  async #poll(res, body) {
    const first = this.handlers.drain(body);
    if (first.Items.length > 0) return this.#json(res, 200, first);

    // Nothing yet. Hold the request instead of answering "no" — an empty
    // answer would just be asked again a moment later, and the latency of
    // that gap is exactly what long polling exists to remove.
    await new Promise((resolve) => {
      const w = { resolve, timer: null };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve();
      }, this.cfg.holdSeconds * 1000);
      this.waiters.push(w);
    });

    return this.#json(res, 200, this.handlers.drain(body));
  }

  #read(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy();
          reject(new Error('body too large'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          reject(new Error('body is not json'));
        }
      });
      req.on('error', reject);
    });
  }

  #json(res, code, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(s),
    });
    res.end(s);
  }
}
