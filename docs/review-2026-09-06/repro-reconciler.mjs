#!/usr/bin/env node
/**
 * Reproduction: does the Rev 35 reconciler ever fire on the path that starts it?
 *
 * Claim under test (oms.html, Unsynced banner + User Guide):
 *   "Do not repeat the edit and do not reload - OMS keeps checking every few
 *    seconds and will confirm this on its own."
 *
 * Method. Load the real inline script in a vm, exactly as test/smoke.mjs does,
 * but with a DRIVABLE CLOCK instead of `setTimeout: noop` -- the smoke harness
 * stubs setTimeout to a no-op, so no timer-driven code in the artifact has ever
 * been executed by any test.
 *
 * Then stage the real incident from 6 Sept 2026:
 *   1. an edit is made and saved
 *   2. the operation POST succeeds
 *   3. canonical does NOT advance within OMS_WAIT_FOR's 24 s budget
 *      (the consolidator is slow / did not start)
 *   4. OMS_WAIT_FOR throws, OMS_QUEUE_SYNC catches, banner reads Unsynced,
 *      OMS_START_RECONCILE(OMS_REVISION) is called
 *   5. canonical THEN advances -- the save did land
 *   6. drive the clock forward and see whether the reconciler notices
 *
 * Instrument check (rule 3): the run also reports a POSITIVE CONTROL -- the same
 * reconciler, started from a state where _dirty is empty. If the positive
 * control does not adopt, the harness is broken and the negative result means
 * nothing.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FILE = process.argv[2] || String.raw`C:\dev\CAO-OMS\oms.html`;
const html = readFileSync(FILE, 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const main = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');

// ------------------------------------------------------------------ clock
let now = 0;
let seq = 0;
const timers = new Map();
const setTimeoutS = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; };
const clearTimeoutS = (id) => timers.delete(id);
// Run every timer due at or before `now + ms`, in time order, awaiting
// microtasks between each so async callbacks settle.
const flush = async () => { for (let k = 0; k < 50; k++) await Promise.resolve(); };
async function advance(ms) {
  const until = now + ms;
  // Microtasks FIRST. OMS_QUEUE_SYNC chains off a resolved promise, so on the
  // first call the sync has not started yet and no timer exists to find; a
  // scan-first loop returns immediately and the caller then awaits forever.
  await flush();
  for (let guard = 0; guard < 100000; guard++) {
    let next = null;
    for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
    if (!next) break;
    timers.delete(next[0]);
    now = Math.max(now, next[1].at);
    try { await next[1].fn(); } catch (e) { console.log('   (timer threw: ' + e.message + ')'); }
    await flush();
  }
  now = until;
  await flush();
}

// ------------------------------------------------------------------ network
let revision = 75;
const STATE = { schemaVersion: 2, revision, tasks: [{ id: 't1', title: 'Original', _version: 1 }] };
const calls = { state: 0, operation: 0 };
const body = () => JSON.stringify({ state: { ...STATE, revision }, revision, schemaVersion: 2 });
const fetchS = async (url, opts) => {
  if (String(url).endsWith('/api/state')) {
    calls.state++;
    return { ok: true, status: 200, text: async () => body(), headers: { get: () => null } };
  }
  if (String(url).endsWith('/api/operation')) {
    calls.operation++;
    return { ok: true, status: 202, text: async () => JSON.stringify({ accepted: true, operationId: 'x' }) };
  }
  return { ok: false, status: 404, text: async () => '{"error":"nope"}' };
};

// ------------------------------------------------------------------ sandbox
const noop = () => {};
const FIELDS = {};
const ELS = {};
const el = (id) => ({ _id: id, textContent: '', innerHTML: '', className: '', style: {},
  get value() { return FIELDS[id] !== undefined ? FIELDS[id] : ''; }, set value(v) { FIELDS[id] = v; },
  get checked() { return !!FIELDS['@' + id]; }, set checked(v) { FIELDS['@' + id] = !!v; },
  dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  appendChild: noop, setAttribute: noop, getAttribute: () => null, addEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }), focus: noop, click: noop });
const store = () => { const m = new Map(); return {
  getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
  removeItem: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i],
  get length() { return m.size; } }; };

const ALERTS = [];
const sandbox = {
  console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
  Map, Set, Promise, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  setTimeout: setTimeoutS, clearTimeout: clearTimeoutS, setInterval: () => 0, clearInterval: noop,
  requestAnimationFrame: noop, fetch: fetchS,
  alert: m => ALERTS.push(String(m)), confirm: () => true, prompt: () => null,
  localStorage: store(), sessionStorage: store(),
  location: { href: 'https://example.invalid/oms.html', replace: noop, search: '' },
  navigator: { userAgent: 'repro' }, crypto: { subtle: {}, getRandomValues: a => a },
  TextEncoder, TextDecoder, URL, URLSearchParams,
};
sandbox.addEventListener = noop; sandbox.removeEventListener = noop;
sandbox.dispatchEvent = () => true;
sandbox.matchMedia = () => ({ matches: false, addEventListener: noop, addListener: noop });
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
sandbox.document = { getElementById: id => (ELS[id] || (ELS[id] = el(id))),
  querySelector: () => null, querySelectorAll: () => [], createElement: () => el('_tmp'),
  addEventListener: noop, body: el('_body'), documentElement: el('_html'), head: el('_head'),
  title: '', readyState: 'complete', cookie: '' };

const ctx = vm.createContext(sandbox);
const shim = `\n;globalThis.__T={
  fn(n){ try{ return eval(n) }catch(e){ return null } },
  run(src){ return eval(src) }
};`;
new vm.Script(main + shim, { filename: 'oms-inline.js' }).runInContext(ctx, { timeout: 15000 });
const T = ctx.__T;
const run = (src) => T.run(src);

// ------------------------------------------------------------------ wiring
sandbox.sessionStorage.setItem('oms_token', 'fake.jwt.token');
run(`OMS_TOKEN = () => 'fake.jwt.token';`);
run(`renderAll = ()=>{}; renderNotificationBadge = ()=>{}; OMS_LOCAL_SAVE = ()=>{};
     OMS_TOAST = (m)=>{ globalThis.__toasts=(globalThis.__toasts||[]); globalThis.__toasts.push(m) };
     OMS_SET_STATE = (s,c,d)=>{ globalThis.__banner = s; globalThis.__detail = d };`);

const q = (expr) => run(expr);

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
  if (!cond) failures++;
};

// =================================================================== NEGATIVE
console.log('\n=== The real incident: sync fails, reconciler is started ===\n');

// A clean baseline, then one edited task -> exactly one update operation.
run(`ST = {schemaVersion:2, revision:75, tasks:[{id:'t1',title:'Original',_version:1}]};
     OMS_BASE = JSON.parse(JSON.stringify(ST));
     OMS_REVISION = 75;
     _dirty.clear();`);
run(`ST.tasks[0].title='Edited by me'; _dirty.add('tasks');`);

check('one operation is produced by the edit', q(`OMS_DIFF().length`) === 1,
      'ops=' + q(`JSON.stringify(OMS_DIFF().map(o=>o.action))`));
check('_dirty is non-empty before the save', q(`_dirty.size`) > 0, '_dirty.size=' + q(`_dirty.size`));

// Canonical will NOT advance -- this is the slow/stalled consolidator.
const p = run(`OMS_QUEUE_SYNC()`);
await advance(40000);                     // burn the whole 24 s WAIT_FOR budget
try { await p; } catch (_) {}

check('banner reads Unsynced after the failed wait', q(`globalThis.__banner`) === 'Unsynced',
      'banner=' + q(`globalThis.__banner`));
check('the reconciler was started (a timer is pending)', timers.size > 0,
      'pending timers=' + timers.size);
const dirtyAtStart = q(`_dirty.size`);
check('_dirty is STILL non-empty when the reconciler starts', dirtyAtStart > 0,
      '_dirty.size=' + dirtyAtStart);

// Now canonical catches up: the save DID land. This is 6 Sept, 16:09Z.
revision = 76;
STATE.tasks = [{ id: 't1', title: 'Edited by me', _version: 2 }];
const stateCallsBefore = calls.state;

await advance(120000);                    // two full minutes of reconciler ticks

const ticks = Math.floor(120000 / 3000);
console.log(`\n   clock advanced 120 s (${ticks} reconciler ticks were scheduled)`);
console.log(`   /api/state calls made by the reconciler: ${calls.state - stateCallsBefore}`);
console.log(`   banner now: ${q(`globalThis.__banner`)}`);
console.log(`   OMS_REVISION now: ${q(`OMS_REVISION`)}  (canonical is at ${revision})\n`);

check('THE PROMISE: the reconciler polls canonical', calls.state - stateCallsBefore > 0,
      'it made ' + (calls.state - stateCallsBefore) + ' state calls in 2 minutes');
check('THE PROMISE: the banner returns to Connected on its own',
      q(`globalThis.__banner`) === 'Connected', 'banner=' + q(`globalThis.__banner`));
check('THE PROMISE: the client adopts the confirmed revision',
      q(`OMS_REVISION`) === 76, 'OMS_REVISION=' + q(`OMS_REVISION`));

// =================================================================== POSITIVE
console.log('\n=== Positive control: same reconciler, _dirty empty ===\n');
run(`OMS_STOP_RECONCILE();`);
timers.clear();
run(`_dirty.clear(); OMS_REVISION=75; globalThis.__banner='Unsynced';`);
const before2 = calls.state;
run(`OMS_START_RECONCILE(75)`);
await advance(20000);
check('positive control: reconciler polls when _dirty is empty', calls.state - before2 > 0,
      (calls.state - before2) + ' state calls');
check('positive control: reconciler adopts and reports Connected',
      q(`globalThis.__banner`) === 'Connected' && q(`OMS_REVISION`) === 76,
      'banner=' + q(`globalThis.__banner`) + ' revision=' + q(`OMS_REVISION`));

console.log('\n' + '='.repeat(66));
console.log(failures ? `REPRO: ${failures} assertion(s) failed` : 'REPRO: everything passed');
console.log('='.repeat(66));
