// Linking a SteamID to a Discord account, through the bot.
//
// The game mints nothing and the player types nothing long. The PDA asks the
// bridge for a SHORT CODE, shows it, and the player runs `/link <code>` in
// Discord. That is the whole flow.
//
// WHY THIS SHAPE, AND NOT "just tell the bot your SteamID": because a SteamID
// typed into Discord is self-asserted. Anyone could claim anyone's, and the
// bot has no way to tell. Neither half of this link may be self-asserted, and
// in this flow neither is:
//
//   - the CODE proves the person is in game, on this server, as that SteamID.
//     It only exists because the game server asked for it on their behalf.
//   - the DISCORD IDENTITY comes from the interaction, which Discord itself
//     authenticated. The bot never asks who they are.
//
// This replaces the OAuth round trip for linking. OAuth worked, but it made
// the player copy a 200-character URL off a game screen by eye, which is the
// worst part of any flow it appears in.
//
// The code expires. A code that stayed valid forever would be a standing offer
// to bind somebody else's Discord account to your SteamID, if they ever saw
// your screen.

import { randomInt } from 'node:crypto';

// No 0/O and no 1/I/L: the code is read off a game screen and typed into a
// phone, and those are the pairs people get wrong.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 6;

const TTL_MS = 10 * 60 * 1000;

export class LinkCodes {
  constructor(store) {
    this.store = store;
    this.byCode = new Map();   // CODE -> { steamId, at }
    this.bySteam = new Map();  // steamId -> CODE
  }

  // Ask for a code. Asking twice returns the SAME code while it is still
  // valid: a player who pressed the button, tabbed out and pressed again
  // should not be handed a second code that invalidates the one already on
  // his screen.
  mint(steamId) {
    this.#sweep();

    const had = this.bySteam.get(steamId);
    if (had && this.byCode.has(had)) {
      return { code: had, expiresInSec: this.#leftSec(had) };
    }

    let code;
    do {
      code = '';
      for (let i = 0; i < LENGTH; i++) {
        code += ALPHABET[randomInt(ALPHABET.length)];
      }
    } while (this.byCode.has(code));

    this.byCode.set(code, { steamId, at: Date.now() });
    this.bySteam.set(steamId, code);

    return { code, expiresInSec: Math.round(TTL_MS / 1000) };
  }

  // Redeem, one shot. Returns the SteamID, or null with a reason.
  //
  // Case and whitespace are forgiven -- the player is retyping from a screen,
  // and refusing "abc123 " because of a trailing space would be a bad joke.
  redeem(raw, discordId, discordName) {
    this.#sweep();

    const code = String(raw || '').trim().toUpperCase();
    if (!code) return { ok: false, reason: 'empty' };

    const rec = this.byCode.get(code);
    if (!rec) return { ok: false, reason: 'unknown' };

    // Already linked to someone else's Discord? Say so rather than silently
    // moving the link: it means two people are using one code.
    const existing = this.store.linkOf(rec.steamId);
    if (existing && existing.discordId !== discordId) {
      return { ok: false, reason: 'taken', steamId: rec.steamId };
    }

    this.byCode.delete(code);
    this.bySteam.delete(rec.steamId);

    this.store.link(rec.steamId, discordId, discordName);
    return { ok: true, steamId: rec.steamId };
  }

  #leftSec(code) {
    const rec = this.byCode.get(code);
    if (!rec) return 0;
    return Math.max(0, Math.round((TTL_MS - (Date.now() - rec.at)) / 1000));
  }

  #sweep() {
    const now = Date.now();
    for (const [code, rec] of this.byCode) {
      if (now - rec.at < TTL_MS) continue;
      this.byCode.delete(code);
      if (this.bySteam.get(rec.steamId) === code) this.bySteam.delete(rec.steamId);
    }
  }
}
