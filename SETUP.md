# Discord setup

Five minutes of clicking, once. Do this before the bridge is written and it will
be waiting when the bridge arrives.

**Nothing secret leaves your machine.** The bot token and the client secret go
into `.env` and are read only by the bridge process. They are never logged,
never sent to a game client, and never committed — `.env` is gitignored.

---

## 1. Create the application

<https://discord.com/developers/applications> → **New Application** → name it
(`OpenZone` is fine).

From **General Information**, copy the **Application ID**. This is not secret.

## 2. Create the bot and turn on two intents

**Bot** tab → the bot is created with the application.

Turn ON, under *Privileged Gateway Intents*:

- **Message Content Intent** — without it the bot receives messages with an
  empty body and the chat bridge silently carries nothing.
- **Server Members Intent** — without it role synchronisation cannot see who is
  in the guild.

Both default to OFF. Forgetting them is the single most common reason a bridge
"connects fine and does nothing".

Then **Reset Token** and copy it. This IS secret.

## 3. Invite the bot

**OAuth2 → URL Generator**:

- Scopes: `bot`, `applications.commands`
- Bot permissions: *View Channels*, *Send Messages*, *Create Private Threads*,
  *Send Messages in Threads*, *Manage Threads*, *Read Message History*,
  *Manage Roles*, **Manage Webhooks**

Open the generated URL, pick your test guild, authorise.

Or skip the generator — this is the same set as a number:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=361582627840
```

### Why Manage Webhooks

Without it the bot can still carry every message, but it posts them all as
itself, with the speaker's name in bold in front of the line. With it, each
stalker appears in the thread under their own in-game name. The bridge starts
either way and says in its first line which of the two it got.

**Already invited the bot without it?** No need to re-invite. Either:

- *Server Settings → Roles → (the bot's role) → Permissions →* turn on
  **Manage Webhooks**; or
- right-click the parent channel *→ Edit Channel → Permissions →* add the bot's
  role and turn on **Manage Webhooks** there — narrower, and enough.

Restart the bridge afterwards; it decides once, at start-up.

### The trap

In the guild, **Server Settings → Roles**, drag the bot's own role **above**
every role it will manage. Discord refuses to grant or revoke a role that sits
higher than the actor's highest role — and it refuses *silently*, with no error
anywhere. If faction roles never appear, this is why.

## 4. Register the redirect URL

**OAuth2** tab → *Redirects* → add:

```
http://localhost:8787/oauth/callback
```

It has to match what the bridge sends character for character — scheme, host,
port, path, trailing slash. A mismatch gives `invalid_redirect_uri`.

Discord permits plain `http` for `localhost` specifically; it is the one
exception to its https rule, and it is what makes a local test bridge possible
without a domain or a certificate.

Copy the **Client Secret** from this tab. It IS secret.

## 5. Get the guild id

In Discord: **User Settings → Advanced → Developer Mode** ON. Then right-click
the server icon → **Copy Server ID**. Not secret.

## 6. Fill in `.env`

```bash
cp .env.example .env
```

Paste in: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
`DISCORD_GUILD_ID`.

Generate the shared secret and paste it in both places:

```bash
openssl rand -hex 32
```

- `.env` → `OZ_SHARED_SECRET`
- the game server's `$profile:OpenZone\Settings.json` → `Bridge.Secret`

`DISCORD_PARENT_CHANNEL_ID` is **required** — the bridge refuses to start without
it. Every private conversation is a thread, and a thread needs a channel to hang
from.

Make the channel yourself:

1. In your server, create a normal text channel — `#openzone` will do. Threads
   only work under a text channel, not under a category or a forum.
2. Make sure the bot can see it, and that it has **Manage Threads**, **Create
   Private Threads** and **Send Messages** there.
3. Right-click the channel → **Copy Channel ID** and paste it into `.env`.

Players never read this channel. They only ever see the threads they are added
to.

---

## What to hand over

Only the two public ids are worth passing to anyone helping you:

- `DISCORD_GUILD_ID`
- `DISCORD_CLIENT_ID`

The token and the client secret stay in `.env`. Anyone who has the token has
your guild.
