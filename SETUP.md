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
  *Manage Roles*

Open the generated URL, pick your test guild, authorise.

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

Leave `DISCORD_PARENT_CHANNEL_ID` empty. The bridge creates the parent channel
on first run and prints its id.

---

## What to hand over

Only the two public ids are worth passing to anyone helping you:

- `DISCORD_GUILD_ID`
- `DISCORD_CLIENT_ID`

The token and the client secret stay in `.env`. Anyone who has the token has
your guild.
