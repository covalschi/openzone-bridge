// NPC posters: names an admin mints and hands to factions.
//
// A persona is AUTHORSHIP, not an account: it exists so a faction leader can
// speak in the news feed as "Сидорович" rather than as himself. Admins may
// wear any persona; a faction leader may wear the ones granted to his
// faction; everyone else posts under their own linked game name only.
//
// Stored as its own small file: the roster of who MAY say what survives a
// restart, and it is not a cache of anything -- losing it loses real grants.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class Personas {
  constructor(path) {
    this.path = path;
    this.data = { version: 1, items: {} }; // name -> { factions: [slug], by, at }
    this.#load();
  }

  #load() {
    if (!existsSync(this.path)) return;
    try {
      this.data = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (err) {
      console.error(`[personas] ${this.path} unreadable (${err.message}); starting empty`);
    }
  }

  #save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  create(name, by) {
    if (this.data.items[name]) return { Error: 'exists' };
    this.data.items[name] = { factions: [], by, at: new Date().toISOString() };
    this.#save();
    return { ok: true };
  }

  remove(name) {
    if (!this.data.items[name]) return { Error: 'no_persona' };
    delete this.data.items[name];
    this.#save();
    return { ok: true };
  }

  grant(name, factionSlug) {
    const p = this.data.items[name];
    if (!p) return { Error: 'no_persona' };
    if (!p.factions.includes(factionSlug)) p.factions.push(factionSlug);
    this.#save();
    return { ok: true };
  }

  revoke(name, factionSlug) {
    const p = this.data.items[name];
    if (!p) return { Error: 'no_persona' };
    const at = p.factions.indexOf(factionSlug);
    if (at >= 0) p.factions.splice(at, 1);
    this.#save();
    return { ok: true };
  }

  list() {
    return Object.entries(this.data.items).map(([name, p]) => ({ name, factions: [...p.factions] }));
  }

  // The names this member may post under, besides his own. Admin -> all;
  // a faction leader -> whatever his faction was granted.
  allowedFor(resolved, isAdmin) {
    if (isAdmin) return Object.keys(this.data.items);
    if (!resolved || !resolved.Faction) return [];
    if (!resolved.Posts || !resolved.Posts.includes('leader')) return [];
    return Object.entries(this.data.items)
      .filter(([, p]) => p.factions.includes(resolved.Faction))
      .map(([name]) => name);
  }
}
