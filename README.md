# OpenZone Bridge

The service that connects a DayZ server running **OpenZone** to a Discord guild.

## Why a separate service

A DayZ server can make outbound HTTP requests, but it accepts no inbound connections,
and its REST client cannot set request headers. Discord cannot push into the game.
The bridge closes that gap:

- **Game to Discord** — the DayZ server POSTs to the bridge; the bridge writes to
  Discord.
- **Discord to game** — the bridge holds the game's poll request open until something
  happens, then answers with a batch, so this behaves like a push with none of the
  latency of short polling. The hold is kept **under ten seconds**: the engine kills
  an asynchronous REST request at exactly ten, whatever `SetOption` was told. The
  3..120 range in the docs describes the blocking `POST_now`, not the async path
  this uses — measured on the stand, and the reason `POLL_HOLD_SECONDS` defaults
  to 8.

## What it does

- Links a player's SteamID to their Discord account through OAuth2.
- Keeps every private conversation and group chat as a **private Discord thread**,
  visible only to its participants. Threads, not channels: a guild is capped at 500
  channels, which a server with active players would exhaust, while archived threads
  are unlimited.
- Keeps factions, posts, ranks and traits, and who holds what, in its own SQLite
  tables (keyed by Steam64, no Discord link required) and mirrors them onto Discord
  roles when the roles mirror is on — one direction: a role edited by hand in the
  guild is put back from the tables.
- Caches recent messages so the PDA still shows history and can queue outgoing
  messages while Discord is unreachable.

## Running

Node.js **24+** (the store is `node:sqlite`, which ships unflagged from 24 -- nothing to
compile on the host) and a filled-in `.env` (see `SETUP.md`). Then:

- **Windows**: `.\run.ps1` — or `.\run.ps1 -Loop` to restart on crash.
- **Linux**: `./run.sh` — or `./run.sh --loop`.

Both scripts check the Node version, install the two dependencies on first
run, refuse to start without `.env`, and then just run `node src/index.js`.

## State

Everything the bridge remembers -- account links, conversation keys, the chat
tail, news, invites -- lives in one SQLite file, `state/bridge.sqlite` by
default (`BRIDGE_DB` in `.env`). Writes are atomic and the chat tail is read
from a cursor, not by loading the whole file; a line that exists only here is
never evicted.

Upgrading from a bridge that kept `state/bridge.json`: the bot does **not**
migrate on its own. Run

```
node scripts/migrate-json-to-sqlite.mjs
```

once, read the report, and only then start the bridge; it refuses to start
beside an unmigrated document. Back up `state/` the way you would any small
database -- copy the `.sqlite` file while the bridge is stopped, or use
`sqlite3 state/bridge.sqlite ".backup state/bridge.bak"` while it runs.

For unattended hosting:

- **Linux**: a systemd unit ships in `deploy/openzone-bridge.service`; the
  install commands are at the top of the file. `journalctl -u openzone-bridge -f`
  for logs.
- **Windows**: register a Scheduled Task that runs at boot:

  ```
  schtasks /create /tn OpenZoneBridge /sc onstart /ru SYSTEM /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\openzone-bridge\run.ps1 -Loop"
  ```

  Adjust the path; the task survives logout, a console window does not.

## Security

The DayZ server is the only party that talks to the bridge. The shared secret travels
in the request body, because DayZ cannot set an `Authorization` header, so the endpoint
**must** be HTTPS. Game clients never see it.

## Status

Working, and exercised against a live guild — private threads created, messages
posted through a webhook, the game's long poll served for hours at a stretch, and
the bridge's own echo suppressed so a player never sees his line twice.

Not production-ready, and the gaps are named rather than hidden: no HTTPS (a plain
`node:http` listener, while the shared secret travels in the body), no outbound
queue or retry, no rate limiting, no input validation, no process supervision, no
health check anybody reads.

Run it behind a TLS terminator and treat `OZ_SHARED_SECRET` as what it is:
credentials to every player's private conversations.

## Licence

CC BY-NC-SA 4.0 with an additional permission — see `LICENSE` and `NOTICE`.
