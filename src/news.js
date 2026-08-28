// News: a Discord FORUM channel read from the game.
//
// The forum finally lands where it belongs (the owner asked about forums
// twice): PUBLIC, admin-authored posts -- announcements, lore, patch news --
// readable from every PDA. Exactly the content forums are for, and exactly
// what the private notebook could not be.
//
// Discord is the truth and the ONLY writer: admins post in Discord, the
// game reads. @everyone loses SendMessages and SendMessagesInThreads on the
// channel, so the feed stays clean (administrators bypass overwrites).
//
// The index lives in MEMORY only. Unlike notes, the bridge owns no ids
// here -- the thread snowflake is the post id -- so a restart rebuilds
// everything from Discord with one warm-up sweep. After that the gateway
// keeps it fresh: threadCreate/Update/Delete and starter-message edits.
// Listing live on every PDA open would cost ~32 REST calls for 30 posts
// against the global 50/s budget shared with chat; the cache pays once.

import { ChannelType, PermissionFlagsBits } from 'discord.js';

const KEEP = 50;
const BODY_MAX = 1500;

function stamp(ts) {
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ');
}

export class News {
  constructor() {
    this.discord = null;
    this.channelId = null;
    this.posts = new Map(); // threadId -> { Id, Title, Who, At, ts, Body, Replies }
  }

  async start(discord, knownId) {
    this.discord = discord;
    const guild = discord.guild;

    let ch = null;
    if (knownId) ch = await discord.client.channels.fetch(knownId).catch(() => null);
    if (!ch) {
      const all = await guild.channels.fetch();
      ch = all.find((c) => c && c.type === ChannelType.GuildForum && c.name === 'новини');
    }
    if (!ch) {
      ch = await guild.channels.create({
        name: 'новини',
        type: ChannelType.GuildForum,
        topic: 'Новини Зони. Пости пишуть адміністратори; гра читає їх на КПК.',
        reason: 'OpenZone news feed',
      });
    }

    await ch.permissionOverwrites.set([
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads],
      },
      {
        id: discord.client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageThreads,
          // The bot may post too: game events will author news one day,
          // and the everyone-deny above would bind the bot without this.
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.SendMessagesInThreads,
        ],
      },
    ]);

    this.channelId = ch.id;
    await this.#warm(ch);

    const c = discord.client;
    c.on('threadCreate', (th) => this.#onThread(th));
    c.on('threadUpdate', (_o, th) => this.#onThread(th));
    c.on('threadDelete', (th) => { if (this.posts.delete(th.id)) void 0; });
    // The starter message shares the thread's id -- that is how a forum
    // post's body edit is told apart from a mere reply.
    c.on('messageCreate', (m) => { if (m.id === m.channelId) this.#onStarter(m); });
    c.on('messageUpdate', (_o, m) => { if (m && m.id === m.channelId) this.#onStarter(m); });
    c.on('messageDelete', (m) => {
      const p = this.posts.get(m.channelId);
      if (p && m.id === m.channelId) p.Body = '';
    });

    console.log(`[news] #новини ready, ${this.posts.size} post(s) cached`);
    return ch;
  }

  async #warm(ch) {
    const found = [];
    const act = await ch.threads.fetchActive();
    for (const th of act.threads.values()) found.push(th);

    // Archived come back by archive time, which lies about creation order --
    // we sort by the snowflake timestamp ourselves below.
    let before;
    for (let page = 0; page < 4 && found.length < KEEP * 2; page++) {
      const arch = await ch.threads.fetchArchived({ type: 'public', before }).catch(() => null);
      if (!arch || arch.threads.size === 0) break;
      for (const th of arch.threads.values()) found.push(th);
      if (!arch.hasMore) break;
      before = found[found.length - 1].id;
    }

    found.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
    for (const th of found.slice(0, KEEP)) {
      await this.#onThread(th, true);
    }
  }

  async #onThread(th, warm = false) {
    if (th.parentId !== this.channelId) return;

    const known = this.posts.get(th.id);
    const post = known || {
      Id: th.id, Title: '', Who: '', At: '', ts: 0, Body: '', Replies: 0,
    };

    post.Title = th.name;
    post.ts = th.createdTimestamp || post.ts;
    post.At = stamp(post.ts);
    // Discord's message_count already excludes the starter message, so it
    // IS the reply count -- subtracting one here ate a reply per post.
    post.Replies = Math.max(0, th.messageCount || 0);

    if (!known || warm || !post.Body) {
      try {
        const starter = await th.fetchStarterMessage();
        post.Body = (starter?.content || '').slice(0, BODY_MAX);
        post.Who = starter?.member?.displayName || starter?.author?.username || post.Who;
      } catch {
        // Starter deleted: the post keeps its title and an empty body.
      }
    }

    this.posts.set(th.id, post);

    // The cap holds on live inserts too, not only at warm-up.
    if (this.posts.size > KEEP) {
      const oldest = [...this.posts.values()].sort((a, b) => a.ts - b.ts)[0];
      this.posts.delete(oldest.Id);
    }
  }

  #onStarter(m) {
    const p = this.posts.get(m.channelId);
    if (!p) return;
    p.Body = (m.content || '').slice(0, BODY_MAX);
    p.Who = m.member?.displayName || m.author?.username || p.Who;
  }

  list() {
    const items = [...this.posts.values()]
      .sort((a, b) => b.ts - a.ts)
      .map((p) => ({ Id: p.Id, Title: p.Title, Who: p.Who, At: p.At, Replies: p.Replies }));
    return { Items: items };
  }

  open(id) {
    const p = this.posts.get(id);
    if (!p) return { Error: 'no_post' };
    return { Id: p.Id, Title: p.Title, Who: p.Who, At: p.At, Body: p.Body };
  }
}
