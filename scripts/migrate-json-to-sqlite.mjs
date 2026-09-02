#!/usr/bin/env node
// One-off, by hand, with a report: state/bridge.json -> the SQLite store.
//
// TZ-2 R6.2 forbids a silent migration at start, and for a reason: the
// document is the only copy of every link and every conversation key, and
// the moment of copying it is the moment an operator wants to be looking.
//
//   node scripts/migrate-json-to-sqlite.mjs [state/bridge.json] [state/bridge.sqlite]
//
// Idempotent: rows already in the database are left alone and counted as
// skipped, so a second run reports zeros. The JSON document is NOT deleted
// or renamed -- that is the operator's decision after reading the report.
// Nothing here prints a secret; the store holds none.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';

const from = resolve(process.argv[2] || process.env.BRIDGE_STATE || './state/bridge.json');
const to = resolve(process.argv[3] || process.env.BRIDGE_DB || './state/bridge.sqlite');

if (!existsSync(from)) {
  console.error(`nothing to migrate: ${from} does not exist`);
  process.exit(2);
}

let data;
try {
  data = JSON.parse(readFileSync(from, 'utf8'));
} catch (err) {
  console.error(`${from} is not readable JSON: ${err.message}`);
  process.exit(2);
}

const sizes = {
  links: Object.keys(data.links || {}).length,
  names: Object.keys(data.names || {}).length,
  convos: Object.keys(data.convos || {}).length,
  invites: Object.values(data.invites || {}).reduce((n, m) => n + Object.keys(m || {}).length, 0),
  news: Object.keys(data.news || {}).length,
  messages: Object.values(data.messages || {}).reduce((n, l) => n + (l || []).length, 0),
  guild: Object.keys(data.guild || {}).length,
  cursor: Number(data.cursor) || 0,
};

console.log(`from ${from}`);
console.log(`to   ${to}`);
console.log('document holds:', JSON.stringify(sizes));

const store = new Store(to);
const rep = store.importJson(data);
store.close();

console.log('imported:      ', JSON.stringify(rep));

const short = ['links', 'names', 'convos', 'invites', 'news', 'messages', 'guild']
  .filter((k) => rep[k] + 0 < sizes[k] && rep.skipped === 0);
if (short.length) {
  console.error(`fewer rows imported than the document holds for: ${short.join(', ')} - read the report before trusting the database`);
  process.exit(1);
}

console.log('done. The JSON document was left in place; move it aside once the bridge has run on the database.');
