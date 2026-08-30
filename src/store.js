// Everything the bridge has to remember between restarts.
//
// Discord is the source of truth for MESSAGES. This file is not a second copy
// of them — it is the index that lets us find them again: which thread belongs
// to which conversation, and which Discord account belongs to which SteamID.
// Lose it and no message is lost, but every conversation becomes unreachable,
// so it is written synchronously on every change.
//
// A small recent-message cache lives here too. Not as an authority: Discord
// rate limits make it impossible to re-read a thread every time a player opens
// the page, so we keep the tail of what we have already seen. Anything the
// cache does not have is simply not shown — it is never invented.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = {
  version: 1,
  // steamId -> { discordId, discordName, linkedAt }
  links: {},
  // conversation key -> { threadId, kind, title, members: [steamId], createdAt }
  convos: {},
  // conversation key -> [ { id, at, uid, who, text } ]  (tail only)
  messages: {},
  // monotonic counter handed to the game so it can ask for "anything newer"
  cursor: 0,
  // Furniture the bot created in the guild and has to find again: key -> id.
  // Ids, never names -- an admin renaming a channel must not make the bot
  // build a second one beside it. Same rule the role roster follows.
  guild: {},
};

export class Store {
  constructor(path, keepPerConvo = 100) {
    this.path = path;
    this.keep = keepPerConvo;
    this.data = EMPTY;
    this.load();
  }

