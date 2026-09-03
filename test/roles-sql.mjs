// TZ-2 section 15: the roles home is SQLite, Discord is a mirror.
//
// Runs against a throwaway store and a fake guild. Touches neither the real
// guild nor the stand. Covers acceptance 15.1-15.6 and 15.8-15.9 as far as
// they can be covered without a game server: rows first, mirror follows,
// manual edits reverted, removals travel by name, the one-time import.

import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Roles, DEFAULTS } from '../src/roles.js';
import { RolesMirror } from '../src/roles-mirror.js';

let pass = 0;
let fail = 0;
function ok(what, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++;
    console.log(`  ok   ${what}`);
    return;
  }
  fail++;
  console.log(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}

function fresh(tag) {
  const path = join(tmpdir(), `oz-roles-sql-${tag}-${process.pid}.sqlite`);
  if (existsSync(path)) unlinkSync(path);
  return new Store(path, 100);
}

// ---- a guild made of maps -------------------------------------------------

class Coll extends Map {
  filter(fn) {
    const c = new Coll();
    for (const [k, v] of this) if (fn(v)) c.set(k, v);
    return c;
  }
  first() {
    return this.values().next().value;
  }
}

function fakeGuild() {
  let n = 0;
  const guild = {
    writes: [],
    roles: {
      cache: new Coll(),
      async fetch() {},
      async create(opts) {
        const id = 'r' + (++n);
        const role = { id, name: opts.name, async setName(nm) { this.name = nm; } };
        guild.roles.cache.set(id, role);
        return role;
      },
      async delete(id) {
        // Discord strips a deleted role from every member on its own.
        guild.roles.cache.delete(id);
        for (const m of guild.members.cache.values()) m.roles.cache.delete(id);
      },
    },
    members: {
      cache: new Coll(),
      async fetch() { return guild.members.cache; },
    },
    addMember(id, roleIds = []) {
      const member = {
        id,
        guild,
        user: { tag: id + '#0' },
        roles: {
          cache: new Coll(roleIds.map((r) => [r, guild.roles.cache.get(r) || { id: r, name: r }])),
          async set(ids, reason) {
            member.roles.cache = new Coll(ids.map((r) => [r, guild.roles.cache.get(r) || { id: r, name: r }]));
            guild.writes.push({ id, ids: [...ids].sort(), reason });
          },
        },
      };
      guild.members.cache.set(id, member);
      return member;
    },
  };
  return guild;
}

const logged = [];
const log = { log: (m) => logged.push(m), warn: (m) => logged.push(m) };

// ---- 1. bootstrap ----------------------------------------------------------

console.log('bootstrap');
{
  const store = fresh('boot');
  const roles = new Roles(store);
  const b = roles.bootstrap('');
  ok('seeded from the defaults', b.source, 'defaults');
  ok('ten factions', roles.factions().length, DEFAULTS.Factions.length);
  ok('three ranks, two traits', [roles.ranks().length, roles.traits().length], [3, 2]);
  ok('the base is the loner flag', roles.base().slug, 'loner');
  ok('stamp starts at 1', roles.stamp(), 1);

  const again = roles.bootstrap('');
  ok('a second bootstrap adds nothing', [again.source, again.grew], ['db', []]);
  ok('and keeps the stamp', roles.stamp(), 1);

  // The old JSON registry with the guild's ids and an admin rename.
  const store2 = fresh('json');
  const roles2 = new Roles(store2);
  const jsonPath = join(tmpdir(), `oz-roles-${process.pid}.json`);
  const raw = structuredClone(DEFAULTS);
  raw.Stamp = 41;
  raw.Factions[1].RoleId = '900';
  raw.Factions[1].Label = 'Долг (renamed)';
  raw.Factions[1].Limit = 12;
  raw.Factions[1].Posts[0].RoleId = '901';
  raw.Factions.push({ Slug: 'renegade', Label: 'Ренегати', Color: 1, Posts: [{ Slug: 'leader', Label: 'Лідер ренегатів' }], Ranks: [{ Slug: 'sgt', Label: 'Сержант', Order: 2 }] });
  raw.Ranks[0].RoleId = '910';
  writeFileSync(jsonPath, JSON.stringify(raw));
  const b2 = roles2.bootstrap(jsonPath);
  ok('seeded from roles.json', b2.source, 'roles.json');
  ok('the stamp carries on from the file', roles2.stamp(), 42);
  const duty = roles2.find('duty');
  ok('ids, label and limit survive the move', [duty.node.roleId, duty.node.label, duty.node.limit], ['900', 'Долг (renamed)', 12]);
  ok('the leader post keeps its id', roles2.find('duty:leader').node.roleId, '901');
  ok("the admin's own faction and its rank come along", [roles2.find('renegade').kind, roles2.find('renegade:sgt').kind], ['faction', 'facrank']);
  unlinkSync(jsonPath);
}

