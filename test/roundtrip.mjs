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
  uid: A.uid, name: A.name, otherUid: B.uid, otherName: B.name,
});
ok('thread created', !!started.Key, started.Key);
const key = started.Key;

console.log('--- both sides see it in their list ---');
const listA = await call('/v1/chat/list', { uid: A.uid });
const listB = await call('/v1/chat/list', { uid: B.uid });
ok('A sees the conversation', listA.Items.some((i) => i.Key === key));
ok('B sees the same one', listB.Items.some((i) => i.Key === key));

console.log('--- send from the game ---');
await call('/v1/chat/send', { uid: A.uid, name: A.name, key, text: 'Проверка связи. Как слышно?' });

console.log('--- poll: the message arrives only once Discord has it ---');
const t0 = Date.now();
const batch = await fetch(BASE + '/v1/poll', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ Secret: SECRET, ServerId: SERVER, Cursor: 0, Uids: [A.uid, B.uid] }),
}).then((r) => r.json());
const held = Date.now() - t0;

const lines = batch.Items.map((i) => JSON.parse(i.Json));
ok('poll returned the message', lines.some((l) => l.Text.includes('Как слышно')), `${held} ms, ${batch.Items.length} item(s)`);
ok('it is addressed to both members', new Set(lines.map((l) => l.Uid)).size === 2);

const mineForA = lines.find((l) => l.Uid === A.uid);
ok('A sees it as their own', mineForA?.Mine === true);
ok('the speaker kept their name', mineForA?.Who === A.name, mineForA?.Who);

console.log('--- read the thread back ---');
const open = await call('/v1/chat/open', { uid: B.uid, key, limit: 20 });
ok('B can open it', open.Key === key, open.Title);
ok('the line is in the history', open.Lines.some((l) => l.Text.includes('Как слышно')));
ok('and is NOT B own', open.Lines.at(-1)?.Mine === false);

console.log('--- a stranger cannot open it ---');
const stranger = await call('/v1/chat/open', { uid: '76561100000000009', key, limit: 5 });
ok('refused', !!stranger.Error, stranger.Error);

console.log('--- group ---');
const grp = await call('/v1/chat/group_new', { uid: A.uid, title: 'Свалка' });
ok('group created', !!grp.Key, grp.Key);
const add = await call('/v1/chat/group_add', { uid: A.uid, key: grp.Key, otherUid: B.uid });
ok('B invited', add.ok === true);
const grpOpen = await call('/v1/chat/open', { uid: B.uid, key: grp.Key });
ok('B can open the group', grpOpen.Key === grp.Key, grpOpen.Title);

console.log('--- link status of an unlinked player ---');
const st = await call('/v1/link/status', { uid: A.uid });
ok('not linked yet', st.Linked === false);
const begin = await call('/v1/link/begin', { uid: A.uid });
ok('link url issued', begin.Url.startsWith('https://discord.com/api/oauth2/authorize'));

console.log('--- a wrong secret is refused ---');
const bad = await fetch(BASE + '/v1/chat/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ Secret: 'nope', ServerId: SERVER, Json: { uid: A.uid } }),
});
ok('403', bad.status === 403);
