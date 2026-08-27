// Notes: the player's notebook, and Discord is the truth for it.
//
// The owner decided 2026-08-28 that notes follow the same doctrine as chat:
// they live in Discord, the game is a window. One private thread per player,
// one note = one message. The design is the thin-client spec of 2026-08-25,
// section 5, applied as written:
//
//  - the note Id is OURS, not the Discord message id: a message id is a
//    moving pointer that changes on every repost, and the stable id must
//    survive exactly that;
//  - there is NO editing of messages, ever. Saving an existing note deletes
//    the old message and posts a new one. A webhook post un-archives the
//    thread for free, deletion is allowed in an archived thread, and PATCH
//    would hit the 30046 edit quota whose size Discord refuses to name;
//  - this file is an INDEX riding alongside Discord, not a second truth:
//    if someone deletes a note message in Discord, the gateway event prunes
//    it here and the note is gone. That is what "Discord is the truth" means.
//
// Storage is its own file, not bridge.json: the state file is rewritten on
// every chat line, and fifty notes per player have no business riding that.

import fs from 'node:fs';
import path from 'node:path';

const NOTES_MAX = 50;
const TITLE_MAX = 64;
const BODY_MAX = 1500;

// The game's own timestamp shape ("2026-08-28 01:23:45"), so the client
// renders bridge notes and legacy notes identically.
function nowUtc() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export class Notes {
  #file;
  #data; // { players: { uid: { threadId, seq, items: [{Id,Title,Body,CreatedAt,EditedAt,MsgId}] } } }

  constructor(filePath) {
    this.#file = filePath;
    this.discord = null;
    this.store = null;
    // Messages WE deleted (resave, delete): their gateway echoes are our own
    // actions coming back, not somebody pruning notes in Discord. Without
    // this set, every resave deleted its own note: delete old message ->
    // messageDelete echo -> onMessageDeleted pruned the freshly saved item.
    this.selfDeleted = new Set();
    try {
      this.#data = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch {
      this.#data = { players: {} };
    }
    this.#data.players ??= {};
  }

  use(discord, store) {
    this.discord = discord;
    this.store = store;
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(this.#file, JSON.stringify(this.#data, null, 2));
  }

  #of(uid) {
    this.#data.players[uid] ??= { threadId: null, seq: 0, items: [] };
    return this.#data.players[uid];
  }

  // The game's list is the whole book: the page renders bodies straight from
  // it and never asks for one note. Same shape as the old server file, so
  // the client parses bridge notes and legacy notes with the same class.
  list(uid) {
    const p = this.#of(uid);
    return {
      Version: 1,
      Notes: p.items.map((n) => ({
        Id: n.Id,
        Title: n.Title,
        Body: n.Body,
        CreatedAt: n.CreatedAt,
        EditedAt: n.EditedAt,
      })),
    };
  }

  async save(uid, id, title, body, name) {
    const p = this.#of(uid);

    title = String(title ?? '').slice(0, TITLE_MAX);
    body = String(body ?? '').slice(0, BODY_MAX);

    let item;
    if (id) {
      item = p.items.find((n) => n.Id === id);
      // Asked to CHANGE something specific and it is not there: refusing
      // beats silently creating -- the game says the same on its side.
      if (!item) return { Error: 'no_note' };
    } else {
      if (p.items.length >= NOTES_MAX) return { Error: 'notes_full' };
      p.seq += 1;
      item = {
        Id: `${nowUtc()}#${p.seq}`,
        CreatedAt: nowUtc(),
      };
      p.items.push(item);
    }

    item.Title = title;
    item.Body = body;
    item.EditedAt = nowUtc();

    // Discord first, index after: if the post fails, the note must not
    // pretend to exist. A new note that failed to post is rolled back.
    try {
      const thread = await this.#thread(uid, name);

      // Saving = delete the old message, post a new one. Never edit.
      if (item.MsgId) {
        this.#ourDelete(item.MsgId);
        await this.discord.deleteNoteMessage(p.threadId, item.MsgId);
      }
      const msg = await this.discord.postNote(
        p.threadId,
        name,
        this.#render(item),
      );
      item.MsgId = msg.id;
    } catch (err) {
      if (!id) p.items.pop();
      console.warn(`[notes] save for ${uid} failed: ${err.message}`);
      return { Error: 'discord_down' };
    }

    this.#save();
    return { Id: item.Id };
  }

  async remove(uid, id) {
    const p = this.#of(uid);
    const at = p.items.findIndex((n) => n.Id === id);
    if (at < 0) return { Error: 'no_note' };

    const [item] = p.items.splice(at, 1);
    try {
      if (item.MsgId && p.threadId) {
        this.#ourDelete(item.MsgId);
        await this.discord.deleteNoteMessage(p.threadId, item.MsgId);
      }
    } catch (err) {
      // The index entry is gone either way: a dangling message in the
      // thread is visible and fixable by hand, a dangling index entry is
      // a note the game shows and Discord does not have.
      console.warn(`[notes] message delete for ${uid} failed: ${err.message}`);
    }

    this.#save();
    return { ok: true };
  }

  // Somebody deleted a message in Discord. If it was a note, the note is
  // gone -- Discord is the truth, the index follows it.
  #ourDelete(messageId) {
    this.selfDeleted.add(messageId);
    // The echo comes within seconds; a minute covers a gateway hiccup, and
    // cleaning up keeps the set from growing for the life of the process.
    setTimeout(() => this.selfDeleted.delete(messageId), 60_000).unref?.();
  }

  onMessageDeleted(channelId, messageId) {
    if (this.selfDeleted.delete(messageId)) return;

    for (const [uid, p] of Object.entries(this.#data.players)) {
      if (p.threadId !== channelId) continue;
      const at = p.items.findIndex((n) => n.MsgId === messageId);
      if (at < 0) return;
      const [gone] = p.items.splice(at, 1);
      console.log(`[notes] "${gone.Title}" of ${uid} deleted in Discord; following`);
      this.#save();
      return;
    }
  }

  // The title carries the note; the body follows; the rule closes it.
  //
  // Without the rule, Discord groups quick posts by one author into a
  // single visual block and three notes read as one text -- the owner saw
  // exactly that and asked for a delimiter after every note.
  #render(item) {
    const head = item.Title ? `**${item.Title}**` : '**...**';
    const text = item.Body ? `${head}\n${item.Body}` : head;
    return `${text}\n──────────────`;
  }

  async #thread(uid, name) {
    const p = this.#of(uid);

    // The notebook channel is lazy: the first note anywhere creates it,
    // every later call finds it by the remembered id.
    if (!this.discord.notesChannel) {
      await this.discord.ensureNotesChannel(this.#data.channelId);
      this.#data.channelId = this.discord.notesChannel.id;
      this.#save();
    }

    if (p.threadId) {
      const th = await this.discord.fetchThread(p.threadId);
      if (th && th.parentId === this.discord.notesChannel.id) return th;

      if (th) {
        // The notebook lives under the wrong parent -- the chat channel,
        // from before notebooks got their own read-only home. Threads
        // cannot move between channels, so the notebook is REPOSTED: new
        // thread in the right channel, every note again, old thread gone.
        console.log(`[notes] moving the notebook of ${uid} to #нотатники`);
        const moved = await this.#repostAll(uid, name, p);
        await this.discord.deleteThread(th.id, 'notebook moved to its read-only channel');
        return moved;
      }

      // Thread deleted in Discord: the notes it held are gone with it.
      console.warn(`[notes] thread of ${uid} is gone; notes start over`);
      p.items = [];
      p.threadId = null;
    }

    const discordId = this.store?.linkOf?.(uid)?.discordId;
    const th = await this.discord.makeNoteThread(
      `Нотатник — ${name || uid}`,
      discordId ? [discordId] : [],
    );
    p.threadId = th.id;
    this.#save();
    return th;
  }

  // New thread in the notes channel, every note posted afresh. Message ids
  // change -- that is why the note Id was never the message id.
  async #repostAll(uid, name, p) {
    const discordId = this.store?.linkOf?.(uid)?.discordId;
    const th = await this.discord.makeNoteThread(
      `Нотатник — ${name || uid}`,
      discordId ? [discordId] : [],
    );
    p.threadId = th.id;

    for (const item of p.items) {
      const msg = await this.discord.postNote(th.id, name, this.#render(item));
      item.MsgId = msg.id;
    }

    this.#save();
    return th;
  }
}
