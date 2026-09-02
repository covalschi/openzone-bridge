// OpenZone Bridge.
//
// DISCORD IS THE SOURCE OF TRUTH. The game does not keep conversations; it
// asks for them and shows what comes back. A message a player sends is not in
// the conversation until Discord has it — which is why the game sees its own
// message only after it comes back down the poll. That is the point, not a
// delay to be optimised away.
//
// The bridge keeps an index (which thread is which conversation, which Discord
// account is which SteamID) and a tail cache of recent messages, because
// Discord's rate limits make re-reading a thread on every page open
// impossible. Neither is an authority: anything the cache has not seen is
// simply not shown.

import 'dotenv/config';
import { byteClip } from './clip.js';
import { Store } from './store.js';
import { DiscordSide } from './discord.js';
import { HttpSide } from './http.js';
import { OAuthSide } from './oauth.js';
import { LinkCodes } from './codes.js';
import { Roles } from './roles.js';
import { News } from './news.js';
import { Personas } from './personas.js';

// Store timestamps are UTC written as "YYYY-MM-DD HH:MM:SS". Date.parse
// reads a space-separated stamp as LOCAL time, which silently shifted the
// history window by the machine's offset -- so the parse is explicit.
function parseAt(at) {
  const s = String(at);
  // Two stamp dialects live in the index: the old writer kept the raw
  // toISOString (with T and Z), the newer one writes "YYYY-MM-DD HH:MM:SS"
  // in UTC. A parser that chokes on one of them returns 0, and 0 passes
  // every window check at once -- measured live as "the whole history in
  // one page".
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : 0;
}

// One 8-hour page of a message list, ending at `endMs` -- or, when that
// window is empty, at the newest message before it, so a quiet stretch
// falls through to the last page that HAS something.
function windowSlice(list, endMs) {
  const windowMs = 8 * 3600 * 1000;
  if (!list.length) return [];

  let end = endMs;
  const inWindow = (m) => {
    const t = parseAt(m.at);
    return t <= end && t > end - windowMs;
  };

  if (!list.some(inWindow)) {
    const newestBefore = [...list].reverse().find((m) => parseAt(m.at) <= end);
    if (!newestBefore) return [];
    end = parseAt(newestBefore.at);
  }

  return list.filter(inWindow);
}

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[bridge] ${name} is missing from .env — see SETUP.md`);
    process.exit(1);
  }
  return v;
}

const cfg = {
  token: need('DISCORD_BOT_TOKEN'),
  clientId: need('DISCORD_CLIENT_ID'),
  clientSecret: need('DISCORD_CLIENT_SECRET'),
  guildId: need('DISCORD_GUILD_ID'),
  parentChannelId: need('DISCORD_PARENT_CHANNEL_ID'),
  redirectUrl: need('OAUTH_REDIRECT_URL'),
  port: Number(process.env.BRIDGE_PORT || 8787),
  secret: need('OZ_SHARED_SECRET'),
  // Under ten: see the note in http.js -- the game's request dies at 10 s.
  holdSeconds: Number(process.env.POLL_HOLD_SECONDS || 8),
  statePath: process.env.BRIDGE_STATE || './state/bridge.json',
  // Optional: a Discord role that counts as bridge admin alongside the
  // Administrator permission (personas, /openzone).
  adminRoleId: process.env.DISCORD_ADMIN_ROLE_ID || '',
};

const store = new Store(cfg.statePath);

// OUR OWN ID FOR A RECORD, and it is deliberately not Discord's (TZ-2 R6.4).
//
// A Discord messageId is a MUTABLE POINTER, not an identity: any strategy
// that reposts a line -- a mirror switched on and backfilled, a thread
// rebuilt after deletion -- changes it, and everything keyed by it comes
// loose. A record needs a name that belongs to the record.
//
// Shape: "o" + milliseconds + counter. Sortable by time like a snowflake, so
// existing code that orders by id keeps working; the counter makes two lines
// in the same millisecond distinct. The prefix keeps ours visually apart from
// Discord's 19-digit numbers in any log or state file.
let ownSeq = 0;
function ownId() {
  ownSeq = (ownSeq + 1) % 100000;
  return `o${Date.now()}${String(ownSeq).padStart(5, '0')}`;
}

// Where each server has read up to. Kept per server id, because one bridge
// can serve several stands and they are not at the same place in the stream.
const cursors = new Map();

let http;

const discord = new DiscordSide(cfg, store, (key, msg) => {
  const stored = store.addMessage(key, msg);
  // Already seen: the gateway hands our own webhook posts back to us, and
  // without this the same line would reach the game twice.
  if (!stored) return;
  http?.wake();
});

const oauth = new OAuthSide(cfg, store, discord);

// The code table lives here and the Discord side redeems against it, so the
// bot never owns state the HTTP side cannot see.
const codes = new LinkCodes(store);
discord.useCodes(codes);

// The roster lives in its own file, not in the bridge state: store.save()
// rewrites the whole state document on every single chat message, and role
// ids have no business riding that.
const roles = new Roles(cfg.statePath.replace(/[^\\/]+$/, 'roles.json'));
discord.useRoles(roles);
const personas = new Personas('./state/personas.json');
discord.usePersonas(personas);

// Реєстр мусить уміти спитати, чи прив'язаний акаунт: без цього роль на
// комусь, хто ніколи не заходив у гру, рахувалась би як претензія на
// лідерство й знімала б його з живого лідера.
roles.useLinks((discordId) => !!store.steamIdOf(discordId));

// THE NOTEBOOK IS NOT HERE, AND MUST NOT BE BROUGHT HERE.
//
// This said "Discord is the truth for it, same doctrine as chat -- the
// owner's decision of 2026-08-28". That decision was written down and never
// built: there is no notes route, no notes storage and no notebook thread in
// this file or in discord.js. Notes have lived on the DEVICE the whole time,
// in OZ_PDA_Base.m_NotesJson, and the game's handler never once asks the
// bridge about them.
//
// The decision was then REVERSED (TZ-2 R1.2): the device is their home, and
// Discord may only ever be a mirror of it, off by default. The reason is the
// doctrine the whole device stands on -- steal the PDA and you get exactly
// what is written on it -- and R3.3 spells out the cost of the mirror:
// a private thread is visible to any moderator holding MANAGE_THREADS, so
// turning it on hands every player's notes to the guild staff.
//
// The comment is kept, rather than deleted, because it nearly cost a
// rewrite: read as a statement of fact it invites someone to "restore" a
// path the owner has since cancelled.

// Members of a conversation, as Discord ids, skipping whoever has not linked.
function discordIdsOf(members) {
  return members.map((uid) => store.linkOf(uid)?.discordId).filter(Boolean);
}

async function startConversation(key, kind, title, members) {
  const thread = await discord.ensureThread(key, title, discordIdsOf(members));
  store.putConvo(key, {
    threadId: thread.id,
    kind,
    title,
    members,
    createdAt: new Date().toISOString(),
  });
  return key;
}

// Shared map marks are couriers, not backups: five minutes on the wire,
// then the message is deleted -- from Discord first, then from the store,
// so neither reopening nor /older can resurrect it. Owner's decision
// 2026-08-29: without the TTL, chats turn into permanent marker vaults.
// One-shot pushes outside the message store: a toast the game shows once.
// Memory only -- a missed toast is a shrug, the invite itself persists in
// the store and shows up in the chat list anyway.
const pendingPushes = [];
let pushSeq = 0;
const pushSeen = new Map(); // ServerId -> last seq handed out
function queuePush(uid, line, kind = 'chat') {
  pushSeq += 1;
  // uid null -- розголос: конверт їде кожному серверу один раз, а вже гра
  // рознесе його всім своїм гравцям.
  pendingPushes.push({ seq: pushSeq, uid, kind, json: JSON.stringify(line) });
  while (pendingPushes.length > 200) pendingPushes.shift();
}
const stampNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const MARK_TTL_MS = 5 * 60 * 1000;
const markStale = (m) => typeof m.text === 'string' && m.text.startsWith('[MARK] ')
  && parseAt(m.at) > 0 && parseAt(m.at) < Date.now() - MARK_TTL_MS;

const selfGranted = new Set();
async function sweepMarks() {
  for (const gone of store.expiredMarks(Date.now() - MARK_TTL_MS, parseAt)) {
    try {
      if (gone.threadId) await discord.deleteMessage(gone.threadId, gone.id);
      store.dropMessage(gone.key, gone.id);
    } catch (err) {
      // Unknown Message: someone beat us to it -- the store record is all
      // that is left, so drop it. Missing Permissions: the bot cannot
      // delete webhook posts without Manage Messages -- try to grant
      // itself a channel overwrite once (it owns these channels), and if
      // Discord refuses that too, the guild owner has to tick the box.
      if (err?.code === 10008) store.dropMessage(gone.key, gone.id);
      else if (err?.code === 50013 && !selfGranted.has(gone.threadId)) {
        selfGranted.add(gone.threadId);
        try {
          const ch = await discord.client.channels.fetch(gone.threadId);
          const target = ch.isThread() ? ch.parent : ch;
          await target.permissionOverwrites.edit(discord.client.user.id, { ManageMessages: true });
          console.log(`[marks] granted itself Manage Messages in #${target.name}`);
        } catch (e2) {
          console.warn(`[marks] cannot self-grant Manage Messages (${e2.message}); ask the guild owner to enable it for the bot role`);
        }
      } else if (err?.code !== 50013) {
        console.warn(`[marks] ttl delete failed: ${err.message}`);
      }
    }
  }
}
setInterval(() => sweepMarks().catch((e) => console.warn(`[marks] sweep: ${e.message}`)), 30000);

