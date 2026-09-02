// TZ-6: who may sign a news post with which name.
//
// This rule was read backwards once and implemented as "one fixed voice per
// organisation, the leader may not choose" (TZ-6 §1a). The owner's answer:
//
//   несколько у одной ГП, лидер ГП может выбирать от чьего имени отправлять,
//   но сами персоны назначаются админами
//
// So the line runs between WHICH NAMES WE HAVE -- an admin's act, a grant --
// and WHICH ONE SIGNS THIS POST, which is the leader's. These assertions
// exist so the next reading cannot go the other way silently.
//
// Reads only. Touches neither Discord nor the stand.

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Personas } from '../src/personas.js';

const path = join(tmpdir(), `oz-personas-${process.pid}.json`);
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

const p = new Personas(path);
p.create('Сидорович', 'admin');
p.create('Бармен', 'admin');
p.create('Лебедєв', 'admin');
p.grant('Сидорович', 'duty');
p.grant('Бармен', 'duty');       // an organisation may hold SEVERAL
p.grant('Лебедєв', 'freedom');

const leaderOfDuty = { Org: 'duty', Posts: ['leader'] };
const memberOfDuty = { Org: 'duty', Posts: [] };
const loner = { Org: '', Posts: [] };

console.log('who may sign with what');

ok('a leader gets EVERY persona granted to his organisation, not one of them',
  p.allowedFor(leaderOfDuty, false).sort(), ['Бармен', 'Сидорович']);

ok('and none of another organisation\'s',
  p.allowedFor(leaderOfDuty, false).includes('Лебедєв'), false);

ok('an admin gets all of them',
  p.allowedFor(loner, true).sort(), ['Бармен', 'Лебедєв', 'Сидорович']);

ok('a member who is not the leader gets none',
  p.allowedFor(memberOfDuty, false), []);

ok('someone with no organisation gets none',
  p.allowedFor(loner, false), []);

// Granting is the admin's act, and revoking takes the name back out of the
// leader's hand the moment it happens.
p.revoke('Бармен', 'duty');
ok('a revoked persona leaves the leader\'s list at once',
  p.allowedFor(leaderOfDuty, false), ['Сидорович']);

// A persona nobody granted is nobody's to use, however many exist.
ok('an ungranted persona belongs to no leader',
  p.allowedFor({ Org: 'bandit', Posts: ['leader'] }, false), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
