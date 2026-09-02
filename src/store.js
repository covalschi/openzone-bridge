// Everything the bridge has to remember between restarts -- in SQLite.
//
// This used to be one JSON document (state/bridge.json) rewritten whole on
// every change. TZ-2 R6.1 names the three things that document could not do
// and this can: a tail read from a cursor without loading everything, a write
// that is atomic without a .tmp-and-rename per line, and no ring buffer that
// quietly eats the oldest record. Since chat's HOME moved here (TZ-2 slice
// 1в) the last one stopped being a nicety: a line sent with the mirror off
// exists in this file and nowhere else in the world.
//
// The shape of the API is unchanged on purpose: every caller keeps working,
// and save()/saveSoon() are kept as no-ops so a caller written for the JSON
// store neither breaks nor learns anything it does not need to know.
//
// node:sqlite, not a native module: it ships with Node 24 and there is nothing
// to compile on the host. Synchronous, like the JSON store was -- the bridge
// is a single event loop and every write here is a few microseconds.
//
// Migration from the JSON document is a MANUAL step with a report
// (scripts/migrate-json-to-sqlite.mjs), never something the bot does on its
// own at start (TZ-2 R6.2). index.js refuses to start beside an unmigrated
// document rather than quietly begin with an empty memory.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 2;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // steamId -> discord account
  `CREATE TABLE IF NOT EXISTS links (
     steam_id     TEXT PRIMARY KEY,
     discord_id   TEXT NOT NULL,
     discord_name TEXT NOT NULL DEFAULT '',
     linked_at    TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS links_discord ON links(discord_id)`,
  // the last name a stalker wore in game
  `CREATE TABLE IF NOT EXISTS names (
     steam_id TEXT PRIMARY KEY,
     name     TEXT NOT NULL
   )`,
  // conversation key -> the conversation record, opaque to the store
  `CREATE TABLE IF NOT EXISTS convos (
     key  TEXT PRIMARY KEY,
     json TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS invites (
     key      TEXT NOT NULL,
     uid      TEXT NOT NULL,
     from_uid TEXT NOT NULL DEFAULT '',
     at       TEXT NOT NULL DEFAULT '',
     PRIMARY KEY (key, uid)
   )`,
  // NEWS live here (TZ-2 R1.1); Discord is a surface they may also appear on
  `CREATE TABLE IF NOT EXISTS news (
     id   TEXT PRIMARY KEY,
     ts   INTEGER NOT NULL DEFAULT 0,
     json TEXT NOT NULL
   )`,
  // chat lines; the cursor is the bridge-wide monotonic counter the game
  // polls by, and it is never reused
  `CREATE TABLE IF NOT EXISTS messages (
     cursor     INTEGER PRIMARY KEY,
     key        TEXT NOT NULL,
     id         TEXT NOT NULL,
     at         TEXT NOT NULL DEFAULT '',
     text       TEXT NOT NULL DEFAULT '',
     in_discord INTEGER NOT NULL DEFAULT 1,
     json       TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS messages_key_id ON messages(key, id)`,
  `CREATE INDEX IF NOT EXISTS messages_key_cursor ON messages(key, cursor)`,
  // furniture the bot created in the guild and has to find again
  `CREATE TABLE IF NOT EXISTS guild (
     key TEXT PRIMARY KEY,
     id  TEXT NOT NULL
   )`,
  // THE ROLES HOME (TZ-2 section 15, owner 2026-09-02): the catalog of
  // factions, posts, faction ranks, stalker ranks and traits, and who holds
  // what. Discord roles are a mirror of these rows, never the other way.
  `CREATE TABLE IF NOT EXISTS factions (
     slug       TEXT PRIMARY KEY,
     label      TEXT NOT NULL,
     color      INTEGER NOT NULL DEFAULT 13158600,
     base       INTEGER NOT NULL DEFAULT 0,
     limit_n    INTEGER NOT NULL DEFAULT 0,
     role_id    TEXT NOT NULL DEFAULT '',
     missing    INTEGER NOT NULL DEFAULT 0,
     ord        INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS faction_posts (
     faction  TEXT NOT NULL,
     slug     TEXT NOT NULL,
     label    TEXT NOT NULL,
     role_id  TEXT NOT NULL DEFAULT '',
     missing  INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (faction, slug)
   )`,
  `CREATE TABLE IF NOT EXISTS faction_ranks (
     faction  TEXT NOT NULL,
     slug     TEXT NOT NULL,
     label    TEXT NOT NULL,
     ord      INTEGER NOT NULL DEFAULT 0,
     role_id  TEXT NOT NULL DEFAULT '',
     missing  INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (faction, slug)
   )`,
  `CREATE TABLE IF NOT EXISTS ranks (
     slug     TEXT PRIMARY KEY,
     label    TEXT NOT NULL,
     ord      INTEGER NOT NULL DEFAULT 0,
     role_id  TEXT NOT NULL DEFAULT '',
     missing  INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS traits (
     slug     TEXT PRIMARY KEY,
     label    TEXT NOT NULL,
     role_id  TEXT NOT NULL DEFAULT '',
     missing  INTEGER NOT NULL DEFAULT 0
   )`,
  // One row per character the bot has ever been told about. Keyed by
  // Steam64: membership no longer needs a Discord link (R7.1, R7.5).
  `CREATE TABLE IF NOT EXISTS members (
     steam_id   TEXT PRIMARY KEY,
     org        TEXT NOT NULL DEFAULT '',
     frank      TEXT NOT NULL DEFAULT '',
     rank       TEXT NOT NULL DEFAULT '',
     posts      TEXT NOT NULL DEFAULT '[]',
     traits     TEXT NOT NULL DEFAULT '[]',
     updated_at TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS members_org ON members(org)`,
  // Factions removed from the catalog. The game's roster merge adds and
  // updates but never deletes on its own, so removals travel by name (R7.9).
  `CREATE TABLE IF NOT EXISTS factions_gone (
     slug  TEXT PRIMARY KEY,
     stamp INTEGER NOT NULL DEFAULT 0
   )`,
];

