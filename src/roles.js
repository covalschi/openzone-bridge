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
    }
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
  rosterParts() {
    const stamp = this.stamp();

    const factions = this.data.Factions.map((f) => ({
      Id: f.Slug,
      DisplayName: f.Label,
      Color: hexToRgb(f.Color),
    }));

    // Ranks, traits and posts travel for the SAME reason factions do: the bot
    // owns what a role is called, because it is the bot that creates it.
    // Without them the game receives "stalker-legend" and has nothing to draw
    // but the slug -- which is how a player reads his own rank in lowercase
    // English on a Ukrainian screen.
    const ranks  = this.data.Ranks.map((r) => ({ Id: r.Slug, DisplayName: r.Label }));
    const traits = this.data.Traits.map((t) => ({ Id: t.Slug, DisplayName: t.Label }));
    const posts  = this.data.Factions.flatMap((f) =>
      (f.Posts || []).map((p) => ({ Id: f.Slug + ':' + p.Slug, DisplayName: p.Label })),
    );

    const parts = [];
    let cur = null;

    // Well under the smallest size measured to work, because the limit was
    // measured, not documented, and a margin is cheaper than another evening.
    const BUDGET = 600;

    const flush = () => {
      if (cur) parts.push(cur);
      cur = { Stamp: stamp, Factions: [], Ranks: [], Traits: [], Posts: [] };
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

    if (cur) parts.push(cur);

    return parts.filter(
      (x) => x.Factions.length || x.Ranks.length || x.Traits.length || x.Posts.length,
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
    const held = this.data.Factions.filter((f) => has(f.RoleId));
    let faction = '';
    let conflict = [];
    if (held.length === 1) faction = held[0].Slug;
    if (held.length > 1) conflict = held.map((f) => f.Slug);

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

    return { Faction: faction, Conflict: conflict, Posts: posts, Rank: rank, Traits: traits };
  }
}

// The game reads colours as "R G B" because a human edits that file and
// 12861480 tells nobody anything.
function hexToRgb(n) {
  const v = Number(n) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].join(' ');
}
