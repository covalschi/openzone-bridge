// TZ-2: the store may only drop what also exists somewhere else.
//
// This became load-bearing the moment chat's HOME moved here. While Discord
// was the truth, the tail was a cache and shifting the oldest line out was
// free -- fetchOlder brought it back. Now a line sent with the mirror off
// lives in this list and nowhere in the world, and dropping it is deletion.
//
// Runs against a throwaway state file. Touches neither Discord nor the stand.

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

const path = join(tmpdir(), `oz-store-retention-${process.pid}.json`);
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

function line(id, text, inDiscord) {
  return { id, at: id, uid: 'u', who: 'w', text, inDiscord };
}
const texts = (s, key) => s.messagesOf(key).map((m) => m.text);

console.log('retention');

// Keep 3. Two lines Discord has, three that only we have.
const s = new Store(path, 3);
s.addMessage('k', line('a', 'mirrored 1', true));
s.addMessage('k', line('b', 'mirrored 2', true));
s.addMessage('k', line('c', 'only here 1', false));
s.addMessage('k', line('d', 'only here 2', false));
s.addMessage('k', line('e', 'only here 3', false));

ok('the mirrored lines are the ones dropped, oldest first',
  texts(s, 'k'), ['only here 1', 'only here 2', 'only here 3']);

// Over the bound and nothing droppable: we keep them anyway. Losing a
// player's words silently is worse than a state file that grows.
s.addMessage('k', line('f', 'only here 4', false));
ok('a full list of unmirrored lines grows rather than losing one',
  texts(s, 'k'), ['only here 1', 'only here 2', 'only here 3', 'only here 4']);

// A line Discord accepted later is droppable again, and it goes first.
s.addMessage('k', line('g', 'mirrored 3', true));
ok('a newly mirrored line is preferred for dropping over unmirrored ones',
  texts(s, 'k'), ['only here 1', 'only here 2', 'only here 3', 'only here 4']);

// Records written before the field existed: Discord was the only path a
// line could take then, so undefined has to mean "Discord has it".
const s2 = new Store(join(tmpdir(), `oz-store-retention-old-${process.pid}.json`), 2);
s2.addMessage('k', { id: 'x', at: '1', uid: 'u', who: 'w', text: 'legacy 1' });
s2.addMessage('k', { id: 'y', at: '2', uid: 'u', who: 'w', text: 'legacy 2' });
s2.addMessage('k', { id: 'z', at: '3', uid: 'u', who: 'w', text: 'legacy 3' });
ok('a record with no inDiscord field is treated as being in Discord',
  texts(s2, 'k'), ['legacy 2', 'legacy 3']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