// ---- 2. membership ---------------------------------------------------------

console.log('membership');
const store = fresh('main');
const roles = new Roles(store);
roles.bootstrap('');
{
  ok('an unknown character has no view', roles.viewOf('100'), null);
  roles.ensureMember('100');
  ok('a fresh stalker: base, no org, novice', roles.viewOf('100'), { Base: 'loner', Org: '', Conflict: [], Posts: [], Rank: 'stalker-novice', FRank: '', Traits: [] });

  // No Discord link anywhere in this file: membership is by Steam64 (R7.5).
  let r = roles.apply('', '100', 'faction.set', 'mercenary');
  ok('admin puts an unlinked player into a faction', [r.ok, roles.viewOf('100').Org], [true, 'mercenary']);
  ok('the first member leads', roles.viewOf('100').Posts, ['leader']);
  ok('touched names him', r.touched, ['100']);

  r = roles.apply('', '100', 'faction.set', 'mercenary');
  ok('setting the same faction again is a yes and changes nothing', [r.ok, roles.viewOf('100').Posts], [true, ['leader']]);

  r = roles.apply('', '200', 'faction.set', 'mercenary');
  ok('a second member joins without a leader post', [r.ok, roles.viewOf('200').Posts], [true, []]);
  ok('sizeOf counts rows', roles.sizeOf('mercenary'), 2);

  // The ceiling: the catalog's limit, else the game's MaxMembers.
  r = roles.apply('', '300', 'faction.set', 'mercenary', 2);
  ok('the game ceiling refuses when the catalog has none', [r.ok, r.why], [false, 'Найманці is full (2/2)']);
  roles.setLimit('mercenary', 3);
  r = roles.apply('', '300', 'faction.set', 'mercenary', 2);
  ok('the catalog limit wins over the game ceiling', [r.ok, roles.viewOf('300').Org], [true, 'mercenary']);
  r = roles.apply('', '400', 'faction.set', 'mercenary');
  ok('and is enforced', [r.ok, r.why], [false, 'Найманці is full (3/3)']);
  roles.setLimit('mercenary', 0);

  r = roles.apply('', '300', 'faction.set', 'nosuch');
  ok('an unknown faction is refused', [r.ok, r.why], [false, 'no such faction: nosuch']);

  // Leadership is handed over by the leader, and only by the leader.
  r = roles.apply('200', '300', 'leader.transfer');
  ok('a non-leader cannot hand leadership over', [r.ok, r.why], [false, 'you are not the leader']);
  r = roles.apply('100', '200', 'leader.transfer');
  ok('the leader hands it over in one transaction', [r.ok, roles.viewOf('100').Posts, roles.viewOf('200').Posts], [true, [], ['leader']]);
  ok('both are touched', r.touched.sort(), ['100', '200']);

  // The admin names a leader outright; the old one loses the post.
  r = roles.apply('', '300', 'leader.set');
  ok('leader.set strips the previous leader', [r.ok, roles.viewOf('200').Posts, roles.viewOf('300').Posts], [true, [], ['leader']]);
  ok('touched names both', r.touched.sort(), ['200', '300']);

  // Leaving takes the post; the post passes down.
  r = roles.apply('', '300', 'faction.clear');
  ok('the leader leaves: org, posts gone, rank kept', roles.viewOf('300'), { Base: 'loner', Org: '', Conflict: [], Posts: [], Rank: 'stalker-novice', FRank: '', Traits: [] });
  const heir = ['100', '200'].find((u) => roles.viewOf(u).Posts.includes('leader'));
  ok('somebody inherits the post', !!heir, true);
  ok('touched names the heir too', r.touched.includes(heir), true);

  // Ranks and traits.
  r = roles.apply('', '100', 'rank.set', 'stalker-legend');
  ok('rank.set', [r.ok, roles.viewOf('100').Rank], [true, 'stalker-legend']);
  r = roles.apply('', '100', 'rank.set', 'general');
  ok('an unknown rank is refused', [r.ok, r.why], [false, 'no such rank: general']);
  r = roles.apply('', '100', 'trait.add', 'medic');
  ok('trait.add', [r.ok, roles.viewOf('100').Traits], [true, ['medic']]);
  r = roles.apply('', '100', 'trait.remove', 'medic');
  ok('trait.remove', [r.ok, roles.viewOf('100').Traits], [true, []]);

  r = roles.apply('', '100', 'frank.set', 'sgt');
  ok('a faction rank that does not exist is refused', [r.ok, r.why], [false, 'no such rank in Найманці: sgt']);
  const a = roles.addFactionRank('mercenary', 'sgt', 'Сержант', 2);
  ok('addFactionRank', a.ok, true);
  r = roles.apply('', '100', 'frank.set', 'sgt');
  ok('frank.set', [r.ok, roles.viewOf('100').FRank], [true, 'sgt']);

  // Succession prefers the faction rank.
  roles.apply('', heir, 'post.remove', 'mercenary:leader');
  ok('post.remove of the leader passes the post to the highest faction rank', roles.viewOf('100').Posts, ['leader']);

  r = roles.apply('', '200', 'post.add', 'duty:leader');
  ok('a post of another faction is refused', [r.ok, r.why], [false, 'that player is not in Долг']);

  r = roles.apply('', '200', 'bogus.op');
  ok('an unknown op is refused', [r.ok, r.why], [false, 'unknown operation: bogus.op']);
}