export class Store {
  constructor(path, keepPerConvo = 100) {
    this.path = path;
    this.keep = keepPerConvo;

    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);

    // WAL: readers never block the writer and a crash mid-write leaves the
    // last committed state, not a torn file. synchronous=FULL because the
    // volume is a chat line a second at most and the cost of losing one is
    // named above.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    for (const ddl of SCHEMA) this.db.exec(ddl);
    this.#upgrade();

    this.#prepare();

    if (this.#meta('version') === null) this.#setMeta('version', String(SCHEMA_VERSION));
    if (this.#meta('cursor') === null) this.#setMeta('cursor', '0');
  }

  close() {
    this.db.close();
  }

  // Kept for callers written against the JSON store. Every change here is
  // already on disk by the time the method that made it returns.
  save() {}
  saveSoon() {}

  // ---- plumbing ----

  // Columns added after the first schema. CREATE TABLE IF NOT EXISTS leaves
  // an existing table alone, so a new column has to be asked for by name.
  #upgrade() {
    const cols = this.db.prepare('PRAGMA table_info(invites)').all().map((c) => c.name);
    if (!cols.includes('expires_at')) {
      // TZ-4 R-D3.3: a group invite has a lifetime. Empty means "never
      // expires" -- every invite written before this column existed.
      this.db.exec("ALTER TABLE invites ADD COLUMN expires_at TEXT NOT NULL DEFAULT ''");
    }
  }