async function pairFreeze(a, b, frozen) {
  if (!a || !b) return { Error: 'no_chat' };
  for (const [key, c] of Object.entries(store.data.convos)) {
    if (c.kind !== 'direct') continue;
    if (!c.members.includes(a) || !c.members.includes(b)) continue;

    c.pairFrozen = frozen;
    store.putConvo(key, c);
    if (c.threadId) {
      try { await discord.lockThread(c.threadId, frozen); }
      catch (err) { console.warn(`[chat] thread lock failed: ${err.message}`); }
    }
    return { ok: true };
  }
  // No conversation yet -- nothing to freeze, and that is fine.
  return { ok: true };
}

const routes = {
  // --- chat ---

  '/v1/chat/list': async ({ Json }) => {
    const { Uid: uid, Until: untilRaw } = Json;
    // A frozen device reads its owner's account AS OF the freeze stamp:
    // everything newer is invisible, and the flag tells the client the
    // whole page is a reading room. The cut is done here on every request
    // instead of being cached on the device -- a cache would burn with the
    // server restart, while Discord remembers everything.
    const until = untilRaw ? parseAt(untilRaw) : 0;
    // The zone pins itself on top: it is the one conversation everybody
    // has, and burying it under private ones would hide the town square.
    const items = store.convosOf(uid)
      // A conversation born AFTER the freeze does not exist for the
      // capsule -- not even as a title in the list. The zone is exempt:
      // its createdAt is the bridge's install date, not the town
      // square's founding.
      .filter((c) => !until || c.kind === 'zone' || !c.createdAt || parseAt(c.createdAt) <= until)
      .sort((a, b) => (a.kind === 'zone' ? -1 : 0) - (b.kind === 'zone' ? -1 : 0))
      .map((c) => {
      const tail = until
        ? [...store.messagesOf(c.key, 1000)].reverse().find((m) => parseAt(m.at) <= until)
        : store.messagesOf(c.key, 1)[0];
      return {
        Id: c.key,
        Kind: c.kind,
        Title: c.title,
        Desc: c.desc || '',
        LastAt: tail?.at || '',
        LastText: tail?.text || '',
      };
    });
    const invites = until ? [] : store.invitesOf(uid)
      .map((i) => {
        const ic = store.convo(i.key);
        return ic ? { Id: i.key, Title: ic.title, From: store.nameOf(i.from) || '' } : null;
      })
      .filter(Boolean);

    return { Items: items, Invites: invites, Frozen: !!until };
  },

  '/v1/chat/open': async ({ Json }) => {
    const { Uid: uid, Id: key, Limit: limit, Until: untilRaw } = Json;
    const c = store.convo(key);
    if (!c || !Store.memberOf(c, uid)) return { Error: 'no_chat' };
    const until = untilRaw ? parseAt(untilRaw) : 0;

    // The default view is ONE 8-HOUR WINDOW, anchored to the conversation
    // itself: the window ends at NOW when the talk is live, otherwise at the
    // NEWEST message -- a quiet conversation still opens on its last page
    // instead of an empty one. Everything older loads page by page through
    // /older, each page one more 8-hour window.
    let all = store.messagesOf(key, 1000);
    if (until) all = all.filter((m) => parseAt(m.at) <= until);
    const shown = windowSlice(all, until || Date.now());
    const trimmed = all.length - shown.length;

    return {
      Id: key,
      Kind: c.kind,
      Title: c.title,
      Desc: c.desc || '',
      // GAME names first: the Zone knows one identity, and the Discord nick
      // is not it. The nick only fills in for people the game never saw.
      Members: c.kind === 'zone' ? [] : c.members.map((m) => store.nameOf(m) || store.linkOf(m)?.discordName || m),
      // Older exists if we trimmed anything here, or the store tail is at its
      // cap (the thread very likely goes further back than we remember).
      More: trimmed > 0 || all.length >= 100,
      Before: shown[0]?.id || '',
      Owner: key.startsWith(`g:${uid}:`),
      Frozen: !!until || (c.kind === 'direct' && !!c.pairFrozen),
      Lines: shown.map((m) => ({
        At: m.at,
        Who: m.who,
        Text: m.text,
        Mine: m.uid === uid,
        AUid: m.uid || '',
      })),
    };
  },

  // Older history, one page per call. Served from the store while it still
  // has older lines, then from the Discord thread itself -- Discord is the
  // truth and the only party that remembers past our tail.
  '/v1/chat/older': async ({ Json }) => {
    const { Uid: uid, Id: key, Before: before, Limit: limit, Until: untilRaw } = Json;
    const c = store.convo(key);
    if (!c || !Store.memberOf(c, uid)) return { Error: 'no_chat' };
    const until = untilRaw ? parseAt(untilRaw) : 0;

    const page = Math.min(limit || 50, 100);

    // 1) the store tail first: the previous 8-hour window, anchored to the
    // newest message OLDER than the current top -- a week-long silence is
    // skipped in one step instead of seven empty pages.
    let all = store.messagesOf(key, 1000);
    if (until) all = all.filter((m) => parseAt(m.at) <= until);
    let at = before ? all.findIndex((m) => m.id === before) : -1;
    if (at > 0) {
      const older = all.slice(0, at);
      const chunk = windowSlice(older, parseAt(older[older.length - 1].at) + 1);
      return {
        Id: key,
        More: older.length - chunk.length > 0 || !!c.threadId,
        Before: chunk[0]?.id || before,
        Lines: chunk.map((m) => ({ At: m.at, Who: m.who, Text: m.text, Mine: m.uid === uid, AUid: m.uid || '' })),
      };
    }

    // 2) the thread itself
    if (!c.threadId) return { Id: key, More: false, Before: before || '', Lines: [] };
    try {
      let lines = await discord.fetchOlder(c.threadId, before, page);

      // The store still knows the author of anything inside its tail, and
      // the Discord page overlaps the tail at its edge. Filling those in
      // from the tail costs one map lookup and recovers every game-relayed
      // line that has not aged out yet -- the ones Discord itself cannot
      // attribute, because a webhook post carries no author but a name.
      const known = new Map();
      for (const m of store.messagesOf(key, 1000)) if (m.uid) known.set(m.id, m.uid);
      for (const m of lines) if (!m.uid && known.has(m.id)) m.uid = known.get(m.id);
      // The anchor id already sits below the freeze stamp, so Discord pages
      // are pre-freeze by construction -- the filter only guards the edge
      // where the anchor itself was the oldest stored line.
      if (until) lines = lines.filter((m) => parseAt(m.at) <= until);
      // Stale marks deeper than the store tail: the sweep only walks the
      // store, so history is the one place they could still leak through.
      lines = lines.filter((m) => !markStale(m));
      // MINE IS DECIDED BY UID, NEVER BY NAME.
      //
      // This compared the reader's CURRENT name to the name on the line, and
      // both halves of that were wrong: rename yourself and your own history
      // stops being yours, and a namesake inherits it along with the accent
      // stripe. Names are the player's to change and the admin's to reuse;
      // only the id is nobody's to take.
      //
      // Unknown author -> not mine, no colour. A line that renders neutral is
      // a line nobody is lying about; the tiers above recover every case
      // where the answer is actually knowable.
      return {
        Id: key,
        More: lines.length === page,
        Before: lines[0]?.id || before || '',
        Lines: lines.map((m) => ({ At: m.at, Who: m.who, Text: m.text, Mine: !!m.uid && m.uid === uid, AUid: m.uid || '' })),
      };
    } catch (err) {
      console.warn(`[chat] older fetch failed: ${err.message}`);
      return { Error: 'discord_down' };
    }
  },

  '/v1/chat/start': async ({ Json }) => {
    const { Uid: uid, Name: name, OtherUid: otherUid, OtherName: otherName } = Json;
    store.rememberName(uid, name);
    store.rememberName(otherUid, otherName);

    // The id comes from the CHARACTER keys, not the SteamIDs: after a
    // permadeath the same account is a different person, and a key derived
    // from the pair of SteamIDs would drop that new character straight into
    // the dead one's conversation, history and all. Membership below stays
    // SteamIDs -- it is the account that reads and writes.
    const key = Store.directKey(Json.MyKey || uid, Json.OtherKey || otherUid);
    const c = store.convo(key);
    if (c) return { Id: key };
    await startConversation(key, 'direct', `${name} & ${otherName}`, [uid, otherUid]);
    return { Id: key };
  },

  '/v1/chat/group_new': async ({ Json }) => {
    const { Uid: uid, Title: title, Desc: desc } = Json;
    const key = `g:${uid}:${Date.now().toString(36)}`;
    await startConversation(key, 'group', title || 'group', [uid]);
    if (desc) {
      const c = store.convo(key);
      c.desc = byteClip(desc, 200);
      store.putConvo(key, c);
    }
    return { Id: key };
  },

  // Name and description of an existing group. Any member may edit: a group
  // small enough to fit a PDA screen runs on trust, not on ownership.
  '/v1/chat/group_edit': async ({ Json }) => {
    const { Uid: uid, Id: key, Title: title, Desc: desc } = Json;
    const c = store.convo(key);
    if (!c || !c.members.includes(uid)) return { Error: 'no_chat' };
    if (c.kind !== 'group') return { Error: 'not_group' };

    if (title && title !== c.title) {
      c.title = byteClip(title, 100);
      // The thread wears the same name people see in game. A rename that
      // fails in Discord is not fatal: the store is what the game lists.
      try {
        await discord.renameThread(c.threadId, c.title);
      } catch (err) {
        console.warn(`[chat] thread rename failed: ${err.message}`);
      }
    }
    if (desc !== undefined) c.desc = byteClip(desc, 200);

    store.putConvo(key, c);
    return { ok: true };
  },

  // A group ends when a member ends it: index entry and tail go at once,
  // and the thread follows -- the town square (zone) and direct talks have
  // no delete on purpose.
  '/v1/chat/group_del': async ({ Json }) => {
    const { Uid: uid, Id: key } = Json;
    const c = store.convo(key);
    if (!c || !c.members.includes(uid)) return { Error: 'no_chat' };
    if (c.kind !== 'group') return { Error: 'not_group' };
    // Deleting is the FOUNDER's act alone -- his uid is minted into the
    // key forever (owner's decision 2026-08-29).
    if (!key.startsWith(`g:${uid}:`)) return { Error: 'not_owner' };

    store.dropInvitesOf(key);
    delete store.data.convos[key];
    delete store.data.messages[key];
    store.save();

    if (c.threadId) {
      try {
        await discord.deleteThread(c.threadId, `group deleted by ${uid}`);
      } catch (err) {
        console.warn(`[chat] group thread delete failed: ${err.message}`);
      }
    }
    return { ok: true };
  },

  // The PAGER: a one-way line from a scripted NPC to one player. The game
  // server is the only caller (it holds the shared secret); the thread is
  // the usual Discord truth, the webhook wears the NPC's name, and the
  // conversation kind 'npc' makes every reader treat it as receive-only.
  '/v1/npc/say': async ({ Json, ServerId }) => {
    const { NpcId: npcId, Name: npcName, Uid: uid, Text: text } = Json;
    if (!npcId || !uid) return { Error: 'no_chat' };

    const key = `npc:${npcId}:${uid}`;
    let c = store.convo(key);
    if (!c) {
      await startConversation(key, 'npc', npcName || npcId, [uid]);
      c = store.convo(key);
    }
    // The NPC may be renamed between mod versions; the pager follows.
    if (npcName && c.title !== npcName) {
      c.title = npcName;
      store.putConvo(key, c);
    }

    // HOME FIRST, exactly like an ordinary line (TZ-2 R1.1: chat lives in
    // the bot). The pager used to depend on the Discord echo to exist at
    // all, so with the mirror off a scripted NPC would speak into nothing
    // and the player's device would never show the line.
    //
    // uid stays null and the game shows the NPC's name in the Who column --
    // the same mechanics the anonymous zone shout uses.
    const npcMirrored = mirrored(ServerId, 'chat');

    const line = store.addMessage(key, {
      id: ownId(),
      at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      uid: null,
      who: npcName || npcId,
      text: byteClip(text),
      fromDiscord: false,
      inDiscord: npcMirrored,
    });
    if (line) http?.wake();

    if (npcMirrored) {
      try {
        await discord.say(c.threadId, npcName || npcId, byteClip(text), null);
      } catch (err) {
        if (line) line.inDiscord = false;
        console.warn(`[npc] stored but not mirrored: ${err.message}`);
      }
    }

    return { ok: true };
  },

  // A broken contact freezes the DIRECT conversation between the two:
  // readable, but mute -- in the game and in the Discord thread alike.
  // A fresh handshake thaws it. Groups are untouched (owner's decision
  // 2026-08-29).
  '/v1/chat/pair_freeze': async ({ Json }) => pairFreeze(Json.A, Json.B, true),
  '/v1/chat/pair_thaw': async ({ Json }) => pairFreeze(Json.A, Json.B, false),

  '/v1/chat/group_add': async ({ Json }) => {
    const { Uid: uid, Id: key, OtherUid: otherUid, Max: max } = Json;
    const c = store.convo(key);
    if (!c || !c.members.includes(uid)) return { Error: 'no_chat' };
    if (c.kind !== 'group') return { Error: 'not_group' };
    if (c.members.includes(otherUid)) return { Error: 'already_in' };

    // The ceiling comes from the game's Tuning.json with every invite; the
    // bridge only holds the roster. Zero (or absent) means no ceiling.
    if (Number.isInteger(max) && max > 0 && c.members.length >= max) {
      return { Error: 'group_full' };
    }

    // Nobody lands in a group unasked (owner's decision 2026-08-29): the
    // add files an INVITE, membership waits for the invitee's own click.
    // The toast rides the ordinary chat-push pipe -- the HUD already knows
    // how to ring about a line.
    store.addInvite(key, otherUid, uid);
    queuePush(otherUid, {
      Uid: otherUid,
      Id: '',
      At: stampNow(),
      Who: store.nameOf(uid) || '',
      Text: `Запрошення до групи «${c.title}»`,
      Mine: false,
    });
    return { ok: true };
  },

  '/v1/chat/invite_accept': async ({ Json }) => {
    const { Uid: uid, Id: key } = Json;
    if (!store.hasInvite(key, uid)) return { Error: 'no_chat' };
    const c = store.convo(key);
    store.dropInvite(key, uid);
    if (!c) return { Error: 'no_chat' };

    if (!c.members.includes(uid)) {
      c.members.push(uid);
      store.putConvo(key, c);
    }
    await discord.ensureThread(key, c.title, discordIdsOf(c.members));
    return { ok: true };
  },

  '/v1/chat/invite_decline': async ({ Json }) => {
    store.dropInvite(Json.Id, Json.Uid);
    return { ok: true };
  },

  '/v1/chat/group_leave': async ({ Json }) => {
    const { Uid: uid, Id: key } = Json;
    const c = store.convo(key);
    if (!c || !c.members.includes(uid)) return { Error: 'no_chat' };
    if (c.kind !== 'group') return { Error: 'not_group' };
    // The creator does not leave -- he deletes: a group whose key names an
    // absent founder would be deletable by nobody at all.
    if (key.startsWith(`g:${uid}:`)) return { Error: 'not_owner' };

    c.members = c.members.filter((m) => m !== uid);
    store.putConvo(key, c);
    return { ok: true };
  },

  '/v1/chat/send': async ({ Json, ServerId }) => {
    const { Uid: uid, Name: name, Id: key, Text: text, Anon: anon } = Json;
    store.rememberName(uid, name);
    const c = store.convo(key);
    if (!c || !Store.memberOf(c, uid)) return { Error: 'no_chat' };

    // A frozen pair reads its history and says nothing new.
    if (c.kind === 'direct' && c.pairFrozen) return { Error: 'read_only' };

    // The pager is one-way by design: NPC lines come in, nothing goes out.
    // The game hides the input, and this is the fence for a client that
    // did not.
    if (c.kind === 'npc') return { Error: 'read_only' };

    // ANONYMOUS is a zone-chat right, not a general one: in a private
    // conversation the other side chose WHO they talk to, and stripping
    // the name there would break that choice. In the zone anyone may
    // shout into the dark -- the owner asked for exactly this.
    //
    // Anonymity means the echo is claimed by nobody: no expect is filed,
    // the stored line keeps uid null, and even the sender's own device
    // shows it as not-theirs. Deniability is the point. The real sender
    // is in the game server's log, nowhere else.
    // STORED FIRST, MIRRORED SECOND. The order is the whole point.
    //
    // This used to read "sent, not stored: it becomes part of the
    // conversation when Discord hands it back over the gateway". That made
    // Discord the HOME of the chat, not its surface -- and it is why turning
    // Discord off used to mean losing chat rather than moving it (TZ-2 §2).
    // With the mirror off, a line sent that way went nowhere and was kept
    // nowhere: the player watched his own words disappear.
    //
    // Now the record is ours from the moment it exists, and Discord is one
    // more place it may also appear.
    const who = (anon && c.kind === 'zone') ? 'Невідомий сталкер' : name;

    // Anonymity means the line is claimed by nobody: uid stays null, and even
    // the sender's own device shows it as not-theirs. Deniability is the
    // point. The real sender is in the game server's log, nowhere else.
    const author = (anon && c.kind === 'zone') ? null : uid;

    // Whether this line will also exist in Discord decides whether the store
    // is allowed to drop it later. Read BEFORE the post, because the answer
    // is about the configuration, not about whether the post succeeded: a
    // guild that refused us is not a guild that has the line.
    const alsoInDiscord = mirrored(ServerId, 'chat');

    const stored = store.addMessage(key, {
      id: ownId(),
      at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      uid: author,
      who,
      text: byteClip(text),
      fromDiscord: false,
      inDiscord: alsoInDiscord,
    });
    if (stored) http?.wake();

    // MIRROR IS A SURFACE, AND FAILING TO REACH IT IS NOT LOSING THE LINE.
    //
    // The line is already home. If the guild refuses -- rate limit, missing
    // permission, deleted thread -- we say so in the log and still answer ok,
    // because from the player's side the message WAS delivered: it is in his
    // conversation and every other member will read it.
    if (alsoInDiscord) {
      try {
        await discord.say(c.threadId, who, text, author);
      } catch (err) {
        // The guild refused, so the line is NOT there -- say so in the
        // record, or the store would later drop it believing Discord has a
        // copy that does not exist.
        if (stored) stored.inDiscord = false;
        console.warn(`[chat] stored but not mirrored: ${err.message}`);
      }
    }

    return { ok: true };
  },

  // Permadeath: the game asks, the bridge executes its half. Faction
  // lifecycle deliberately has NO route -- factions are born and die only
  // through the bot commands (owner's decision 2026-08-30).
  '/v1/player/wipe': async ({ Json }) => {
    const r = await wipePlayer(Json.Uid);

    // WHO STARTED IT decides who still has work to do. From the game's own
    // admin console (FromGame) the game has already frozen the character
    // and sealed his devices, and a push back would do it a second time.
    // From anywhere else — the bot command, an admin tool — the game has
    // heard nothing yet, and without this line a wipe reset the Discord
    // roles while every PDA of the dead character kept working.
    if (r.ok && !Json.FromGame) queuePush(null, { Uid: Json.Uid }, 'wipe');

    return { Ok: !!r.ok, Why: r.why || '' };
  },

  // --- news ---
  '/v1/news/list': async () => news.list(),
  '/v1/news/open': async ({ Json }) => news.open(Json.Id),

  // WHICH NAMES THIS PERSON MAY SIGN WITH (TZ-6 R2.1).
  //
  // Both surfaces ask before they draw: the PDA to fill a leader's chooser,
  // the VPP console to fill the admin's. The CLIENT never invents this list
  // and never decides rights from it -- it draws what it is given, and the
  // write route checks again anyway. Two checks, because a list is a hint
  // and a grant is a fact.
  '/v1/news/voices': async ({ Json }) => {
    const uid = Json && Json.Uid;
    const link = uid ? store.linkOf(uid) : null;
    const member = link ? discord.memberOf(link.discordId) : null;
    const resolved = member && roles ? roles.resolve(member) : null;
    const admin = member ? discord.isAdminMember(member) : false;

    return {
      // The name he signs with when he picks nobody. Empty for someone the
      // bridge cannot name at all, and the page says so rather than offering
      // an author it made up.
      Self: (uid && store.nameOf(uid)) || member?.displayName || '',
      Admin: admin,
      Leader: !!(resolved && resolved.Posts && resolved.Posts.includes('leader')),
      Org: (resolved && resolved.Org) || '',
      Voices: personas.allowedFor(resolved, admin),
    };
  },

  // WRITING a news post from the game (TZ-6 R3.1).
  //
  // TWO CALLERS, ONE ROUTE: the admin console in VPP and a faction leader's
  // PDA. The game checks its own side -- IsAdmin for the console, a device
  // and a session for the page -- and this checks the other: who may write
  // at all, and whose voice a persona is.
  //
  // Both checks are needed and neither replaces the other. The server decides
  // who may reach a surface; only the bridge knows who leads what, because
  // leadership lives in the guild's roles. A server trusted about the second
  // would let a compromised console speak as anyone.
  '/v1/news/post': async ({ Json }) => {
    const { Uid: uid, Who: asName, Title: title, Body: body } = Json || {};

    if (!title || !String(title).trim()) return { Error: 'no_title' };
    if (!body || !String(body).trim()) return { Error: 'no_body' };

    const link = uid ? store.linkOf(uid) : null;
    const member = link ? discord.memberOf(link.discordId) : null;
    const resolved = member && roles ? roles.resolve(member) : null;
    const admin = member ? discord.isAdminMember(member) : false;

    // WHO MAY WRITE AT ALL (TZ-6 §2). Admins and faction leaders, nobody
    // else -- not a member of an organisation, not a linked stalker, not an
    // unlinked one. Checked before the voice, because "you may not write"
    // and "that is not your name" are different refusals and the first one
    // has to come first.
    const leader = !!(resolved && resolved.Posts && resolved.Posts.includes('leader'));
    if (!admin && !leader) return { Error: 'not_allowed' };

    // Under his own game name unless he names a voice.
    let who = (uid && store.nameOf(uid)) || member?.displayName || '';

    // ONE RULE FOR BOTH SURFACES AND BOTH KINDS OF CALLER (TZ-6 R1.2/R1.4).
    //
    // allowedFor() is the whole answer: every persona for an admin, the ones
    // granted to his organisation for a leader, nothing for anyone else. The
    // leader picks among his own -- an organisation may hold several names,
    // and choosing between them is his.
    //
    // The refusal carries the list, because "not your voice" without saying
    // which are is the kind of answer that sends someone reading source.
    const wanted = String(asName || '').trim();
    if (wanted) {
      const allowed = personas.allowedFor(resolved, admin);
      if (!allowed.includes(wanted)) return { Error: 'not_your_voice', Allowed: allowed };
      who = wanted;
    } else if (!admin && !who) {
      // Nobody we can name: an unlinked non-admin has no author at all.
      return { Error: 'no_author' };
    }

    if (!who) return { Error: 'no_author' };

    try {
      await news.post(who, String(title).trim(), String(body));
      return { ok: true, Who: who };
    } catch (err) {
      // Words, not a code: the admin whose post did not appear will go
      // looking for a fault otherwise (R3.3).
      console.warn(`[news] post from the game failed: ${err.message}`);
      return { Error: 'post_failed', Why: err.message };
    }
  },

  // --- account link ---

  // A short code, not a URL. The player reads it off the PDA screen and runs
  // /link <code> in Discord; the bot knows who they are from the interaction.
  // Url is still returned for anyone running the old OAuth flow, but the game
  // shows the code.
  '/v1/link/begin': async ({ Json }) => {
    const c = codes.mint(Json.Uid);
    return { Code: c.code, ExpiresInSec: c.expiresInSec, Url: oauth.begin(Json.Uid) };
  },

  // DiscordId comes back too. The game stores it as the fact of the link --
  // without it the server had nothing true to write and would have had to
  // invent something, which is how a field ends up holding a SteamID under a
  // name that says Discord.
  '/v1/link/status': async ({ Json }) => {
    const l = store.linkOf(Json.Uid);
    return {
      Linked: !!l,
      DiscordId: l?.discordId || '',
      DiscordName: l?.discordName || '',
    };
  },

  // The game asking for somebody's roles to be CHANGED.
  //
  // The only inbound write there is, and deliberately the only one. The game
  // holds no faction of its own: it asks here, the Discord role changes, and
  // the change reaches the game as an ordinary projection on the next poll.
  // One home for the fact and one direction of travel -- so a refusal here
  // means nothing changed anywhere, which is what makes it safe to report the
  // refusal honestly instead of papering over it.
  //
  // AUTHORITY IS RE-CHECKED HERE. The game holds the shared secret and is
  // trusted, and it does its own check first; that does not make it the only
  // thing between a player and a role. Admin is the exception: whether a
  // SteamID is a server admin is knowledge only the game has, so that claim
  // is taken on the secret alone.
  '/v1/roles/apply': async ({ Json }) => {
    if (!discord.guild) return { Ok: false, Why: 'the bot is not connected' };

    const targetLink = store.linkOf(Json.TargetUid);
    if (!targetLink) return { Ok: false, Why: 'that player has not linked a Discord account' };

    const target = discord.memberOf(targetLink.discordId);
    if (!target) return { Ok: false, Why: 'that player is not in this Discord server' };

    // The actor is absent for an admin action -- the game vouches for it.
    let actor = null;
    if (Json.ActorUid) {
      const actorLink = store.linkOf(Json.ActorUid);
      if (!actorLink) return { Ok: false, Why: 'you have not linked a Discord account' };
      actor = discord.memberOf(actorLink.discordId);
      if (!actor) return { Ok: false, Why: 'you are not in this Discord server' };
    }

    if (!Json.Admin) {
      const gate = leaderMay(actor, Json.Op, Json.Arg, target);
      if (!gate.ok) return { Ok: false, Why: gate.why };
    }

    const r = await roles.apply(discord.guild, actor, target, Json.Op, Json.Arg);
    if (!r.ok) return { Ok: false, Why: r.why };

    console.log(`[roles] ${Json.Admin ? 'admin' : Json.ActorUid} ${Json.Op} ${Json.Arg || ''} -> ${Json.TargetUid}`);
    return { Ok: true, Why: '' };
  },
};

