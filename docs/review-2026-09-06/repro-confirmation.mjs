#!/usr/bin/env node
/**
 * Reproduction: what does the client treat as proof that a save landed?
 *
 * OMS_WAIT_FOR(ops,startRevision) returns as soon as
 *     Number(x.revision) > Number(startRevision)
 * and OMS_SYNC_ONCE then adopts that state, clears _dirty, and reports
 * "Save successful" / Connected.
 *
 * But scripts/consolidate.py increments state.revision ONCE PER BATCH,
 * "including conflicts/invalid operations" (its own comment; verified by
 * probe_consolidator.py C6a/C6b). So a revision increase proves that a
 * consolidation ran -- not that THIS operation was applied.
 *
 * Two scenarios, neither of which the client distinguishes from success:
 *
 *   S1  the operation was rejected (written to conflicts/unresolved) and
 *       canonical advanced anyway
 *   S2  somebody ELSE's unrelated save was consolidated first, advancing the
 *       revision while this operation is still sitting in the inbox
 *
 * Control: the honest case -- the operation really was applied.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FILE = String.raw`C:\dev\CAO-OMS\oms.html`;
const html = readFileSync(FILE, 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const main = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
  if (!cond) failures++;
};

function makeCtx(canonical) {
  let now = 0, seq = 0;
  const timers = new Map();
  const calls = { state: 0, operation: 0, posted: [] };
  const setTimeoutS = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; };
  const flush = async () => { for (let k = 0; k < 50; k++) await Promise.resolve(); };
  async function advance(ms) {
    const until = now + ms;
    await flush();
    for (let g = 0; g < 100000; g++) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      timers.delete(next[0]); now = Math.max(now, next[1].at);
      try { await next[1].fn(); } catch (_) {}
      await flush();
    }
    now = until; await flush();
  }
  const fetchS = async (url, opts) => {
    if (String(url).endsWith('/api/state')) {
      calls.state++;
      const c = canonical();
      return { ok: true, status: 200, headers: { get: () => null },
               text: async () => JSON.stringify({ state: c, revision: c.revision, schemaVersion: 2 }) };
    }
    calls.operation++;
    calls.posted.push(JSON.parse(opts.body));
    return { ok: true, status: 202, text: async () => JSON.stringify({ accepted: true, operationId: 'x' }) };
  };

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

  const sandbox = { console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
    Map, Set, Promise, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout: setTimeoutS, clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: noop, fetch: fetchS, alert: noop, confirm: () => true, prompt: () => null,
    localStorage: store(), sessionStorage: store(),
    location: { href: 'https://x.invalid/oms.html', replace: noop, search: '' },
    navigator: { userAgent: 'repro' }, crypto: { subtle: {}, getRandomValues: a => a },
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
  run(`OMS_TOKEN=()=>'t'; renderAll=()=>{}; renderNotificationBadge=()=>{}; OMS_LOCAL_SAVE=()=>{};
       OMS_TOAST=(m)=>{globalThis.__toasts=(globalThis.__toasts||[]);globalThis.__toasts.push(m)};
       OMS_SET_STATE=(s,c,d)=>{globalThis.__banner=s};`);
  return { run, advance, calls };
}

// ------------------------------------------------------------- S1: rejected
console.log('\n=== S1: the operation is REJECTED, canonical advances anyway ===\n');
{
  // canonical keeps the OLD title but bumps the revision, exactly as
  // consolidate.py does when it files the operation under conflicts/unresolved.
  let rev = 75;
  const canonical = () => ({ schemaVersion: 2, revision: rev,
    tasks: [{ id: 't1', title: 'Original', _version: 1 }] });
  const { run, advance, calls } = makeCtx(canonical);
  run(`ST={schemaVersion:2,revision:75,tasks:[{id:'t1',title:'Original',_version:1}]};
       OMS_BASE=JSON.parse(JSON.stringify(ST));OMS_REVISION=75;_dirty.clear();`);
  run(`ST.tasks[0].title='My important edit';_dirty.add('tasks');`);
  const p = run(`OMS_QUEUE_SYNC()`);
  await advance(500);
  rev = 76;                      // consolidation ran; this op went to conflicts
  await advance(5000);
  try { await p; } catch (_) {}

  console.log('   operations POSTed:', calls.operation);
  console.log('   banner:', run(`globalThis.__banner`));
  console.log('   toasts:', JSON.stringify(run(`globalThis.__toasts`)));
  console.log('   task title the user now sees:', run(`ST.tasks[0].title`));
  check('S1: the client does NOT report a rejected save as successful',
        run(`globalThis.__banner`) !== 'Connected',
        'banner=' + run(`globalThis.__banner`));
  check('S1: the user is told their edit did not land',
        !(run(`globalThis.__toasts`) || []).includes('Save successful'),
        'toasts=' + JSON.stringify(run(`globalThis.__toasts`)));
  check('S1: the edit is not silently replaced by the old value',
        run(`ST.tasks[0].title`) === 'My important edit',
        'ST now shows ' + JSON.stringify(run(`ST.tasks[0].title`)));
}

// ------------------------------------------- S2: somebody else's save confirms mine
console.log("\n=== S2: another user's unrelated save advances the revision first ===\n");
{
  let rev = 75;
  let tasks = [{ id: 't1', title: 'Original', _version: 1 }];
  const canonical = () => ({ schemaVersion: 2, revision: rev, tasks: JSON.parse(JSON.stringify(tasks)) });
  const { run, advance, calls } = makeCtx(canonical);
  run(`ST={schemaVersion:2,revision:75,tasks:[{id:'t1',title:'Original',_version:1}]};
       OMS_BASE=JSON.parse(JSON.stringify(ST));OMS_REVISION=75;_dirty.clear();`);
  run(`ST.tasks[0].title='My important edit';_dirty.add('tasks');`);
  const p = run(`OMS_QUEUE_SYNC()`);
  await advance(500);
  // A DIFFERENT user's save is consolidated. Our operation is still queued.
  rev = 76;
  tasks = [{ id: 't1', title: 'Original', _version: 1 }, { id: 't2', title: 'Someone else', _version: 1 }];
  await advance(5000);
  try { await p; } catch (_) {}

  console.log('   banner:', run(`globalThis.__banner`));
  console.log('   toasts:', JSON.stringify(run(`globalThis.__toasts`)));
  console.log('   task title the user now sees:', run(`ST.tasks[0].title`));
  console.log('   _dirty after "confirmation":', run(`_dirty.size`));
  check("S2: another user's save is not mistaken for confirmation of mine",
        run(`globalThis.__banner`) !== 'Connected', 'banner=' + run(`globalThis.__banner`));
  check('S2: my edit survives', run(`ST.tasks[0].title`) === 'My important edit',
        'ST now shows ' + JSON.stringify(run(`ST.tasks[0].title`)));
}

// ------------------------------------------------------------- control
console.log('\n=== Control: the operation really was applied ===\n');
{
  let rev = 75;
  let tasks = [{ id: 't1', title: 'Original', _version: 1 }];
  const canonical = () => ({ schemaVersion: 2, revision: rev, tasks: JSON.parse(JSON.stringify(tasks)) });
  const { run, advance } = makeCtx(canonical);
  run(`ST={schemaVersion:2,revision:75,tasks:[{id:'t1',title:'Original',_version:1}]};
       OMS_BASE=JSON.parse(JSON.stringify(ST));OMS_REVISION=75;_dirty.clear();`);
  run(`ST.tasks[0].title='My important edit';_dirty.add('tasks');`);
  const p = run(`OMS_QUEUE_SYNC()`);
  await advance(500);
  rev = 76; tasks = [{ id: 't1', title: 'My important edit', _version: 2 }];
  await advance(5000);
  try { await p; } catch (_) {}
  check('control: a genuinely applied save reports Connected',
        run(`globalThis.__banner`) === 'Connected', 'banner=' + run(`globalThis.__banner`));
  check('control: and the edit is in the adopted state',
        run(`ST.tasks[0].title`) === 'My important edit');
}

console.log('\n' + '='.repeat(66));
console.log(failures ? `REPRO: ${failures} assertion(s) failed` : 'REPRO: everything passed');
console.log('='.repeat(66));
