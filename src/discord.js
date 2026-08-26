// The Discord half.
//
// Conversations are PRIVATE THREADS, not channels. A guild is capped at 500
// channels — a populated server would eat that in a week — while archived
// threads are unlimited and a thread can be un-archived by posting into it.
//
// Players speak through a WEBHOOK, not as the bot. Two reasons, and both
// matter: every stalker gets their own in-game name and avatar in the thread
// instead of a wall of "OpenZone BOT said", and a player who has not linked a
// Discord account can still be heard. Linking buys reading and writing FROM
// Discord; it is not the price of speaking in game.

import {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  MessageFlags,
  Partials,
  ChannelType,
  ThreadAutoArchiveDuration,
} from 'discord.js';

export class DiscordSide {
  constructor(cfg, store, onMessage) {
    this.cfg = cfg;
    this.store = store;
    this.onMessage = onMessage;
    this.webhook = null;

    // Lines we are in the middle of sending, so their echo can be attributed:
    // thread + speaker + text -> the SteamIDs waiting for it.
    //
    // Keyed on what we know BEFORE the send rather than on the message id we
    // learn after it, because the gateway regularly hands the echo back while
    // the REST call that created it is still in flight -- measured at both
    // orders on the same guild. An id learned too late attributes nothing.
    this.pending = new Map();

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        // Without MessageContent the bot receives every message with an empty
        // body and the bridge silently carries nothing. It is OFF by default.
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.on('messageCreate', (m) => this.#incoming(m));

    // МЕЖА ПОМИЛОК, і вона тут не про охайність.
    //
    // EventEmitter викидає повернуту обіцянку. Під Node 20 нерозглянута
    // відмова -- це смерть процесу, а цей процес обслуговує не лише чат: на
    // ньому висить восьмисекундний опит ігрового сервера. Одна відхилена
    // відповідь -- і в грі зникають чат, реєстр і ролі.
    //
    // Найімовірніший шлях навіть не екзотичний: store.save() синхронно
    // переписує весь документ на КОЖНЕ повідомлення, і на людній гільдії
    // цикл подій легко перестрибує тривисекундне вікно Discord. Тоді
    // i.reply() відмовляє з 10062 Unknown interaction -- і забирає з собою
    // все інше.
    this.client.on('interactionCreate', (i) => {
      this.#interaction(i).catch((e) => {
        console.warn(`[discord] interaction failed (${e.message})`);
      });
    });

    // Останній рубіж. Сюди має не доходити, але якщо дійде -- хай це буде
    // рядок у логу, а не тиша й мертвий міст.
    process.on('unhandledRejection', (e) => {
      console.error(`[discord] unhandled rejection: ${(e && e.stack) || e}`);
    });
    // Keeps members.cache honest after the initial fetch: discord.js
    // replaces the cached member on each of these, so role changes made in
    // Discord reach the game on the next poll rather than the next restart.
    this.client.on('guildMemberUpdate', (o, n) => { if (n && n.guild) n.guild.members.cache.set(n.id, n); });
    this.client.on('guildMemberAdd', (m) => { if (m && m.guild) m.guild.members.cache.set(m.id, m); });

