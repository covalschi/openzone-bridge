// TZ-2 R1.1: news live in the bot's store, Discord is a surface.
//
// Owner's decision 2026-09-01: "пусть бот держит и новости у себя в базе, а
// дискорд -- только миррор". Before that the index lived in memory only and
// was rebuilt from Discord on every start, which meant a bot that could not
// reach the guild had no news at all -- the feed was exactly as optional as
// Discord was, which is the thing TZ-2 exists to stop being true.
//
// The property under test is therefore precise: news must exist BEFORE
// Discord is asked anything. So this never constructs a client and never
// calls start(); it builds News over a store and reads it.
//
// Runs against a throwaway state file. Touches neither Discord nor the stand.

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { News } from '../src/news.js';

const path = join(tmpdir(), `oz-news-home-${process.pid}.json`);
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

function post(id, title, ts) {
  return { Id: id, Title: title, Who: 'admin', At: '2026-09-01 12:00:00', ts, Body: `body of ${title}`, Replies: 0 };
}

console.log('news live in the store');

const store = new Store(path, 100);
store.newsPut(post('1', 'older', 1000));
store.newsPut(post('2', 'newer', 2000));

// No client, no start(): Discord is never contacted.
const news = new News(store);

ok('a fresh News over a store already has the posts',
  news.list().Items.map((p) => p.Title), ['newer', 'older']);

ok('newest first, by timestamp',
  news.list().Items[0].Title, 'newer');

ok('open() returns the body without Discord',
  news.open('1').Body, 'body of older');

ok('an unknown id still refuses',
  news.open('nope'), { Error: 'no_post' });

// A second process over the same file sees the same feed -- that is what
// "home" means, as opposed to a cache that dies with the process.
//
// save() explicitly: writes go through saveSoon(), which debounces for one
// second. The debounce is the store's, not this feature's -- chat has always
// been written the same way -- but it is worth stating that a crash inside
// that window loses the newest records, which is one of the three things
// TZ-2 R6.1 wants a real database for.
store.save();
const again = new News(new Store(path, 100));
ok('the feed survives a restart with Discord unreachable',
  again.list().Items.map((p) => p.Title), ['newer', 'older']);

// Eviction is allowed here in a way it is not for chat: news are authored in
// Discord and stay there, so an evicted post is still where it was written.
store.newsPut(post('3', 'third', 3000));
store.newsTrim(2);
store.save();
ok('trimming drops the oldest and keeps the cap',
  new News(new Store(path, 100)).list().Items.map((p) => p.Title), ['third', 'newer']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
