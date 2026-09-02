// The roles home: what factions, posts, ranks and traits exist, and who
// holds what. Rows in the bot's SQLite (TZ-2 section 15, owner 2026-09-02).
//
// THREE AXES, not one list, because they fail differently:
//
//   RANK     one per player, ordered. The stalker's personal standing.
//   FACTION  one per player, plus POSTS and a FACTION RANK inside it.
//   TRAIT    any number. A mechanic is a mechanic whatever else he is.
//
// The slug is the join key with the game and the only string both sides must
// know character for character. The LABEL is what a Discord role is named
// and what the game draws, and it is Ukrainian, because that is what members
// read. The slug never appears in Discord at all.
//
// DISCORD IS A MIRROR OF THESE ROWS, never the other way round. Until
// 2026-09-02 membership WAS the Discord role: the game asked the bot, the
// bot read the guild, and a player without a Discord link could not be in a
// faction at all. Now every read comes from here, every write lands here
// first, and roles-mirror.js pushes the result into the guild when the roles
// mirror is on. A manual role edit in Discord is reverted by that mirror,
// not honoured. Discord role ids still live on the catalog rows: the mirror
// follows ids, never names, because Discord permits duplicate role names and
// gives no error for them.

import { readFileSync } from 'node:fs';

// Colours as plain integers. discord.js 14.27 deprecated `color` in favour of
// `colors: { primaryColor }`, and passing the old key emits a process warning.
const C = {
  ecolog: 0xe6c85a,
  duty: 0xc44028,
  freedom: 0x60b048,
  mercenary: 0x5082be,
  neutral: 0xc8c8c8,
  stalker: 0xd8c070,
  bandit: 0x967846,
  clearsky: 0x78bec8,
  monolith: 0xaa96dc,
  military: 0x6e825a,
  rank: 0x9aa0a6,
  trait: 0x7f8c8d,
};

// What a guild starts with. Seeded ONCE into the tables; after that the
// tables are the truth and these are only consulted for entries that ship
// in a later version (add-only, see bootstrap()).
export const DEFAULTS = {
  Version: 1,

  // Ordered low to high. Order is EXPLICIT and lives here -- never Discord's
  // role position, which guild admins drag around in the UI for display and
  // would silently reorder the ranks.
  //
  // These are STALKER ranks: personal standing in the Zone, a separate axis
  // from faction (owner's decision 2026-08-30). Joining Duty does not erase
  // being a legend -- the rank stays through every faction change, like the
  // base stalker identity itself.
  Ranks: [
    { Slug: 'stalker-novice', Label: 'Сталкер-новачок', Order: 1, Color: C.rank },
    { Slug: 'stalker-experienced', Label: 'Досвідчений сталкер', Order: 2, Color: C.rank },
    { Slug: 'stalker-legend', Label: 'Легендарний сталкер', Order: 3, Color: C.rank },
  ],

  // Posts are scoped to their faction: `leader` is reserved and means the
  // same thing everywhere, the rest are the faction's own vocabulary.
  Factions: [
    { Slug: 'ecolog', Label: 'Вчені', Color: C.ecolog,
      Posts: [
        { Slug: 'leader', Label: 'Лідер вчених' },
        { Slug: 'professor', Label: 'Професор вчених' },
        { Slug: 'guard', Label: 'Охорона вчених' },
      ] },
    // EXCEPTION, and a deliberate one: every other label here is Ukrainian,
    // but Duty ships under its original name because that is what players
    // recognise. Recorded in CLAUDE.md so it does not read as an oversight.
    { Slug: 'duty', Label: 'Долг', Color: C.duty,
      Posts: [{ Slug: 'leader', Label: 'Лідер Долга' }] },
    { Slug: 'freedom', Label: 'Воля', Color: C.freedom,
      Posts: [{ Slug: 'leader', Label: 'Лідер Волі' }] },
    { Slug: 'mercenary', Label: 'Найманці', Color: C.mercenary,
      Posts: [{ Slug: 'leader', Label: 'Лідер найманців' }] },
    { Slug: 'neutral', Label: 'Нейтрали', Color: C.neutral,
      Posts: [{ Slug: 'leader', Label: 'Лідер нейтралів' }] },
    // THE BASE IDENTITY, not one faction among many (owner's decision
    // 2026-08-30). Everyone in the Zone is a stalker: it is worn by every
    // character the bot knows, STAYS ON through every faction change, and
    // joining Duty means being a stalker IN Duty, not instead of it. It has
    // no leader (a crowd, not an organisation) and cannot be deleted. The
    // FLAG is what the code reads, never the slug.
    { Slug: 'loner', Label: 'Сталкери', Color: C.stalker, Posts: [], Base: true },
    { Slug: 'bandit', Label: 'Бандити', Color: C.bandit,
      Posts: [{ Slug: 'leader', Label: 'Лідер бандитів' }] },
    { Slug: 'clearsky', Label: 'Чисте небо', Color: C.clearsky,
      Posts: [{ Slug: 'leader', Label: 'Лідер Чистого неба' }] },
    { Slug: 'monolith', Label: 'Моноліт', Color: C.monolith,
      Posts: [{ Slug: 'leader', Label: 'Лідер Моноліту' }] },
    { Slug: 'military', Label: 'Військові', Color: C.military,
      Posts: [{ Slug: 'leader', Label: 'Лідер військових' }] },
  ],

  Traits: [
    { Slug: 'mechanic', Label: 'Механік', Color: C.trait },
    { Slug: 'medic',    Label: 'Медик',   Color: C.trait },
  ],
};

