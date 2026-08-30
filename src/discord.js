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

import { byteClip } from './clip.js';
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
    // Lines sent to Discord whose echo has not come back yet, oldest first.
    // An array, not a map: the claim ladder searches it four different ways.
    this.pending = [];

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
    // Notes follow Discord: a deleted message means a deleted note.
    this.client.on('messageDelete', (m) => {
    });

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
    await this.#syncNewRoles();
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
                  name: 'limit',
                  description: 'Cap how many players a faction may take in',
                  type: 1, // SUB_COMMAND
                  options: [
                    { name: 'slug', description: 'The faction, e.g. duty', type: 3, required: true },
                    { name: 'size', description: 'Maximum members, or 0 for no limit', type: 4, required: true },
                  ],
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
            {
              name: 'persona',
              description: 'NPC posters for the news feed',
              type: 2, // SUB_COMMAND_GROUP
              options: [
                {
                  name: 'create',
                  description: 'Mint a new poster persona',
                  type: 1,
                  options: [{ name: 'name', description: 'The name posts will carry', type: 3, required: true }],
                },
                {
                  name: 'grant',
                  description: 'Let a faction post as this persona',
                  type: 1,
                  options: [
                    { name: 'name', description: 'The persona', type: 3, required: true },
                    { name: 'faction', description: 'Faction slug, e.g. duty', type: 3, required: true },
                  ],
                },
                {
                  name: 'revoke',
                  description: 'Take the persona away from a faction',
                  type: 1,
                  options: [
                    { name: 'name', description: 'The persona', type: 3, required: true },
                    { name: 'faction', description: 'Faction slug, e.g. duty', type: 3, required: true },
                  ],
                },
                {
                  name: 'list',
                  description: 'Show every persona and who holds it',
                  type: 1,
                },
              ],
            },
          ],
        },
        {
          name: 'post',
          description: 'Post to the Zone news feed',
          options: [
            { name: 'title', description: 'The headline', type: 3, required: true },
            { name: 'body', description: 'The text of the post', type: 3, required: true },
            {
              name: 'as',
              description: 'Post as a persona (leaders and admins only)',
              type: 3,
              required: false,
            },
          ],
        },
      ]);
      console.log('[discord] /link, /openzone and /post registered on the guild');
    } catch (e) {
      console.warn(
        `[discord] could not register slash commands (${e.message}). ` +
          'The invite probably lacks the applications.commands scope. ' +
          'Chat still works; /link will not.',
      );
    }
  }

  // /openzone persona ... -- the admin surface of the NPC posters.
  async #persona(i, sub) {
    if (!this.personas) {
      await i.reply({ content: 'Personas are not available right now.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'create') {
      const name = i.options.getString('name').trim().slice(0, 60);
      const r = this.personas.create(name, i.user.id);
      await i.reply({
        content: r.Error ? `"${name}" already exists.` : `Persona **${name}** minted. Grant it with /openzone persona grant.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'grant' || sub === 'revoke') {
      const name = i.options.getString('name').trim();
      const slug = i.options.getString('faction').trim();
      if (this.roles && !this.roles.find(slug)) {
        await i.reply({ content: `No faction with slug "${slug}".`, flags: MessageFlags.Ephemeral });
        return;
      }
      const r = sub === 'grant' ? this.personas.grant(name, slug) : this.personas.revoke(name, slug);
      await i.reply({
        content: r.Error ? `No persona "${name}".` : `Done: **${name}** ${sub === 'grant' ? 'granted to' : 'revoked from'} ${slug}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'list') {
      const items = this.personas.list();
      const lines = items.map((p) => `**${p.name}** — ${p.factions.join(', ') || 'nobody'}`);
      await i.reply({ content: lines.join('\n') || 'No personas yet.', flags: MessageFlags.Ephemeral });
      return;
    }

    await i.reply({ content: 'Unknown persona command.', flags: MessageFlags.Ephemeral });
  }

  // /post -- the only door into the news forum. Ordinary players speak as
  // their linked character; leaders and admins may wear a granted persona.
  async #post(i) {
    if (!this.news) {
      await i.reply({ content: 'The news feed is not available right now.', flags: MessageFlags.Ephemeral });
      return;
    }

    const uid = this.store.steamIdOf(i.user.id);
    const selfName = (uid && this.store.nameOf(uid)) || '';
    const admin = this.isAdminMember(i.member);

    if (!selfName && !admin) {
      await i.reply({ content: 'Link your account first: /link with the code from your PDA.', flags: MessageFlags.Ephemeral });
      return;
    }

    let who = selfName || i.member?.displayName || i.user.username;

    const as = (i.options.getString('as') || '').trim();
    if (as) {
      const resolved = this.roles && i.member ? this.roles.resolve(i.member) : null;
      const allowed = this.personas ? this.personas.allowedFor(resolved, admin) : [];
      if (!allowed.includes(as)) {
        const hint = allowed.length ? `You may post as: ${allowed.join(', ')}.` : 'You have no personas.';
        await i.reply({ content: `Not your voice. ${hint}`, flags: MessageFlags.Ephemeral });
        return;
      }
      who = as;
    }

    const title = i.options.getString('title').trim().slice(0, 90);
    const body = i.options.getString('body');

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await this.news.post(who, title, body);
      await i.editReply({ content: `Posted as **${who}**.` });
    } catch (err) {
      console.warn(`[news] post failed: ${err.message}`);
      await i.editReply({ content: 'The post did not go through. Try again.' });
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

  // Roles that ship in an update and have never existed in this guild.
  //
  // The owner's requirement is that the bot creates the roles itself. That
  // held for the first run and nowhere after it: adding a trait to the
  // defaults left an admin to somehow know that /openzone roles sync now
  // wants running, and until he did, the game would ask about a role nobody
  // could hold.
  //
  // NARROW ON PURPOSE. This runs only when something has never been wired at
  // all, and sync() itself refuses to resurrect a role marked Missing -- so
  // a role the admin deleted stays deleted, every time. Nothing happens on a
  // normal restart, which is why it is safe to have it on a normal restart.
  async #syncNewRoles() {
    if (!this.roles) return;
    if (this.roles.pending() === 0) return;

    try {
      // FETCH first. roles.cache is filled by GUILD_CREATE and can still be
      // empty here, and an empty cache reads as "no role by that name" --
      // which would create a duplicate of a role that already exists.
      await this.guild.roles.fetch();

      const r = await this.roles.sync(this.guild);
      if (r.made.length) console.log(`[discord] new roles created: ${r.made.join(', ')}`);
      if (r.adopted.length) console.log(`[discord] adopted existing roles: ${r.adopted.join(', ')}`);
      if (r.ambiguous.length) console.warn(`[discord] left alone, ambiguous: ${r.ambiguous.join('; ')}`);
    } catch (e) {
      console.warn(`[discord] could not create the new roles (${e.message}); run /openzone roles sync when it is fixed`);
    }
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

  usePersonas(personas) {
    this.personas = personas;
  }

  useNews(news) {
    this.news = news;
  }

  // Admin is a PERMISSION or a ROLE: guilds that run on a dedicated admin
  // role set DISCORD_ADMIN_ROLE_ID, everyone else falls back to the Discord
  // Administrator bit.
  isAdminMember(member) {
    if (!member) return false;
    if (this.cfg.adminRoleId && member.roles?.cache?.has(this.cfg.adminRoleId)) return true;
    return !!member.permissions?.has(PermissionFlagsBits.Administrator);
  }

  async #interaction(i) {
    if (!i.isChatInputCommand()) return;

    if (!(await this.#inTheRightChannel(i))) return;

    if (i.commandName === 'openzone') {
      await this.#openzone(i);
      return;
    }

    if (i.commandName === 'post') {
      await this.#post(i);
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
    if (!this.isAdminMember(i.member)) {
      await i.reply({ content: 'That is for server administrators.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!this.roles) {
      await i.reply({ content: 'The role roster is not available right now.', flags: MessageFlags.Ephemeral });
      return;
    }

    const group = i.options.getSubcommandGroup(false);
    const sub = i.options.getSubcommand(false);

    if (group === 'persona') {
      await this.#persona(i, sub);
      return;
    }

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

        let cap = '';
        if (e.kind === 'faction' && e.node.Limit > 0) {
          cap = '  ' + this.roles.sizeOf(i.guild, e.slug) + '/' + e.node.Limit;
        }

        lines.push('`' + e.slug + '` ' + mark + cap);
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

    if (group === 'roles' && sub === 'limit') {
      const slug = i.options.getString('slug');
      const size = i.options.getInteger('size');

      const r = this.roles.setLimit(slug, size);
      if (!r.ok) {
        await i.reply({ content: r.why, flags: MessageFlags.Ephemeral });
        return;
      }

      // Кажемо, скільки ВЖЕ є: ліміт, поставлений нижче за поточний склад,
      // нікого не виганяє -- він лише перекриває набір, -- і адмін мусить
      // побачити це одразу, а не з'ясовувати з чужих скарг.
      const now = this.roles.sizeOf(i.guild, slug);

      let said = `\`${slug}\`: no limit`;
      if (r.limit > 0) said = `\`${slug}\`: at most ${r.limit} (currently ${now})`;
      if (r.limit > 0 && now > r.limit) {
        said += ` -- already over. Nobody is removed; the faction just takes no more.`;
      }

      await i.reply({ content: said, flags: MessageFlags.Ephemeral });
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
    // No thread gate: the zone is a plain channel, and convoByThread is the
    // real question -- a message either belongs to a conversation we carry
    // or it does not.
    const convo = this.store.convoByThread(m.channel.id);
    if (!convo) return;

    // Ours by id first -- exact. Then by linked Discord account, for messages
    // a player typed in Discord rather than in game.
    let who = m.member?.displayName || m.author.username;
    // Byte-clipped at the door: the game truncates any JSON string value at
    // 1023 bytes when parsing, mid-character if we let it (see clip.js).
    let text = byteClip(m.content || '');

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
    //
    // A webhook echo can only be a line WE sent, so it is allowed the loose
    // tiers of the ladder; a human-typed message must match exactly or not
    // at all -- misattributing a stranger's line is worse than dropping ours.
    const ours = !!m.webhookId || m.author.id === this.client.user.id;
    let uid = this.#claim(m.channel.id, who, text, ours);
    if (!uid && !m.webhookId) {
      uid = this.store.steamIdOf(m.author.id);
      // A linked stalker typing FROM Discord speaks under his game name:
      // the Zone knows one identity, and the Discord nick is not it. The
      // unlinked keep their Discord name -- an admin writing from outside
      // is exactly that.
      if (uid) who = this.store.nameOf(uid) || who;
    }

    this.onMessage(convo.key, {
      id: m.id,
      at: new Date(m.createdTimestamp).toISOString().slice(0, 19).replace('T', ' '),
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

    const home = this.homeOf(key.startsWith('g:') ? 'group' : 'direct');
    const th = await home.threads.create({
      name: title.slice(0, 90),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `OpenZone conversation ${key}`,
    });

    await this.#invite(th, memberDiscordIds);
    return th;
  }

  // --- notes ---
  //
  // Notes never touch the conversation index: a notebook thread is not a
  // chat and must not show up in /v1/chat/list. These helpers give the
  // Notes module the same machinery conversations use, minus the index.
  //
  // Notebooks live in THEIR OWN channel, not the chat parent, and that is
  // what makes them read-only: a thread has no permissions of its own, it
  // inherits the channel -- so the chat parent must allow writing in
  // threads (conversations!) while the notebook channel denies it. Only
  // the bot and its webhook write there; a player sees their thread and
  // cannot type into it. The owner asked for exactly this on 2026-08-28.

  // --- typed thread homes ---
  //
  // The owner asked for separate channels per thread TYPE (2026-08-28):
  // direct conversations in one, groups in another, notebooks and the zone
  // already have their own, news will too. The channels stay EMPTY on
  // purpose -- people write inside their threads, never into the channel --
  // so @everyone loses SendMessages and thread creation, but keeps
  // SendMessagesInThreads: a conversation you are in is yours to write in.
  //
  // Old threads stay where they were born: a thread cannot move, and the
  // webhook is resolved by the thread's PARENT, so both eras keep working.

  async ensureTypedChannel(name, topic, knownId) {
    let ch = null;
    if (knownId) ch = await this.client.channels.fetch(knownId).catch(() => null);

    if (!ch) {
      const all = await this.guild.channels.fetch();
      ch = all.find((c) => c && c.type === ChannelType.GuildText && c.name === name);
    }

    if (!ch) {
      ch = await this.guild.channels.create({
        name,
        type: ChannelType.GuildText,
        topic,
        parent: this.parent.parentId ?? undefined,
        reason: 'OpenZone typed thread home',
      });
    }

    await ch.permissionOverwrites.set([
      {
        id: this.guild.roles.everyone.id,
        deny: [
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads,
        ],
        allow: [PermissionFlagsBits.SendMessagesInThreads],
      },
      {
        id: this.client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.CreatePrivateThreads,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.ManageThreads,
          PermissionFlagsBits.ManageWebhooks,
        ],
      },
    ]);

    this.hookByChannel ??= new Map();
    if (!this.hookByChannel.has(ch.id)) {
      this.hookByChannel.set(ch.id, await this.#webhookOn(ch));
    }
    return ch;
  }

  // Where a conversation of this kind is born.
  homeOf(kind) {
    if (kind === 'group' && this.groupChannel) return this.groupChannel;
    if (this.directChannel) return this.directChannel;
    return this.parent;
  }

  // The webhook that can reach a thread: its parent channel's own, with the
  // chat parent's webhook as the fallback for threads born before the split.
  async hookFor(threadId) {
    const th = await this.client.channels.fetch(threadId).catch(() => null);
    if (th?.parentId && this.hookByChannel?.has(th.parentId)) {
      return this.hookByChannel.get(th.parentId);
    }
    return this.webhook;
  }

  // The zone: ONE public text channel. A channel, not a thread, on purpose:
  // a thread must be joined to be followed and archives itself after a
  // quiet week; a channel simply sits in the list, which is what a town
  // square is. Everybody reads and writes it, from the game and from
  // Discord alike. It carries its own webhook -- a webhook belongs to a
  // channel, and the chat parent's one cannot post outside its threads.
  async ensureZoneChannel(knownId) {
    let ch = null;
    if (knownId) {
      ch = await this.client.channels.fetch(knownId).catch(() => null);
      // The first cut of the zone was a THREAD, and its id may still be on
      // file. A thread cannot carry a webhook and is not a town square:
      // only a real text channel qualifies. Anything else falls through to
      // the search below, and index.js then deletes the stray thread and
      // stores the channel id in its place. Measured live: the stored id
      // resolved to thread #Зона and every zone line posted plainly into it.
      if (ch && ch.type !== ChannelType.GuildText) ch = null;
    }

    if (!ch) {
      const all = await this.guild.channels.fetch();
      ch = all.find((c) => c && c.type === ChannelType.GuildText && c.name === 'зона');
    }

    if (!ch) {
      ch = await this.guild.channels.create({
        name: 'зона',
        type: ChannelType.GuildText,
        topic: 'Спільний ефір Зони. Те, що сказано тут, чує кожен КПК.',
        reason: 'OpenZone zone-wide chat',
      });
    }

    this.zoneChannel = ch;
    this.zoneWebhook = await this.#webhookOn(ch);
    return ch;
  }

  async deleteThread(threadId, reason) {
    const th = await this.client.channels.fetch(threadId).catch(() => null);
    if (th) await th.delete(reason);
  }

  // Three answers, never conflated -- the same discipline as #lookUp.
  // A note book must NOT be wiped because Discord had a 500: `gone` is only
  // 10003 Unknown Channel / 10004 Unknown/10008 Unknown Message-thread;
  // every other failure is `unsure` and the caller must leave the index
  // alone. Returning bare null (deleted) for a transient error is exactly
  // how a routine hiccup used to erase a player's whole notebook.
  async fetchThread(threadId) {
    try {
      const th = await this.client.channels.fetch(threadId);
      if (!th) return { gone: true };
      if (th.archived) {
        // Un-archiving can itself fail transiently; that is NOT proof the
        // thread is gone, so a failure here still returns the thread.
        try { await th.setArchived(false); } catch { /* keep the thread */ }
      }
      return { thread: th };
    } catch (e) {
      if (e && (e.code === 10003 || e.code === 10004)) return { gone: true };
      return { unsure: true, why: e && e.message };
    }
  }


  // A page of thread history BEFORE the given message id (or the newest
  // page when no anchor). Returned oldest-first, each line already shaped
  // for the game: webhook posts wear the speaker's name as the author, our
  // bot fallback posts carry it bolded in the text and are unwrapped here.
  // Delete one message in a thread or channel. The zone lives in a plain
  // channel and every other conversation in a thread; channels.fetch
  // resolves both, so one door serves the whole mark-TTL sweep.
  async deleteMessage(threadOrChannelId, messageId) {
    const ch = await this.client.channels.fetch(threadOrChannelId);
    await ch.messages.delete(messageId);
  }

  // Lock or unlock a thread: a frozen direct conversation stays readable
  // in Discord but takes no new messages -- same rule the game enforces.
  async lockThread(threadId, locked) {
    const th = await this.client.channels.fetch(threadId);
    await th.setLocked(locked);
  }

  async fetchOlder(threadId, beforeId, limit) {
    const th = await this.client.channels.fetch(threadId);
    const opts = { limit: Math.min(limit || 50, 100) };
    if (beforeId) opts.before = beforeId;

    const batch = await th.messages.fetch(opts);
    const out = [];
    for (const m of batch.values()) {
      let who = m.member?.displayName || m.author?.username || '';
      let text = m.content || '';
      if (!m.webhookId && m.author?.id === this.client.user.id) {
        const cut = text.match(/^\*\*(.{1,80}?)\*\*: ([\s\S]*)$/);
        if (cut) {
          who = cut[1];
          text = cut[2];
        }
      }
      out.push({
        id: m.id,
        at: new Date(m.createdTimestamp).toISOString().slice(0, 19).replace('T', ' '),
        who,
        text: byteClip(text),
      });
    }

    out.sort((a, b) => (a.id < b.id ? -1 : 1));
    return out;
  }

  async renameThread(threadId, name) {
    const th = await this.client.channels.fetch(threadId);
    await th.setName(name.slice(0, 100));
  }

  // The news module speaks through a webhook too -- that is what puts the
  // persona's NAME on the post instead of the bot's.
  async webhookFor(channel) {
    return this.#webhookOn(channel);
  }

  // The channel-bound twin of #ensureWebhook.
  async #webhookOn(channel) {
    try {
      const hooks = await channel.fetchWebhooks();
      const mine = hooks.find((h) => h.owner?.id === this.client.user.id);
      if (mine) return mine;
      return await channel.createWebhook({
        name: 'OpenZone',
        reason: 'posts notebook entries under each stalker own name',
      });
    } catch (err) {
      console.warn(`[discord] no webhook on #${channel.name} (${err.message}); the bot posts plainly`);
      return null;
    }
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

    // Expect the echo of EVERY line we send, anonymous ones included. An
    // anon send carries uid null, and if we filed no claim for it, its
    // webhook echo fell through the ladder to the thread-order tier and
    // stole an innocent player's still-pending line -- attributing the
    // anonymous shout to them. Filing the claim with uid null makes the
    // echo match itself exactly and resolve to null: nobody's, which is
    // the whole point of anonymity.
    this.#expect(threadId, who, body, uid ?? null);

    try {
      // The zone is a plain channel: its own webhook, no threadId.
      if (this.zoneChannel && threadId === this.zoneChannel.id) {
        if (this.zoneWebhook) {
          await this.zoneWebhook.send({
            username: who,
            content: body,
            allowedMentions: { parse: [] },
          });
        } else {
          await this.zoneChannel.send({
            content: `**${who}**: ${body}`,
            allowedMentions: { parse: [] },
          });
        }
        return;
      }

      const hook = await this.hookFor(threadId);
      if (hook) {
        await hook.send({
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
      // leave it to be collected by the next identical line -- for anon
      // sends too, or the abandoned null-claim would sit and swallow the
      // next matching echo.
      this.#claim(threadId, who, body, true);
      throw err;
    }
  }

  #expect(threadId, who, text, uid) {
    const entry = { threadId, who, text, uid };
    this.pending.push(entry);

    // A send that never echoes must not leave its claim behind, or the next
    // identical line would collect it and be attributed to the wrong stalker.
    setTimeout(() => {
      const at = this.pending.indexOf(entry);
      if (at >= 0) this.pending.splice(at, 1);
    }, 60_000).unref?.();
  }

  // Recognise the echo of a line we sent, and hand back who said it.
  //
  // This used to be ONE exact key: thread + name + text. It looked airtight
  // and it lost lines in the field: Discord is free to normalise both halves
  // of a webhook post -- trim trailing whitespace in the content, adjust a
  // username it dislikes -- and any single changed character turned the
  // player's own message into a stranger's. Nothing said why; the line just
  // rendered as not-theirs.
  //
  // So for OUR OWN webhook echoes the match is a ladder, strict to loose:
  // exact -> same thread+text (name normalised) -> same thread+name (text
  // normalised) -> same thread, oldest first (both normalised; sends are
  // awaited one at a time, so Discord echoes in send order). Every loose
  // tier is logged: the day the normalisation changes, the log says so.
  //
  // Messages a human typed (loose=false) still match only exactly: for them
  // a wrong match is worse than no match.
  #claim(threadId, who, text, loose) {
    let at = this.pending.findIndex((e) => e.threadId === threadId && e.who === who && e.text === text);
    let tier = 'exact';

    if (at < 0 && loose) {
      at = this.pending.findIndex((e) => e.threadId === threadId && e.text === text);
      tier = 'name-normalised';
    }
    if (at < 0 && loose) {
      at = this.pending.findIndex((e) => e.threadId === threadId && e.who === who);
      tier = 'text-normalised';
    }
    if (at < 0 && loose) {
      at = this.pending.findIndex((e) => e.threadId === threadId);
      tier = 'thread-order';
    }
    if (at < 0) return null;

    const [entry] = this.pending.splice(at, 1);
    if (tier !== 'exact') {
      console.log(`[discord] echo matched via ${tier} tier (thread ${threadId}); Discord normalised something`);
    }
    return entry.uid;
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
