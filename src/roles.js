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
  ],
};

export class Roles {
  constructor(path) {
    this.path = path;
    this.data = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      if (raw && raw.Version) return raw;
    } catch {
      // No file yet, or it is unreadable. Either way we start from the
      // defaults rather than refusing to run: a bot that will not boot
      // because its roster is missing is worse than one that ships the
      // roster it was written with.
    }
    return structuredClone(DEFAULTS);
  }

  save() {
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
    const posts = [];
    if (faction) {
      const f = this.data.Factions.find((x) => x.Slug === faction);
      for (const p of f.Posts || []) if (has(p.RoleId)) posts.push(p.Slug);
    }

    const traits = this.data.Traits.filter((t) => has(t.RoleId)).map((t) => t.Slug);

    return { Faction: faction, Conflict: conflict, Posts: posts, Rank: rank, Traits: traits };
  }
}