  #prepare() {
    const q = (sql) => this.db.prepare(sql);
    this.q = {
      metaGet: q('SELECT value FROM meta WHERE key = ?'),
      metaSet: q('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

      guildGet: q('SELECT id FROM guild WHERE key = ?'),
      guildSet: q('INSERT INTO guild(key, id) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET id = excluded.id'),
      guildDel: q('DELETE FROM guild WHERE key = ?'),

      linkSet: q('INSERT INTO links(steam_id, discord_id, discord_name, linked_at) VALUES (?, ?, ?, ?) ' +
                 'ON CONFLICT(steam_id) DO UPDATE SET discord_id = excluded.discord_id, discord_name = excluded.discord_name, linked_at = excluded.linked_at'),
      linkGet: q('SELECT discord_id, discord_name, linked_at FROM links WHERE steam_id = ?'),
      linkByDiscord: q('SELECT steam_id FROM links WHERE discord_id = ? ORDER BY linked_at DESC LIMIT 1'),
      linkAll: q('SELECT steam_id, discord_id FROM links ORDER BY linked_at'),

      nameSet: q('INSERT INTO names(steam_id, name) VALUES (?, ?) ON CONFLICT(steam_id) DO UPDATE SET name = excluded.name'),
      nameGet: q('SELECT name FROM names WHERE steam_id = ?'),

      convoGet: q('SELECT json FROM convos WHERE key = ?'),
      convoSet: q('INSERT INTO convos(key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json'),
      convoDel: q('DELETE FROM convos WHERE key = ?'),
      convoAll: q('SELECT key, json FROM convos ORDER BY key'),

      invSet: q('INSERT INTO invites(key, uid, from_uid, at, expires_at) VALUES (?, ?, ?, ?, ?) ' +
                'ON CONFLICT(key, uid) DO UPDATE SET from_uid = excluded.from_uid, at = excluded.at, expires_at = excluded.expires_at'),
      invDel: q('DELETE FROM invites WHERE key = ? AND uid = ?'),
      // "live" = not expired: an empty expiry never expires.
      invHas: q("SELECT 1 FROM invites WHERE key = ? AND uid = ? AND (expires_at = '' OR expires_at > ?)"),
      invOfUid: q("SELECT key, from_uid FROM invites WHERE uid = ? AND (expires_at = '' OR expires_at > ?) ORDER BY at"),
      invCount: q("SELECT COUNT(*) AS n FROM invites WHERE key = ? AND (expires_at = '' OR expires_at > ?)"),
      invSweep: q("DELETE FROM invites WHERE expires_at <> '' AND expires_at <= ?"),
      invDelKey: q('DELETE FROM invites WHERE key = ?'),

      newsAll: q('SELECT json FROM news ORDER BY ts'),
      newsSet: q('INSERT INTO news(id, ts, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, json = excluded.json'),
      newsDel: q('DELETE FROM news WHERE id = ?'),
      newsCount: q('SELECT COUNT(*) AS n FROM news'),
      newsOldest: q('SELECT id FROM news ORDER BY ts LIMIT ?'),

      msgHas: q('SELECT 1 FROM messages WHERE key = ? AND id = ?'),
      msgIns: q('INSERT INTO messages(cursor, key, id, at, text, in_discord, json) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      msgCount: q('SELECT COUNT(*) AS n FROM messages WHERE key = ?'),
      msgDropOldestMirrored: q('DELETE FROM messages WHERE cursor = (SELECT cursor FROM messages WHERE key = ? AND in_discord = 1 ORDER BY cursor LIMIT 1)'),
      msgDel: q('DELETE FROM messages WHERE key = ? AND id = ?'),
      msgDelKey: q('DELETE FROM messages WHERE key = ?'),
      msgTailDesc: q('SELECT json FROM messages WHERE key = ? ORDER BY cursor DESC LIMIT ?'),
      msgAllAsc: q('SELECT json FROM messages WHERE key = ? ORDER BY cursor'),
      msgSince: q('SELECT key, json FROM messages WHERE cursor > ? ORDER BY cursor'),
      msgMarks: q("SELECT key, id, at, text FROM messages WHERE text LIKE '[MARK] %'"),

      // ---- roles home ----
      facAll: q('SELECT slug, label, color, base, limit_n, role_id, missing, ord FROM factions ORDER BY ord, rowid'),
      facGet: q('SELECT slug, label, color, base, limit_n, role_id, missing, ord FROM factions WHERE slug = ?'),
      facSet: q('INSERT INTO factions(slug, label, color, base, limit_n, role_id, missing, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
                'ON CONFLICT(slug) DO UPDATE SET label = excluded.label, color = excluded.color, base = excluded.base, limit_n = excluded.limit_n, role_id = excluded.role_id, missing = excluded.missing, ord = excluded.ord'),
      facDel: q('DELETE FROM factions WHERE slug = ?'),
      facCount: q('SELECT COUNT(*) AS n FROM factions'),
      facMaxOrd: q('SELECT COALESCE(MAX(ord), 0) AS n FROM factions'),

      postAll: q('SELECT faction, slug, label, role_id, missing FROM faction_posts ORDER BY faction, rowid'),
      postSet: q('INSERT INTO faction_posts(faction, slug, label, role_id, missing) VALUES (?, ?, ?, ?, ?) ' +
                 'ON CONFLICT(faction, slug) DO UPDATE SET label = excluded.label, role_id = excluded.role_id, missing = excluded.missing'),
      postDel: q('DELETE FROM faction_posts WHERE faction = ? AND slug = ?'),
      postDelFaction: q('DELETE FROM faction_posts WHERE faction = ?'),

      frankAll: q('SELECT faction, slug, label, ord, role_id, missing FROM faction_ranks ORDER BY faction, ord, rowid'),
      frankSet: q('INSERT INTO faction_ranks(faction, slug, label, ord, role_id, missing) VALUES (?, ?, ?, ?, ?, ?) ' +
                  'ON CONFLICT(faction, slug) DO UPDATE SET label = excluded.label, ord = excluded.ord, role_id = excluded.role_id, missing = excluded.missing'),
      frankDel: q('DELETE FROM faction_ranks WHERE faction = ? AND slug = ?'),
      frankDelFaction: q('DELETE FROM faction_ranks WHERE faction = ?'),

      rankAll: q('SELECT slug, label, ord, role_id, missing FROM ranks ORDER BY ord, rowid'),
      rankSet: q('INSERT INTO ranks(slug, label, ord, role_id, missing) VALUES (?, ?, ?, ?, ?) ' +
                 'ON CONFLICT(slug) DO UPDATE SET label = excluded.label, ord = excluded.ord, role_id = excluded.role_id, missing = excluded.missing'),
      rankDel: q('DELETE FROM ranks WHERE slug = ?'),

      traitAll: q('SELECT slug, label, role_id, missing FROM traits ORDER BY rowid'),
      traitSet: q('INSERT INTO traits(slug, label, role_id, missing) VALUES (?, ?, ?, ?) ' +
                  'ON CONFLICT(slug) DO UPDATE SET label = excluded.label, role_id = excluded.role_id, missing = excluded.missing'),
      traitDel: q('DELETE FROM traits WHERE slug = ?'),

      memGet: q('SELECT steam_id, org, frank, rank, posts, traits, updated_at FROM members WHERE steam_id = ?'),
      memSet: q('INSERT INTO members(steam_id, org, frank, rank, posts, traits, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
                'ON CONFLICT(steam_id) DO UPDATE SET org = excluded.org, frank = excluded.frank, rank = excluded.rank, posts = excluded.posts, traits = excluded.traits, updated_at = excluded.updated_at'),
      memDel: q('DELETE FROM members WHERE steam_id = ?'),
      memAll: q('SELECT steam_id, org, frank, rank, posts, traits, updated_at FROM members ORDER BY steam_id'),
      memOfOrg: q('SELECT steam_id, org, frank, rank, posts, traits, updated_at FROM members WHERE org = ? ORDER BY updated_at, steam_id'),
      memCountOrg: q('SELECT COUNT(*) AS n FROM members WHERE org = ?'),
      memCount: q('SELECT COUNT(*) AS n FROM members'),

      goneSet: q('INSERT INTO factions_gone(slug, stamp) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET stamp = excluded.stamp'),
      goneDel: q('DELETE FROM factions_gone WHERE slug = ?'),
      goneAll: q('SELECT slug FROM factions_gone ORDER BY stamp'),
    };
  }

  #meta(key) {
    const row = this.q.metaGet.get(key);
    return row ? row.value : null;
  }