// What a leader is allowed to do, and only inside his own faction.
//
// Separate from roles.apply on purpose: apply answers "can this role change
// be made", this answers "is this person allowed to ask for it". Mixing them
// is how an authority check ends up depending on whether a role happens to
// exist.
function leaderMay(actor, op, arg, target) {
  if (!actor) return { ok: false, why: 'only a faction leader can do that' };

  // LEAVING IS NOBODY'S PERMISSION BUT YOUR OWN. Joining takes an
  // invitation you accepted, and the way out has to be symmetrical: with
  // this gate demanding leadership, the only way to leave a faction was to
  // ask its leader to expel you -- who may be the person you are leaving.
  // The leader may leave too; the post passes down on the same change.
  if (op === 'faction.clear' && actor.id === target.id) return { ok: true };

  // The ORG axis, not the base one: leadership, membership and expulsion
  // only exist inside an organisation. Everybody is a stalker, and being a
  // stalker gives authority over nobody (TZ-1 R8.1).
  const view = roles.resolve(actor);
  if (!view.Org) return { ok: false, why: 'you are not in a faction' };
  if (!view.Posts.includes('leader')) return { ok: false, why: 'only the leader of a faction can do that' };

  const mine = view.Org;

  // Taking somebody INTO the faction is the one case where the target is not
  // yet a member, so it is checked against the faction being joined.
  if (op === 'faction.set') {
    if (arg !== mine) return { ok: false, why: 'you can only take players into your own faction' };
    return { ok: true };
  }

  // Everything else acts on somebody who must already be one of his.
  const theirs = roles.resolve(target).Org;
  if (theirs !== mine) return { ok: false, why: 'that player is not in your faction' };

  if (op === 'faction.clear') return { ok: true };
  if (op === 'leader.transfer') return { ok: true };

  // Promote and demote INSIDE his own faction -- the faction rank ladder is
  // the leader's to run (owner's decision 2026-08-30). The arg is a bare
  // slug and apply() resolves it against the TARGET's faction, which this
  // gate just proved is his own. The stalker ranks stay admin-only: they
  // never pass through here, being a different op.
  if (op === 'frank.set') return { ok: true };

  if (op === 'post.add' || op === 'post.remove') {
    if (!arg || !arg.startsWith(mine + ':')) return { ok: false, why: 'that post does not belong to your faction' };
    // Leadership is handed over, never handed out: a leader who can grant the
    // leader post can mint a second leader, and then neither of them is one.
    if (arg === mine + ':leader') return { ok: false, why: 'use hand over leadership for that' };
    return { ok: true };
  }

  return { ok: false, why: 'only an administrator can do that' };
}

