// D77: who said it in history deeper than the store tail.
//
// The live guild on the dev stand has no history older than its own tail, so
// the Discord tier cannot be exercised against it. This drives the same two
// pieces of logic directly, against the REAL store and the REAL link table:
// the resolution fetchOlder does per Discord message, and the attribution the
// /v1/chat/older route does per line.
//
// Reads only. Nothing here touches Discord.

import { Store } from '../src/store.js';

const store = new Store(process.env.BRIDGE_DB || './state/bridge.sqlite');

let pass = 0;
let fail = 0;
function ok(what, got, want) {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) pass++;
  else {
    fail++;
    console.log(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    return;
  }
  console.log(`  ok   ${what}`);
}

// The link table this stand actually carries.
const LINKED_DISCORD = '242189070724235264';
const LINKED_STEAM = '76561198014475380';
const OTHER_STEAM = '76561198114539600';
const BOT = '999999999999999999';

// --- what fetchOlder does per message, extracted verbatim in shape ---
//
// Kept as a local copy on purpose: the real one is a method on DiscordSide
// and needs a logged-in client. What is under test is the RULE, and the rule
// is three lines.
function uidOf(m, botId) {
  if (!m.webhookId && m.author?.id !== botId) return store.steamIdOf(m.author?.id) || '';
  return '';
}

console.log('fetchOlder: who said it');
ok('a linked player typing in Discord resolves to his stalker',
  uidOf({ author: { id: LINKED_DISCORD } }, BOT), LINKED_STEAM);
ok('an unlinked Discord account resolves to nobody',
  uidOf({ author: { id: '111111111111111111' } }, BOT), '');
ok('a webhook post (a line the game sent) resolves to nobody, never by name',
  uidOf({ webhookId: 'w1', author: { id: BOT } }, BOT), '');
ok('the bot speaking as itself resolves to nobody',
  uidOf({ author: { id: BOT } }, BOT), '');

// --- what the route does with those uids ---
function attribute(lines, reader, tail) {
  const known = new Map();
  for (const m of tail) if (m.uid) known.set(m.id, m.uid);
  for (const m of lines) if (!m.uid && known.has(m.id)) m.uid = known.get(m.id);
  return lines.map((m) => ({ Who: m.who, Mine: !!m.uid && m.uid === reader, AUid: m.uid || '' }));
}

console.log('\n/v1/chat/older: attribution');

// The whole point of the defect: a rename must not move history, and a
// namesake must not inherit it.
const renamed = attribute(
  [{ id: '1', who: 'Survivor', uid: LINKED_STEAM }],
  LINKED_STEAM, []);
ok('my own line is mine even though I have since been renamed',
  renamed[0], { Who: 'Survivor', Mine: true, AUid: LINKED_STEAM });

const namesake = attribute(
  [{ id: '2', who: 'Survivor', uid: OTHER_STEAM }],
  LINKED_STEAM, []);
ok('a namesake does NOT inherit my line',
  namesake[0], { Who: 'Survivor', Mine: false, AUid: OTHER_STEAM });

const unknown = attribute(
  [{ id: '3', who: 'Survivor', uid: '' }],
  LINKED_STEAM, []);
ok('an unattributable line is neutral, not mine, not coloured',
  unknown[0], { Who: 'Survivor', Mine: false, AUid: '' });

// The overlap tier: Discord cannot attribute a webhook post, but the tail
// still remembers who sent it.
const filled = attribute(
  [{ id: '4', who: 'Survivor', uid: '' }],
  LINKED_STEAM,
  [{ id: '4', uid: LINKED_STEAM }]);
ok('a game-relayed line still inside the tail is recovered from the tail',
  filled[0], { Who: 'Survivor', Mine: true, AUid: LINKED_STEAM });

const past = attribute(
  [{ id: '5', who: 'Survivor', uid: '' }],
  LINKED_STEAM,
  [{ id: '4', uid: LINKED_STEAM }]);
ok('a line past the tail stays honest rather than guessing',
  past[0], { Who: 'Survivor', Mine: false, AUid: '' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
