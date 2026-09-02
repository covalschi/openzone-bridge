// TZ-4 D3: invites have a lifetime and count toward the group ceiling.
//
// Store-level, offline. Touches neither Discord nor the stand.

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

const path = join(tmpdir(), `oz-group-invites-${process.pid}.sqlite`);
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

console.log('group invites');

const s = new Store(path, 100);
s.putConvo('g:a:x', { threadId: '', kind: 'group', title: 'g', members: ['a'] });

s.addInvite('g:a:x', 'b', 'a', 3600);
s.addInvite('g:a:x', 'c', 'a', 0);
ok('a live invite is seen', s.hasInvite('g:a:x', 'b'), true);
ok('an invite without a lifetime is seen too', s.hasInvite('g:a:x', 'c'), true);
ok('both count toward the ceiling', s.inviteCount('g:a:x'), 2);
ok('the invitee sees it in his list', s.invitesOf('b').map((i) => i.key), ['g:a:x']);

// An invite already past its lifetime: written with a negative ttl so its
// expiry lies in the past.
s.addInvite('g:a:x', 'd', 'a', -5);
ok('an expired invite is not seen', s.hasInvite('g:a:x', 'd'), false);
ok('nor counted', s.inviteCount('g:a:x'), 2);
ok('nor listed', s.invitesOf('d'), []);
ok('the sweep removes exactly it', s.sweepInvites(), 1);
ok('and the live ones stay', s.inviteCount('g:a:x'), 2);

s.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