// What a polling server has not seen yet. The cursor is per server, and it
// only moves once we have handed the batch over.
// What roster stamp each polling server has already been handed.
// Memory only: a bridge restart re-sends it once, which is right --
// the game may have restarted too and we cannot know.
const rosterSeen = new Map();

// What role projection each polling server has already been handed, per
// player: ServerId -> Map(uid -> the exact JSON we sent).
const rolesSeen = new Map();

// WHICH KINDS THIS SERVER SHOWS IN THE GUILD, per server id.
//
// The game asserts it on every poll rather than announcing it once: the list
// is a handful of short strings, and the alternative would have the bot
// remembering state across its own restarts and disagreeing with the server's
// file exactly when that file was edited while the bot was down.
//
// Absent entry means "we have not heard from that server yet", and that is
// deliberately NOT the same as "nothing is mirrored" -- see mirrored().
const mirrors = new Map();

// Off unless the server said otherwise. A bot that has not yet heard the
// server's configuration must not post to the guild on a guess: the quiet
// failure (a missing thread) is recoverable, the loud one (private chat
// spilled into Discord) is not.
function mirrored(serverId, kind) {
  const list = mirrors.get(serverId);
  if (!list) return false;
  return list.has(kind);
}

function drain({ ServerId, Cursor, Uids, Fresh, Mirrors }) {
  if (Array.isArray(Mirrors)) {
    // Said only when it CHANGES. The list rides every poll -- seven times a
    // minute per server -- and a line each time would bury the one moment
    // that matters. Silence here means "still the same".
    const was = mirrors.get(ServerId);
    const now = new Set(Mirrors);
    const same = was && was.size === now.size && [...now].every((k) => was.has(k));
    if (!same) {
      const what = Mirrors.length ? Mirrors.join(', ') : 'nothing - the guild stays quiet';
      console.log(`[mirror] ${ServerId} shows: ${what}`);
    }
    mirrors.set(ServerId, now);
  }
  const from = Number.isInteger(Cursor) ? Cursor : (cursors.get(ServerId) ?? 0);

  // The game says so itself when it has just started and remembers nothing.
  // Everything this server was told before that is void.
  if (Fresh) {
    rosterSeen.delete(ServerId);
    rolesSeen.delete(ServerId);
  }

  const items = [];
  for (const uid of Uids || []) {
    for (const m of store.since(uid, from)) {
      const pc = store.convo(m.key);
      items.push({
        Kind: 'chat',
        Json: JSON.stringify({
          Uid: uid,
          Id: m.key,
          At: m.at,
          Who: m.who,
          Text: m.text,
          Mine: m.uid === uid,
          AUid: m.uid || '',
          Kind: pc ? pc.kind : '',
          Title: pc ? pc.title : '',
        }),
      });
    }
  }

  // Queued one-shot pushes (invite toasts). A server we have not met yet
  // starts from "now": stale toasts are not worth replaying.
  const seenSeq = pushSeen.has(ServerId) ? pushSeen.get(ServerId) : pushSeq;
  for (const p of pendingPushes) {
    if (p.seq <= seenSeq) continue;
    if (p.uid && !(Uids || []).includes(p.uid)) continue;
    items.push({ Kind: p.kind || 'chat', Json: p.json });
  }
  pushSeen.set(ServerId, pushSeq);

  // The roster, but ONLY when it changed for this server.
  //
  // Two kilobytes seven times a minute for data that changes once a month
  // would be silly. Per-ServerId because one bridge serves several stands
  // and they restart independently -- a server that just came back needs
  // it again even though nothing changed.
  const stamp = roles.stamp();
  if (rosterSeen.get(ServerId) !== stamp) {
    // Several items, one roster. A single big one does not survive the wire:
    // the game gets the Json field TRUNCATED and says "Missing a closing
    // quotation mark". Measured -- 805 bytes arrives, ~1200 does not.
    //
    // The pieces need no reassembly on the far side: ApplyRoster adds and
    // updates and never deletes, so a roster in three parts is the roster.
    for (const part of roles.rosterParts()) {
      items.push({ Kind: 'roster', Json: JSON.stringify(part) });
    }
    rosterSeen.set(ServerId, stamp);
  }

  // Roles, for the linked players this server is asking about -- ONLY when
  // the projection actually changed for this server.
  //
  // This used to be sent every poll, because the bridge cannot tell a server
  // that has run for an hour from one that restarted a second ago. That was
  // the wrong answer to a real problem, and it cost the whole long poll: an
  // item on every poll means the batch is never empty, a batch that is never
  // empty means the hold never engages, and the game re-asks on the next
  // FRAME. Measured on the stand -- 5020 polls in five minutes, seventeen a
  // second, against 0.12 a second before anybody linked. On a game server
  // with exactly one core.
  //
  // The right answer is to let the game say so. It sets Fresh on its first
  // poll after start-up, which voids everything remembered here.
  //
  // UNLINKED PLAYERS ARE OMITTED, not sent empty. Absent means "we know
  // nothing about him"; an empty projection would mean "Discord says he has
  // no faction", and the game treats those two very differently -- one falls
  // back to the account file, the other overrides it.
  let seen = rolesSeen.get(ServerId);
  if (!seen) {
    seen = new Map();
    rolesSeen.set(ServerId, seen);
  }

  for (const uid of Uids || []) {
    const view = rolesFor(uid);
    if (!view) {
      // Cannot answer for him now. Drop what we remember, so the projection
      // is sent again the moment we can -- otherwise a player whose link is
      // being repaired would stay on a stale faction until he next changes
      // a Discord role.
      seen.delete(uid);
      continue;
    }

    const json = JSON.stringify({ Uid: uid, ...view });
    if (seen.get(uid) === json) continue;

    items.push({ Kind: 'roles', Json: json });
    seen.set(uid, json);
  }

  // Forget whoever left. He may come back to a server that restarted while
  // he was away, and the projection has to reach him again.
  for (const uid of [...seen.keys()]) {
    if (!(Uids || []).includes(uid)) seen.delete(uid);
  }

  cursors.set(ServerId, store.cursor);
  return { Cursor: store.cursor, Items: items };
}