// ---- 3. the catalog --------------------------------------------------------

console.log('catalog');
{
  const before = roles.stamp();
  let r = roles.upsertFaction({ slug: 'Renegade', label: 'Ренегати', hasLeader: true });
  ok('a new faction from the editor', [r.ok, r.created, r.slug], [true, true, 'renegade']);
  ok('with a leader post', roles.find('renegade:leader').node.label, 'Лідер: Ренегати');
  ok('the stamp moved', roles.stamp() > before, true);

  r = roles.upsertFaction({ slug: 'bad slug!' });
  ok('a bad slug is refused', [r.ok, r.why], [false, 'slug must be a short lowercase word']);

  roles.apply('', '500', 'faction.set', 'renegade');
  ok('its first member leads', roles.viewOf('500').Posts, ['leader']);

  r = roles.upsertFaction({ slug: 'renegade', label: 'Ренегати Зони' });
  ok('renaming the faction renames the leader post named after it', roles.find('renegade:leader').node.label, 'Лідер: Ренегати Зони');
  roles.rename('renegade:leader', 'Отаман');
  r = roles.upsertFaction({ slug: 'renegade', label: 'Ренегати Краю' });
  ok('a hand-named post keeps its name', roles.find('renegade:leader').node.label, 'Отаман');
  r = roles.rename('renegade', 'Ренегати');
  ok('rename() of the faction leaves the hand-named post alone too', [r.ok, roles.find('renegade:leader').node.label], [true, 'Отаман']);
  r = roles.upsertFaction({ slug: 'renegade', label: 'Ренегати Зони', limit: 5, hasLeader: false });
  ok('editing: label and limit change, the leader post goes', [r.ok, r.created, roles.find('renegade').node.label, roles.limitOf('renegade'), roles.find('renegade:leader')], [true, false, 'Ренегати Зони', 5, null]);
  ok('and the member lost the post', [roles.viewOf('500').Posts, r.touched], [[], ['500']]);

  r = roles.upsertFaction({ slug: 'renegade', hasLeader: true });
  ok('the post can come back', roles.find('renegade:leader') !== null, true);

  r = roles.removeFaction('loner');
  ok('the base cannot be removed', [r.ok, r.why], [false, 'that is the base identity, it cannot be removed']);

  r = roles.removeFaction('renegade');
  ok('removal moves the members back to stalkers', [r.ok, r.touched, roles.viewOf('500').Org], [true, ['500'], '']);
  const parts = roles.rosterParts();
  const gone = parts.flatMap((p) => p.Gone);
  ok('the removal travels by name', gone, ['renegade']);
  ok('every part carries the same stamp', new Set(parts.map((p) => p.Stamp)).size, 1);
  ok('every part fits the wire', parts.every((p) => JSON.stringify(p).length <= 600), true);
  ok('the removed faction is not in the roster', parts.some((p) => p.Factions.some((f) => f.Id === 'renegade')), false);

  r = roles.upsertFaction({ slug: 'renegade', label: 'Ренегати' });
  ok('re-creating takes it off the gone list', roles.rosterParts().flatMap((p) => p.Gone), []);
  roles.removeFaction('renegade');

  r = roles.rename('duty', 'Долг!');
  ok('rename', [r.ok, r.was, r.now, roles.find('duty').node.label], [true, 'Долг', 'Долг!', 'Долг!']);
  roles.rename('duty', 'Долг');

  // A row that points at a faction the catalog no longer has is filtered
  // on the way out, whatever it says.
  store.memberSet({ steamId: '600', org: 'ghost', frank: 'x', rank: 'stalker-legend', posts: ['leader'], traits: ['medic', 'nosuch'] });
  ok('stale rows project only what exists', roles.viewOf('600'), { Base: 'loner', Org: '', Conflict: [], Posts: [], Rank: 'stalker-legend', FRank: '', Traits: ['medic'] });

  // Permadeath.
  roles.apply('', '600', 'faction.set', 'duty');
  roles.apply('', '700', 'faction.set', 'duty');
  const w = roles.wipe('600');
  ok('a wipe: everything off, novice back', roles.viewOf('600'), { Base: 'loner', Org: '', Conflict: [], Posts: [], Rank: 'stalker-novice', FRank: '', Traits: [] });
  ok('and the post passed down', [roles.viewOf('700').Posts, w.touched.sort()], [['leader'], ['600', '700']]);
}

