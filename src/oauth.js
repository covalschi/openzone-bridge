// Linking a SteamID to a Discord account.
//
// The player asks in game, gets a one-time URL, opens it in a browser, and
// Discord sends them back here. Nothing about this flow travels through the
// game client: the URL carries an opaque one-shot state, and the exchange for
// the token happens here, server to server.
//
// The state expires. A link URL that stayed valid forever would be a standing
// offer to bind somebody else's Discord account to your SteamID if you ever
// saw their link.

import { randomBytes } from 'node:crypto';

const STATE_TTL_MS = 10 * 60 * 1000;

export class OAuthSide {
  constructor(cfg, store, discord) {
    this.cfg = cfg;
    this.store = store;
    this.discord = discord;
    this.pending = new Map(); // state -> { steamId, at }
  }

  begin(steamId) {
    this.#sweep();

    const state = randomBytes(16).toString('hex');
    this.pending.set(state, { steamId, at: Date.now() });

    const u = new URL('https://discord.com/api/oauth2/authorize');
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('redirect_uri', this.cfg.redirectUrl);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'identify');
    u.searchParams.set('state', state);
    return u.toString();
  }

  async callback(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    const entry = state && this.pending.get(state);
    if (!code || !entry) return this.#page(res, 400, 'This link is no longer valid. Ask the PDA for a new one.');

    // One shot. Even a valid state is spent the moment it is used.
    this.pending.delete(state);

    try {
      const tok = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.cfg.redirectUrl,
        }),
      }).then((r) => r.json());

      if (!tok.access_token) throw new Error(tok.error_description || 'no token');

      const me = await fetch('https://discord.com/api/users/@me', {
        headers: { authorization: `Bearer ${tok.access_token}` },
      }).then((r) => r.json());

      if (!me.id) throw new Error('no user');

      const shown = (await this.discord.displayName(me.id)) || me.global_name || me.username;
      this.store.link(entry.steamId, me.id, shown);

      console.log(`[oauth] linked ${entry.steamId} -> ${me.id}`);
      return this.#page(res, 200, `Linked as ${shown}. You can close this tab.`);
    } catch (err) {
      console.error(`[oauth] ${err.message}`);
      return this.#page(res, 500, 'Discord refused the exchange. Try again from the PDA.');
    }
  }

  #sweep() {
    const now = Date.now();
    for (const [k, v] of this.pending) {
      if (now - v.at > STATE_TTL_MS) this.pending.delete(k);
    }
  }

  #page(res, code, text) {
    const html = `<!doctype html><meta charset="utf-8"><title>OpenZone</title>
<body style="background:#111;color:#ddd;font:16px/1.5 system-ui;padding:3rem">
<p style="color:#ff7a1a">OpenZone</p><p>${text}</p></body>`;
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}
