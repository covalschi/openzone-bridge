# OpenZone Bridge

The service that connects a DayZ server running **OpenZone** to a Discord guild.

## Why a separate service

A DayZ server can make outbound HTTP requests, but it accepts no inbound connections,
and its REST client cannot set request headers. Discord cannot push into the game.
The bridge closes that gap:

- **Game to Discord** — the DayZ server POSTs to the bridge; the bridge writes to
  Discord.
- **Discord to game** — the bridge holds the game's poll request open until something
  happens, then answers with a batch. DayZ's REST timeout is configurable up to 120
  seconds, so this behaves like a push with none of the latency of short polling.

## What it does

- Links a player's SteamID to their Discord account through OAuth2.
- Keeps every private conversation and group chat as a **private Discord thread**,
  visible only to its participants. Threads, not channels: a guild is capped at 500
  channels, which a server with active players would exhaust, while archived threads
  are unlimited.
- Mirrors faction and rank changes onto Discord roles, and reads role membership back
  into the game — with the direction of authority declared per mapping.
- Caches recent messages so the PDA still shows history and can queue outgoing
  messages while Discord is unreachable.

## Security

The DayZ server is the only party that talks to the bridge. The shared secret travels
in the request body, because DayZ cannot set an `Authorization` header, so the endpoint
**must** be HTTPS. Game clients never see it.

## Status

Not started. Design lives with the OpenZone specs.

## Licence

CC BY-NC-SA 4.0 with an additional permission — see `LICENSE` and `NOTICE`.