// PERMADEATH, the bridge half. The character is dead, the PLAYER stays:
// the Discord link survives, the news he posted survive, the zone channel
// is public anyway.
//
// WHAT THE SURVIVORS KEEP, and this is the whole rule (owner's decision
// 2026-08-30): everything. The conversation, the group, the contact, the
// history — all of it stays exactly where it was. Deleting a thread or a
// contact would ANNOUNCE THE DEATH: a line that disappears says only one
// thing, and the PDA never tells anybody that somebody died.
//
// What actually happens is that the dead man's ACCOUNT stops being in the
// room. He is removed from every private thread on the Discord side, so he
// reads and writes nothing there any more, while the record of the
// conversation — and every message in it — stays for the people who were
// in it with him.
//
// His next character is a different person: the game addresses contacts by
// character key, so a new life starts unknown to everyone and its threads
// are new threads.
async function wipePlayer(uid) {
  if (!uid) return { ok: false, why: 'no uid' };

  const link = store.linkOf(uid);
  const discordId = link?.discordId || '';

  // З приватних тредiв -- геть, але самi треди лишаються жити.
  for (const key of store.allConvoKeys()) {
    const c = store.convo(key);
    if (!c || !c.members || !c.members.includes(uid)) continue;
    if (c.kind !== 'group' && c.kind !== 'direct') continue;

    if (discordId && c.threadId) {
      try {
        const th = await discord.client.channels.fetch(c.threadId);
        await th.members.remove(discordId);
      } catch {
        // Тред мiг зникнути, або учасника там уже немає -- склад у сторi
        // все одно виправляється нижче.
      }
    }

    // Зi складу розмови його прибираємо: iнакше наступний ensureThread
    // запросив би той самий акаунт назад.
    c.members = c.members.filter((m) => m !== uid);
    store.putConvo(key, c);
  }

  // Ролi: усе геть, новачок назад -- нове життя починається з нуля.
  if (discordId) {
    try {
      const member = await discord.guild.members.fetch({ user: discordId, force: true });

      // The factions he held, noted BEFORE the roles come off: leadership
      // there may need to pass on, and after the removal nobody remembers.
      const ledFrom = [];
      for (const f of roles.data.Factions) {
        if (!f.Base && f.RoleId && member.roles.cache.has(f.RoleId)) ledFrom.push(f.Slug);
      }

      // ONE atomic PATCH: strip every registry role and hand out the new
      // life in the same request. Two array calls would each rebuild the
      // full list from a cache the other has already outdated -- the same
      // measured race that once glued a member into two factions.
      const dropSet = new Set();
      for (const e of roles.entries()) {
        if (e.node.RoleId && member.roles.cache.has(e.node.RoleId)) dropSet.add(e.node.RoleId);
      }

      // A new life starts where every life in the Zone starts: the stalker
      // base identity plus the novice rank.
      const fresh = [];
      const base = roles.base();
      if (base?.RoleId) fresh.push(base.RoleId);
      const novice = (roles.data.Ranks || []).find((rk) => rk.Slug === 'stalker-novice');
      if (novice?.RoleId) fresh.push(novice.RoleId);

      const current = [...member.roles.cache.keys()];
      const final = current.filter((id) => !dropSet.has(id));
      for (const id of fresh) if (!final.includes(id)) final.push(id);
      await member.roles.set(final, 'OpenZone: permadeath, a new life begins');

      const moved = { id: member.id, roleIds: new Set(final) };
      for (const slug of ledFrom) {
        await roles.ensureLeadership(discord.guild, slug, 'the leader was wiped', moved);
      }
    } catch (err) {
      return { ok: false, why: 'Discord refused: ' + err.message };
    }
  }

  console.log(`[wipe] ${uid} started over`);
  return { ok: true };
}

