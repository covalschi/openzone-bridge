// TZ-4 D2: history pages are counts of lines, and "more" is a fact.
//
// Runs against a throwaway store. Touches neither Discord nor the stand.

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { openPage, olderFromStore } from '../src/history.js';

const path = join(tmpdir(), `oz-chat-history-${process.pid}.sqlite`);
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

const parseAt = (at) => Date.parse(String(at).replace(' ', 'T') + 'Z') || 0;
const stamp = (i) => `2026-09-02 10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;

console.log('history by count');

const s = new Store(path, 1000);
s.putConvo('k', { threadId: '', kind: 'direct', title: 't', members: ['a', 'b'] });
for (let i = 1; i <= 45; i++) s.addMessage('k', { id: 'm' + i, at: stamp(i), uid: 'a', who: 'A', text: 'line ' + i });

const first = openPage({ store: s, key: 'k', uid: 'a', limit: 20, until: 0, parseAt });
ok('open hands back the newest 20', first.lines.map((l) => l.Text), Array.from({ length: 20 }, (_, i) => 'line ' + (26 + i)));
ok('and knows there is more', first.more, true);
ok('the top of the page is line 26', first.before, 'm26');

const second = olderFromStore({ store: s, key: 'k', uid: 'a', before: first.before, limit: 20, until: 0, parseAt });
ok('older hands back the 20 before that', second.lines.map((l) => l.Text), Array.from({ length: 20 }, (_, i) => 'line ' + (6 + i)));
ok('and still knows there is more', second.more, true);

const third = olderFromStore({ store: s, key: 'k', uid: 'a', before: second.before, limit: 20, until: 0, parseAt });
ok('the last page is the remaining 5', third.lines.map((l) => l.Text), ['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
ok('and says there is no more', third.more, false);
ok('and that the store edge was reached', third.atStoreEdge, true);

const none = olderFromStore({ store: s, key: 'k', uid: 'a', before: third.before, limit: 20, until: 0, parseAt });
ok('nothing older than the first line comes from the store', none, null);

const frozen = openPage({ store: s, key: 'k', uid: 'a', limit: 20, until: parseAt(stamp(10)), parseAt });
ok('a freeze stamp cuts the view at that moment', frozen.lines.map((l) => l.Text).slice(-1), ['line 10']);
ok('mine is decided by uid', first.lines[0].Mine, true);

const small = openPage({ store: s, key: 'k', uid: 'b', limit: 200, until: 0, parseAt });
ok('a page is capped at 100', small.lines.length, 45);

s.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
