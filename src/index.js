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
  holdSeconds: Number(process.env.POLL_HOLD_SECONDS || 25),
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
    const { uid } = Json;
    const items = store.convosOf(uid).map((c) => {
      const tail = store.messagesOf(c.key, 1)[0];
      return {
        Key: c.key,
        Kind: c.kind,
        Title: c.title,
        LastAt: tail?.at || '',
        LastText: tail?.text || '',
      };
    });
    return { Items: items };
  },

  '/v1/chat/open': async ({ Json }) => {
    const { uid, key, limit } = Json;
    const c = store.convo(key);
    if (!c || !c.members.includes(uid)) return { Error: 'no such conversation' };

    return {
      Key: key,
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
    const { uid, name, otherUid, otherName } = Json;
    const key = Store.directKey(uid, otherUid);
    const c = store.convo(key);
    if (c) return { Key: key };
    await startConversation(key, 'direct', `${name} & ${otherName}`, [uid, otherUid]);
    return { Key: key };
  },

  '/v1/chat/group_new': async ({ Json }) => {
    const { uid, title } = Json;
    const key = `g:${uid}:${Date.now().toString(36)}`;
    await startConversation(key, 'group', title || 'group', [uid]);
    return { Key: key };
  },

  '/v1/chat/group_add': async ({ Json }) => {
    const { uid, key, otherUid } = Json;
    const c = store.convo(key);
    if (!c || !c.members.includes(uid)) return { Error: 'no such conversation' };
    if (c.kind !== 'group') return { Error: 'not a group' };
    if (c.members.includes(otherUid)) return { Error: 'already in' };

    c.members.push(otherUid);
    store.putConvo(key, c);
    await discord.ensureThread(key, c.title, discordIdsOf(c.members));
    return { ok: true };
  },

  '/v1/chat/send': async ({ Json }) => {
    const { uid, name, key, text } = Json;
    const c = store.convo(key);
    if (!c || !c.members.includes(uid)) return { Error: 'no such conversation' };

    // Sent, not stored. It becomes part of the conversation when Discord
    // hands it back over the gateway — that is what "Discord is the truth"
    // means in practice.
    await discord.say(c.threadId, name, text, uid);
    return { ok: true };
  },

  // --- account link ---

  '/v1/link/begin': async ({ Json }) => ({ Url: oauth.begin(Json.uid) }),

  '/v1/link/status': async ({ Json }) => {
    const l = store.linkOf(Json.uid);
    return { Linked: !!l, DiscordName: l?.discordName || '' };
  },
};

// What a polling server has not seen yet. The cursor is per server, and it
// only moves once we have handed the batch over.
function drain({ ServerId, Cursor, Uids }) {
  const from = Number.isInteger(Cursor) ? Cursor : (cursors.get(ServerId) ?? 0);

  const items = [];
  for (const uid of Uids || []) {
    for (const m of store.since(uid, from)) {
      items.push({
        Kind: 'chat',
        Json: JSON.stringify({
          Uid: uid,
          Key: m.key,
          At: m.at,
          Who: m.who,
          Text: m.text,
          Mine: m.uid === uid,
        }),
      });
    }
  }

  cursors.set(ServerId, store.cursor);
  return { Cursor: store.cursor, Items: items };
}

http = new HttpSide(cfg, {
  routes,
  drain,
  oauthCallback: (req, res) => oauth.callback(req, res),
});

await discord.start();
await http.listen();
console.log('[bridge] ready');