  #setMeta(key, value) {
    this.q.metaSet.run(key, String(value));
  }

  #tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- guild furniture ----

  guildRef(key) {
    const row = this.q.guildGet.get(key);
    return row ? row.id : null;
  }

  setGuildRef(key, id) {
    if (id) this.q.guildSet.run(key, String(id));
    else this.q.guildDel.run(key);
  }

  // ---- account links ----

  link(steamId, discordId, discordName) {
    this.q.linkSet.run(steamId, discordId, discordName || '', new Date().toISOString());
    // One hook for both doors (the /link code and the OAuth page): the roles
    // home makes the character's row here. Set from index.js.
    if (this.onLink) this.onLink(steamId, discordId);
  }

  linkOf(steamId) {
    const row = this.q.linkGet.get(steamId);
    if (!row) return null;
    return { discordId: row.discord_id, discordName: row.discord_name, linkedAt: row.linked_at };
  }

  steamIdOf(discordId) {
    const row = this.q.linkByDiscord.get(discordId);
    return row ? row.steam_id : null;
  }

  // Everybody who ever linked, oldest first. The admin roster is built from
  // this (TZ-4 R-C4.2): the game itself only knows who is in the Zone.
  linksAll() {
    return this.q.linkAll.all().map((row) => ({ steamId: row.steam_id, discordId: row.discord_id, discordName: row.discord_name }));
  }

  // ---- roles home (TZ-2 section 15) ----
  //
  // Rows in, rows out. Every rule about who may hold what lives in roles.js;
  // this layer only promises that a write is on disk when it returns and
  // that tx() makes several writes one.

  tx(fn) {
    return this.#tx(fn);
  }

  metaGet(key) {
    return this.#meta(key);
  }

  metaSet(key, value) {
    this.#setMeta(key, value);
  }

  factionsAll() {
    return this.q.facAll.all().map(rowFaction);
  }

  factionGet(slug) {
    const row = this.q.facGet.get(slug);
    return row ? rowFaction(row) : null;
  }

  factionSet(f) {
    let ord = f.ord;
    if (!(ord > 0)) ord = (this.q.facMaxOrd.get().n || 0) + 1;
    this.q.facSet.run(f.slug, f.label, Number(f.color) || 0, f.base ? 1 : 0, Math.max(0, Math.floor(Number(f.limit) || 0)), f.roleId || '', f.missing ? 1 : 0, ord);
  }

  factionDel(slug) {
    this.q.postDelFaction.run(slug);
    this.q.frankDelFaction.run(slug);
    this.q.facDel.run(slug);
  }

  factionCount() {
    return this.q.facCount.get().n || 0;
  }

  postsAll() {
    return this.q.postAll.all().map((r) => ({ faction: r.faction, slug: r.slug, label: r.label, roleId: r.role_id, missing: !!r.missing }));
  }

  postSet(p) {
    this.q.postSet.run(p.faction, p.slug, p.label, p.roleId || '', p.missing ? 1 : 0);
  }

  postDel(faction, slug) {
    this.q.postDel.run(faction, slug);
  }

  franksAll() {
    return this.q.frankAll.all().map((r) => ({ faction: r.faction, slug: r.slug, label: r.label, ord: r.ord, roleId: r.role_id, missing: !!r.missing }));
  }

  frankSet(f) {
    this.q.frankSet.run(f.faction, f.slug, f.label, Math.floor(Number(f.ord) || 0), f.roleId || '', f.missing ? 1 : 0);
  }

  frankDel(faction, slug) {
    this.q.frankDel.run(faction, slug);
  }

  ranksAll() {
    return this.q.rankAll.all().map((r) => ({ slug: r.slug, label: r.label, ord: r.ord, roleId: r.role_id, missing: !!r.missing }));
  }

  rankSet(r) {
    this.q.rankSet.run(r.slug, r.label, Math.floor(Number(r.ord) || 0), r.roleId || '', r.missing ? 1 : 0);
  }

  rankDel(slug) {
    this.q.rankDel.run(slug);
  }

  traitsAll() {
    return this.q.traitAll.all().map((r) => ({ slug: r.slug, label: r.label, roleId: r.role_id, missing: !!r.missing }));
  }

  traitSet(t) {
    this.q.traitSet.run(t.slug, t.label, t.roleId || '', t.missing ? 1 : 0);
  }

  traitDel(slug) {
    this.q.traitDel.run(slug);
  }

  memberGet(steamId) {
    const row = this.q.memGet.get(steamId);
    return row ? rowMember(row) : null;
  }

  memberSet(m) {
    this.q.memSet.run(
      m.steamId,
      m.org || '',
      m.frank || '',
      m.rank || '',
      JSON.stringify(Array.isArray(m.posts) ? m.posts : []),
      JSON.stringify(Array.isArray(m.traits) ? m.traits : []),
      new Date().toISOString(),
    );
  }

  memberDel(steamId) {
    this.q.memDel.run(steamId);
  }

  membersAll() {
    return this.q.memAll.all().map(rowMember);
  }

  membersOf(org) {
    return this.q.memOfOrg.all(org).map(rowMember);
  }

  memberCountOf(org) {
    return this.q.memCountOrg.get(org).n || 0;
  }

  memberCount() {
    return this.q.memCount.get().n || 0;
  }

  goneAdd(slug, stamp) {
    this.q.goneSet.run(slug, stamp);
  }

  goneForget(slug) {
    this.q.goneDel.run(slug);
  }

  goneAll() {
    return this.q.goneAll.all().map((r) => r.slug);
  }

  // ---- game names ----

  rememberName(steamId, name) {
    if (!steamId || !name) return;
    this.q.nameSet.run(steamId, name);
  }

  nameOf(steamId) {
    const row = this.q.nameGet.get(steamId);
    return row ? row.name : '';
  }

  // ---- conversations ----

  // A direct conversation key is DERIVED from the two CHARACTER keys
  // ("<steamId>#<generation>"), so both sides always arrive at the same key
  // without any registry lookup -- and a character who died leaves his
  // conversation behind instead of handing it to whoever the account
  // becomes next.
  static directKey(a, b) {
    return a < b ? `d:${a}:${b}` : `d:${b}:${a}`;
  }

  allConvoKeys() {
    return this.q.convoAll.all().map((r) => r.key);
  }

  // Every conversation with its key folded in: what callers used to get by
  // walking data.convos themselves.
  convosAll() {
    return this.q.convoAll.all().map((r) => ({ key: r.key, ...JSON.parse(r.json) }));
  }

  convo(key) {
    const row = this.q.convoGet.get(key);
    return row ? JSON.parse(row.json) : null;
  }

  putConvo(key, convo) {
    this.q.convoSet.run(key, JSON.stringify(convo));
  }

  // The conversation and every line in it, in one transaction: a convo
  // without its lines or lines without their convo is the half-state the
  // JSON store could leave behind between two writes.
  dropConvo(key) {
    return this.#tx(() => {
      this.q.invDelKey.run(key);
      this.q.msgDelKey.run(key);
      return this.q.convoDel.run(key).changes > 0;
    });
  }

  // The zone conversation belongs to everyone: its member list is ['*'],
  // and every membership question in the bridge goes through here.
  static memberOf(c, steamId) {
    return c.members.includes('*') || c.members.includes(steamId);
  }

  convosOf(steamId) {
    return this.convosAll().filter((c) => Store.memberOf(c, steamId));
  }

  convoByThread(threadId) {
    for (const c of this.convosAll()) {
      if (c.threadId === threadId) return c;
    }
    return null;
  }

  // ---- group invites ----

  // ttlSeconds > 0 gives the invite a lifetime (TZ-4 R-D3.3); 0 or absent
  // keeps it until answered, as before.
  addInvite(key, uid, from, ttlSeconds = 0) {
    const now = Date.now();
    // Zero keeps it forever; any other number is a lifetime in seconds, and a
    // negative one is already over -- which is how a test writes an expired
    // invite without waiting.
    const ttl = Number(ttlSeconds) || 0;
    const expires = ttl !== 0 ? new Date(now + ttl * 1000).toISOString() : '';
    this.q.invSet.run(key, uid, from || '', new Date(now).toISOString(), expires);
  }

  dropInvite(key, uid) {
    return this.q.invDel.run(key, uid).changes > 0;
  }

  hasInvite(key, uid) {
    return !!this.q.invHas.get(key, uid, new Date().toISOString());
  }

  invitesOf(uid) {
    return this.q.invOfUid.all(uid, new Date().toISOString()).map((r) => ({ key: r.key, from: r.from_uid }));
  }

  // Live invites standing against a conversation: they count toward the
  // group ceiling (TZ-4 R-D3.1) - a seat promised is a seat taken.
  inviteCount(key) {
    return this.q.invCount.get(key, new Date().toISOString()).n;
  }

  // Drop every invite past its lifetime. Returns how many went.
  sweepInvites() {
    return this.q.invSweep.run(new Date().toISOString()).changes;
  }

  dropInvitesOf(key) {
    this.q.invDelKey.run(key);
  }

  // ---- news ----
  //
  // The store keeps them; the News module decides what a post IS. Nothing
  // here reads inside a post beyond its id and its timestamp for trimming.

  newsAll() {
    return this.q.newsAll.all().map((r) => JSON.parse(r.json));
  }

  newsPut(post) {
    if (!post || !post.Id) return;
    this.q.newsSet.run(String(post.Id), Number(post.ts) || 0, JSON.stringify(post));
  }

  newsDrop(id) {
    return this.q.newsDel.run(String(id)).changes > 0;
  }

  // Oldest out when the feed runs long. Safe to drop here in a way chat is
  // not: news are authored in Discord and stay there, so an evicted post is
  // still where it was written.
  newsTrim(keep) {
    const n = this.q.newsCount.get().n;
    if (n <= keep) return;
    const doomed = this.q.newsOldest.all(n - keep);
    this.#tx(() => {
      for (const r of doomed) this.q.newsDel.run(r.id);
    });
  }

  // ---- messages ----

  // Returns the stored line with its cursor, or null when this message was
  // already seen. Discord delivers the bot's own webhook posts back over the
  // gateway, so without this check every message would appear twice.
  addMessage(key, msg) {
    return this.#tx(() => {
      if (this.q.msgHas.get(key, String(msg.id))) return null;

      const cursor = Number(this.#meta('cursor')) + 1;
      const stored = { ...msg, cursor };
      this.q.msgIns.run(
        cursor, key, String(msg.id), String(msg.at ?? ''), typeof msg.text === 'string' ? msg.text : '',
        msg.inDiscord === false ? 0 : 1, JSON.stringify(stored),
      );
      this.#setMeta('cursor', cursor);
      this.#trim(key);
      return stored;
    });
  }

  // A line Discord accepted after it was stored becomes droppable. The JSON
  // store got this for free by mutating the shared object; here it is a
  // write, and callers say so explicitly.
  setInDiscord(key, id, flag) {
    const row = this.db.prepare('SELECT json FROM messages WHERE key = ? AND id = ?').get(key, String(id));
    if (!row) return false;
    const m = JSON.parse(row.json);
    m.inDiscord = !!flag;
    return this.db.prepare('UPDATE messages SET in_discord = ?, json = ? WHERE key = ? AND id = ?')
      .run(flag ? 1 : 0, JSON.stringify(m), key, String(id)).changes > 0;
  }

  markInDiscord(key, id) {
    return this.setInDiscord(key, id, true);
  }

  // WE MAY ONLY DROP WHAT ALSO EXISTS SOMEWHERE ELSE.
  //
  // A line sent with the mirror off exists in this table and nowhere else in
  // the world; dropping it is deletion, and no /older can bring it back. So:
  // drop the oldest line that IS in Discord, and never one that is not.
  //
  // A record written before the field existed has in_discord = 1: back then
  // Discord was the only path a line could take, so every one of them is
  // there.
  #trim(key) {
    let n = this.q.msgCount.get(key).n;
    while (n > this.keep) {
      if (this.q.msgDropOldestMirrored.run(key).changes === 0) break;
      n--;
    }

    // NOTHING LEFT TO DROP -- and that is a fact the operator has to hear.
    // We keep them: losing a player's words silently is worse than a table
    // that grows -- and a table, unlike the old document, can grow.
    if (n > this.keep) {
      this.warned ??= new Set();
      if (!this.warned.has(key)) {
        this.warned.add(key);
        console.warn(
          `[store] ${key} holds ${n} lines and none can be dropped: ` +
          'they exist nowhere but here. Keeping them all.'
        );
      }
    }
  }

  // Shared map marks past their TTL: [{key, threadId, id}]. A mark line in
  // chat is a courier, not a vault -- the caller deletes each one in
  // Discord first and then drops it here.
  expiredMarks(cutoffMs, parseAt) {
    const out = [];
    const threads = new Map();
    for (const c of this.convosAll()) threads.set(c.key, c.threadId);
    for (const r of this.q.msgMarks.all()) {
      if (!threads.has(r.key)) continue;
      const t = parseAt(r.at);
      if (t > 0 && t < cutoffMs) out.push({ key: r.key, threadId: threads.get(r.key), id: r.id });
    }
    return out;
  }

  dropMessage(key, id) {
    return this.q.msgDel.run(key, String(id)).changes > 0;
  }

  messagesOf(key, limit) {
    if (limit) return this.q.msgTailDesc.all(key, limit).map((r) => JSON.parse(r.json)).reverse();
    return this.q.msgAllAsc.all(key).map((r) => JSON.parse(r.json));
  }

  // Everything newer than `cursor` that `steamId` is allowed to see.
  since(steamId, cursor) {
    const allowed = new Set(this.convosOf(steamId).map((c) => c.key));
    const out = [];
    for (const r of this.q.msgSince.all(Number(cursor) || 0)) {
      if (!allowed.has(r.key)) continue;
      out.push({ key: r.key, ...JSON.parse(r.json) });
    }
    return out;
  }

  get cursor() {
    return Number(this.#meta('cursor')) || 0;
  }

  // Nothing remembered yet: what a fresh database looks like, and what an
  // unmigrated one looks like too -- index.js tells them apart by whether
  // the old document is still lying beside it.
  isEmpty() {
    const n = (sql) => this.db.prepare(sql).get().n;
    return n('SELECT COUNT(*) AS n FROM links') === 0
      && n('SELECT COUNT(*) AS n FROM convos') === 0
      && n('SELECT COUNT(*) AS n FROM messages') === 0
      && n('SELECT COUNT(*) AS n FROM news') === 0;
  }

  // ---- migration from the JSON document (TZ-2 R6.2) ----
  //
  // Raw inserts, one transaction, existing rows left alone: run twice, the
  // second run reports zeros and changes nothing. Cursors are kept as they
  // were, because the game holds the last one it saw and asks for "newer".
  importJson(data) {
    const rep = { links: 0, names: 0, convos: 0, invites: 0, news: 0, messages: 0, guild: 0, skipped: 0, cursor: 0 };
    const ins = {
      link: this.db.prepare('INSERT OR IGNORE INTO links(steam_id, discord_id, discord_name, linked_at) VALUES (?, ?, ?, ?)'),
      name: this.db.prepare('INSERT OR IGNORE INTO names(steam_id, name) VALUES (?, ?)'),
      convo: this.db.prepare('INSERT OR IGNORE INTO convos(key, json) VALUES (?, ?)'),
      inv: this.db.prepare('INSERT OR IGNORE INTO invites(key, uid, from_uid, at) VALUES (?, ?, ?, ?)'),
      news: this.db.prepare('INSERT OR IGNORE INTO news(id, ts, json) VALUES (?, ?, ?)'),
      msg: this.db.prepare('INSERT OR IGNORE INTO messages(cursor, key, id, at, text, in_discord, json) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      guild: this.db.prepare('INSERT OR IGNORE INTO guild(key, id) VALUES (?, ?)'),
    };
    const count = (r, field) => { if (r.changes > 0) rep[field]++; else rep.skipped++; };

    this.#tx(() => {
      for (const [sid, l] of Object.entries(data.links || {}))
        count(ins.link.run(sid, String(l.discordId || ''), String(l.discordName || ''), String(l.linkedAt || '')), 'links');
      for (const [sid, name] of Object.entries(data.names || {}))
        count(ins.name.run(sid, String(name)), 'names');
      for (const [key, c] of Object.entries(data.convos || {}))
        count(ins.convo.run(key, JSON.stringify(c)), 'convos');
      for (const [key, m] of Object.entries(data.invites || {}))
        for (const [uid, inv] of Object.entries(m || {}))
          count(ins.inv.run(key, uid, String(inv.from || ''), String(inv.at || '')), 'invites');
      for (const [id, p] of Object.entries(data.news || {}))
        count(ins.news.run(String(id), Number(p.ts) || 0, JSON.stringify(p)), 'news');
      for (const [key, id] of Object.entries(data.guild || {}))
        count(ins.guild.run(key, String(id)), 'guild');

      // Lines without a cursor (there should be none) get fresh ones after
      // the highest known, so the counter stays monotonic.
      let top = Number(data.cursor) || 0;
      const late = [];
      for (const [key, list] of Object.entries(data.messages || {})) {
        for (const m of list || []) {
          if (typeof m.cursor === 'number' && m.cursor > 0) {
            count(ins.msg.run(m.cursor, key, String(m.id), String(m.at ?? ''), typeof m.text === 'string' ? m.text : '',
              m.inDiscord === false ? 0 : 1, JSON.stringify(m)), 'messages');
            if (m.cursor > top) top = m.cursor;
          } else {
            late.push([key, m]);
          }
        }
      }
      for (const [key, m] of late) {
        top++;
        const stored = { ...m, cursor: top };
        count(ins.msg.run(top, key, String(m.id), String(m.at ?? ''), typeof m.text === 'string' ? m.text : '',
          m.inDiscord === false ? 0 : 1, JSON.stringify(stored)), 'messages');
      }

      const have = Number(this.#meta('cursor')) || 0;
      if (top > have) this.#setMeta('cursor', top);
      rep.cursor = Math.max(top, have);
    });

    return rep;
  }
}

function rowFaction(r) {
  return { slug: r.slug, label: r.label, color: r.color, base: !!r.base, limit: r.limit_n, roleId: r.role_id, missing: !!r.missing, ord: r.ord };
}

function rowMember(r) {
  let posts = [];
  let traits = [];
  try { posts = JSON.parse(r.posts || '[]'); } catch { posts = []; }
  try { traits = JSON.parse(r.traits || '[]'); } catch { traits = []; }
  return { steamId: r.steam_id, org: r.org, frank: r.frank, rank: r.rank, posts, traits, updatedAt: r.updated_at };
}