// One player's roles, or null when we cannot answer for him.
function rolesFor(uid) {
  const link = store.linkOf(uid);
  if (!link) return null;

  const member = discord.memberOf(link.discordId);
  if (!member) return null;

  // The Discord display name rides along: the admin console shows it next
  // to the in-game name, and only the projection ever reaches the game.
  return { ...roles.resolve(member), DName: member.displayName || '' };
}

http = new HttpSide(cfg, {
  routes,
  drain,
  oauthCallback: (req, res) => oauth.callback(req, res),
});

// The bot command is a wipe started OUTSIDE the game, so the game has to be
// told: it freezes the character's record and seals his devices on the push.
discord.onWipe = async (uid) => {
  const r = await wipePlayer(uid);
  if (r.ok) queuePush(null, { Uid: uid }, 'wipe');
  return r;
};

await discord.start();

// The store is the home for news too (owner, 2026-09-01). Passing it here
// is the whole wiring: News reads what it already owns at construction and
// writes through on every change.
const news = new News(store);
news.onFresh = (p) => queuePush(null, { Id: p.Id, Title: p.Title, Who: p.Who, At: p.At }, 'news');

// Typed homes for threads: direct talks and groups each get their own
// channel; the ids live in the bridge state so a rename survives.
{
  const d = await discord.ensureTypedChannel(
    'пда-розмови',
    'Особисті розмови з КПК. Пишіть у своїх тредах — сам канал порожній.',
    store.guildRef?.('directChannelId'),
  );
  discord.directChannel = d;
  store.setGuildRef?.('directChannelId', d.id);

  const g = await discord.ensureTypedChannel(
    'пда-групи',
    'Групові розмови з КПК. Пишіть у своїх тредах — сам канал порожній.',
    store.guildRef?.('groupChannelId'),
  );
  discord.groupChannel = g;
  store.setGuildRef?.('groupChannelId', g.id);
}

// The zone exists from the first boot: one conversation for everyone,
// members ['*'] -- the wildcard Store.memberOf understands.
{
  const known = store.convo('zone');
  const ch = await discord.ensureZoneChannel(known?.threadId);
  if (!known || known.threadId !== ch.id) {
    // The first cut of the zone was a public thread; a stray one is
    // deleted rather than left as a second town square.
    if (known?.threadId) {
      await discord.deleteThread(known.threadId, 'the zone moved to its own channel').catch(() => {});
    }
    store.putConvo('zone', {
      threadId: ch.id, // the channel id rides in the thread field: convoByThread keeps working
      kind: 'zone',
      title: 'Зона',
      members: ['*'],
      createdAt: known?.createdAt || new Date().toISOString(),
    });
  }
}

discord.useNews(news);
await news.start(discord, store.guildRef?.('newsChannelId')).then((ch) => store.setGuildRef?.('newsChannelId', ch.id));

await http.listen();
console.log('[bridge] ready');
