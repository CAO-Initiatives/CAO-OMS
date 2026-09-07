#!/usr/bin/env node
/**
 * Fable 5.1 QA / architecture / security pass, 6-7 Sept 2026.
 * Reproductions against the sync path of oms.html, run in a Node vm with the
 * same stubs the smoke suite uses. Each case states what the artifact CLAIMS
 * (User Guide / OMS_REV_LOG) and what the code DOES.
 *
 *   node docs/review-2026-09-06-qa-security/repro-sync-path.mjs [path/to/oms.html]
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FILE = process.argv[2] || String.raw`C:\dev\CAO-OMS\oms.html`;
const html = readFileSync(FILE, 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const main = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');
const noop = () => {};
const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), key: i => [...m.keys()][i], get length() { return m.size; } }; };
let failures = 0;
const ok = (name, cond, detail = '') => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : '')); if (!cond) failures++; };

function build(opts = {}) {
  let now = 0, seq = 0;
  const timers = new Map();
  const calls = { state: 0, operation: 0, posted: [] };
  const flush = async () => { for (let k = 0; k < 50; k++) await Promise.resolve(); };
  const advance = async (ms) => {
    const until = now + ms; await flush();
    for (let g = 0; g < 100000; g++) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      timers.delete(next[0]); now = Math.max(now, next[1].at);
      try { const r = next[1].fn(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (_) {} // never await: a debounce callback returns the whole sync chain
      await flush();
    }
    now = until; await flush();
  };
  let canonical = { schemaVersion: 2, revision: 75, tasks: [{ id: 't1', title: 'Original', notes: '', _version: 1 }, { id: 't2', title: 'Second', notes: '', _version: 1 }], people: [], notifications: [], assignmentHistory: [] };
  const sb = {
    console: { log: noop, error: noop, warn: noop }, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Promise, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, TextEncoder, TextDecoder, URL, URLSearchParams,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: noop, alert: m => { sb.__alerts.push(m); }, confirm: () => true, prompt: () => null,
    localStorage: store(), sessionStorage: store(),
    location: { href: 'https://x.invalid/oms.html', replace: noop, search: '' },
    navigator: { userAgent: 'repro' }, crypto: { subtle: {}, getRandomValues: a => a }, performance: { now: () => now },
    fetch: async (url, o) => {
      if (String(url).endsWith('/api/state')) { calls.state++; return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ state: canonical, revision: canonical.revision, schemaVersion: 2 }) }; }
      calls.operation++; calls.posted.push(JSON.parse(o.body));
      return { ok: true, status: 202, text: async () => '{"accepted":true,"operationId":"x"}' };
    },
    __alerts: [],
  };
  const F = {}, EL = {};
  const mk = id => ({ _id: id, textContent: '', innerHTML: '', className: '', style: {}, get value() { return F[id] !== undefined ? F[id] : ''; }, set value(v) { F[id] = v; }, get checked() { return !!F['@' + id]; }, set checked(v) { F['@' + id] = !!v; }, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, appendChild: noop, setAttribute: noop, getAttribute: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }), focus: noop, click: noop });
  sb.addEventListener = noop; sb.removeEventListener = noop; sb.dispatchEvent = () => true;
  sb.matchMedia = () => ({ matches: false, addEventListener: noop, addListener: noop });
  sb.window = sb; sb.globalThis = sb; sb.self = sb;
  sb.document = { getElementById: id => (EL[id] || (EL[id] = mk(id))), querySelector: () => null, querySelectorAll: () => [], createElement: () => mk('_t'), addEventListener: noop, body: mk('_b'), documentElement: mk('_h'), head: mk('_hd'), title: '', readyState: 'complete', cookie: '', hidden: false };
  const c = vm.createContext(sb);
  new vm.Script(main + `\n;globalThis.__R={run(s){return eval(s)}};`, { filename: 'oms-repro.js' }).runInContext(c, { timeout: 15000 });
  const run = s => c.__R.run(s);
  run(`OMS_TOKEN=()=>'t';renderAll=()=>{};renderNotificationBadge=()=>{};OMS_LOCAL_SAVE=()=>{};
       OMS_TOAST=m=>{globalThis.__t=(globalThis.__t||[]);globalThis.__t.push(m)};
       OMS_SET_STATE=(s,c,d)=>{globalThis.__b=s;globalThis.__d=d||''};`);
  if (!opts.noSeed) run(`ST=${JSON.stringify(canonical)};OMS_BASE=JSON.parse(JSON.stringify(ST));OMS_REVISION=75;_dirty.clear();OMS_SYNC_READY=true;`);
  return { run, advance, calls, setCanonical: v => { canonical = v; }, get canonical() { return canonical; }, timers, alerts: sb.__alerts };
}

// ------------------------------------------------------------------ CASE 1
console.log('\n# Case 1. CLAIM (Rev 44 log, guide): a visible tab looks about once a minute and adopts anything newer.');
console.log('#         CODE: OMS_BOOT -> migrateNotificationsState() -> save() marks every collection dirty with');
console.log('#         OMS_SYNC_READY false, nothing ever clears it, and OMS_WATCH_SAFE() refuses while _dirty.size.');
{
  const h = build({ noSeed: true });
  h.run(`sessionStorage.setItem('cao_oms_session','t');sessionStorage.setItem('cao_oms_user','{}');`);
  const p = h.run(`OMS_BOOT()`);
  await h.advance(100); try { await p; } catch (e) { console.log('boot threw', e.message); }
  ok('boot reached Connected', h.run(`globalThis.__b`) === 'Connected', h.run(`globalThis.__b`));
  const dirty = h.run(`_dirty.size`);
  ok('nothing is actually different from canonical after boot', h.run(`OMS_DIFF().length`) === 0);
  ok('...yet the dirty set is empty after boot', dirty === 0, dirty + ' collections marked dirty by the boot migration');
  ok('...and the idle watch is allowed to run', h.run(`OMS_WATCH_SAFE()`) === true, 'OMS_WATCH_SAFE()=' + h.run(`OMS_WATCH_SAFE()`));
  h.setCanonical({ ...h.canonical, revision: 80, tasks: [...h.canonical.tasks, { id: 't9', title: 'From a colleague', _version: 1 }] });
  const before = h.calls.state;
  await h.advance(10 * 60 * 1000);
  ok('ten idle minutes after sign-in, the colleague\'s task has arrived', h.run(`ST.tasks.length`) === 3, h.run(`ST.tasks.length`) + ' tasks, ' + (h.calls.state - before) + ' state reads in 10 min');
}

// ------------------------------------------------------------------ CASE 2
console.log('\n# Case 2. CLAIM (guide): "Two people can edit the same record at once, as long as they touch different fields."');
console.log('#         CODE: OMS_ASSERT_CURRENT throws a conflict whenever _version moved at all, before any operation is');
console.log('#         posted, so the consolidator\'s field-level merge is never reached in the ordinary case.');
{
  const h = build();
  // A colleague changed the title; canonical moved to v2. This user has not adopted it (modal open / mid-edit).
  h.setCanonical({ ...h.canonical, revision: 76, tasks: [{ id: 't1', title: 'Colleague title', notes: '', _version: 2 }, h.canonical.tasks[1]] });
  h.run(`ST.tasks[0].notes='My note on a different field';save();`);
  await h.advance(60000);
  ok('the note was posted to the gateway', h.calls.operation === 1, h.calls.operation + ' operations posted');
  ok('no conflict alert was shown', h.alerts.length === 0, h.alerts.length + ' alert(s): ' + (h.alerts[0] || ''));
  ok('the note survives on screen', h.run(`ST.tasks[0].notes`) === 'My note on a different field', JSON.stringify(h.run(`ST.tasks[0].notes`)));
}

// ------------------------------------------------------------------ CASE 3
console.log('\n# Case 3. CLAIM (Rev 36/37, toast "Save successful"): a confirmation means the change is actually there.');
console.log('#         CODE: OMS_SYNC_ONCE adopts canonical wholesale (ST = x.state) after OMS_WAIT_FOR; an edit made');
console.log('#         while the first save was still awaiting confirmation is overwritten and its dirty flag cleared.');
{
  const h = build();
  h.run(`ST.tasks[0].title='Edit A';save();`);
  await h.advance(2000);                     // A is posted, WAIT_FOR is polling
  h.run(`ST.tasks[1].title='Edit B';save();`);   // second edit while A is in flight
  await h.advance(1000);
  // consolidator folds A only (B has not been posted yet)
  h.setCanonical({ ...h.canonical, revision: 76, tasks: [{ id: 't1', title: 'Edit A', notes: '', _version: 2 }, { id: 't2', title: 'Second', notes: '', _version: 1 }] });
  await h.advance(60000);
  ok('both edits were posted', h.calls.operation === 2, h.calls.operation + ' operation(s) posted: ' + h.calls.posted.map(o => o.entityId + ':' + JSON.stringify(o.changes)).join(' | '));
  ok('Edit B is still on screen', h.run(`ST.tasks[1].title`) === 'Edit B', JSON.stringify(h.run(`ST.tasks[1].title`)));
  ok('or at least the screen does not say Connected while B is lost', !(h.run(`globalThis.__b`) === 'Connected' && h.run(`ST.tasks[1].title`) !== 'Edit B'), 'state=' + h.run(`globalThis.__b`) + ' toasts=' + JSON.stringify(h.run(`globalThis.__t`)));
}

// ------------------------------------------------------------------ CASE 4
console.log('\n# Case 4. CLAIM (conflict banner): "Your stale change was not applied" - singular.');
console.log('#         CODE: one stale update makes OMS_ASSERT_CURRENT throw before ANY operation is posted, and');
console.log('#         OMS_HANDLE_CONFLICT adopts canonical wholesale, discarding every other edit in the batch.');
{
  const h = build();
  h.setCanonical({ ...h.canonical, revision: 76, tasks: [{ id: 't1', title: 'Colleague title', notes: '', _version: 2 }, h.canonical.tasks[1]] });
  h.run(`ST.tasks[0].title='My stale title';ST.tasks.push({id:'n1',title:'Brand new task 1'});ST.tasks.push({id:'n2',title:'Brand new task 2'});save();`);
  await h.advance(60000);
  ok('the two new tasks were posted even though one update was stale', h.calls.posted.filter(o => o.action === 'create').length === 2, h.calls.posted.length + ' operation(s) posted');
  ok('the two new tasks are still on screen', h.run(`ST.tasks.filter(t=>/^n/.test(t.id)).length`) === 2, h.run(`ST.tasks.map(t=>t.id).join(',')`));
}

// ------------------------------------------------------------------ CASE 5
console.log('\n# Case 5 (found live, 6 Sept 2026). A save made while an earlier CREATE is still confirming.');
console.log('#         CODE (Rev 50-53): OMS_DIFF regenerates the create with baseVersion 0; canonical now holds the record');
console.log('#         at version 1; OMS_ASSERT_CURRENT treats a create as a plain mismatch and raises the conflict alert.');
{
  const h = build();
  h.run(`ST.tasks.push({id:'n1',title:'New one'});save();`);
  await h.advance(2000);                                   // create posted, WAIT_FOR polling, not yet folded
  h.setCanonical({ ...h.canonical, revision: 76, tasks: [...h.canonical.tasks, { id: 'n1', title: 'New one', _version: 1 }] });
  await h.advance(3000);                                   // the create lands; confirmation adopts
  h.run(`ST.tasks[0].notes='A later note';save();`);      // second save
  await h.advance(5000);
  ok('no conflict alert was raised for the user\'s own create', h.alerts.length === 0, h.alerts.length + ' alert(s): ' + (h.alerts[0] || ''));
  ok('the later note was posted', h.calls.posted.some(o => o.entityId === 't1' && o.changes && o.changes.notes === 'A later note'), h.calls.posted.map(o => o.entityId + ':' + o.action).join(','));
  ok('the create was not sent twice', h.calls.posted.filter(o => o.action === 'create').length === 1, h.calls.posted.filter(o => o.action === 'create').length + ' create(s)');
}

console.log('\n' + (failures ? failures + ' FAIL' : 'all pass'));
process.exit(failures ? 1 : 0);
