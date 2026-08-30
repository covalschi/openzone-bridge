// End-to-end check against a running bridge and a real guild.
//
// Proves the one thing that matters for a Discord-first chat: a message the
// game sends is not in the conversation until DISCORD hands it back. So we
// send, then poll, and the poll is what confirms it — not the send's own reply.
//
//   node test/roundtrip.mjs
//
// Reads the secret from .env; it is never printed.

import 'dotenv/config';

const BASE = `http://127.0.0.1:${process.env.BRIDGE_PORT || 8787}`;
const SECRET = process.env.OZ_SHARED_SECRET;
const SERVER = 'stand';

const A = { uid: '76561100000000001', name: 'Bродяга' };
const B = { uid: '76561100000000002', name: 'Сидорович' };

async function call(path, json) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Secret: SECRET, ServerId: SERVER, Json: json }),
  });
  const body = await r.json();
  if (r.status !== 200) throw new Error(`${path} -> ${r.status} ${JSON.stringify(body)}`);
  return body;
}

function ok(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

console.log('--- start a direct conversation ---');
const started = await call('/v1/chat/start', {
  Uid: A.uid, Name: A.name, OtherUid: B.uid, OtherName: B.name,
});
ok('thread created', !!started.Id, started.Id);
const key = started.Id;

console.log('--- both sides see it in their list ---');
const listA = await call('/v1/chat/list', { Uid: A.uid });
const listB = await call('/v1/chat/list', { Uid: B.uid });
ok('A sees the conversation', listA.Items.some((i) => i.Id === key));
ok('B sees the same one', listB.Items.some((i) => i.Id === key));

console.log('--- send from the game ---');
// The probe text carries a per-run nonce: identical texts across runs let a
// LATE Discord echo of the previous run claim this run's expect, and the
// line lands unowned (measured 2026-08-30: reruns flipped Mine/name).
const probe = `Перевірка зв'язку ${Date.now().toString(36)}. Чути?`;
await call('/v1/chat/send', { Uid: A.uid, Name: A.name, Id: key, Text: probe });

console.log('--- poll: the message arrives only once Discord has it ---');
const t0 = Date.now();
const batch = await fetch(BASE + '/v1/poll', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ Secret: SECRET, ServerId: SERVER, Cursor: 0, Uids: [A.uid, B.uid] }),
}).then((r) => r.json());
const held = Date.now() - t0;

const lines = batch.Items.map((i) => JSON.parse(i.Json));
ok('poll returned the message', lines.some((l) => l.Text.includes(probe)), `${held} ms, ${batch.Items.length} item(s)`);
ok('it is addressed to both members', new Set(lines.map((l) => l.Uid)).size === 2);

// The poll replays from cursor 0, so history — the zone included — rides
// along; pick OUR line, not merely the first one addressed to A.
const mineForA = lines.find((l) => l.Uid === A.uid && l.Text.includes(probe));
ok('A sees it as their own', mineForA?.Mine === true);
ok('the speaker kept their name', mineForA?.Who === A.name, mineForA?.Who);

console.log('--- read the thread back ---');
const open = await call('/v1/chat/open', { Uid: B.uid, Id: key, Limit: 20 });
ok('B can open it', open.Id === key, open.Title);
ok('the line is in the history', open.Lines.some((l) => l.Text.includes(probe)));
ok('and is NOT B own', open.Lines.at(-1)?.Mine === false);

console.log('--- a stranger cannot open it ---');
const stranger = await call('/v1/chat/open', { Uid: '76561100000000009', Id: key, Limit: 5 });
ok('refused', !!stranger.Error, stranger.Error);

console.log('--- group ---');
const grp = await call('/v1/chat/group_new', { Uid: A.uid, Title: 'Звалище' });
ok('group created', !!grp.Id, grp.Id);
const add = await call('/v1/chat/group_add', { Uid: A.uid, Id: grp.Id, OtherUid: B.uid });
ok('B invited', add.ok === true);
// Nobody lands in a group unasked: the add only files an invite, so the
// group stays closed to B until B accepts it himself.
const early = await call('/v1/chat/open', { Uid: B.uid, Id: grp.Id });
ok('B cannot open before accepting', early.Error === 'no_chat');
const accept = await call('/v1/chat/invite_accept', { Uid: B.uid, Id: grp.Id });
ok('B accepted the invite', accept.ok === true);
const grpOpen = await call('/v1/chat/open', { Uid: B.uid, Id: grp.Id });
ok('B can open the group', grpOpen.Id === grp.Id, grpOpen.Title);

console.log('--- link status of an unlinked player ---');
const st = await call('/v1/link/status', { Uid: A.uid });
ok('not linked yet', st.Linked === false);
const begin = await call('/v1/link/begin', { Uid: A.uid });
ok('link url issued', begin.Url.startsWith('https://discord.com/api/oauth2/authorize'));

console.log('--- a wrong secret is refused ---');
const bad = await fetch(BASE + '/v1/chat/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ Secret: 'nope', ServerId: SERVER, Json: { Uid: A.uid } }),
});
ok('403', bad.status === 403);

