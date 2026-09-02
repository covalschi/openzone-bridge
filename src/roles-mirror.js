// The roles MIRROR: Discord roles as a reflection of the bot's tables
// (TZ-2 section 15, R7.6).
//
// One direction. The catalog says which roles exist and what they are
// called; the members table says who wears which. When the mirror kind
// `roles` is on for any server, this module makes the guild match: it
// creates the roles the catalog lacks, renames the ones that drifted, and
// sets each linked member's roles to exactly what his row says. A role
// somebody adds or removes BY HAND in Discord is put back on the next
// member update and on the ten-minute sweep, with a log line naming the
// change -- the tables are the home, and the guild does not get a vote.
//
// With the mirror OFF nothing here touches the guild at all: no creation,
// no revert, no fill. Turning it on runs fillAll() first, from the game's
// console, before the game records the mirror as on.
//
// Nothing here can fail an operation. Every guild write is best effort and
// logged; the row was already written before the mirror was asked.

export class RolesMirror {
  constructor(roles, store, { isOn = () => false, log = console } = {}) {
    this.roles = roles;
    this.store = store;
    this.isOn = isOn;
    this.log = log;
    this.busy = false;
  }

  on() {
    return !!this.isOn();
  }

  // ---- what the guild should look like -----------------------------------

  // Every role id the catalog owns. Only these are ever taken off a member;
  // whatever else he wears in the guild is none of the mirror's business.
  managedRoleIds() {
    const ids = new Set();
    for (const e of this.roles.entries()) if (e.roleId) ids.add(e.roleId);
    return ids;
  }

  // The roles one character should wear, from his row: the base identity,
  // his organisation and the posts and rank inside it, his stalker rank,
  // his traits. Entries with no role yet are simply not there.
  desiredRoleIds(uid) {
    const ids = new Set();
    const v = this.roles.viewOf(uid);
    if (!v) return ids;

    const want = (slug) => {
      const e = this.roles.find(slug);
      if (e && e.node.roleId && !e.node.missing) ids.add(e.node.roleId);
    };

    if (v.Base) want(v.Base);
    if (v.Org) {
      want(v.Org);
      for (const p of v.Posts) want(v.Org + ':' + p);
      if (v.FRank) want(v.Org + ':' + v.FRank);
    }
    if (v.Rank) want(v.Rank);
    for (const t of v.Traits) want(t);
    return ids;
  }