// ---- 4. the mirror, off ----------------------------------------------------

console.log('mirror off');
{
  const guild = fakeGuild();
  const off = new RolesMirror(roles, store, { isOn: () => false, log, echoWindowMs: 0 });
  store.link('100', 'd-100', 'one');
  const m = guild.addMember('d-100', ['stray']);
  await off.afterApply(guild, ['100']);
  await off.afterCatalog(guild, { touched: ['100'], dropRoleIds: [] });
  await off.onMemberUpdate(m);
  const rr = await off.reconcileAll(guild);
  ok('nothing is written to the guild while the mirror is off', [guild.writes.length, guild.roles.cache.size, rr.skipped], [0, 0, true]);
  ok('a fill still says what it would need', (await off.fillAll(null)).ok, false);
}

// ---- 5. the mirror, on -----------------------------------------------------

console.log('mirror on');
{
  const guild = fakeGuild();
  let on = false;
  const mirror = new RolesMirror(roles, store, { isOn: () => on, log, echoWindowMs: 0 });
  const one = guild.addMember('d-100', ['stray']);
  store.link('200', 'd-200', 'two');
  const two = guild.addMember('d-200', []);
  // '300' is a member of the tables with no link: nothing to mirror.

  // Turning it on: the fill runs with the kind still off in every server.
  const f = await mirror.fillAll(guild);
  const entries = [...roles.entries()];
  ok('the fill creates a role per catalog entry', guild.roles.cache.size, entries.length);
  ok('every entry now has an id', roles.pending(), 0);
  ok('linked members were set, the rest skipped, nothing failed', [f.ok, f.pushed, f.failed, f.pushed + f.skipped], [true, 2, 0, roles.memberCount()]);

  const want100 = [...mirror.desiredRoleIds('100')].sort();
  ok('the member wears exactly his row plus what is not ours', [...one.roles.cache.keys()].sort(), ['stray', ...want100].sort());
  const v100 = roles.viewOf('100');
  const idOf = (slug) => roles.find(slug).node.roleId;
  ok('base, org, post, rank, faction rank are all there', [idOf('loner'), idOf('mercenary'), idOf('mercenary:leader'), idOf('stalker-legend'), idOf('mercenary:sgt')].every((id) => one.roles.cache.has(id)), true);
  ok('(the view agrees)', [v100.Org, v100.Posts, v100.Rank, v100.FRank], ['mercenary', ['leader'], 'stalker-legend', 'sgt']);

  on = true;

  // A hand on the roles in Discord: put back, and said.
  guild.writes.length = 0;
  logged.length = 0;
  one.roles.cache.set(idOf('duty'), guild.roles.cache.get(idOf('duty')));
  one.roles.cache.delete(idOf('loner'));
  await mirror.onMemberUpdate(one);
  ok('a manual faction role is taken off and the base put back', [one.roles.cache.has(idOf('duty')), one.roles.cache.has(idOf('loner'))], [false, true]);
  ok('one write, with the log line the spec asks for', [guild.writes.length, logged.some((l) => l.startsWith('[roles] reverted a manual change on d-100#0: -Долг, +Сталкери'))], [1, true]);

  // Our own write produces no drift and no second write.
  guild.writes.length = 0;
  await mirror.onMemberUpdate(one);
  ok('a matching member is left alone', guild.writes.length, 0);

  // A stranger's roles are none of the mirror's business.
  const stranger = guild.addMember('d-999', [idOf('duty')]);
  await mirror.onMemberUpdate(stranger);
  ok('an unlinked account is not touched', stranger.roles.cache.has(idOf('duty')), true);

  // A change in the game follows into the guild.
  guild.writes.length = 0;
  const r = roles.apply('', '200', 'faction.set', 'duty');
  await mirror.afterApply(guild, r.touched);
  // 700 has led Duty since the wipe above, so 200 joins as a plain member.
  ok('the row change is projected', [two.roles.cache.has(idOf('duty')), two.roles.cache.has(idOf('duty:leader')), roles.viewOf('700').Posts], [true, false, ['leader']]);

  // The catalog changes follow too.
  const c = roles.upsertFaction({ slug: 'renegade', label: 'Ренегати', hasLeader: true });
  await mirror.afterCatalog(guild, c);
  ok('a new faction gets its roles', [!!idOf('renegade'), !!idOf('renegade:leader')], [true, true]);
  const rid = idOf('renegade');
  roles.apply('', '200', 'faction.set', 'renegade');
  await mirror.afterApply(guild, ['200']);
  const d = roles.removeFaction('renegade');
  await mirror.afterCatalog(guild, d);
  ok('a removed faction loses its roles and its members are re-projected', [guild.roles.cache.has(rid), two.roles.cache.has(rid), two.roles.cache.has(idOf('loner'))], [false, false, true]);

  // A renamed role is renamed back on the next sync.
  guild.roles.cache.get(idOf('duty')).name = 'Hand-renamed';
  const s = await mirror.syncCatalog(guild);
  ok('the table name wins', [s.renamed, guild.roles.cache.get(idOf('duty')).name], [['duty'], 'Долг']);

  // A deleted role comes back.
  guild.roles.cache.delete(idOf('medic'));
  const s2 = await mirror.syncCatalog(guild);
  ok('a deleted role is recreated under a new id', [s2.made, !!guild.roles.cache.get(idOf('medic'))], [['medic'], true]);

  // The echo of our own write is not a manual change: looked at again later.
  {
    const slow = new RolesMirror(roles, store, { isOn: () => true, log, echoWindowMs: 150 });
    roles.apply('', '200', 'trait.add', 'medic');
    await slow.afterApply(guild, ['200']);
    guild.writes.length = 0;
    two.roles.cache.delete(idOf('medic'));
    await slow.onMemberUpdate(two);
    ok('inside the window nothing is written yet', guild.writes.length, 0);
    await new Promise((r) => setTimeout(r, 250));
    ok('after the window the drift is put back', [guild.writes.length, two.roles.cache.has(idOf('medic'))], [1, true]);
    roles.apply('', '200', 'trait.remove', 'medic');
    await mirror.afterApply(guild, ['200']);
  }

  // The sweep finds nothing after all that.
  const sw = await mirror.reconcileAll(guild, 'sweep');
  ok('the sweep is quiet when the guild matches', [sw.checked, sw.fixed, sw.failed], [2, 0, 0]);
}

