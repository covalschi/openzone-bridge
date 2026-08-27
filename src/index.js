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
import { Store } from './store.js';
import { DiscordSide } from './discord.js';
import { HttpSide } from './http.js';
import { OAuthSide } from './oauth.js';
import { LinkCodes } from './codes.js';
import { Roles } from './roles.js';

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
};

const store = new Store(cfg.statePath);

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

const routes = {
  // --- chat ---

  '/v1/chat/list': async ({ Json }) => {
    const { Uid: uid } = Json;
    const items = store.convosOf(uid).map((c) => {
      const tail = store.messagesOf(c.key, 1)[0];
      return {
        Id: c.key,
        Kind: c.kind,
        Title: c.title,
        LastAt: tail?.at || '',
        LastText: tail?.text || '',
      };
    });
    return { Items: items };
  },

  '/v1/chat/open': async ({ Json }) => {
    const { Uid: uid, Id: key, Limit: limit } = Json;
    const c = store.convo(key);
    if (!c || !c.members.includes(uid)) return { Error: 'no_chat' };

    return {
      Id: key,
      Kind: c.kind,
      Title: c.title,
      Members: c.members.map((m) => store.linkOf(m)?.discordName || m),
      Lines: store.messagesOf(key, limit || 50).map((m) => ({
        At: m.at,
        Who: m.who,
        Text: m.text,
        Mine: m.uid === uid,
      })),
    };
  },

  '/v1/chat/start': async ({ Json }) => {
    const { Uid: uid, Name: name, OtherUid: otherUid, OtherName: otherName } = Json;
    const key = Store.directKey(uid, otherUid);
    const c = store.convo(key);
    if (c) return { Id: key };
    await startConversation(key, 'direct', `${name} & ${otherName}`, [uid, otherUid]);
    return { Id: key };
  },

  '/v1/chat/group_new': async ({ Json }) => {
    const { Uid: uid, Title: title } = Json;
    const key = `g:${uid}:${Date.now().toString(36)}`;
    await startConversation(key, 'group', title || 'group', [uid]);
    return { Id: key };
  },

  '/v1/chat/group_add': async ({ Json }) => {
    const { Uid: uid, Id: key, OtherUid: otherUid } = Json;
    const c = store.convo(key);
    if (!c || !c.members.includes(uid)) return { Error: 'no_chat' };
    if (c.kind !== 'group') return { Error: 'not_group' };
    if (c.members.includes(otherUid)) return { Error: 'already_in' };

    c.members.push(otherUid);
    store.putConvo(key, c);
    await discord.ensureThread(key, c.title, discordIdsOf(c.members));
    return { ok: true };
  },

  '/v1/chat/send': async ({ Json }) => {
    const { Uid: uid, Name: name, Id: key, Text: text } = Json;
    const c = store.convo(key);
    if (!c || !c.members.includes(uid)) return { Error: 'no_chat' };

    // Sent, not stored. It becomes part of the conversation when Discord
    // hands it back over the gateway — that is what "Discord is the truth"
    // means in practice.
    await discord.say(c.threadId, name, text, uid);
    return { ok: true };
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

  const view = roles.resolve(actor);
  if (!view.Faction) return { ok: false, why: 'you are not in a faction' };
  if (!view.Posts.includes('leader')) return { ok: false, why: 'only the leader of a faction can do that' };

  const mine = view.Faction;

  // Taking somebody INTO the faction is the one case where the target is not
  // yet a member, so it is checked against the faction being joined.
  if (op === 'faction.set') {
    if (arg !== mine) return { ok: false, why: 'you can only take players into your own faction' };
    return { ok: true };
  }

  // Everything else acts on somebody who must already be one of his.
  const theirs = roles.resolve(target).Faction;
  if (theirs !== mine) return { ok: false, why: 'that player is not in your faction' };

  if (op === 'faction.clear') return { ok: true };
  if (op === 'leader.transfer') return { ok: true };

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

function drain({ ServerId, Cursor, Uids, Fresh }) {
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
      items.push({
        Kind: 'chat',
        Json: JSON.stringify({
          Uid: uid,
          Id: m.key,
          At: m.at,
          Who: m.who,
          Text: m.text,
          Mine: m.uid === uid,
        }),
      });
    }
  }

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

// One player's roles, or null when we cannot answer for him.
function rolesFor(uid) {
  const link = store.linkOf(uid);
  if (!link) return null;

  const member = discord.memberOf(link.discordId);
  if (!member) return null;

  return roles.resolve(member);
}

http = new HttpSide(cfg, {
  routes,
  drain,
  oauthCallback: (req, res) => oauth.callback(req, res),
});

await discord.start();
await http.listen();
console.log('[bridge] ready');
