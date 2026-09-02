// Conversation history BY COUNT, not by clock (TZ-4 R-D2.1..R-D2.4).
//
// The old pages were 8-hour windows anchored to the newest line, and the
// game's ChatHistoryOpen / ChatHistoryPage numbers travelled here to be
// ignored. Now a page is N lines: open() hands back the newest N, older()
// the N before a given line, and "there is more" is a FACT read from the
// store rather than a guess about the tail being full.
//
// Pure functions over the store so a test can drive them without Discord;
// the Discord tier (lines deeper than the store remembers) stays in the
// route, because only the route has a client.

export function openPage({ store, key, uid, limit, until, parseAt }) {
  const page = Math.min(Math.max(Number(limit) || 20, 1), 100);
  let all = store.messagesOf(key);
  if (until) all = all.filter((m) => parseAt(m.at) <= until);

  const shown = all.slice(Math.max(all.length - page, 0));
  return {
    lines: shown.map((m) => toLine(m, uid)),
    // More lines exist in the store before the ones shown: a fact.
    more: all.length > shown.length,
    before: shown[0]?.id || '',
    oldest: shown[0]?.id || '',
  };
}

// The page BEFORE `before`, from the store. Null when the store holds
// nothing older than that line -- the caller then asks Discord, which is
// the only party that remembers past the tail.
export function olderFromStore({ store, key, uid, before, limit, until, parseAt }) {
  const page = Math.min(Math.max(Number(limit) || 20, 1), 100);
  let all = store.messagesOf(key);
  if (until) all = all.filter((m) => parseAt(m.at) <= until);

  const at = before ? all.findIndex((m) => m.id === before) : -1;
  if (at <= 0) return null;

  const older = all.slice(0, at);
  const chunk = older.slice(Math.max(older.length - page, 0));
  return {
    lines: chunk.map((m) => toLine(m, uid)),
    more: older.length > chunk.length,
    before: chunk[0]?.id || before,
    oldest: chunk[0]?.id || before,
    // Whether the store's edge was reached with this page: when the chunk
    // starts at the very first stored line, whatever lies deeper is in
    // Discord and the route has to ask there before saying "no more".
    atStoreEdge: older.length <= chunk.length,
  };
}

export function toLine(m, uid) {
  return { At: m.at, Who: m.who, Text: m.text, Mine: !!m.uid && m.uid === uid, AUid: m.uid || '' };
}
