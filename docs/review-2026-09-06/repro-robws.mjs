#!/usr/bin/env node
/**
 * Reproduction: "Add Workstream" in the Cadence grid creates a record with no id.
 *
 * CLAUDE.md, "Things that will bite you":
 *   "OMS_MAP drops records with no id. ... `gw` (CAO Visibility) and `rob` (the
 *    Cadence grid) had never synced, in either direction, until they were
 *    migrated on 5 Sept 2026."
 * RECOVERY.md records the same migration as a one-off direct commit.
 *
 * The migration repaired the rows that existed. This checks the code path that
 * makes NEW ones:
 *
 *   oms.html, saveModal, t==='robws':
 *     ST.rob.push({ws:ws,cells:Array(12).fill(''),st:Array(12).fill('')})
 *
 * Control: the same handler in EDIT mode, and a Deadline create (`id:uid()`),
 * which is what a collection that assigns ids looks like.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FILE = String.raw`C:\dev\CAO-OMS\oms.html`;
const html = readFileSync(FILE, 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const main = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');

const noop = () => {};
const FIELDS = {}, ELS = {};
const el = id => ({ _id: id, textContent: '', innerHTML: '', className: '', style: {},
  get value() { return FIELDS[id] ?? ''; }, set value(v) { FIELDS[id] = v; },
  get checked() { return !!FIELDS['@' + id]; }, set checked(v) { FIELDS['@' + id] = !!v; },
  dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  appendChild: noop, setAttribute: noop, getAttribute: () => null, addEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }), focus: noop, click: noop });
const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null),
  setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear(),
  key: i => [...m.keys()][i], get length() { return m.size; } }; };
const ALERTS = [];
const sandbox = { console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
  Map, Set, Promise, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  requestAnimationFrame: noop, fetch: () => Promise.reject(new Error('network off')),
  alert: m => ALERTS.push(String(m)), confirm: () => true, prompt: () => null,
  localStorage: store(), sessionStorage: store(),
  location: { href: 'https://x.invalid/oms.html', replace: noop, search: '' },
  navigator: { userAgent: 'probe' }, crypto: { subtle: {}, getRandomValues: a => a },
  TextEncoder, TextDecoder, URL, URLSearchParams };
sandbox.addEventListener = noop; sandbox.removeEventListener = noop; sandbox.dispatchEvent = () => true;
sandbox.matchMedia = () => ({ matches: false, addEventListener: noop, addListener: noop });
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
sandbox.document = { getElementById: id => (ELS[id] || (ELS[id] = el(id))), querySelector: () => null,
  querySelectorAll: () => [], createElement: () => el('_t'), addEventListener: noop,
  body: el('_b'), documentElement: el('_h'), head: el('_hd'), title: '', readyState: 'complete', cookie: '' };
const ctx = vm.createContext(sandbox);
new vm.Script(main + `\n;globalThis.__T={run(s){return eval(s)}};`, { filename: 'oms-inline.js' })
  .runInContext(ctx, { timeout: 15000 });
const run = s => ctx.__T.run(s);

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
  if (!cond) failures++;
};

// Canonical shape, exactly as state/oms-state.json holds it today.
// Every collection the renderers touch, or rDash() throws on a missing array
// and the control looks like a defect when it is a hole in the seed.
const seed = () => run(`
  ST={}; OMS_COLLECTIONS.forEach(t=>ST[t]=[]);
  ST.rob=[{id:'rob-board-governance-rhythm',ws:'Board Governance Rhythm',cells:Array(12).fill(''),st:Array(12).fill(''),_version:1}];
  ST.briefWeek='2026-09-07';
  OMS_BASE=JSON.parse(JSON.stringify(ST));
  _dirty.clear(); OMS_SYNC_READY=false;
`);

const unsyncable = () => run(
  `JSON.stringify(OMS_COLLECTIONS.filter(t=>Array.isArray(ST[t])&&ST[t].some(x=>x&&x.id==null)))`);

// ------------------------------------------------------- the real user action
console.log('\n=== A user adds a workstream in the Cadence grid ===\n');
seed();
run(`openRobWsModal()`);                        // "Add Workstream" — no index
console.log('   modal context after opening Add Workstream:', run(`JSON.stringify(MC)`));
run(`document.getElementById('f_rob_ws').value='Digital Health Steering'`);
run(`saveModal()`);

const rows = JSON.parse(run(`JSON.stringify(ST.rob)`));
console.log('   ST.rob now holds', rows.length, 'rows');
console.log('   the new row:', JSON.stringify(rows[rows.length - 1]).slice(0, 140));

check('the new workstream is added to ST.rob', rows.length === 2);
check('THE CONTRACT: every record in a synced collection has an id',
      rows.every(r => r.id != null),
      'the new row has id=' + JSON.stringify(rows[rows.length - 1].id));

console.log('\n   OMS_UNSYNCABLE now reports:', unsyncable());
check('the Rev 15 guard notices (this part works)', unsyncable() === '["rob"]', unsyncable());

run(`_dirty.add('rob')`);
const ops = JSON.parse(run(`JSON.stringify(OMS_DIFF())`));
console.log('   operations OMS_DIFF produces for this change:', JSON.stringify(ops));
check('THE CONSEQUENCE: the new workstream produces no create operation',
      ops.some(o => o.action === 'create'),
      ops.length + ' operations — it can never reach canonical');

// -------------------------------------------------------------- controls
console.log('\n=== Control 1: the same handler in EDIT mode ===\n');
seed();
run(`openRobWsModal(0)`);
run(`document.getElementById('f_rob_ws').value='Board Governance Rhythm (renamed)'`);
run(`saveModal()`);
const edited = JSON.parse(run(`JSON.stringify(ST.rob)`));
check('control: editing keeps the existing id', edited[0].id === 'rob-board-governance-rhythm',
      String(edited[0].id));
check('control: the rename applied', edited[0].ws === 'Board Governance Rhythm (renamed)');
run(`_dirty.add('rob')`);
check('control: an edit DOES produce an update operation',
      JSON.parse(run(`JSON.stringify(OMS_DIFF())`)).some(o => o.action === 'update'));

console.log('\n=== Control 2: a collection that assigns ids (Deadlines) ===\n');
seed();
run(`MC={type:'dl',id:null}`);
run(`document.getElementById('f_deadline').value='Board packet to printers'`);
run(`document.getElementById('f_dl_due').value='2026-10-01'`);
run(`saveModal()`);
const dls = JSON.parse(run(`JSON.stringify(ST.deadlines)`));
check('control: a new Deadline gets an id', dls.length === 1 && dls[0].id,
      JSON.stringify(dls[0] && dls[0].id));
run(`_dirty.add('deadlines')`);
check('control: and therefore produces a create operation',
      JSON.parse(run(`JSON.stringify(OMS_DIFF())`)).some(o => o.action === 'create'));

// ---------------------------------------------------- can gw do it too?
console.log('\n=== And CAO Visibility (gw), the other half of the 5 Sept migration ===\n');
const gwPush = /ST\.gw\.push\(([^;]{0,200})/.exec(main);
console.log('   ST.gw.push site:', gwPush ? gwPush[1].slice(0, 160) : '(no ST.gw.push in the artifact)');

console.log('\n' + '='.repeat(66));
console.log(failures ? `REPRO: ${failures} assertion(s) failed` : 'REPRO: everything passed');
console.log('='.repeat(66));
if (ALERTS.length) console.log('alerts raised:', JSON.stringify(ALERTS));