  load() {
    if (!existsSync(this.path)) {
      this.data = structuredClone(EMPTY);
      this.save();
      return;
    }
    try {
      this.data = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(this.path, 'utf8')) };
    } catch (err) {
      // A corrupt index is kept, never overwritten: the reason is read after
      // the crash, and rewriting it destroys that forever.
      const bad = `${this.path}.bad`;
      renameSync(this.path, bad);
      console.error(`[store] ${this.path} is unreadable (${err.message}); kept at ${bad}`);
      this.data = structuredClone(EMPTY);
      this.save();
    }
  }

  save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    // Write beside, then rename: a half-written index is worse than an old one.
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  // For the message tail ONLY. The tail is a cache -- Discord holds the
  // truth, and a lost second of it merely un-caches a line the next poll
  // re-reads. Structural changes (links, convos, guild refs) stay on the
  // synchronous save(): losing those makes threads unreachable. Without
  // this split every gateway message rewrote the whole file synchronously,
  // blocking the event loop once per line of chat.
  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1000);
    this.saveTimer.unref?.();
  }

  // ---- guild furniture ----

  guildRef(key) {
    return (this.data.guild && this.data.guild[key]) || null;
  }

  setGuildRef(key, id) {
    this.data.guild ||= {};
    if (id) this.data.guild[key] = id;
    else delete this.data.guild[key];
    this.save();
  }

  // ---- account links ----

  link(steamId, discordId, discordName) {
    this.data.links[steamId] = { discordId, discordName, linkedAt: new Date().toISOString() };
    this.save();
  }

  linkOf(steamId) {
    return this.data.links[steamId] || null;
  }

  steamIdOf(discordId) {
    for (const [steamId, l] of Object.entries(this.data.links)) {
      if (l.discordId === discordId) return steamId;
    }
    return null;
  }

  // ---- game names ----
  //
  // The last name a stalker wore IN GAME, remembered from his own requests.
  // Needed the other way round: when a linked player types in Discord, the
  // game must show his character, not his Discord nick.

  rememberName(steamId, name) {
    if (!steamId || !name) return;
    this.data.names ??= {};
    if (this.data.names[steamId] === name) return;
    this.data.names[steamId] = name;
    this.save();
  }

  nameOf(steamId) {
    return (this.data.names ?? {})[steamId] || '';
  }

  // ---- conversations ----

  // A direct conversation key is DERIVED from the two SteamIDs, so both sides
  // always arrive at the same key without any registry lookup.
  static directKey(a, b) {
    return a < b ? `d:${a}:${b}` : `d:${b}:${a}`;
  }

  convo(key) {
    return this.data.convos[key] || null;
  }

  putConvo(key, convo) {
    this.data.convos[key] = convo;
    this.save();
  }

  // The zone conversation belongs to everyone: its member list is ['*'],
  // and every membership question in the bridge goes through here.
  static memberOf(c, steamId) {
    return c.members.includes('*') || c.members.includes(steamId);
  }

  convosOf(steamId) {
    return Object.entries(this.data.convos)
      .filter(([, c]) => Store.memberOf(c, steamId))
      .map(([key, c]) => ({ key, ...c }));
  }

  convoByThread(threadId) {
    for (const [key, c] of Object.entries(this.data.convos)) {
      if (c.threadId === threadId) return { key, ...c };
    }
    return null;
  }

  // ---- group invites ----
  //
  // Nobody lands in a group unasked: the add is an INVITE and joining is
  // the invitee's own click. Persisted -- an invite must survive a bridge
  // restart, or a night owl's offer would evaporate before morning.

  addInvite(key, uid, from) {
    const inv = (this.data.invites ||= {});
    (inv[key] ||= {})[uid] = { from, at: new Date().toISOString() };
    this.saveSoon();
  }

  dropInvite(key, uid) {
    const inv = this.data.invites?.[key];
    if (!inv || !(uid in inv)) return false;
    delete inv[uid];
    if (!Object.keys(inv).length) delete this.data.invites[key];
    this.saveSoon();
    return true;
  }

  hasInvite(key, uid) {
    return !!this.data.invites?.[key]?.[uid];
  }

  invitesOf(uid) {
    const out = [];
    for (const [key, m] of Object.entries(this.data.invites || {})) {
      if (m[uid]) out.push({ key, from: m[uid].from });
    }
    return out;
  }

  dropInvitesOf(key) {
    if (this.data.invites?.[key]) {
      delete this.data.invites[key];
      this.saveSoon();
    }
  }

  // ---- messages ----

  // Returns the assigned cursor, or null when this message was already seen.
  // Discord delivers the bot's own webhook posts back over the gateway, so
  // without this check every message would appear twice.
  addMessage(key, msg) {
    const list = (this.data.messages[key] ||= []);
    if (list.some((m) => m.id === msg.id)) return null;

    this.data.cursor += 1;
    const stored = { ...msg, cursor: this.data.cursor };
    list.push(stored);
    while (list.length > this.keep) list.shift();
    this.saveSoon();
    return stored;
  }

  // Shared map marks past their TTL: [{key, threadId, id}]. A mark line in
  // chat is a courier, not a vault -- the caller deletes each one in
  // Discord first and then drops it here.
  expiredMarks(cutoffMs, parseAt) {
    const out = [];
    for (const [key, list] of Object.entries(this.data.messages)) {
      const c = this.data.convos[key];
      if (!c) continue;
      for (const m of list) {
        const t = parseAt(m.at);
        if (typeof m.text === 'string' && m.text.startsWith('[MARK] ') && t > 0 && t < cutoffMs)
          out.push({ key, threadId: c.threadId, id: m.id });
      }
    }
    return out;
  }

  dropMessage(key, id) {
    const list = this.data.messages[key];
    if (!list) return false;
    const at = list.findIndex((m) => m.id === id);
    if (at < 0) return false;
    list.splice(at, 1);
    this.saveSoon();
    return true;
  }

  messagesOf(key, limit) {
    const list = this.data.messages[key] || [];
    return limit ? list.slice(-limit) : list;
  }

  // Everything newer than `cursor` that `steamId` is allowed to see.
  since(steamId, cursor) {
    const out = [];
    for (const [key, list] of Object.entries(this.data.messages)) {
      const c = this.data.convos[key];
      if (!c || !Store.memberOf(c, steamId)) continue;
      for (const m of list) {
        if (m.cursor > cursor) out.push({ key, ...m });
      }
    }
    out.sort((a, b) => a.cursor - b.cursor);
    return out;
  }

  get cursor() {
    return this.data.cursor;
  }
}