const SLUG = /^[a-z][a-z0-9_-]{1,23}$/;

// Where every life in the Zone starts. Looked up by slug because the rank
// ladder is the admin's to rename, and the lowest rung is whichever carries
// this slug; when nobody does, a new character simply has no rank.
const NOVICE = 'stalker-novice';

const STAMP = 'roles_stamp';
const IMPORTED = 'roles_imported_at';

export class Roles {
  constructor(store) {
    this.store = store;
    this.cache = null;
  }

  // ---- bootstrap ---------------------------------------------------------

  // Fill empty tables and adopt what a newer version ships.
  //
  // FIRST START takes the old JSON registry when there is one: that file
  // carried the guild's Discord role ids and the admin's renames, and both
  // survive the move. Without a file, the defaults. Either way the tables
  // are the home from this moment and the file is never read again.
  //
  // ADD ONLY after that. Never remove an entry the tables have and the
  // defaults do not: that is the admin's own faction, and a bot update is
  // not the moment to delete it. Never overwrite a label or a colour
  // either -- he is allowed to rename things.
  bootstrap(jsonPath = '') {
    let source = 'db';
    const grew = [];

    if (this.store.factionCount() === 0) {
      let raw = null;
      if (jsonPath) {
        try {
          raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
        } catch {
          // No file, or unreadable: the defaults it is.
        }
      }
      if (raw && raw.Version && Array.isArray(raw.Factions)) {
        this.#seed(raw);
        source = 'roles.json';
      } else {
        this.#seed(DEFAULTS);
        source = 'defaults';
      }
    }

    this.store.tx(() => {
      const cat = this.#catalog();
      for (const r of DEFAULTS.Ranks) {
        if (cat.ranks.some((x) => x.slug === r.Slug)) continue;
        this.store.rankSet({ slug: r.Slug, label: r.Label, ord: r.Order });
        grew.push(r.Slug);
      }
      for (const t of DEFAULTS.Traits) {
        if (cat.traits.some((x) => x.slug === t.Slug)) continue;
        this.store.traitSet({ slug: t.Slug, label: t.Label });
        grew.push(t.Slug);
      }
      for (const f of DEFAULTS.Factions) {
        const had = cat.bySlug.get(f.Slug);
        if (!had) {
          this.store.factionSet({ slug: f.Slug, label: f.Label, color: f.Color, base: !!f.Base, limit: 0 });
          for (const p of f.Posts || []) this.store.postSet({ faction: f.Slug, slug: p.Slug, label: p.Label });
          grew.push(f.Slug);
          continue;
        }
        for (const p of f.Posts || []) {
          if (had.posts.some((x) => x.slug === p.Slug)) continue;
          this.store.postSet({ faction: f.Slug, slug: p.Slug, label: p.Label });
          grew.push(f.Slug + ':' + p.Slug);
        }
        // Base is STRUCTURE, not decoration: the code special-cases it in
        // half a dozen places, so the flag follows the defaults even when
        // the label and colour stay the admin's.
        if (f.Base && !had.base) {
          this.store.factionSet({ ...had, base: true });
          grew.push(f.Slug + ':base');
        }
      }
    });

    if (grew.length) this.#bump();
    else this.cache = null;

    return { source, grew };
  }

