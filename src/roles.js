// The role roster: what roles exist, what they mean, and their Discord ids.
//
// THREE AXES, not one list, because they fail differently:
//
//   RANK     one per player, ordered. Two at once -> take the highest.
//   FACTION  one per player, plus POSTS inside it. Two at once -> REFUSE to
//            guess, because faction decides who is hostile to whom and a
//            coin-flip is wrong half the time in a way nobody can see.
//   TRAIT    any number. A mechanic is a mechanic whatever else he is.
//
// The slug is the join key with the game and the only string both sides must
// know character for character. The LABEL is what the Discord role is named,
// and it is Ukrainian, because that is what members read. The slug never
// appears in Discord at all.
//
// Roles are tracked BY ID, never by name. Discord permits duplicate role
// names and gives no error for them, so a name lookup would silently split a
// population across two roles after one double-run or one admin copying a
// role in the UI. Name matching is used exactly once, as an adoption
// heuristic on first sync, and it refuses when it matches more than one.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

export const DEFAULTS = {
  Version: 1,

  // Ordered low to high. Order is EXPLICIT and lives here -- never Discord's
  // role position, which guild admins drag around in the UI for display and
  // would silently reorder the ranks.
  //
  // These are STALKER ranks: personal standing in the Zone, a separate axis
  // from faction (owner's decision 2026-08-30). Joining Duty does not erase
  // being a legend -- the rank stays through every faction change, like the
  // base stalker identity itself. Faction-scoped ranks are a different,
  // future thing and will live inside their faction's entry.
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
    // 2026-08-30). Everyone in the Zone is a stalker: the role goes on at
    // link time, STAYS ON through every faction change, and joining Duty
    // means being a stalker IN Duty, not instead of it. It has no leader
    // (a crowd, not an organisation) and cannot be deleted. The FLAG is what
    // the code reads, never the slug: a guild is free to name its base
    // something else, and the game closes its faction screen for whichever
    // faction carries it.
    { Slug: 'stalker', Label: 'Сталкери', Color: C.stalker, Posts: [], Base: true },
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

export class Roles {
  constructor(path) {
    this.path = path;
    this.data = this.#load();

    // Something shipped in this version that this guild had never heard of.
    // Written down at once, which also bumps the stamp, which is what tells
    // the game there is a new roster to take.
    if (this.grew.length) {
      console.log(`[roles] new in this version: ${this.grew.join(', ')}`);
      this.save();
    }
  }

  #load() {
    this.grew = [];

    let raw = null;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      // No file yet, or it is unreadable. Either way we start from the
      // defaults rather than refusing to run: a bot that will not boot
      // because its roster is missing is worse than one that ships the
      // roster it was written with.
    }

    if (!raw || !raw.Version) return structuredClone(DEFAULTS);

    this.#adoptNewDefaults(raw);
    return raw;
  }

  // Defaults that shipped since this guild's file was written.
  //
  // Without this the defaults are a FIRST-RUN TEMPLATE and nothing more: the
  // file wins forever after, so a role added in an update reaches nobody who
  // already runs the bot. Found the honest way -- a trait was added, the bot
  // restarted, and nothing at all happened.
  //
  // ADD ONLY. Never remove an entry this file has and the defaults do not:
  // that is the admin's own faction, and a bot update is not the moment to
  // delete it. Never overwrite Label or Color either -- he is allowed to
  // rename things, and the whole point of following role IDs is that renaming
  // is safe.
  #adoptNewDefaults(raw) {
    const add = (list, node, what) => {
      if (list.some((x) => x.Slug === node.Slug)) return;
      list.push(structuredClone(node));
      this.grew.push(what);
    };

    raw.Ranks ||= [];
    raw.Factions ||= [];
    raw.Traits ||= [];

    for (const r of DEFAULTS.Ranks) add(raw.Ranks, r, r.Slug);
    for (const t of DEFAULTS.Traits) add(raw.Traits, t, t.Slug);

    for (const f of DEFAULTS.Factions) {
      const had = raw.Factions.find((x) => x.Slug === f.Slug);
      if (!had) {
        add(raw.Factions, f, f.Slug);
        continue;
      }
      // The faction is already here, but a post inside it may not be.
      had.Posts ||= [];
      for (const p of f.Posts || []) add(had.Posts, p, f.Slug + ':' + p.Slug);

      // Base is STRUCTURE, not decoration: it says this faction is what
      // everyone in the Zone is, and the code special-cases it in half a
      // dozen places. Label and Color stay the admin's -- this one flag
      // follows the defaults, or a guild that predates it would keep a
      // stalker faction the game treats as an organisation.
      if (f.Base && !had.Base) {
        had.Base = true;
        this.grew.push(f.Slug + ':base');
      }
    }
  }

  // THE BASE FACTION: the one everybody in the Zone wears. Asked by slug
  // nowhere -- the flag is the fact, and a guild is free to name its own
  // base something other than "stalker" without any code caring.
  base() {
    return this.data.Factions.find((f) => f.Base) || null;
  }

  isBase(slug) {
    const f = this.data.Factions.find((x) => x.Slug === slug);
    return !!(f && f.Base);
  }

  // Changes whenever the roster does, so the game can be told once
  // instead of every poll. A counter rather than a hash: it only has to
  // differ, and a counter cannot collide.
  stamp() {
    return this.data.Stamp || 0;
  }

  save() {
    this.data.Stamp = (this.data.Stamp || 0) + 1;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  // Every entry that should have a Discord role, flattened. Posts carry the
  // faction they belong to so a sync failure can name it.
  *entries() {
    for (const r of this.data.Ranks) yield { kind: 'rank', slug: r.Slug, label: r.Label, color: r.Color, node: r };
    for (const f of this.data.Factions) {
      yield { kind: 'faction', slug: f.Slug, label: f.Label, color: f.Color, node: f };
      for (const p of f.Posts || []) {
        yield { kind: 'post', slug: f.Slug + ':' + p.Slug, label: p.Label, color: f.Color, node: p, faction: f.Slug };
      }
      // Faction-scoped ranks: a FOURTH axis, separate from the global
      // stalker ranks on purpose (owner's decision 2026-08-30). Ordered,
      // one per member, and they die with faction membership.
      for (const q of f.Ranks || []) {
        yield { kind: 'facrank', slug: f.Slug + ':' + q.Slug, label: q.Label, color: f.Color, node: q, faction: f.Slug };
      }
    }
    for (const t of this.data.Traits) yield { kind: 'trait', slug: t.Slug, label: t.Label, color: t.Color, node: t };
  }

  // Create what is missing, adopt what already exists, and never touch what
  // an admin deliberately changed.
  //
  // Returns a report rather than logging: the caller is a slash command and
  // the person who ran it is waiting for an answer.
  // Хто вміє сказати, чи прив'язаний цей акаунт Discord до SteamID.
  //
  // Ставиться ззовні, як і решта: реєстр не володіє таблицею прив'язок і не
  // мусить -- вона живе в store, і тягнути її сюди означало б два доми для
  // одного факту.
  useLinks(isLinked) {
    this.isLinked = isLinked;
  }

  // Entries that have never been wired to a Discord role at all.
  //
  // Deliberately NOT the same as "has no RoleId": an entry the admin deleted
  // in Discord carries Missing, and that is a decision, not a gap. Counting
  // it here would make every restart try to resurrect it.
  pending() {
    let n = 0;
    for (const e of this.entries()) {
      if (!e.node.RoleId && !e.node.Missing) n++;
    }
    return n;
  }

  async sync(guild) {
    const made = [];
    const adopted = [];
    const kept = [];
    const failed = [];
    const ambiguous = [];

    for (const e of this.entries()) {
      // 1. We already know an id. Follow it, and only it.
      if (e.node.RoleId) {
        const known = guild.roles.cache.get(e.node.RoleId);
        if (known) {
          // An admin renaming the role in Discord WINS: the requirement is
          // that this is configurable from Discord, and renaming it back
          // would be the bot fighting the person who owns the guild.
          if (known.name !== e.node.Label) {
            e.node.Label = known.name;
          }
          kept.push(e.slug);
          continue;
        }

        // The role is gone. Do NOT recreate it: silently resurrecting a role
        // somebody deliberately deleted, with nobody in it, is worse than the
        // gap. Mark it and say so.
        e.node.Missing = true;
        failed.push(e.slug + ' (role deleted in Discord)');
        continue;
      }

      // 2. First run: adopt an existing role with the same name, but only if
      //    exactly one matches. Two matches means the guild already has the
      //    ambiguity we are trying to avoid, and picking one would hide it.
      const byName = guild.roles.cache.filter((r) => r.name === e.label);
      if (byName.size === 1) {
        e.node.RoleId = byName.first().id;
        delete e.node.Missing;
        adopted.push(e.slug);
        continue;
      }
      if (byName.size > 1) {
        ambiguous.push(e.slug + ' (' + byName.size + ' roles named "' + e.label + '")');
        continue;
      }

      // 3. Create it. No `position` is passed, deliberately: discord.js does
      //    not send position on create at all, and supplying one makes it
      //    issue a SECOND request that re-indexes every role in the guild.
      try {
        const role = await guild.roles.create({
          name: e.label,
          colors: { primaryColor: e.color },
          hoist: e.kind === 'faction',
          mentionable: false,
          reason: 'OpenZone role roster',
        });
        e.node.RoleId = role.id;
        delete e.node.Missing;
        made.push(e.slug);
      } catch (err) {
        // 50013 covers BOTH "no Manage Roles" and "that role outranks you",
        // and Discord gives no way to tell them apart from the code, so say
        // both. 30005 is the guild role cap, whose actual number Discord does
        // not publish -- catching the error is the only honest way to know.
        let why = err.message;
        if (err.code === 50013) why = 'missing permissions, or the bot role sits too low';
        if (err.code === 30005) why = 'this guild has hit its role limit';
        failed.push(e.slug + ' (' + why + ')');
      }
    }

    this.save();
    return { made, adopted, kept, failed, ambiguous };
  }

  // Rename a role FROM the bot, so configuration stays in Discord rather
  // than in Server Settings. sync() adopts a rename made by hand; this is
  // the same move driven from a command, which is what the owner asked
  // for -- configure it where you already are.
  async rename(guild, slug, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return { ok: false, why: 'Give it a name.' };
    if (trimmed.length > 100) return { ok: false, why: 'Discord caps role names at 100 characters.' };

    let hit = null;
    for (const e of this.entries()) if (e.slug === slug) { hit = e; break; }
    if (!hit) return { ok: false, why: 'No such entry. Run /openzone roles list to see the slugs.' };
    if (!hit.node.RoleId) return { ok: false, why: 'That one has no Discord role yet. Run /openzone roles sync first.' };

    const role = guild.roles.cache.get(hit.node.RoleId);
    if (!role) return { ok: false, why: 'That role no longer exists in Discord.' };

    try {
      await role.setName(trimmed, 'OpenZone roster rename');
    } catch (err) {
      // 50013 is BOTH 'no Manage Roles' and 'that role outranks you', and
      // Discord gives no way to tell them apart, so the message says both.
      let why = err.message;
      if (err.code === 50013) why = 'missing permissions, or that role sits above the bot';
      return { ok: false, why };
    }

    const was = hit.node.Label;
    hit.node.Label = trimmed;
    this.save();
    return { ok: true, was, now: trimmed };
  }

  // The roster as the game needs it: what a faction is CALLED and what
  // colour it is. Nothing about Discord crosses -- the game never needs a
  // role id, because the bot resolves roles to slugs before anything is
  // sent, and a second home for that mapping is exactly the drift this
  // push exists to remove.
  //
  // Relations, Joinable and Hidden are NOT here on purpose. They are
  // per-server simulation rules that Discord has no surface to express,
  // and the admin's own file keeps owning them. One direction of flow,
  // one join key, no drift.
  // The roster, cut into pieces small enough to survive the wire.
  //
  // ONE BIG ITEM DOES NOT ARRIVE. The game reported "Missing a closing
  // quotation mark in string" -- the item's Json field reaches it TRUNCATED,
  // not malformed at the source. Measured on the stand: 805 bytes arrives,
  // ~1200 does not, and adding the eleven post labels crossed it.
  //
  // Splitting rather than trimming, because the limit is somebody else's and
  // sitting next to it is how this breaks again the day a faction is added.
  // The pieces merge on their own: ApplyRoster adds and updates and never
  // deletes, so a roster in four parts is the same roster.
  //
  // Every piece carries the same Stamp -- it is one roster, and the game
  // tracks having seen that stamp, not having seen N items.
  // A new faction, born HERE: the bot owns Discord roles, so the entry is
  // appended to the registry and sync() then creates the roles. The game
  // config follows separately on the game server.
  async addFaction(guild, slug, label, color, hasLeader) {
    if (!/^[a-z][a-z0-9_-]{1,23}$/.test(slug)) {
      return { ok: false, why: 'slug must be a short lowercase word' };
    }
    if (this.data.Factions.some((f) => f.Slug === slug)) {
      return { ok: false, why: 'this faction already exists' };
    }

    const node = {
      Slug: slug,
      Label: label || slug,
      Color: color || 0xc8c8c8,
      Posts: hasLeader ? [{ Slug: 'leader', Label: 'Лідер: ' + (label || slug) }] : [],
    };
    this.data.Factions.push(node);
    this.save();

    await guild.roles.fetch();
    const r = await this.sync(guild);
    if (r.failed.length) return { ok: false, why: 'Discord refused to create the role' };
    return { ok: true };
  }

  // A faction-scoped rank, born from the bot like everything else. Order is
  // explicit and higher outranks lower -- succession reads it. The slug
  // shares the faction's namespace with posts, and 'leader' is reserved.
  async addFactionRank(guild, facSlug, slug, label, order) {
    const f = this.data.Factions.find((x) => x.Slug === facSlug);
    if (!f) return { ok: false, why: `no such faction: ${facSlug}` };

    // Stalkers rank by the GLOBAL stalker ranks -- that axis already
    // exists, and a second ladder inside the base identity would be the
    // same fact in two homes.
    if (f.Base) return { ok: false, why: 'the base faction uses the stalker ranks, not faction ranks' };

    if (!/^[a-z][a-z0-9_-]{1,23}$/.test(slug)) {
      return { ok: false, why: 'slug must be a short lowercase word' };
    }

    f.Ranks ||= [];
    const taken = slug === 'leader'
      || (f.Posts || []).some((p) => p.Slug === slug)
      || f.Ranks.some((r) => r.Slug === slug);
    if (taken) return { ok: false, why: 'that slug is already taken inside this faction' };

    const n = Math.floor(Number(order));
    if (!(n > 0)) return { ok: false, why: 'order must be a positive number - higher outranks lower' };

    f.Ranks.push({ Slug: slug, Label: label || slug, Order: n });
    f.Ranks.sort((a, b) => a.Order - b.Order);
    this.save();

    await guild.roles.fetch();
    const r = await this.sync(guild);
    if (r.failed.length) return { ok: false, why: 'Discord refused to create the role' };
    return { ok: true };
  }

  async delFactionRank(guild, facSlug, slug) {
    const f = this.data.Factions.find((x) => x.Slug === facSlug);
    if (!f) return { ok: false, why: `no such faction: ${facSlug}` };

    const at = (f.Ranks || []).findIndex((r) => r.Slug === slug);
    if (at === -1) return { ok: false, why: 'no such rank in that faction' };

    const node = f.Ranks[at];
    if (node.RoleId) {
      try {
        await guild.roles.delete(node.RoleId, 'OpenZone: faction rank removed');
      } catch {
        // Already gone, or not ours to delete -- the registry entry goes
        // either way; a stray role is visible and fixable by hand.
      }
    }

    f.Ranks.splice(at, 1);
    this.save();
    return { ok: true };
  }

  // Deletion takes the Discord roles with it: a faction the admin removed
  // must not keep marking members. Members lose the role by role deletion.
  async delFaction(guild, slug) {
    // The base identity is not removable: deleting it would strip "being a
    // stalker" off every member at once, and nothing in the model survives
    // that.
    if (this.isBase(slug)) return { ok: false, why: 'that is the base identity, it cannot be removed' };

    const at = this.data.Factions.findIndex((f) => f.Slug === slug);
    if (at === -1) return { ok: false, why: 'no such faction' };

    const node = this.data.Factions[at];
    const ids = [
      node.RoleId,
      ...(node.Posts || []).map((p) => p.RoleId),
      ...(node.Ranks || []).map((r) => r.RoleId),
    ].filter(Boolean);
    for (const id of ids) {
      try {
        await guild.roles.delete(id, 'OpenZone: faction removed');
      } catch {
        // Already gone, or not ours to delete -- the registry entry goes
        // either way; a stray role is visible and fixable by hand.
      }
    }

    this.data.Factions.splice(at, 1);
    this.save();
    return { ok: true };
  }

  rosterParts() {
    const stamp = this.stamp();

    // Base travels because the GAME has to know which faction is merely
    // everyone's identity: it is the bot that puts that badge on every
    // linked member, so it is the bot that knows. The PDA closes its
    // faction screen for a base faction -- there is no roster to show.
    const factions = this.data.Factions.map((f) => ({
      Id: f.Slug,
      DisplayName: f.Label,
      Color: hexToRgb(f.Color),
      Base: !!f.Base,
    }));

    // Ranks, traits and posts travel for the SAME reason factions do: the bot
    // owns what a role is called, because it is the bot that creates it.
    // Without them the game receives "stalker-legend" and has nothing to draw
    // but the slug -- which is how a player reads his own rank in lowercase
    // English on a Ukrainian screen.
    // Order travels with the ranks. The game knows the slugs, but which of
    // them outranks which is the registry's word -- and without it "promote"
    // cannot exist in the PDA at all.
    const ranks  = this.data.Ranks.map((r) => ({ Id: r.Slug, DisplayName: r.Label, Order: r.Order || 0 }));
    const traits = this.data.Traits.map((t) => ({ Id: t.Slug, DisplayName: t.Label }));
    const posts  = this.data.Factions.flatMap((f) =>
      (f.Posts || []).map((p) => ({ Id: f.Slug + ':' + p.Slug, DisplayName: p.Label })),
    );
    // Faction ranks travel as their own list, not inside Posts: the game
    // keeps a catalog per axis for the admin UI, and mixing the two would
    // put sergeants in the posts picker.
    const franks = this.data.Factions.flatMap((f) =>
      (f.Ranks || []).map((q) => ({ Id: f.Slug + ':' + q.Slug, DisplayName: q.Label, Order: q.Order || 0 })),
    );

    const parts = [];
    let cur = null;

    // Well under the smallest size measured to work, because the limit was
    // measured, not documented, and a margin is cheaper than another evening.
    const BUDGET = 600;

    const flush = () => {
      if (cur) parts.push(cur);
      cur = { Stamp: stamp, Factions: [], Ranks: [], Traits: [], Posts: [], FRanks: [] };
    };
    flush();

    const put = (field, item) => {
      cur[field].push(item);
      if (JSON.stringify(cur).length > BUDGET) {
        // Too big WITH this one -- take it back out, close the piece, and
        // start the next one holding it.
        cur[field].pop();
        flush();
        cur[field].push(item);
      }
    };

    for (const f of factions) put('Factions', f);
    for (const r of ranks)    put('Ranks', r);
    for (const t of traits)   put('Traits', t);
    for (const p of posts)    put('Posts', p);
    for (const q of franks)   put('FRanks', q);

    if (cur) parts.push(cur);

    return parts.filter(
      (x) => x.Factions.length || x.Ranks.length || x.Traits.length || x.Posts.length || x.FRanks.length,
    );
  }

  // Is this post held by more than one member of the guild.
  //
  // ONLY THE LEADER POST is unique. A faction may have any number of guards
  // or professors, and refusing to answer for those would break something
  // that was never broken. "leader" is already the one slug the code treats
  // specially -- IsLeader() in the game, the hand-over rule above -- so this
  // is one more place it means the same thing, not a new convention. The day
  // a second unique post is wanted, this is where it becomes a field on the
  // post instead of a slug test.
  //
  // Counted from the member cache, which is warmed at start-up and kept
  // honest by the gateway. A cold cache would under-count and quietly hand
  // authority to whoever was cached -- so an EMPTY count is treated as "we
  // cannot tell", and we leave the post alone rather than guess.
  #contested(member, faction, post) {
    if (post.Slug !== 'leader') return false;
    if (!post.RoleId) return false;

    const role = member.guild?.roles?.cache?.get(post.RoleId);
    if (!role) return false;

    const holders = role.members;
    if (!holders || holders.size === 0) return this.#settled(faction);

    // РАХУЄМО ЛИШЕ ПРИВ'ЯЗАНИХ.
    //
    // Роль на акаунті без SteamID у грі не важить нічого: гра питає про
    // ЛЮДЕЙ У ЗОНІ, тобто про SteamID, і про непривязаного не спитає ніколи
    // -- а ворота прив'язки й грати йому не дадуть. Такий держатель не
    // суперник, він просто напис у Discord.
    //
    // Без цієї перевірки будь-хто з гільдії, хто ніколи не заходив у гру,
    // одним лише фактом наявності ролі знімав би лідерство з живого лідера.
    // Знайдено питанням власника через годину після того, як правило про
    // двох лідерів було написано.
    if (!this.isLinked)
    {
      // Не знаємо, хто прив'язаний -- не забираємо нічого. Те саме рішення,
      // що й для холодного кешу: «не можу сказати» ніколи не мусить
      // означати «відбираю».
      if (!this.warnedNoLinks) {
        this.warnedNoLinks = true;
        console.warn('[roles] no link lookup wired -- the contested-leader rule is off');
      }
      return this.#settled(faction);
    }

    const linked = holders.filter((m) => this.isLinked(m.id));
    if (linked.size <= 1) return this.#settled(faction);

    this.#sayContested(faction, linked);
    return true;
  }

  // Back to one holder (or none). Forget what we warned about, so the SAME
  // pair contesting it again a week later is reported again instead of being
  // silently swallowed as "already said that".
  #settled(faction) {
    if (this.contested) this.contested.delete(faction.Slug);
    return false;
  }

  // Said ONCE per change, not once per poll. The projection is resolved
  // several times a minute for every online player, and a line each time
  // would bury the one that matters.
  #sayContested(faction, holders) {
    this.contested ||= new Map();

    const names = holders.map((m) => m.user?.tag || m.id).sort();
    const key = names.join(',');

    if (this.contested.get(faction.Slug) === key) return;
    this.contested.set(faction.Slug, key);

    console.warn(
      `[roles] ${faction.Label}: ${holders.size} members hold the leader role ` +
        `(${names.join(', ')}) - nobody leads it until one of them gives it up`,
    );
  }

  // Скільки людей пускати у фракцію. 0 -- без обмеження.
  //
  // Живе В РЕЄСТРІ, у бота, поруч із назвою й кольором: саме бот роздає ролі
  // й саме він єдиний бачить УСІХ членів. Гра бачить лише тих, хто зараз у
  // Зоні, і порахувати фракцію не може навіть теоретично.
  limitOf(slug) {
    const f = this.data.Factions.find((x) => x.Slug === slug);
    return (f && f.Limit) || 0;
  }

  setLimit(slug, n) {
    const f = this.data.Factions.find((x) => x.Slug === slug);
    if (!f) return { ok: false, why: `no such faction: ${slug}` };
    if (!(n >= 0)) return { ok: false, why: 'the limit must be zero or more' };

    f.Limit = Math.floor(n);
    this.save();
    return { ok: true, limit: f.Limit };
  }

  // Скільки зараз у фракції.
  //
  // Рахуємо ВСІХ держателів ролі, а не лише прив'язаних -- на відміну від
  // правила про двох лідерів, і різниця тут змістовна. Лідерство -- це право
  // ДІЯТИ в грі, і хто в гру не заходив, діяти не може. А склад фракції -- це
  // склад: людина в Долзі числиться в Долзі, навіть якщо ще не прив'язала
  // акаунт. Інакше набір обходився б у два кроки: видати роль, поки він
  // непривязаний, і ліміт нічого не помітить.
  sizeOf(guild, slug) {
    const f = this.data.Factions.find((x) => x.Slug === slug);
    if (!f || !f.RoleId) return 0;

    const role = guild && guild.roles && guild.roles.cache ? guild.roles.cache.get(f.RoleId) : null;
    if (!role || !role.members) return 0;

    return role.members.size;
  }

  // One entry by slug. Posts are addressed "faction:post" because a post slug
  // is only unique inside its faction -- every faction has a "leader".
  find(slug) {
    if (!slug) return null;

    const cut = slug.indexOf(':');
    if (cut !== -1) {
      const f = this.data.Factions.find((x) => x.Slug === slug.slice(0, cut));
      if (!f) return null;
      const sub = slug.slice(cut + 1);
      // Posts and faction ranks share the faction's namespace -- creation
      // refuses a duplicate slug, so at most one of these matches.
      const p = (f.Posts || []).find((x) => x.Slug === sub);
      if (p) return { kind: 'post', node: p, faction: f };
      const q = (f.Ranks || []).find((x) => x.Slug === sub);
      if (q) return { kind: 'facrank', node: q, faction: f };
      return null;
    }

    const r = this.data.Ranks.find((x) => x.Slug === slug);
    if (r) return { kind: 'rank', node: r };

    const f2 = this.data.Factions.find((x) => x.Slug === slug);
    if (f2) return { kind: 'faction', node: f2 };

    const t = this.data.Traits.find((x) => x.Slug === slug);
    if (t) return { kind: 'trait', node: t };

    return null;
  }

  // Change a member's roles in DISCORD, on behalf of somebody in the game.
  //
  // This is the ONLY writer, and that is the whole design. The game never
  // records a faction of its own: it asks here, this changes the Discord
  // role, and the change comes back to the game as an ordinary projection on
  // the next poll. One home for the fact, one direction of travel, and a
  // refusal here means nothing changed anywhere -- which is exactly why a
  // refusal can be reported honestly instead of papered over.
  //
  // The actor's authority is checked HERE TOO, not only in the game. The game
  // is trusted (it holds the shared secret) but "trusted" and "the only thing
  // standing between a player and a role" are different jobs.
  async apply(guild, actor, target, op, arg) {
    const idOf = (e) => (e && e.node && !e.node.Missing ? e.node.RoleId : null);

    const held = (member, id) => id && member.roles.cache.has(id);

    // Which faction the member is actually in, by the same rule resolve()
    // uses: the one REAL (non-stalker) faction, or the stalker base when
    // there is no real one, or nothing when two real ones collide.
    const factionOf = (member) => {
      const real = this.data.Factions.filter((f) => !f.Base && held(member, f.RoleId));
      if (real.length === 1) return real[0];
      if (real.length > 1) return null;
      return this.data.Factions.find((f) => f.Base && held(member, f.RoleId)) || null;
    };

    const add = [];
    const remove = [];

    // Every real faction the target is leaving -- leadership there may need
    // to pass on once the roles have actually changed. A LIST, not one slug:
    // a member healing out of the two-faction corruption leaves both, and
    // factionOf() refuses to name either.
    const wasSlugs = [];

    if (op === 'faction.set' || op === 'faction.clear') {
      // FRESH member, not the cache. Two quick sets in a row read a stale
      // roles.cache, held() missed the just-added faction, the removal was
      // skipped -- and the member ended up wearing TWO faction roles, which
      // resolve() rightly refuses to project (measured 2026-08-30:
      // freedom + ecolog on one member, empty faction in the game).
      try {
        target = await guild.members.fetch({ user: target.id, force: true });
      } catch {
        return { ok: false, why: 'cannot fetch the member from Discord' };
      }

      const was = factionOf(target);

      // ALREADY THERE -- change nothing, and say yes.
      //
      // Without this the "leaving takes its posts" rule below fires on a
      // move to the faction he is already in: the role comes off, every post
      // with it, and the role goes back on. A leader double-clicking accept
      // on one of his own stripped him of every post he held, and a leader
      // who did it to himself lost his leadership without a word. Measured
      // -- Posts went from ["leader"] to [] and the next refusal blamed the
      // wrong thing.
      //
      // Yes rather than a refusal, because the state he asked for is the
      // state that holds. That is what makes this safe to press twice.
      if (op === 'faction.set' && was && was.Slug === arg) {
        return { ok: true };
      }

      // Leaving a faction takes its posts with it. A "Лідер Долга" badge on
      // somebody who is no longer in Duty is exactly the stale state the
      // resolve() rules already refuse to honour -- so do not create it.
      //
      // EVERY real faction role held comes off, not merely factionOf's
      // answer: factionOf refuses to pick when a past race left two badges
      // on one member, and the set is the natural moment that corruption
      // heals. The stalker BASE never comes off -- one faction at a time
      // means one REAL faction; being a stalker is not a membership, it is
      // what everyone in the Zone is.
      for (const f of this.data.Factions) {
        if (f.Base) continue;
        if (!held(target, f.RoleId)) continue;
        wasSlugs.push(f.Slug);
        remove.push(f.RoleId);
        for (const p of f.Posts || []) if (held(target, p.RoleId)) remove.push(p.RoleId);
        // Faction ranks die with membership, exactly like posts: a Duty
        // sergeant badge on somebody who left Duty means nothing.
        for (const q of f.Ranks || []) if (held(target, q.RoleId)) remove.push(q.RoleId);
      }

      // The base goes ON whenever it is somehow missing: set, clear, any
      // faction move re-asserts it. Cheap, and it self-heals members who
      // predate this rule.
      const base = this.base();
      if (base && base.RoleId && !base.Missing && !held(target, base.RoleId)) add.push(base.RoleId);

      // "Move him to the stalkers" is the same act as clearing: the base is
      // already everyone's, so there is nothing more to add.
      if (op === 'faction.set' && !this.isBase(arg)) {
        const e = this.find(arg);
        if (!e || e.kind !== 'faction') return { ok: false, why: `no such faction: ${arg}` };
        const id = idOf(e);
        if (!id) return { ok: false, why: `the Discord role for ${arg} is missing` };

        // ЛІМІТ. Перевіряється ТУТ, у єдиному місці, де хтось вступає у
        // фракцію з гри -- і саме тому він не заважає адмінові видати роль у
        // Discord вручну. Discord головний; ліміт керує НАБОРОМ, а не складом.
        const cap = e.node.Limit || 0;
        if (cap > 0) {
          const now = this.sizeOf(guild, e.node.Slug);
          if (now >= cap) return { ok: false, why: `${e.node.Label} is full (${now}/${cap})` };
        }

        add.push(id);
      }
    } else if (op === 'post.add' || op === 'post.remove') {
      const e = this.find(arg);
      if (!e || e.kind !== 'post') return { ok: false, why: `no such post: ${arg}` };

      // A post only means anything inside the faction it belongs to.
      const now = factionOf(target);
      if (!now || now.Slug !== e.faction.Slug) {
        return { ok: false, why: `that player is not in ${e.faction.Label}` };
      }

      const id = idOf(e);
      if (!id) return { ok: false, why: `the Discord role for ${arg} is missing` };
      (op === 'post.add' ? add : remove).push(id);
    } else if (op === 'trait.add' || op === 'trait.remove') {
      const e = this.find(arg);
      if (!e || e.kind !== 'trait') return { ok: false, why: `no such trait: ${arg}` };
      const id = idOf(e);
      if (!id) return { ok: false, why: `the Discord role for ${arg} is missing` };
      (op === 'trait.add' ? add : remove).push(id);
    } else if (op === 'frank.set') {
      // The FACTION rank: one per member, scoped to the faction actually
      // held, a separate axis from the global stalker rank. The arg is the
      // BARE slug -- which ladder applies is decided by the target's own
      // faction, so a Duty leader cannot even name Freedom's ranks.
      const now = factionOf(target);
      if (!now || now.Base) return { ok: false, why: 'that player is not in a faction' };

      for (const q of now.Ranks || []) if (held(target, q.RoleId)) remove.push(q.RoleId);

      if (arg) {
        const rk = (now.Ranks || []).find((x) => x.Slug === arg);
        if (!rk) return { ok: false, why: `no such rank in ${now.Label}: ${arg}` };
        const id = rk.Missing ? null : rk.RoleId;
        if (!id) return { ok: false, why: `the Discord role for ${now.Slug}:${arg} is missing` };
        add.push(id);
      }
    } else if (op === 'leader.set') {
      // The ADMIN names the leader outright. Different from leader.transfer
      // on purpose: transfer is the leader's own act and requires him to
      // hold the post; set is the console's act and requires nothing but a
      // target inside a faction. leaderMay() never allows it, so only the
      // admin path reaches here.
      const now = factionOf(target);
      if (!now || now.Base) return { ok: false, why: 'that player is not in a faction' };

      const post = (now.Posts || []).find((p) => p.Slug === 'leader');
      const id = post && !post.Missing ? post.RoleId : null;
      if (!id) return { ok: false, why: `${now.Label} has no leader role` };

      // Set, singular: the post comes OFF everyone else first, or the guild
      // ends up with two leaders and the contested rule blanks them both.
      const role = guild.roles.cache.get(id);
      if (role) {
        for (const m of role.members.values()) {
          if (m.id === target.id) continue;
          try {
            await m.roles.remove(id, 'OpenZone: the leader was set by an admin');
          } catch {
            // The one we could not strip stays visible in Discord; the
            // contested rule keeps the post honest until somebody fixes it.
          }
        }
      }

      add.push(id);
    } else if (op === 'rank.set') {
      // One rank at a time: every other one comes off, by the same rule
      // resolve() reads them with.
      for (const r of this.data.Ranks) if (held(target, r.RoleId)) remove.push(r.RoleId);

      if (arg) {
        const e = this.find(arg);
        if (!e || e.kind !== 'rank') return { ok: false, why: `no such rank: ${arg}` };
        const id = idOf(e);
        if (!id) return { ok: false, why: `the Discord role for ${arg} is missing` };
        add.push(id);
      }
    } else if (op === 'leader.transfer') {
      if (!actor) return { ok: false, why: 'nobody to hand it over from' };

      const f = factionOf(actor);
      if (!f) return { ok: false, why: 'you are not in a faction' };

      const post = (f.Posts || []).find((p) => p.Slug === 'leader');
      const id = post && !post.Missing ? post.RoleId : null;
      if (!id) return { ok: false, why: `${f.Label} has no leader role` };
      if (!held(actor, id)) return { ok: false, why: 'you are not the leader' };

      const theirs = factionOf(target);
      if (!theirs || theirs.Slug !== f.Slug) return { ok: false, why: `that player is not in ${f.Label}` };

      // Given away, not shared. Handing leadership over and keeping it is
      // not handing it over.
      remove.push(id);
      add.push(id);

      try {
        await actor.roles.remove(id, 'OpenZone: leadership handed over');
        await target.roles.add(id, 'OpenZone: leadership handed over');
        return { ok: true };
      } catch (e) {
        return { ok: false, why: this.#whyDiscordSaidNo(e) };
      }
    } else {
      return { ok: false, why: `unknown operation: ${op}` };
    }

    // ONE atomic PATCH with the final role set -- never remove-then-add.
    // GuildMemberRoleManager's array add() and remove() each rebuild the
    // FULL list from the member's role cache, and the second call reads
    // that cache as it was before the first one landed. Measured
    // 2026-08-30: a move from freedom to military stripped freedom and
    // its leader post, then the add() put them straight back, and the
    // member stood in two factions with two posts while the game
    // projected the conflict as "no faction at all".
    let movedRoles = null;
    try {
      const gainList = add.filter(Boolean);
      const dropSet = new Set(remove.filter(Boolean).filter((id) => !gainList.includes(id)));

      const current = [...target.roles.cache.keys()];
      const final = current.filter((id) => !dropSet.has(id));
      for (const id of gainList) if (!final.includes(id)) final.push(id);
      movedRoles = new Set(final);

      const changed = final.length !== current.length || final.some((id) => !current.includes(id));
      if (changed) await target.roles.set(final, 'OpenZone');
    } catch (e) {
      return { ok: false, why: this.#whyDiscordSaidNo(e) };
    }

    // Leadership follows membership. AFTER the role change, or the pool
    // still contains yesterday: the faction he joined may have been empty
    // (its first member leads), the ones he left may have just lost their
    // leader (the post passes down). The mover's FINAL roles travel along:
    // every cache -- ours and the gateway's -- lags the PATCH we just made,
    // and reading it back is how the first member failed to get his post
    // (measured 2026-08-30).
    if (op === 'faction.set' || op === 'faction.clear') {
      const moved = { id: target.id, roleIds: movedRoles };
      const joined = op === 'faction.set' && !this.isBase(arg) ? arg : '';
      if (joined) await this.ensureLeadership(guild, joined, 'the first member leads', moved);
      for (const ws of wasSlugs) {
        if (ws !== joined) await this.ensureLeadership(guild, ws, 'the leader left', moved);
      }
    }

    return { ok: true };
  }

  // Leadership follows membership on its own (owner's decision 2026-08-30):
  // the first member of a faction leads it, and when the leader leaves the
  // post passes down -- by the faction's own rank first, by stalker rank
  // next, and to the first member found when everything ties. The stalker
  // base is exempt: a crowd has no leader.
  //
  // Does nothing when a valid leader is already there, so it is safe to call
  // after every membership change.
  //
  // `moved` is the member whose roles the caller JUST rewrote, with the
  // authoritative final set: every cache -- ours and the gateway's -- lags
  // the PATCH for a moment, and reading it back is how the first member of
  // a faction failed to receive his post (measured 2026-08-30). His roles
  // come from the caller's own hands; everyone else's from the cache, which
  // is honest about members this operation did not touch.
  async ensureLeadership(guild, slug, reason, moved = null) {
    if (!slug || this.isBase(slug)) return;

    const f = this.data.Factions.find((x) => x.Slug === slug);
    if (!f || !f.RoleId) return;

    const post = (f.Posts || []).find((p) => p.Slug === 'leader');
    const id = post && !post.Missing ? post.RoleId : null;
    if (!id) return;

    const holdsRole = (m, roleId) => {
      if (moved && moved.roleIds && m.id === moved.id) return moved.roleIds.has(roleId);
      return m.roles.cache.has(roleId);
    };

    let members;
    try {
      members = await guild.members.fetch();
    } catch {
      members = guild.members.cache;
    }

    // Only linked members count -- the same rule as the contested-leader
    // check, for the same reason: a role on an account the game will never
    // ask about is a label, not a person in the Zone, and it must neither
    // hold authority nor inherit it.
    const linked = (m) => !this.isLinked || this.isLinked(m.id);

    const holders = members.filter((m) => holdsRole(m, id) && holdsRole(m, f.RoleId) && linked(m));
    if (holders.size >= 1) return;

    const pool = [...members.filter((m) => holdsRole(m, f.RoleId) && linked(m)).values()];
    if (!pool.length) return;

    // The faction's own rank decides first, the stalker rank breaks the
    // tie, and a full tie goes to the first in the list (owner's order).
    const frankOrd = (m) => {
      let best = 0;
      for (const q of f.Ranks || []) {
        if (q.RoleId && holdsRole(m, q.RoleId) && q.Order > best) best = q.Order;
      }
      return best;
    };
    const rankOrd = (m) => {
      let best = 0;
      for (const r of this.data.Ranks) {
        if (r.RoleId && holdsRole(m, r.RoleId) && r.Order > best) best = r.Order;
      }
      return best;
    };

    pool.sort((a, b) => (frankOrd(b) - frankOrd(a)) || (rankOrd(b) - rankOrd(a)));
    const heir = pool[0];

    try {
      // A single-role add is a direct PUT: no cache in the way.
      await heir.roles.add(id, 'OpenZone: leadership - ' + reason);
      console.log(`[roles] ${f.Label}: ${heir.user?.tag || heir.id} now leads (${reason})`);
    } catch (e) {
      console.warn(`[roles] ${f.Label}: cannot hand leadership over: ${e.message}`);
    }
  }

  // Discord's refusals, in words somebody can act on.
  #whyDiscordSaidNo(e) {
    if (e && e.code === 50013) {
      return 'the bot cannot manage that role - move the bot role above it in Server Settings';
    }
    if (e && e.code === 50001) return 'the bot cannot see that member';
    return (e && e.message) || 'Discord refused';
  }

  // What Discord says about one member, resolved onto the three axes.
  //
  // The conflict rules differ ON PURPOSE and both are stated here rather than
  // discovered later.
  resolve(member) {
    const has = (id) => id && member.roles.cache.has(id);

    // RANK: highest wins. Cannot be gamed by adding a role, and rank is
    // cosmetic -- refusing to answer would be worse than answering.
    let rank = '';
    let best = -1;
    for (const r of this.data.Ranks) {
      if (!has(r.RoleId)) continue;
      if (r.Order <= best) continue;
      best = r.Order;
      rank = r.Slug;
    }

    // FACTION: refuse to guess. Faction feeds hostility, and showing no
    // faction is the safe answer AND makes the misconfiguration visible on
    // the player's own card, so somebody fixes it.
    //
    // THE BASE IS NOT A CONFLICT. Everyone wears the stalker role, so
    // "stalker + duty" is the normal state of every Duty member, and the
    // REAL faction is the non-stalker one. Only two real factions at once
    // is the corruption this rule refuses to project.
    const held = this.data.Factions.filter((f) => has(f.RoleId));
    const real = held.filter((f) => !f.Base);
    let faction = '';
    let conflict = [];
    if (real.length === 1) faction = real[0].Slug;
    if (real.length === 0 && held.length > 0) faction = held[0].Slug;
    if (real.length > 1) conflict = real.map((f) => f.Slug);

    // Posts only count inside the faction actually held. A Duty leader badge
    // on somebody who is not in Duty means nothing.
    //
    // AND A CONTESTED LEADER POST COUNTS FOR NOBODY. Same rule as the faction
    // above, for the same reason: two people holding it is a mistake in the
    // guild, not a state of either player, and picking one of them would hide
    // the mistake behind something that looks like it works.
    //
    // It matters more here than it looks. Faction feeds hostility; the leader
    // post feeds AUTHORITY OVER PEOPLE -- two leaders can expel each other's
    // members and each hand the faction to a third party, and whoever clicks
    // first wins. The game already refuses to let a leader grant the leader
    // post ("handed over, never handed out"); assigning it twice in Discord
    // walked around that fence from the other side.
    const posts = [];
    if (faction) {
      const f = this.data.Factions.find((x) => x.Slug === faction);
      for (const p of f.Posts || []) {
        if (!has(p.RoleId)) continue;
        if (this.#contested(member, f, p)) continue;
        posts.push(p.Slug);
      }
    }

    const traits = this.data.Traits.filter((t) => has(t.RoleId)).map((t) => t.Slug);

    // FACTION RANK: highest wins, same rule as the stalker rank -- and only
    // inside the faction actually held, same rule as the posts.
    let frank = '';
    if (faction && !this.isBase(faction)) {
      const ff = this.data.Factions.find((x) => x.Slug === faction);
      let fbest = -1;
      for (const q of ff.Ranks || []) {
        if (!has(q.RoleId)) continue;
        if (q.Order <= fbest) continue;
        fbest = q.Order;
        frank = q.Slug;
      }
    }

    return { Faction: faction, Conflict: conflict, Posts: posts, Rank: rank, FRank: frank, Traits: traits };
  }
}

// The game reads colours as "R G B" because a human edits that file and
// 12861480 tells nobody anything.
function hexToRgb(n) {
  const v = Number(n) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].join(' ');
}