  #memberFor(guild, uid) {
    if (!guild) return null;
    const link = this.store.linkOf(uid);
    if (!link) return null;
    return guild.members.cache.get(link.discordId) || null;
  }

  // ---- the catalog in the guild ------------------------------------------

  // Create what is missing, adopt what already exists by name (once, and
  // only when exactly one role matches), rename what drifted. Ids are
  // written back to the catalog rows; the tables never learn anything else
  // from the guild.
  async syncCatalog(guild) {
    const made = [];
    const adopted = [];
    const kept = [];
    const renamed = [];
    const failed = [];
    const ambiguous = [];
    if (!guild) return { made, adopted, kept, renamed, failed, ambiguous };

    try {
      await guild.roles.fetch();
    } catch {
      // The cache will have to do.
    }

    for (const e of [...this.roles.entries()]) {
      if (e.roleId) {
        const known = guild.roles.cache.get(e.roleId);
        if (known) {
          // THE TABLE'S NAME WINS. Before the move the rename made by hand
          // in Discord was adopted; now the label lives here and the guild
          // follows it, like every other manual edit.
          if (known.name !== e.label) {
            try {
              await known.setName(e.label, 'OpenZone: the roles mirror follows the bot database');
              renamed.push(e.slug);
            } catch (err) {
              failed.push(e.slug + ' (rename: ' + whyDiscordSaidNo(err) + ')');
            }
          } else {
            kept.push(e.slug);
          }
          continue;
        }
        // Deleted in Discord. A manual edit like any other: it comes back.
        this.log.log(`[roles] the role for ${e.slug} was deleted in Discord - recreating it`);
      }

      const byName = guild.roles.cache.filter((r) => r.name === e.label);
      if (!e.roleId && byName.size === 1) {
        this.roles.setRoleId(e.slug, byName.first().id);
        adopted.push(e.slug);
        continue;
      }
      if (!e.roleId && byName.size > 1) {
        ambiguous.push(e.slug + ' (' + byName.size + ' roles named "' + e.label + '")');
        continue;
      }

      // No `position`, deliberately: discord.js does not send position on
      // create at all, and supplying one makes it issue a SECOND request
      // that re-indexes every role in the guild.
      try {
        const role = await guild.roles.create({
          name: e.label,
          colors: { primaryColor: e.color },
          hoist: e.kind === 'faction',
          mentionable: false,
          reason: 'OpenZone role roster',
        });
        this.roles.setRoleId(e.slug, role.id);
        made.push(e.slug);
      } catch (err) {
        this.roles.setRoleId(e.slug, '', true);
        failed.push(e.slug + ' (' + whyDiscordSaidNo(err) + ')');
      }
    }

    return { made, adopted, kept, renamed, failed, ambiguous };
  }

  async dropRoles(guild, ids, reason) {
    if (!guild) return;
    for (const id of ids || []) {
      try {
        await guild.roles.delete(id, 'OpenZone: ' + reason);
      } catch {
        // Already gone, or not ours to delete -- a stray role is visible
        // and fixable by hand.
      }
    }
  }

  async renameRole(guild, roleId, name) {
    if (!this.on() || !guild || !roleId) return { ok: true };
    const role = guild.roles.cache.get(roleId);
    if (!role) return { ok: true };
    try {
      await role.setName(String(name), 'OpenZone roster rename');
      return { ok: true };
    } catch (err) {
      return { ok: false, why: whyDiscordSaidNo(err) };
    }
  }

  // ---- members in the guild ----------------------------------------------

  // Set one linked member's roles to what his row says. One PATCH with the
  // final set -- never remove-then-add, which reads a cache the first call
  // already outdated (measured 2026-08-30).
  async projectMember(guild, uid, reason, force = false) {
    if (!force && !this.on()) return 'off';
    const member = this.#memberFor(guild, uid);
    if (!member) return 'unlinked';

    const desired = this.desiredRoleIds(uid);
    const managed = this.managedRoleIds();
    const current = [...member.roles.cache.keys()];
    const final = current.filter((id) => !managed.has(id) || desired.has(id));
    for (const id of desired) if (!final.includes(id)) final.push(id);

    const changed = final.length !== current.length || final.some((id) => !current.includes(id));
    if (!changed) return 'same';

    try {
      await member.roles.set(final, 'OpenZone: ' + reason);
      return 'set';
    } catch (err) {
      this.log.warn(`[roles] cannot set the roles of ${member.user?.tag || uid}: ${whyDiscordSaidNo(err)}`);
      return 'failed';
    }
  }

  // After a membership change: the touched characters follow into the guild.
  async afterApply(guild, touched, reason = 'roles changed in the game') {
    if (!this.on()) return;
    for (const uid of touched || []) {
      await this.projectMember(guild, uid, reason);
    }
  }

  // After a catalog change: new entries get roles, removed ones lose them,
  // and whoever was moved by the change follows.
  async afterCatalog(guild, r, reason = 'the catalog changed') {
    if (!this.on() || !guild) return;
    try {
      const s = await this.syncCatalog(guild);
      if (s.made.length) this.log.log(`[roles] roles created: ${s.made.join(', ')}`);
      if (s.failed.length) this.log.warn(`[roles] roles not created: ${s.failed.join('; ')}`);
    } catch (err) {
      this.log.warn(`[roles] could not sync the roles: ${err.message}`);
    }
    await this.dropRoles(guild, r && r.dropRoleIds, reason);
    await this.afterApply(guild, r && r.touched, reason);
  }

  // A member's roles changed in the guild. Ours, or somebody's hand: only
  // the second kind produces a difference, and the difference is reverted.
  async onMemberUpdate(member) {
    if (!this.on() || !member || !member.guild) return;
    const uid = this.store.steamIdOf(member.id);
    if (!uid) return;
    if (!this.roles.knows(uid)) return;

    const desired = this.desiredRoleIds(uid);
    const managed = this.managedRoleIds();
    const current = new Set(member.roles.cache.keys());

    const extra = [...current].filter((id) => managed.has(id) && !desired.has(id));
    const lacking = [...desired].filter((id) => !current.has(id));
    if (!extra.length && !lacking.length) return;

    const name = (id) => member.guild.roles.cache.get(id)?.name || id;
    const what = [...extra.map((id) => '-' + name(id)), ...lacking.map((id) => '+' + name(id))].join(', ');

    const r = await this.projectMember(member.guild, uid, 'the roles mirror follows the bot database');
    if (r === 'set') this.log.log(`[roles] reverted a manual change on ${member.user?.tag || member.id}: ${what}`);
  }

  // Every known, linked member back to his row. The ten-minute sweep, and
  // the second half of turning the mirror on.
  async reconcileAll(guild, reason = 'sweep', force = false) {
    if (!force && !this.on()) return { skipped: true, checked: 0, fixed: 0, failed: 0 };
    if (!guild) return { skipped: true, checked: 0, fixed: 0, failed: 0 };

    let checked = 0;
    let fixed = 0;
    let failed = 0;
    for (const m of this.roles.membersAll()) {
      if (!this.store.linkOf(m.steamId)) continue;
      checked++;
      const r = await this.projectMember(guild, m.steamId, 'the roles mirror follows the bot database (' + reason + ')', force);
      if (r === 'set') fixed++;
      if (r === 'failed') failed++;
    }
    if (fixed || failed) this.log.log(`[roles] ${reason}: ${checked} member(s) checked, ${fixed} put back, ${failed} failed`);
    return { skipped: false, checked, fixed, failed };
  }

  // The mirror was just found ON (a server said so, or the bot restarted
  // with it on): make the guild match once, quietly.
  async warm(guild) {
    if (!this.on() || !guild || this.busy) return;
    this.busy = true;
    try {
      const s = await this.syncCatalog(guild);
      if (s.made.length) this.log.log(`[roles] roles created: ${s.made.join(', ')}`);
      if (s.adopted.length) this.log.log(`[roles] adopted existing roles: ${s.adopted.join(', ')}`);
      if (s.renamed.length) this.log.log(`[roles] roles renamed back: ${s.renamed.join(', ')}`);
      if (s.ambiguous.length) this.log.warn(`[roles] left alone, ambiguous: ${s.ambiguous.join('; ')}`);
      if (s.failed.length) this.log.warn(`[roles] roles failed: ${s.failed.join('; ')}`);
      await this.reconcileAll(guild, 'mirror on');
    } catch (err) {
      this.log.warn(`[roles] could not warm the mirror: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  // Turning the mirror on from the game (R7.6): the whole picture goes
  // into the guild before the game records the mirror as on. Runs with
  // force because at this moment no server reports the kind yet.
  async fillAll(guild) {
    if (!guild) return { ok: false, why: 'the bot is not connected', pushed: 0, skipped: 0, failed: 0, note: '' };

    let s;
    try {
      s = await this.syncCatalog(guild);
    } catch (err) {
      return { ok: false, why: 'could not sync the roles: ' + err.message, pushed: 0, skipped: 0, failed: 0, note: '' };
    }
    if (s.failed.length && !s.made.length && !s.kept.length && !s.adopted.length) {
      return { ok: false, why: s.failed[0], pushed: 0, skipped: 0, failed: s.failed.length, note: '' };
    }

    let pushed = 0;
    let skipped = 0;
    let failed = 0;
    for (const m of this.roles.membersAll()) {
      const r = await this.projectMember(guild, m.steamId, 'the roles mirror was turned on', true);
      if (r === 'set') pushed++;
      else if (r === 'failed') failed++;
      else skipped++;
    }

    const bits = [];
    if (s.made.length) bits.push(s.made.length + ' role(s) created');
    if (s.renamed.length) bits.push(s.renamed.length + ' renamed');
    if (s.failed.length) bits.push(s.failed.length + ' role(s) failed');
    if (s.ambiguous.length) bits.push(s.ambiguous.length + ' ambiguous');
    const note = bits.join(', ');

    this.log.log(`[roles] mirror fill: ${pushed} member(s) set, ${skipped} unchanged or unlinked, ${failed} failed${note ? ' (' + note + ')' : ''}`);
    return { ok: failed === 0, why: failed ? 'Discord refused some members - see the bot log' : '', pushed, skipped, failed, note };
  }

  // ---- the one-time import -----------------------------------------------

  // First start after the move (R7.10): the guild's roles, as the old
  // registry read them, become rows. Once. The marker is set only after a
  // real attempt against a real guild, so a start without the bot
  // connected imports on the next one instead of never.
  async importIfNeeded(guild) {
    if (this.roles.importedAt()) return { done: false, members: 0 };
    if (!guild) return { done: false, members: 0 };

    let members = 0;
    if (this.roles.memberCount() === 0) {
      try {
        await guild.members.fetch();
      } catch {
        // The cache will have to do.
      }
      const rows = [];
      for (const l of this.store.linksAll()) {
        const member = guild.members.cache.get(l.discordId);
        if (!member) continue;
        const r = this.roles.resolveFromRoles((id) => member.roles.cache.has(id));
        if (!r.anything) continue;
        if (r.conflict.length) {
          this.log.warn(`[roles] import: ${member.user?.tag || l.discordId} wears ${r.conflict.join(' and ')} - neither is taken`);
        }
        rows.push({ steamId: l.steamId, org: r.org, frank: r.frank, rank: r.rank, posts: r.posts, traits: r.traits });
      }
      this.store.tx(() => {
        for (const row of rows) this.store.memberSet(row);
      });
      members = rows.length;
    }

    this.roles.markImported();
    this.log.log(`[roles] imported ${this.roles.factions().length} factions, ${members} members from Discord`);
    return { done: true, members };
  }
}

// Discord's refusals, in words somebody can act on.
function whyDiscordSaidNo(e) {
  // 50013 covers BOTH "no Manage Roles" and "that role outranks you", and
  // Discord gives no way to tell them apart, so say both. 30005 is the
  // guild role cap, whose number Discord does not publish.
  if (e && e.code === 50013) return 'the bot cannot manage that role - move the bot role above it in Server Settings';
  if (e && e.code === 30005) return 'this guild has hit its role limit';
  if (e && e.code === 50001) return 'the bot cannot see that member';
  return (e && e.message) || 'Discord refused';
}