  #seed(raw) {
    this.store.tx(() => {
      let ord = 0;
      for (const f of raw.Factions || []) {
        ord++;
        this.store.factionSet({
          slug: f.Slug,
          label: f.Label || f.Slug,
          color: f.Color || C.neutral,
          base: !!f.Base,
          limit: f.Limit || 0,
          roleId: f.RoleId || '',
          missing: !!f.Missing,
          ord,
        });
        for (const p of f.Posts || []) {
          this.store.postSet({ faction: f.Slug, slug: p.Slug, label: p.Label || p.Slug, roleId: p.RoleId || '', missing: !!p.Missing });
        }
        for (const q of f.Ranks || []) {
          this.store.frankSet({ faction: f.Slug, slug: q.Slug, label: q.Label || q.Slug, ord: q.Order || 0, roleId: q.RoleId || '', missing: !!q.Missing });
        }
      }
      for (const r of raw.Ranks || []) {
        this.store.rankSet({ slug: r.Slug, label: r.Label || r.Slug, ord: r.Order || 0, roleId: r.RoleId || '', missing: !!r.Missing });
      }
      for (const t of raw.Traits || []) {
        this.store.traitSet({ slug: t.Slug, label: t.Label || t.Slug, roleId: t.RoleId || '', missing: !!t.Missing });
      }
      // The stamp carries on from the file, so a game server that saw the
      // last JSON roster is told about this one too.
      const was = Number(raw.Stamp) || 0;
      this.store.metaSet(STAMP, String(was + 1));
    });
    this.cache = null;
  }

  // ---- the catalog -------------------------------------------------------

  // Every catalog row, shaped for reading, rebuilt whenever anything here
  // wrote. All writers are methods of this class, so a cache keyed on
  // nothing but "did I write" is honest.
  #catalog() {
    if (this.cache) return this.cache;

    const factions = this.store.factionsAll().map((f) => ({ ...f, posts: [], ranks: [] }));
    const bySlug = new Map(factions.map((f) => [f.slug, f]));
    for (const p of this.store.postsAll()) {
      const f = bySlug.get(p.faction);
      if (f) f.posts.push(p);
    }
    for (const q of this.store.franksAll()) {
      const f = bySlug.get(q.faction);
      if (f) f.ranks.push(q);
    }
    for (const f of factions) f.ranks.sort((a, b) => a.ord - b.ord);

    this.cache = {
      factions,
      bySlug,
      ranks: this.store.ranksAll(),
      traits: this.store.traitsAll(),
      base: factions.find((f) => f.base) || null,
    };
    return this.cache;
  }

  // Changes whenever the roster the GAME cares about does, so the game can
  // be told once instead of every poll. A counter rather than a hash: it
  // only has to differ, and a counter cannot collide. Role ids do not bump
  // it -- the game never sees them.
  stamp() {
    return Number(this.store.metaGet(STAMP)) || 0;
  }

  #bump() {
    this.store.metaSet(STAMP, String(this.stamp() + 1));
    this.cache = null;
  }

  // THE BASE FACTION: the one everybody in the Zone wears. Asked by slug
  // nowhere -- the flag is the fact.
  base() {
    return this.#catalog().base;
  }

  isBase(slug) {
    const f = this.#catalog().bySlug.get(slug);
    return !!(f && f.base);
  }

  factions() {
    return this.#catalog().factions;
  }

  ranks() {
    return this.#catalog().ranks;
  }

  traits() {
    return this.#catalog().traits;
  }

  // Every entry that may have a Discord role, flattened. Posts and faction
  // ranks carry the faction they belong to so a sync failure can name it.
  *entries() {
    const cat = this.#catalog();
    for (const r of cat.ranks) yield { kind: 'rank', slug: r.slug, label: r.label, color: C.rank, roleId: r.roleId, missing: r.missing, node: r };
    for (const f of cat.factions) {
      yield { kind: 'faction', slug: f.slug, label: f.label, color: f.color, roleId: f.roleId, missing: f.missing, limit: f.limit, base: f.base, node: f };
      for (const p of f.posts) {
        yield { kind: 'post', slug: f.slug + ':' + p.slug, label: p.label, color: f.color, roleId: p.roleId, missing: p.missing, faction: f.slug, node: p };
      }
      for (const q of f.ranks) {
        yield { kind: 'facrank', slug: f.slug + ':' + q.slug, label: q.label, color: f.color, roleId: q.roleId, missing: q.missing, faction: f.slug, node: q };
      }
    }
    for (const t of cat.traits) yield { kind: 'trait', slug: t.slug, label: t.label, color: C.trait, roleId: t.roleId, missing: t.missing, node: t };
  }

  // One entry by slug. Posts and faction ranks are addressed "faction:x"
  // because their slug is only unique inside the faction -- every faction
  // has a "leader".
  find(slug) {
    if (!slug) return null;
    const cat = this.#catalog();

    const cut = slug.indexOf(':');
    if (cut !== -1) {
      const f = cat.bySlug.get(slug.slice(0, cut));
      if (!f) return null;
      const sub = slug.slice(cut + 1);
      const p = f.posts.find((x) => x.slug === sub);
      if (p) return { kind: 'post', node: p, faction: f };
      const q = f.ranks.find((x) => x.slug === sub);
      if (q) return { kind: 'facrank', node: q, faction: f };
      return null;
    }

    const r = cat.ranks.find((x) => x.slug === slug);
    if (r) return { kind: 'rank', node: r };
    const f2 = cat.bySlug.get(slug);
    if (f2) return { kind: 'faction', node: f2 };
    const t = cat.traits.find((x) => x.slug === slug);
    if (t) return { kind: 'trait', node: t };
    return null;
  }

  // Entries with no Discord role yet. The mirror asks before touching the
  // guild, so a bot restart with nothing new does nothing.
  pending() {
    let n = 0;
    for (const e of this.entries()) if (!e.roleId) n++;
    return n;
  }

  // The mirror writes the ids it created or adopted. Not a stamp bump: the
  // game never sees role ids.
  setRoleId(slug, roleId, missing = false) {
    const e = this.find(slug);
    if (!e) return false;
    const node = { ...e.node, roleId: roleId || '', missing: !!missing };
    if (e.kind === 'rank') this.store.rankSet(node);
    else if (e.kind === 'trait') this.store.traitSet(node);
    else if (e.kind === 'faction') this.store.factionSet(node);
    else if (e.kind === 'post') this.store.postSet(node);
    else if (e.kind === 'facrank') this.store.frankSet(node);
    this.cache = null;
    return true;
  }

  // ---- catalog editing ---------------------------------------------------
  //
  // Two doors, one home (R7.7, R7.8): the bot's slash commands and the VPP
  // FACTIONS pane both land here. Each returns { ok, why } plus what the
  // mirror needs to follow: `touched` (uids whose projection changed) and
  // `dropRoleIds` (Discord roles that no longer have a catalog row).

  // Create a faction, or change an existing one's label, limit and whether
  // it has a leader. Nothing here can make or unmake the base.
  upsertFaction({ slug, label, color, limit, hasLeader }) {
    slug = String(slug || '').trim().toLowerCase();
    if (!SLUG.test(slug)) return { ok: false, why: 'slug must be a short lowercase word' };
    if (slug.indexOf(':') !== -1) return { ok: false, why: 'slug must be a short lowercase word' };

    const name = String(label || '').trim();
    if (name.length > 100) return { ok: false, why: 'Discord caps role names at 100 characters.' };

    const cat = this.#catalog();
    const had = cat.bySlug.get(slug);
    const touched = new Set();
    const dropRoleIds = [];
    let created = false;

    this.store.tx(() => {
      if (!had) {
        created = true;
        this.store.factionSet({
          slug,
          label: name || slug,
          color: Number(color) || C.neutral,
          base: false,
          limit: limit === undefined || limit === null ? 0 : Math.max(0, Math.floor(Number(limit) || 0)),
        });
        if (hasLeader) this.store.postSet({ faction: slug, slug: 'leader', label: 'Лідер: ' + (name || slug) });
        this.store.goneForget(slug);
        return;
      }

      const next = { ...had };
      if (name) next.label = name;
      if (color !== undefined && color !== null && Number(color) > 0) next.color = Number(color);
      if (limit !== undefined && limit !== null) next.limit = Math.max(0, Math.floor(Number(limit) || 0));
      this.store.factionSet(next);

      if (hasLeader !== undefined && hasLeader !== null && !had.base) {
        const post = had.posts.find((p) => p.slug === 'leader');
        if (hasLeader && !post) {
          this.store.postSet({ faction: slug, slug: 'leader', label: 'Лідер: ' + next.label });
        }
        if (!hasLeader && post) {
          // The post goes, so does everybody's hold on it.
          for (const m of this.store.membersOf(slug)) {
            if (!m.posts.includes('leader')) continue;
            m.posts = m.posts.filter((p) => p !== 'leader');
            this.store.memberSet(m);
            touched.add(m.steamId);
          }
          if (post.roleId) dropRoleIds.push(post.roleId);
          this.store.postDel(slug, 'leader');
        }
      }
    });

    this.#bump();
    if (created) console.log(`[roles] faction created: ${slug} (${name || slug})`);
    else console.log(`[roles] faction changed: ${slug}`);
    return { ok: true, why: '', created, slug, touched: [...touched], dropRoleIds };
  }

  // Removal takes the members with it: they fall back to plain stalkers,
  // and the game is told by name so its own file forgets the faction too
  // (R7.9). The base identity is not removable: deleting it would strip
  // "being a stalker" off everyone at once, and nothing in the model
  // survives that.
  removeFaction(slug) {
    slug = String(slug || '').trim().toLowerCase();
    const f = this.#catalog().bySlug.get(slug);
    if (!f) return { ok: false, why: 'no such faction' };
    if (f.base) return { ok: false, why: 'that is the base identity, it cannot be removed' };

    const touched = new Set();
    const dropRoleIds = [f.roleId, ...f.posts.map((p) => p.roleId), ...f.ranks.map((q) => q.roleId)].filter(Boolean);

    this.store.tx(() => {
      for (const m of this.store.membersOf(slug)) {
        m.org = '';
        m.frank = '';
        m.posts = [];
        this.store.memberSet(m);
        touched.add(m.steamId);
      }
      this.store.factionDel(slug);
      this.store.goneAdd(slug, this.stamp() + 1);
    });

    this.#bump();
    console.log(`[roles] faction removed: ${slug} (${touched.size} member(s) back to stalkers)`);
    return { ok: true, why: '', slug, label: f.label, touched: [...touched], dropRoleIds };
  }

  // A faction-scoped rank. Order is explicit and higher outranks lower --
  // succession reads it. The slug shares the faction's namespace with
  // posts, and 'leader' is reserved.
  addFactionRank(facSlug, slug, label, order) {
    const f = this.#catalog().bySlug.get(String(facSlug || '').toLowerCase());
    if (!f) return { ok: false, why: `no such faction: ${facSlug}` };
    // Stalkers rank by the GLOBAL stalker ranks -- that axis already
    // exists, and a second ladder inside the base identity would be the
    // same fact in two homes.
    if (f.base) return { ok: false, why: 'the base faction uses the stalker ranks, not faction ranks' };

    slug = String(slug || '').trim().toLowerCase();
    if (!SLUG.test(slug)) return { ok: false, why: 'slug must be a short lowercase word' };
    const taken = slug === 'leader' || f.posts.some((p) => p.slug === slug) || f.ranks.some((q) => q.slug === slug);
    if (taken) return { ok: false, why: 'that slug is already taken inside this faction' };

    const n = Math.floor(Number(order));
    if (!(n > 0)) return { ok: false, why: 'order must be a positive number - higher outranks lower' };

    this.store.frankSet({ faction: f.slug, slug, label: String(label || '').trim() || slug, ord: n });
    this.#bump();
    return { ok: true, why: '', touched: [], dropRoleIds: [] };
  }

  delFactionRank(facSlug, slug) {
    const f = this.#catalog().bySlug.get(String(facSlug || '').toLowerCase());
    if (!f) return { ok: false, why: `no such faction: ${facSlug}` };
    slug = String(slug || '').trim().toLowerCase();
    const q = f.ranks.find((x) => x.slug === slug);
    if (!q) return { ok: false, why: 'no such rank in that faction' };

    const touched = new Set();
    this.store.tx(() => {
      for (const m of this.store.membersOf(f.slug)) {
        if (m.frank !== slug) continue;
        m.frank = '';
        this.store.memberSet(m);
        touched.add(m.steamId);
      }
      this.store.frankDel(f.slug, slug);
    });
    this.#bump();
    return { ok: true, why: '', touched: [...touched], dropRoleIds: q.roleId ? [q.roleId] : [] };
  }

  // How many people a faction takes. 0 -- no limit. The bot's count is the
  // ONLY ceiling (TZ-4 R-C3.2): it is the one place that knows everybody,
  // offline members included.
  limitOf(slug) {
    const f = this.#catalog().bySlug.get(slug);
    return (f && f.limit) || 0;
  }

  setLimit(slug, n) {
    const f = this.#catalog().bySlug.get(slug);
    if (!f) return { ok: false, why: `no such faction: ${slug}` };
    if (!(n >= 0)) return { ok: false, why: 'the limit must be zero or more' };
    this.store.factionSet({ ...f, limit: Math.floor(n) });
    this.#bump();
    return { ok: true, limit: Math.floor(n) };
  }

  sizeOf(slug) {
    return this.store.memberCountOf(slug);
  }

  // Rename any catalog entry. The Discord role follows through the mirror.
  rename(slug, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return { ok: false, why: 'Give it a name.' };
    if (trimmed.length > 100) return { ok: false, why: 'Discord caps role names at 100 characters.' };

    const e = this.find(slug);
    if (!e) return { ok: false, why: 'No such entry. Run /openzone roles list to see the slugs.' };

    const was = e.node.label;
    const node = { ...e.node, label: trimmed };
    if (e.kind === 'rank') this.store.rankSet(node);
    else if (e.kind === 'trait') this.store.traitSet(node);
    else if (e.kind === 'faction') this.store.factionSet(node);
    else if (e.kind === 'post') this.store.postSet(node);
    else if (e.kind === 'facrank') this.store.frankSet(node);
    this.#bump();
    return { ok: true, was, now: trimmed, roleId: e.node.roleId || '' };
  }

  // ---- members -----------------------------------------------------------

  // A character the bot knows. Created the first time anyone names him --
  // a link, an assignment, a wipe -- and he starts where every life in the
  // Zone starts: a plain stalker of the lowest rank.
  ensureMember(uid) {
    uid = String(uid || '').trim();
    if (!uid) return null;
    const had = this.store.memberGet(uid);
    if (had) return had;
    const row = { steamId: uid, org: '', frank: '', rank: this.#novice(), posts: [], traits: [] };
    this.store.memberSet(row);
    return row;
  }

  #novice() {
    return this.#catalog().ranks.some((r) => r.slug === NOVICE) ? NOVICE : '';
  }

  knows(uid) {
    return !!this.store.memberGet(uid);
  }

  membersAll() {
    return this.store.membersAll();
  }

  memberCount() {
    return this.store.memberCount();
  }

  // One character on the three axes, as the game reads it, or null when
  // the bot has never heard of him. Absent means "we know nothing"; an
  // empty projection would mean "he has no faction", and the game treats
  // those two very differently.
  //
  // Everything is checked against the catalog on the way out: a faction
  // that was removed, a post that no longer exists, a rank that was
  // deleted are simply not there, whatever the row still says. Conflict
  // stays in the shape for the game's sake and is always empty -- one row,
  // one org, nothing to collide.
  viewOf(uid) {
    const m = this.store.memberGet(uid);
    if (!m) return null;
    const cat = this.#catalog();

    const org = cat.bySlug.get(m.org);
    const real = org && !org.base ? org : null;

    const posts = real ? m.posts.filter((p) => real.posts.some((x) => x.slug === p)) : [];
    let frank = '';
    if (real && real.ranks.some((q) => q.slug === m.frank)) frank = m.frank;
    let rank = '';
    if (cat.ranks.some((r) => r.slug === m.rank)) rank = m.rank;
    const traits = m.traits.filter((t) => cat.traits.some((x) => x.slug === t));

    return {
      Base: cat.base ? cat.base.slug : '',
      Org: real ? real.slug : '',
      Conflict: [],
      Posts: posts,
      Rank: rank,
      FRank: frank,
      Traits: traits,
    };
  }

  // Change one character's roles, on behalf of somebody in the game or in
  // Discord. THE ONLY WRITER of membership, and that is the whole design:
  // the game never records a faction of its own, the guild is a mirror.
  //
  // Everything lands in one transaction; a refusal means nothing changed
  // anywhere, which is what lets a refusal be reported honestly. Returns
  // { ok, why, touched } -- every uid whose projection changed, for the
  // mirror to follow. The actor's authority is NOT checked here: leaderMay
  // in index.js answers "may this person ask", this answers "can this
  // change be made".
  apply(actorUid, targetUid, op, arg = '', max = 0) {
    actorUid = String(actorUid || '').trim();
    targetUid = String(targetUid || '').trim();
    arg = String(arg || '').trim();
    if (!targetUid) return { ok: false, why: 'no target' };

    const cat = this.#catalog();
    const no = (why) => ({ ok: false, why, touched: [] });

    return this.store.tx(() => {
      const touched = new Set();
      const yes = () => ({ ok: true, why: '', touched: [...touched] });
      const t = this.ensureMember(targetUid);
      touched.add(targetUid);

      const orgOf = (row) => {
        const f = cat.bySlug.get(row.org);
        return f && !f.base ? f : null;
      };

      if (op === 'faction.set' || op === 'faction.clear') {
        const was = orgOf(t);

        // ALREADY THERE -- change nothing, and say yes: the state he asked
        // for is the state that holds. That is what makes this safe to
        // press twice, and why a leader accepting one of his own does not
        // strip himself of every post.
        if (op === 'faction.set' && was && was.slug === arg) return yes();

        // "Move him to the stalkers" is the same act as clearing: the base
        // is already everyone's.
        let joined = null;
        if (op === 'faction.set' && !this.isBase(arg)) {
          joined = cat.bySlug.get(arg);
          if (!joined) return no(`no such faction: ${arg}`);

          // THE ONLY CEILING (TZ-4 R-C3.2), counted over everybody the bot
          // knows, offline included. `max` is what the game's own file says
          // (MaxMembers) and is taken only when the catalog has no limit.
          const cap = joined.limit || max || 0;
          if (cap > 0) {
            const now = this.store.memberCountOf(joined.slug);
            if (now >= cap) return no(`${joined.label} is full (${now}/${cap})`);
          }
        }

        // Leaving a faction takes its posts and its rank with it. A "Лідер
        // Долга" badge on somebody who is no longer in Duty means nothing.
        t.org = joined ? joined.slug : '';
        t.frank = '';
        t.posts = [];
        this.store.memberSet(t);

        // Leadership follows membership: the first member of a faction
        // leads it, and when the leader leaves the post passes down.
        if (joined) this.#succession(cat, joined.slug, 'the first member leads', touched);
        if (was && (!joined || was.slug !== joined.slug)) this.#succession(cat, was.slug, 'the leader left', touched);
        return yes();
      }

      if (op === 'post.add' || op === 'post.remove') {
        const e = this.find(arg);
        if (!e || e.kind !== 'post') return no(`no such post: ${arg}`);
        const now = orgOf(t);
        if (!now || now.slug !== e.faction.slug) return no(`that player is not in ${e.faction.label}`);

        const set = new Set(t.posts);
        if (op === 'post.add') set.add(e.node.slug);
        else set.delete(e.node.slug);
        t.posts = [...set];
        this.store.memberSet(t);
        if (op === 'post.remove' && e.node.slug === 'leader') this.#succession(cat, now.slug, 'the leader stepped down', touched);
        return yes();
      }

      if (op === 'trait.add' || op === 'trait.remove') {
        const e = this.find(arg);
        if (!e || e.kind !== 'trait') return no(`no such trait: ${arg}`);
        const set = new Set(t.traits);
        if (op === 'trait.add') set.add(e.node.slug);
        else set.delete(e.node.slug);
        t.traits = [...set];
        this.store.memberSet(t);
        return yes();
      }

      if (op === 'frank.set') {
        // The FACTION rank: one per member, scoped to the faction actually
        // held. The arg is the BARE slug -- which ladder applies is decided
        // by the target's own faction, so a Duty leader cannot even name
        // Freedom's ranks.
        const now = orgOf(t);
        if (!now) return no('that player is not in a faction');
        if (arg && !now.ranks.some((q) => q.slug === arg)) return no(`no such rank in ${now.label}: ${arg}`);
        t.frank = arg;
        this.store.memberSet(t);
        return yes();
      }

      if (op === 'leader.set') {
        // The ADMIN names the leader outright. Different from
        // leader.transfer on purpose: transfer is the leader's own act and
        // requires him to hold the post; set requires nothing but a target
        // inside a faction. leaderMay() never allows it.
        const now = orgOf(t);
        if (!now) return no('that player is not in a faction');
        if (!now.posts.some((p) => p.slug === 'leader')) return no(`${now.label} has no leader post`);

        // Set, singular: the post comes OFF everyone else.
        for (const m of this.store.membersOf(now.slug)) {
          if (m.steamId === t.steamId || !m.posts.includes('leader')) continue;
          m.posts = m.posts.filter((p) => p !== 'leader');
          this.store.memberSet(m);
          touched.add(m.steamId);
        }
        if (!t.posts.includes('leader')) t.posts = [...t.posts, 'leader'];
        this.store.memberSet(t);
        return yes();
      }

      if (op === 'rank.set') {
        if (arg) {
          const e = this.find(arg);
          if (!e || e.kind !== 'rank') return no(`no such rank: ${arg}`);
        }
        t.rank = arg;
        this.store.memberSet(t);
        return yes();
      }

      if (op === 'leader.transfer') {
        if (!actorUid) return no('nobody to hand it over from');
        const a = this.store.memberGet(actorUid);
        const f = a ? orgOf(a) : null;
        if (!f) return no('you are not in a faction');
        if (!f.posts.some((p) => p.slug === 'leader')) return no(`${f.label} has no leader post`);
        if (!a.posts.includes('leader')) return no('you are not the leader');
        const theirs = orgOf(t);
        if (!theirs || theirs.slug !== f.slug) return no(`that player is not in ${f.label}`);
        if (actorUid === targetUid) return yes();

        // Given away, not shared -- and in ONE transaction, so the faction
        // is never caught with no leader or with two.
        if (!t.posts.includes('leader')) t.posts = [...t.posts, 'leader'];
        this.store.memberSet(t);
        a.posts = a.posts.filter((p) => p !== 'leader');
        this.store.memberSet(a);
        touched.add(actorUid);
        return yes();
      }

      return no(`unknown operation: ${op}`);
    });
  }

  // Leadership follows membership on its own (owner's decision 2026-08-30):
  // the first member of a faction leads it, and when the leader leaves the
  // post passes down -- by the faction's own rank first, by stalker rank
  // next, and to the longest-standing member when everything ties. The
  // base is exempt: a crowd has no leader. Does nothing when a leader is
  // already there, so it is safe after every membership change.
  ensureLeadership(slug, reason) {
    const touched = new Set();
    this.store.tx(() => this.#succession(this.#catalog(), slug, reason, touched));
    return [...touched];
  }

  #succession(cat, slug, reason, touched) {
    const f = cat.bySlug.get(slug);
    if (!f || f.base) return;
    if (!f.posts.some((p) => p.slug === 'leader')) return;

    const pool = this.store.membersOf(slug);
    if (!pool.length) return;
    if (pool.some((m) => m.posts.includes('leader'))) return;

    const frankOrd = (m) => {
      const q = f.ranks.find((x) => x.slug === m.frank);
      return q ? q.ord : 0;
    };
    const rankOrd = (m) => {
      const r = cat.ranks.find((x) => x.slug === m.rank);
      return r ? r.ord : 0;
    };
    pool.sort((a, b) => (frankOrd(b) - frankOrd(a)) || (rankOrd(b) - rankOrd(a)));

    const heir = pool[0];
    heir.posts = [...heir.posts, 'leader'];
    this.store.memberSet(heir);
    touched.add(heir.steamId);
    console.log(`[roles] ${f.label}: ${heir.steamId} now leads (${reason})`);
  }

  // Permadeath: everything off, novice back -- a new life starts from
  // zero. The faction he led gets its next leader on the same change.
  wipe(uid) {
    const m = this.store.memberGet(uid);
    if (!m) return { touched: [] };
    const cat = this.#catalog();
    const touched = new Set([uid]);
    this.store.tx(() => {
      const was = cat.bySlug.get(m.org);
      m.org = '';
      m.frank = '';
      m.posts = [];
      m.traits = [];
      m.rank = this.#novice();
      this.store.memberSet(m);
      if (was && !was.base) this.#succession(cat, was.slug, 'the leader was wiped', touched);
    });
    return { touched: [...touched] };
  }

  // ---- the one-time import -----------------------------------------------

  // Membership as the Discord roles say it, by the rules the old registry
  // projected with: highest rank wins, exactly one real faction or none,
  // posts and the faction rank only inside that faction. Used ONCE, to
  // carry the guild's current state into the tables (R7.10); after that the
  // tables are the truth and this direction is never read again.
  resolveFromRoles(has) {
    const cat = this.#catalog();
    const held = (x) => !!(x.roleId && !x.missing && has(x.roleId));

    let rank = '';
    let best = -1;
    for (const r of cat.ranks) {
      if (!held(r) || r.ord <= best) continue;
      best = r.ord;
      rank = r.slug;
    }

    const orgs = cat.factions.filter((f) => !f.base && held(f));
    const org = orgs.length === 1 ? orgs[0] : null;

    const posts = org ? org.posts.filter((p) => held(p)).map((p) => p.slug) : [];
    let frank = '';
    if (org) {
      let fbest = -1;
      for (const q of org.ranks) {
        if (!held(q) || q.ord <= fbest) continue;
        fbest = q.ord;
        frank = q.slug;
      }
    }
    const traits = cat.traits.filter((t) => held(t)).map((t) => t.slug);
    const anything = !!(rank || org || traits.length || cat.factions.some((f) => f.base && held(f)));

    return { org: org ? org.slug : '', frank, rank, posts, traits, anything, conflict: orgs.length > 1 ? orgs.map((f) => f.slug) : [] };
  }

  importedAt() {
    return this.store.metaGet(IMPORTED) || '';
  }

  markImported() {
    this.store.metaSet(IMPORTED, new Date().toISOString());
  }

  // ---- the roster for the game -------------------------------------------

  // The roster, cut into pieces small enough to survive the wire.
  //
  // ONE BIG ITEM DOES NOT ARRIVE. The game reported "Missing a closing
  // quotation mark in string" -- the item's Json field reaches it
  // TRUNCATED. Measured on the stand: 805 bytes arrives, ~1200 does not.
  // The pieces merge on their own: ApplyRoster adds and updates and never
  // deletes, so a roster in four parts is the same roster -- and removals
  // travel by name in Gone (R7.9), the one thing a merge cannot infer.
  //
  // Relations, Joinable and Hidden are NOT here on purpose (R7.2): they are
  // per-server simulation rules, and the game's own file keeps owning them.
  rosterParts() {
    const cat = this.#catalog();
    const stamp = this.stamp();

    const factions = cat.factions.map((f) => ({ Id: f.slug, DisplayName: f.label, Color: hexToRgb(f.color), Base: !!f.base }));
    const ranks = cat.ranks.map((r) => ({ Id: r.slug, DisplayName: r.label, Order: r.ord || 0 }));
    const traits = cat.traits.map((t) => ({ Id: t.slug, DisplayName: t.label }));
    const posts = cat.factions.flatMap((f) => f.posts.map((p) => ({ Id: f.slug + ':' + p.slug, DisplayName: p.label })));
    const franks = cat.factions.flatMap((f) => f.ranks.map((q) => ({ Id: f.slug + ':' + q.slug, DisplayName: q.label, Order: q.ord || 0 })));
    const gone = this.store.goneAll();

    const parts = [];
    let cur = null;

    // Well under the smallest size measured to work, because the limit was
    // measured, not documented, and a margin is cheaper than another evening.
    const BUDGET = 600;

    const flush = () => {
      if (cur) parts.push(cur);
      cur = { Stamp: stamp, Factions: [], Ranks: [], Traits: [], Posts: [], FRanks: [], Gone: [] };
    };
    flush();

    const put = (field, item) => {
      cur[field].push(item);
      if (JSON.stringify(cur).length > BUDGET) {
        cur[field].pop();
        flush();
        cur[field].push(item);
      }
    };

    for (const f of factions) put('Factions', f);
    for (const r of ranks) put('Ranks', r);
    for (const t of traits) put('Traits', t);
    for (const p of posts) put('Posts', p);
    for (const q of franks) put('FRanks', q);
    for (const g of gone) put('Gone', g);

    if (cur) parts.push(cur);

    return parts.filter(
      (x) => x.Factions.length || x.Ranks.length || x.Traits.length || x.Posts.length || x.FRanks.length || x.Gone.length,
    );
  }
}

// The game reads colours as "R G B" because a human edits that file and
// 12861480 tells nobody anything.
function hexToRgb(n) {
  const v = Number(n) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].join(' ');
}