    // Канал видалили посеред сеансу -- ПЕРЕСТАЄМО спрямовувати.
    //
    // Без цього обіцянка в заголовку #ensureCommandChannel («команди знову
    // працюють будь-де, а не ніде») діяла лише на старті. Видалений о 20:00
    // канал лишав this.commandChannelId вказувати в порожнечу до кінця
    // роботи процесу: кожен /link у кожному каналі відмовлявся посиланням на
    // канал, якого немає, а полагодити це міг тільки адмін -- бо саме
    // /openzone channel і винятий з перевірки. Гільдія переставала
    // прив'язуватись зовсім.
    this.client.on('channelDelete', (c) => {
      if (!c || c.id !== this.commandChannelId) return;
      this.commandChannelId = null;
      try {
        this.store.setGuildRef('commandChannelId', null);
      } catch (e) {
        console.warn(`[discord] could not forget the deleted channel (${e.message})`);
      }
      console.warn('[discord] the command channel was deleted; commands are allowed anywhere until /openzone channel setup');
    });
  }

  // Set by index.js after construction: the bridge owns the code table, the
  // Discord side only redeems against it. Kept as a setter rather than a
  // constructor argument so this class stays constructible without it.
  useCodes(codes) {
    this.codes = codes;
  }

  async start() {
    await this.client.login(this.cfg.token);
    this.guild = await this.client.guilds.fetch(this.cfg.guildId);
    this.parent = await this.client.channels.fetch(this.cfg.parentChannelId);

    if (this.parent.type !== ChannelType.GuildText) {
      throw new Error(
        `parent channel ${this.cfg.parentChannelId} is not a text channel; private threads can only live under one`,
      );
    }

    this.webhook = await this.#ensureWebhook();
    await this.#registerCommands();
    await this.#ensureCommandChannel();
    await this.#warmMembers();
    console.log(`[discord] logged in as ${this.client.user.tag}`);
  }

  // Registered on the GUILD, not globally: guild commands appear immediately,
  // global ones take up to an hour to propagate and would make every change
  // here untestable.
  //
  // Failing to register is not fatal. The bot's whole other job -- carrying
  // conversations -- does not need commands, and a missing `applications.commands`
  // scope in the invite is exactly the kind of thing that should produce a
  // sentence telling you to fix the invite, not a bridge that will not start.
  async #registerCommands() {
    try {
      await this.guild.commands.set([
        {
          name: 'link',
          description: 'Link your Discord account to your character',
          options: [
            {
              name: 'code',
              description: 'The six-character code your PDA is showing',
              type: 3, // STRING
              required: true,
            },
          ],
        },
        {
          name: 'openzone',
          description: 'OpenZone server configuration',
          // A STRING bitfield, quoted deliberately: discord.js BigInt-parses
          // this key behind a truthiness check, so a bare numeric 0 slips
          // through unconverted. 8 is Administrator.
          //
          // It is a DEFAULT, not a boundary -- a guild owner can widen it in
          // Server Settings, which is why every handler checks permissions
          // again on arrival.
          default_member_permissions: '8',
          options: [
            {
              name: 'roles',
              description: 'The role roster',
              type: 2, // SUB_COMMAND_GROUP
              options: [
                {
                  name: 'sync',
                  description: 'Create any roles that do not exist yet, and adopt those that do',
                  type: 1, // SUB_COMMAND
                },
                {
                  name: 'list',
                  description: 'Show the roster and which roles are wired up',
                  type: 1, // SUB_COMMAND
                },
                {
                  name: 'rename',
                  description: 'Rename one role, in Discord and in the roster',
                  type: 1, // SUB_COMMAND
                  options: [
                    { name: 'slug', description: 'The entry, e.g. duty or duty:leader', type: 3, required: true },
                    { name: 'name', description: 'What the role should be called', type: 3, required: true },
                  ],
                },
              ],
            },
            {
              name: 'channel',
              description: 'The channel commands belong in',
              type: 2, // SUB_COMMAND_GROUP
              options: [
                {
                  name: 'setup',
                  description: 'Create the command channel, or adopt the one that is already there',
                  type: 1, // SUB_COMMAND
                },
                {
                  name: 'show',
                  description: 'Say which channel is the command channel',
                  type: 1, // SUB_COMMAND
                },
                {
                  name: 'forget',
                  description: 'Stop steering commands to a channel',
                  type: 1, // SUB_COMMAND
                },
              ],
            },
          ],
        },
      ]);
      console.log('[discord] /link and /openzone registered on the guild');
    } catch (e) {
      console.warn(
        `[discord] could not register slash commands (${e.message}). ` +
          'The invite probably lacks the applications.commands scope. ' +
          'Chat still works; /link will not.',
      );
    }
  }

  // The channel commands belong in.
  //
  // The bot BUILDS it, because the alternative is a setup step in a document
  // nobody reads and a guild where /link works in the roleplay channel. It is
  // created once, on the first start that finds none recorded.
  //
  // Followed by ID, never by name -- an admin who renames it keeps it, and the
  // bot never builds a second one beside the first. Same rule the role roster
  // follows, for the same reason.
  //
  // DELETED IS NOT RECREATED. An admin who removes it meant to remove it, and
  // rebuilding it on every restart would be a fight he cannot win. The record
  // is dropped instead and steering stops -- which is deliberately the SAFE
  // failure: commands work everywhere again rather than nowhere. `/openzone
  // channel setup` builds a new one when he wants it back.
  async #ensureCommandChannel() {
    const known = this.store.guildRef('commandChannelId');

    if (known) {
      const r = await this.#lookUp(known);

      if (r.channel) {
        this.commandChannelId = known;
        console.log(`[discord] command channel #${r.channel.name}`);
        return;
      }

      // WE DO NOT KNOW. A 500 during a Discord incident, or a View Channel
      // override an admin just removed, must NOT be read as "deleted": that
      // erases his configuration permanently over a hiccup, and he finds out
      // when a duplicate appears next time somebody runs setup.
      //
      // Keep the record, leave steering off. Commands work everywhere for
      // now -- which is the safe half -- and the next restart adopts the
      // channel again once Discord answers.
      if (r.unsure) {
        console.warn(`[discord] cannot see the command channel right now (${r.why}); keeping the record, commands are allowed anywhere meanwhile`);
        return;
      }

      this.store.setGuildRef('commandChannelId', null);
      console.warn('[discord] the command channel was deleted; commands are allowed anywhere until /openzone channel setup');
      return;
    }

    const r = await this.#makeCommandChannel();
    if (r.ok) console.log(`[discord] command channel #${r.channel.name} created`);
    else console.warn(`[discord] ${r.why}; commands are allowed anywhere`);
  }

  // One channel by id, with the three answers kept apart.
  //
  // `gone` is ONLY 10003 Unknown Channel. Every other failure is `unsure`,
  // because "Discord did not answer" and "the channel does not exist" call
  // for opposite actions and look identical if you catch them together.
  async #lookUp(id) {
    try {
      const ch = await this.guild.channels.fetch(id);
      return ch ? { channel: ch } : { gone: true };
    } catch (e) {
      if (e && e.code === 10003) return { gone: true };
      return { unsure: true, why: e.message };
    }
  }

  async #makeCommandChannel() {
    const name = 'оз-команди';

    // The STORED ID comes first, before any name matching.
    //
    // The header promises a renamed channel is kept, not duplicated -- but
    // that promise lived only in memory. An admin who renames it and later
    // runs setup would have had a fresh "оз-команди" built beside his own,
    // which is exactly the duplicate this design exists to avoid.
    const known = this.store.guildRef('commandChannelId');
    if (known) {
      const r = await this.#lookUp(known);
      if (r.channel) {
        this.commandChannelId = r.channel.id;
        return { ok: true, channel: r.channel };
      }
      // Not knowing is not a licence to build a second one.
      if (r.unsure) return { ok: false, why: `cannot see the recorded channel (${r.why})` };
    }

    let ch = null;
    try {
      // FETCH, do not read the cache. guild.channels.cache starts EMPTY and
      // is filled by GUILD_CREATE, which on a large guild can land after
      // this code runs -- and an empty cache means "no channel by that name",
      // which means a duplicate. The member cache taught us this once
      // already, further down this file.
      const all = await this.guild.channels.fetch();
      ch = all.find((c) => c && c.type === ChannelType.GuildText && c.name === name);
    } catch (e) {
      // Cannot see the channel list -> cannot rule out a duplicate. Refusing
      // to build is the recoverable failure; building is not.
      return { ok: false, why: `cannot list channels (${e.message})` };
    }

    if (!ch) {
      try {
        ch = await this.guild.channels.create({
          name,
          type: ChannelType.GuildText,
          topic: 'Команди OpenZone. Тут працює /link — привʼязка акаунта Discord до персонажа.',
        });
      } catch (e) {
        // Not fatal, and deliberately so: carrying conversations is this
        // bot's other job and it needs no channel of its own. A missing
        // Manage Channels permission should produce a sentence telling you
        // to grant it, not a bridge that will not start.
        return { ok: false, why: `could not create the command channel (${e.message})` };
      }
    }

    // The channel EXISTS from here on, whatever happens next.
    this.commandChannelId = ch.id;
    try {
      this.store.setGuildRef('commandChannelId', ch.id);
    } catch (e) {
      // Reporting this as "could not create" would send the admin to fix a
      // permission that is already fine, while a channel he cannot see in
      // the log sits there being used.
      console.warn(`[discord] #${ch.name} is in use but could not be written down (${e.message}); it will need adopting again after a restart`);
    }
    return { ok: true, channel: ch };
  }

  // Pull the member list once, and keep it current from the gateway.
  //
  // This is not optional: guild.members.cache starts EMPTY. The gateway
  // populates roles.cache on its own but not members, and
  // client.guilds.fetch() short-circuits to the cached Guild without any
  // REST call at all -- so without this, memberOf() returns null for
  // everybody and no role projection is ever sent. Cost me one live test
  // to find: the sink registered, the poll ran, and every batch was empty.
  //
  // Fetched ONCE rather than per lookup, because the lookup runs for every
  // linked player on every eight-second poll and a fetch there would be a
  // rate-limit problem instead of a cache.
  async #warmMembers() {
    try {
      const members = await this.guild.members.fetch();
      console.log(`[discord] member cache warm: ${members.size}`);
    } catch (e) {
      // Needs the GuildMembers intent, which is privileged and off by
      // default in the developer portal. Say which switch, because the
      // symptom otherwise is 'roles silently never arrive'.
      console.warn(
        `[discord] could not fetch members (${e.message}). ` +
          'Enable SERVER MEMBERS INTENT for this application in the Discord ' +
          'developer portal, or role projection will stay empty.',
      );
    }
  }

  // A cached guild member by Discord id, or null.
  //
  // Cache only, never a fetch: this runs inside the poll drain, for every
  // linked player, every eight seconds. A fetch per player there would turn a
  // role lookup into a rate-limit problem. A member we have never seen
  // reports null -- which the game reads as "we do not know", not as "he has
  // no roles".
  memberOf(discordId) {
    if (!discordId) return null;
    if (!this.guild) return null;
    return this.guild.members.cache.get(discordId) || null;
  }

  useRoles(roles) {
    this.roles = roles;
  }

  async #interaction(i) {
    if (!i.isChatInputCommand()) return;

    if (!(await this.#inTheRightChannel(i))) return;

    if (i.commandName === 'openzone') {
      await this.#openzone(i);
      return;
    }

    if (i.commandName !== 'link') return;

    // Ephemeral throughout: a link code on a public channel is an invitation
    // for whoever reads it faster than you do.
    if (!this.codes) {
      await i.reply({ content: 'Linking is not available right now.', flags: MessageFlags.Ephemeral });
      return;
    }

    const r = this.codes.redeem(
      i.options.getString('code'),
      i.user.id,
      i.user.username,
    );

    if (r.ok) {
      await i.reply({
        content: 'Linked. Your PDA will notice within a few seconds.',
        flags: MessageFlags.Ephemeral,
      });
      console.log(`[discord] linked ${r.steamId} to ${i.user.tag}`);
      return;
    }

    // Each refusal says what to DO, because the player is standing in a menu
    // with a code on the screen and a timer running.
    let why = 'That code did not work.';
    if (r.reason === 'empty') why = 'Type the code your PDA is showing.';
    if (r.reason === 'unknown') why = 'That code is unknown or has expired. Press the button in your PDA again for a fresh one.';
    if (r.reason === 'taken') why = 'That character is already linked to a different Discord account.';

    await i.reply({ content: why, flags: MessageFlags.Ephemeral });
  }

  // Commands belong in one channel, and everywhere else they are turned away
  // with a pointer to it -- ephemerally, so the refusal is not itself the
  // clutter it exists to prevent.
  //
  // TWO deliberate holes, and both are about not locking anyone out:
  //
  //   - no channel recorded (never built, or deleted) -> allow everywhere.
  //     Steering is a convenience; being unable to run /link is not.
  //   - `/openzone channel` -> always allowed. It is the command that FIXES a
  //     wrong or missing channel, and enforcing it against itself would make
  //     a deleted channel unrecoverable without editing the state file.
  async #inTheRightChannel(i) {
    if (!this.commandChannelId) return true;
    if (i.channelId === this.commandChannelId) return true;

    if (i.commandName === 'openzone') {
      if (i.options.getSubcommandGroup(false) === 'channel') return true;
    }

    await i.reply({
      content: `Команди OpenZone — у <#${this.commandChannelId}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  // Configuration lives in the bot, so this is where an admin drives it.
  //
  // default_member_permissions is only a DEFAULT -- a guild owner can widen
  // it in Server Settings -- so the permission is checked again here rather
  // than trusted.
  async #openzone(i) {
    if (!i.memberPermissions || !i.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await i.reply({ content: 'That is for server administrators.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!this.roles) {
      await i.reply({ content: 'The role roster is not available right now.', flags: MessageFlags.Ephemeral });
      return;
    }

    const group = i.options.getSubcommandGroup(false);
    const sub = i.options.getSubcommand(false);

    if (group === 'roles' && sub === 'sync') {
      // Creating a dozen roles takes longer than the three seconds Discord
      // gives an interaction, so defer first or the reply is refused.
      await i.deferReply({ flags: MessageFlags.Ephemeral });

      const r = await this.roles.sync(i.guild);

      const lines = [];
      if (r.made.length) lines.push('**Created:** ' + r.made.join(', '));
      if (r.adopted.length) lines.push('**Adopted existing:** ' + r.adopted.join(', '));
      if (r.kept.length) lines.push('**Already wired:** ' + r.kept.length + ' role(s)');
      if (r.ambiguous.length) lines.push('**Ambiguous, left alone:** ' + r.ambiguous.join('; '));
      if (r.failed.length) lines.push('**Failed:** ' + r.failed.join('; '));
      if (!lines.length) lines.push('Nothing to do.');

      await i.editReply({ content: lines.join('\n').slice(0, 1900) });
      return;
    }

    if (group === 'roles' && sub === 'list') {
      const lines = [];
      for (const e of this.roles.entries()) {
        let mark = '--';
        if (e.node.RoleId) mark = '<@&' + e.node.RoleId + '>';
        if (e.node.Missing) mark = '(deleted in Discord)';
        lines.push('`' + e.slug + '` ' + mark);
      }
      await i.reply({ content: lines.join('\n').slice(0, 1900), flags: MessageFlags.Ephemeral });
      return;
    }

    if (group === 'channel' && sub === 'setup') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await this.#makeCommandChannel();
      // Кажемо, ЩО САМЕ не вийшло. «Бракує Manage Channels» на будь-яку
      // невдачу відправляло б адміна лагодити право, яке й так є.
      if (r.ok) await i.editReply({ content: `Команди тепер у <#${r.channel.id}>.` });
      else await i.editReply({ content: `Не вийшло: ${r.why}` });
      return;
    }

    if (group === 'channel' && sub === 'show') {
      let msg = 'Каналу для команд немає — команди працюють будь-де.';
      if (this.commandChannelId) msg = `Команди — у <#${this.commandChannelId}>.`;
      await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
      return;
    }

    if (group === 'channel' && sub === 'forget') {
      // Drops the STEERING, not the channel. Deleting somebody's channel is
      // not the bot's call, and an admin asking it to stop pointing there is
      // not asking it to tear anything down.
      this.commandChannelId = null;
      this.store.setGuildRef('commandChannelId', null);
      await i.reply({ content: 'Більше не спрямовую. Канал лишився на місці.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (group === 'roles' && sub === 'rename') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await this.roles.rename(i.guild, i.options.getString('slug'), i.options.getString('name'));
      if (r.ok) await i.editReply({ content: `Renamed \`${i.options.getString('slug')}\`: **${r.was}** -> **${r.now}**` });
      else await i.editReply({ content: r.why });
      return;
    }

    await i.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
  }

  // Webhooks need Manage Webhooks, which is easy to leave out of the invite.
  // Without one the bridge still works — the bot posts and the speaker's name
  // goes in front of the line. That is worse to read, so we say exactly what
  // to change instead of dying on it: a chat that works badly beats a bridge
  // that will not start.
  async #ensureWebhook() {
    try {
      const hooks = await this.parent.fetchWebhooks();
      const mine = hooks.find((h) => h.owner?.id === this.client.user.id);
      if (mine) return mine;
      return await this.parent.createWebhook({
        name: 'OpenZone',
        reason: 'carries in-game messages under each stalker own name',
      });
    } catch (err) {
      console.warn(
        `[discord] no webhook (${err.message}). Messages will be posted by the bot with the ` +
          "speaker's name in front. Grant Manage Webhooks on the parent channel to give every " +
          'stalker their own name in the thread.',
      );
      return null;
    }
  }

  // A message appeared in Discord. If it belongs to a conversation we know,
  // it goes to the game — including the webhook posts we made ourselves,
  // because the store, not this handler, decides what is a duplicate. That
  // way a message reaches the game only once Discord actually has it.
  #incoming(m) {
    if (!m.channel?.isThread?.()) return;

    const convo = this.store.convoByThread(m.channel.id);
    if (!convo) return;

    // Ours by id first -- exact. Then by linked Discord account, for messages
    // a player typed in Discord rather than in game.
    let who = m.member?.displayName || m.author.username;
    let text = m.content || '';

    // Undo the fallback format, so the game shows the speaker in its own
    // column instead of a bold blob inside the line.
    if (!m.webhookId && m.author.id === this.client.user.id) {
      const cut = text.match(/^\*\*(.{1,80}?)\*\*: ([\s\S]*)$/);
      if (cut) {
        who = cut[1];
        text = cut[2];
      }
    }

    // Ours if we are the ones who sent it. Otherwise, whoever typed it in
    // Discord, if that account is linked to a stalker.
    let uid = this.#claim(m.channel.id, who, text);
    if (!uid && !m.webhookId) uid = this.store.steamIdOf(m.author.id);

    this.onMessage(convo.key, {
      id: m.id,
      at: new Date(m.createdTimestamp).toISOString(),
      uid,
      who,
      text,
      fromDiscord: !m.webhookId,
    });
  }

  // Create the thread for a conversation, or reopen the one that already
  // exists. Threads archive themselves; posting wakes them, so an old
  // conversation continues in the same place instead of scattering.
  async ensureThread(key, title, memberDiscordIds) {
    const known = this.store.convo(key);
    if (known?.threadId) {
      try {
        const th = await this.client.channels.fetch(known.threadId);
        if (th.archived) await th.setArchived(false);
        await this.#invite(th, memberDiscordIds);
        return th;
      } catch {
        // Thread deleted in Discord. Discord is the truth, so we make a new
        // one rather than pretending the old one is still there.
        console.warn(`[discord] thread ${known.threadId} for ${key} is gone; creating a new one`);
      }
    }

    const th = await this.parent.threads.create({
      name: title.slice(0, 90),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `OpenZone conversation ${key}`,
    });

    await this.#invite(th, memberDiscordIds);
    return th;
  }

  async #invite(thread, discordIds) {
    for (const id of discordIds) {
      if (!id) continue;
      try {
        await thread.members.add(id);
      } catch (err) {
        // Not fatal: an unlinked or absent member simply does not see the
        // thread in Discord. They still read and write in game.
        console.warn(`[discord] could not add ${id} to ${thread.id}: ${err.message}`);
      }
    }
  }

  // Speak as the player. The thread id goes to the webhook, so the message
  // lands inside the conversation rather than in the parent channel.
  // `uid` is who said it, noted before the line leaves so the echo can be
  // recognised as theirs whichever way the race falls.
  async say(threadId, name, text, uid) {
    const who = name.slice(0, 80);
    const body = text.slice(0, 1900);

    if (uid) this.#expect(threadId, who, body, uid);

    try {
      if (this.webhook) {
        await this.webhook.send({
          threadId,
          username: who,
          content: body,
          allowedMentions: { parse: [] },
        });
      } else {
        // Fallback. The name has to survive the round trip, because it is how
        // the game knows who spoke: the gateway hands this back and the parser
        // reads it off the front.
        const th = await this.client.channels.fetch(threadId);
        await th.send({
          content: `**${who}**: ${body}`,
          allowedMentions: { parse: [] },
        });
      }
    } catch (err) {
      // Nothing was said, so nothing will echo. Drop the claim rather than
      // leave it to be collected by the next identical line.
      if (uid) this.#claim(threadId, who, body);
      throw err;
    }
  }

  static #slot(threadId, who, text) {
    return `${threadId}\u0000${who}\u0000${text}`;
  }

  #expect(threadId, who, text, uid) {
    const slot = DiscordSide.#slot(threadId, who, text);
    const queue = this.pending.get(slot) || [];
    queue.push(uid);
    this.pending.set(slot, queue);

    // A send that never echoes must not leave its claim behind, or the next
    // identical line would collect it and be attributed to the wrong stalker.
    setTimeout(() => {
      const q = this.pending.get(slot);
      if (!q) return;
      const at = q.indexOf(uid);
      if (at >= 0) q.splice(at, 1);
      if (q.length === 0) this.pending.delete(slot);
    }, 60_000).unref?.();
  }

  #claim(threadId, who, text) {
    const slot = DiscordSide.#slot(threadId, who, text);
    const queue = this.pending.get(slot);
    if (!queue?.length) return null;
    const uid = queue.shift();
    if (queue.length === 0) this.pending.delete(slot);
    return uid;
  }

  async displayName(discordId) {
    try {
      const member = await this.guild.members.fetch(discordId);
      return member.displayName;
    } catch {
      return null;
    }
  }
}
