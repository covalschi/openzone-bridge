// Turning a mirror ON pushes the history of that kind from the bot's base
// into the guild (TZ-2 R5.2). The base is the home; Discord is a surface,
// and a surface that was off for a while has simply not seen those lines.
//
// Idempotent by construction: every stored line says whether Discord has it
// (`inDiscord`), a pushed line is marked the moment the guild accepts it,
// and a repeat pushes only what is still missing. A failure halfway leaves
// the pushed part marked and the rest unmarked -- the caller keeps the
// mirror OFF and tries again later (R5.2: "Mirror не тронут").
//
// Only `chat` has a mirror today (direct, group, npc threads and the zone
// channel). Any other kind is refused by name rather than silently skipped.

export async function fillMirror({ store, discord, kind, log = console }) {
  const report = { ok: false, why: '', pushed: 0, skipped: 0, failed: 0, note: '' };

  if (kind !== 'chat') {
    report.why = `no mirror for kind "${kind}"`;
    return report;
  }

  const notes = [];
  const idsOf = (members) => (members || []).map((uid) => store.linkOf(uid)?.discordId).filter(Boolean);

  for (const c of store.convosAll()) {
    if (!c || !c.key) continue;

    const lines = store.messagesOf(c.key).filter((m) => m && m.inDiscord === false && !m.fromDiscord);
    if (lines.length === 0) continue;

    // An archived group is over: its thread is locked in the guild, and the
    // lines it never mirrored stay home. Not a failure -- a fact.
    if (c.archived) {
      report.skipped += lines.length;
      notes.push(`${c.key}: archived, ${lines.length} line(s) stay home`);
      continue;
    }

    let threadId = c.threadId || '';
    if (c.kind === 'zone') {
      if (!threadId) {
        report.skipped += lines.length;
        notes.push('zone: no channel bound, lines stay home');
        continue;
      }
    } else {
      try {
        const th = await discord.ensureThread(c.key, c.title || c.key, idsOf(c.members));
        threadId = th.id;
        if (c.threadId !== th.id) {
          c.threadId = th.id;
          store.putConvo(c.key, c);
        }
      } catch (err) {
        report.failed += lines.length;
        notes.push(`${c.key}: no thread (${err.message})`);
        continue;
      }
    }

    for (const m of lines) {
      try {
        await discord.say(threadId, m.who || '?', m.text || '', m.uid ?? null);
        store.setInDiscord(c.key, m.id, true);
        report.pushed++;
      } catch (err) {
        report.failed++;
        notes.push(`${c.key}/${m.id}: ${err.message}`);
      }
    }
  }

  report.ok = report.failed === 0;
  if (!report.ok) report.why = `${report.failed} line(s) did not reach Discord; the mirror stays off - run it again`;
  report.note = notes.slice(0, 5).join('; ');
  if (notes.length > 5) report.note += `; +${notes.length - 5} more`;

  log.log(`[mirror] fill ${kind}: pushed ${report.pushed}, skipped ${report.skipped}, failed ${report.failed}`);
  return report;
}
