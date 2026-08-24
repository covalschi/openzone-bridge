# Contributing to OpenZone

Thanks for wanting to help. A few things to know before you open a pull request.

## Licence and rights

OpenZone is licensed under **CC BY-NC-SA 4.0** with an additional permission (see
`LICENSE` and `NOTICE`).

By submitting a contribution you agree that:

1. The contribution is your own work, or you have the right to submit it.
2. You assign copyright in the contribution to the project owner, or — where your
   jurisdiction does not permit assignment — you grant the owner an irrevocable,
   worldwide, royalty-free licence to use, modify, sublicense and relicense it,
   including under terms different from CC BY-NC-SA 4.0.

Point 2 exists so the project can be relicensed later without hunting down every
past contributor. Without it, a single unreachable contributor can freeze the
licence forever.

Contributions that carry code under a licence incompatible with CC BY-NC-SA 4.0
cannot be accepted. **GPL code in particular cannot go in.**

## Ground rules for the mod repositories

- **Do not invent DayZ API.** Every engine call must be checked against the
  unpacked game scripts. If you are not sure, unpack the PBO and look.
- **No text in code.** Every user-facing string goes through the stringtable.
  English is the base language.
- **No hard dependency beyond Community Framework.** Anything else is an optional
  provider behind an `#ifdef` plus a runtime probe, with a working fallback.
- **Never identify an item by inheritance from our own class.** Item classnames come
  from JSON so that admins can point the mod at items from any mod.
- Every `.ps1` file must be saved as **UTF-8 with BOM**, or Windows PowerShell 5.1
  reads it in the system codepage and the parser dies on non-ASCII.

## Before you open a pull request

- The mod compiles: server boot and client compile check both clean.
- No new warnings in the server log.
- If you added a config field, it has a default, a migration, and a line in
  `Validate()`.
