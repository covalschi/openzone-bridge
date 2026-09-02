// TZ-2 R5.2/R5.5: turning the chat mirror on pushes exactly the lines the
// guild has never seen, marks them, and a repeat pushes nothing again; a
// refusal halfway leaves the rest for the next run.
//
// Runs against a throwaway store and a fake Discord. Touches neither the
// real guild nor the stand.

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { fillMirror } from '../src/mirror.js';

const path = join(tmpdir(), `oz-mirror-fill-${process.pid}.sqlite`);
if (existsSync(path)) unlinkSync(path);

let pass = 0;
let fail = 0;
function ok(what, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++;
    console.log(`  ok   ${what}`);
    return;
  }
  fail++;
  console.log(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}

const store = new Store(path, 100);
const quiet = { log() {} };

store.link('111', 'd-111', 'one');
store.link('222', 'd-222', 'two');

// A direct conversation that never had a thread (mirror was off when it started).
store.putConvo('d:111:222', { threadId: '', kind: 'direct', title: 'one & two', members: ['111', '222'] });
store.addMessage('d:111:222', { id: 'a1', at: '2026-09-02 10:00:00', uid: '111', who: 'one', text: 'hello', inDiscord: false });
store.addMessage('d:111:222', { id: 'a2', at: '2026-09-02 10:00:05', uid: '222', who: 'two', text: 'hi', inDiscord: false });
// Already in Discord: must not be pushed again.
store.addMessage('d:111:222', { id: 'a3', at: '2026-09-02 10:00:09', uid: '111', who: 'one', text: 'old', inDiscord: true });
// Came FROM Discord: it is there by definition.
store.addMessage('d:111:222', { id: 'a4', at: '2026-09-02 10:00:12', uid: '222', who: 'two', text: 'from guild', inDiscord: false, fromDiscord: true });

// The zone: a plain channel, no thread to create.
store.putConvo('zone', { threadId: 'zone-ch', kind: 'zone', title: 'Zone', members: [] });
store.addMessage('zone', { id: 'z1', at: '2026-09-02 10:01:00', uid: null, who: 'Невідомий сталкер', text: 'anyone?', inDiscord: false });

// An archived group: its lines stay home.
store.putConvo('g:111:x', { threadId: 'gone', kind: 'group', title: 'old crew', members: [], archived: true });
store.addMessage('g:111:x', { id: 'g1', at: '2026-09-02 10:02:00', uid: '111', who: 'one', text: 'bye', inDiscord: false });

const said = [];
const threads = [];
const discord = {
  async ensureThread(key, title, ids) { threads.push({ key, title, ids }); return { id: 't-' + key }; },
  async say(threadId, who, text, uid) {
    if (text.includes('BOOM')) throw new Error('refused');
    said.push({ threadId, who, text, uid });
  },
};

console.log('unknown kind');
{
  const r = await fillMirror({ store, discord, kind: 'notes', log: quiet });
  ok('refused by name', [r.ok, r.why], [false, 'no mirror for kind "notes"']);
}

console.log('first fill');
{
  const r = await fillMirror({ store, discord, kind: 'chat', log: quiet });
  ok('ok, counts', [r.ok, r.pushed, r.skipped, r.failed], [true, 3, 1, 0]);
  ok('thread created for the direct pair with both members', threads.map((t) => [t.key, t.ids]), [['d:111:222', ['d-111', 'd-222']]]);
  ok('the convo learned its thread', store.convo('d:111:222').threadId, 't-d:111:222');
  ok('lines pushed in order, zone into its channel', said.map((s) => [s.threadId, s.text, s.uid]),
    [['t-d:111:222', 'hello', '111'], ['t-d:111:222', 'hi', '222'], ['zone-ch', 'anyone?', null]]);
  ok('pushed lines are marked', store.messagesOf('d:111:222').map((m) => [m.id, m.inDiscord]),
    [['a1', true], ['a2', true], ['a3', true], ['a4', false]]);
  ok('archived group named in the note', r.note.includes('g:111:x: archived'), true);
}

console.log('second fill pushes nothing');
{
  said.length = 0;
  const r = await fillMirror({ store, discord, kind: 'chat', log: quiet });
  ok('nothing new', [r.ok, r.pushed, r.failed, said.length], [true, 0, 0, 0]);
}

console.log('a refusal halfway');
{
  store.addMessage('d:111:222', { id: 'a5', at: '2026-09-02 10:03:00', uid: '111', who: 'one', text: 'fine', inDiscord: false });
  store.addMessage('d:111:222', { id: 'a6', at: '2026-09-02 10:03:05', uid: '111', who: 'one', text: 'BOOM', inDiscord: false });
  store.addMessage('d:111:222', { id: 'a7', at: '2026-09-02 10:03:09', uid: '222', who: 'two', text: 'after', inDiscord: false });
  said.length = 0;
  const r = await fillMirror({ store, discord, kind: 'chat', log: quiet });
  ok('not ok, one failed, the others pushed', [r.ok, r.pushed, r.failed], [false, 2, 1]);
  ok('the refused line stays unmarked, the rest marked', store.messagesOf('d:111:222').filter((m) => m.id >= 'a5').map((m) => [m.id, m.inDiscord]),
    [['a5', true], ['a6', false], ['a7', true]]);
  ok('why says to run again', r.why.includes('run it again'), true);
}

store.close();
if (existsSync(path)) unlinkSync(path);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