// ---- 6. the one-time import ------------------------------------------------

console.log('import');
{
  const st = fresh('import');
  const rl = new Roles(st);
  rl.bootstrap('');
  const guild = fakeGuild();
  // The catalog already carries ids, as a roles.json would have.
  for (const e of [...rl.entries()]) {
    const role = await guild.roles.create({ name: e.label });
    rl.setRoleId(e.slug, role.id);
  }
  const id = (slug) => rl.find(slug).node.roleId;
  st.link('111', 'd-111', 'one');
  st.link('222', 'd-222', 'two');
  st.link('333', 'd-333', 'three');
  guild.addMember('d-111', [id('loner'), id('duty'), id('duty:leader'), id('stalker-legend'), id('medic')]);
  guild.addMember('d-222', [id('loner'), id('stalker-novice')]);
  // Two factions at once: neither is taken, the rest still comes.
  guild.addMember('d-333', [id('loner'), id('duty'), id('freedom'), id('stalker-experienced')]);

  const mirror = new RolesMirror(rl, st, { isOn: () => false, log, echoWindowMs: 0 });
  logged.length = 0;
  const imp = await mirror.importIfNeeded(guild);
  ok('the import ran once', [imp.done, imp.members], [true, 3]);
  ok('a leader comes across whole', rl.viewOf('111'), { Base: 'loner', Org: 'duty', Conflict: [], Posts: ['leader'], Rank: 'stalker-legend', FRank: '', Traits: ['medic'] });
  ok('a plain stalker too', rl.viewOf('222'), { Base: 'loner', Org: '', Conflict: [], Posts: [], Rank: 'stalker-novice', FRank: '', Traits: [] });
  ok('two factions at once: no org, rank kept', [rl.viewOf('333').Org, rl.viewOf('333').Rank], ['', 'stalker-experienced']);
  ok('the log says so', logged.some((l) => l.includes('imported 10 factions, 3 members from Discord')), true);
  const again = await mirror.importIfNeeded(guild);
  ok('a second start does not import again', again.done, false);
  ok('nothing was written to the guild by the import', guild.writes.length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
