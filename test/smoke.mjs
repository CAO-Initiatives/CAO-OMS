#!/usr/bin/env node
/**
 * OMS behavioural smoke test.
 *
 *   node test/smoke.mjs [path/to/oms.html]
 *
 * The release gate checks that an artifact is well FORMED. This checks that it
 * BEHAVES. The gw/rob defect — two collections that had never synced in either
 * direction — passed every gate check ever written, because nothing exercised
 * the logic. These assertions exist so that class of bug fails loudly.
 *
 * No browser, no jsdom, no credentials. The main inline script is evaluated in
 * a Node vm with minimal stubs and OMS_BOOT is never called, so nothing touches
 * the network or canonical data.
 *
 * Exit 0 = all pass. Exit 1 = a real failure. Exit 2 = harness problem.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const FILE = process.argv[2] || 'oms.html';
let pass = 0, fail = 0, todo = 0;
let ctxAmb = null;

const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
};
// Documents a known-broken behaviour. Prints, never fails the run, and flips to
// a hard assertion the day the fix ships.
const todoCheck = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('PASS  ' + name + ' (previously known-broken — promote this to ok())'); }
  else { todo++; console.log('TODO  ' + name + (detail ? ' — ' + detail : '')); }
};

// ---------------------------------------------------------------- load
const html = readFileSync(FILE, 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!blocks.length) { console.error('HARNESS: no inline script found in ' + FILE); process.exit(2); }
const main = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');

const noop = () => {};
const store = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i],
           get length() { return m.size; } };
};
const el = () => ({ textContent: '', innerHTML: '', className: '', style: {}, value: '',
                    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
                    appendChild: noop, setAttribute: noop, getAttribute: () => null,
                    addEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
                    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }), focus: noop, click: noop });

const sandbox = {
  console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
  Map, Set, Promise, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  requestAnimationFrame: noop, fetch: () => Promise.reject(new Error('smoke: network disabled')),
  alert: noop, confirm: () => true, prompt: () => null,
  localStorage: store(), sessionStorage: store(),
  location: { href: 'https://example.invalid/oms.html', replace: noop, search: '' },
  navigator: { userAgent: 'smoke' }, crypto: { subtle: {}, getRandomValues: a => a },
  TextEncoder, TextDecoder, URL, URLSearchParams,
};
sandbox.addEventListener = noop;
sandbox.removeEventListener = noop;
sandbox.dispatchEvent = () => true;
sandbox.matchMedia = () => ({ matches: false, addEventListener: noop, addListener: noop });
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.document = {
  getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
  createElement: () => el(), addEventListener: noop, body: el(), documentElement: el(),
  head: el(), title: '', readyState: 'complete', cookie: '',
};

const ctx = vm.createContext(sandbox);
try {
  // Boot listeners are registered but never fired; nothing self-executes here.
  // Appended IN THE SAME SCRIPT SCOPE: const/let bindings (OMS_COLLECTIONS, ST)
  // never become context properties, so reach them from inside instead.
  const shim = `\n;globalThis.__T={
    get collections(){return typeof OMS_COLLECTIONS!=='undefined'?OMS_COLLECTIONS:null},
    get st(){return typeof ST!=='undefined'?ST:null},
    setST(v){ if(typeof ST!=='undefined'){ ST=v; return true } return false },
    fn(n){ try{ return eval(n) }catch(e){ return null } }
  };`;
  new vm.Script(main + shim, { filename: 'oms-inline.js' }).runInContext(ctx, { timeout: 15000 });
} catch (e) {
  console.error('HARNESS: inline script threw on evaluation: ' + e.message);
  process.exit(2);
}

const T = ctx.__T || {};
const G = name => (typeof ctx[name] !== 'undefined' ? ctx[name] : (T.fn ? T.fn(name) : undefined));
console.log('\n--- loaded ' + FILE + ' (' + html.length + ' chars, main block ' + main.length + ') ---\n');

// ---------------------------------------------------------------- 1. root cause
console.log('# OMS_MAP and the id contract');
const OMS_MAP = G('OMS_MAP');
ok('OMS_MAP is defined', typeof OMS_MAP === 'function');
if (typeof OMS_MAP === 'function') {
  ok('OMS_MAP keys records that have an id', OMS_MAP([{ id: 'a' }, { id: 'b' }]).size === 2);
  ok('OMS_MAP DROPS records with no id (the gw/rob root cause)',
     OMS_MAP([{ date: '2026-01-01' }, { id: 'a' }]).size === 1,
     'if this ever changes, the guard below is no longer needed');
}

// ---------------------------------------------------------------- 2. the guard
console.log('\n# Silent-save guard (Rev 15)');
const syncSrc = typeof G('OMS_SYNC_ONCE') === 'function' ? G('OMS_SYNC_ONCE').toString() : '';
ok('OMS_SYNC_ONCE exists', syncSrc.length > 0);
ok('sync path checks for id-less records before reporting success',
   /id\s*==\s*null/.test(syncSrc) && /Unsynced/.test(syncSrc),
   'a save producing no operations must not report Connected');
ok('the guard names the offending collections to the user',
   /join\(/.test(syncSrc) && /NOT saved/i.test(syncSrc));
ok('the guard is non-blocking for healthy collections',
   /OMS_SET_STATE\('Saving'/.test(syncSrc),
   'other collections must still sync');

const COLLECTIONS = T.collections || G('OMS_COLLECTIONS') || [];
ok('OMS_COLLECTIONS includes gw and rob', COLLECTIONS.includes('gw') && COLLECTIONS.includes('rob'));

// functional: the guard predicate must flag a collection holding an id-less record
const detects = (state) => COLLECTIONS.filter(t => Array.isArray(state[t]) && state[t].some(x => x && x.id == null));
ok('guard predicate flags an id-less record', detects({ gw: [{ date: 'x' }], rob: [] }).join() === 'gw');
ok('guard predicate stays silent when every record has an id', detects({ gw: [{ id: 'gw-1' }], rob: [{ id: 'rob-1' }] }).length === 0);

// ---------------------------------------------------------------- 3. block-save ordering
console.log('\n# Owner-email block (OMS-005, Rev 15)');
const iConfirm = main.indexOf("if(o.owner&&!o.ownerEmail){if(!confirm(");
const iPush = main.indexOf('ST.tasks.push(o)');
ok('the owner-email check is a confirm, not a post-hoc alert', iConfirm > -1);
ok('the check runs BEFORE the task is written',
   iConfirm > -1 && iPush > -1 && iConfirm < iPush,
   'cancelling must return before any mutation');
ok('the old warn-after-save text is gone', !/Task saved, but NO notification/.test(main));

// ---------------------------------------------------------------- 4. owner resolution
console.log('\n# Owner resolution (Rev 16 target)');
const findPerson = G('findPerson');
ok('findPerson is defined', typeof findPerson === 'function');
if (typeof findPerson === 'function') {
  // Live directory shape as at 5 Sept 2026. Display names and email names diverge
  // systematically at Advocate: Maggie/Margaret, Ari/Ariana.
  T.setST({ people: [
    { id: 'maggie-scirica', name: 'Maggie Scirica', email: 'Margaret.Scirica@Advocatehealth.org', active: true },
    { id: 'ari-ball', name: 'Ari Ball', email: 'Ariana.Ball@advocatehealth.org', active: true },
    { id: 'hossam-elsaie', name: 'Hossam Elsaie', email: 'hossam.elsaie@advocatehealth.org', active: true },
  ] });
  const r = q => { const p = findPerson(q); return p ? p.name : null; };
  ok('exact full name resolves', r('Ari Ball') === 'Ari Ball');
  ok('exact email resolves', r('Ariana.Ball@advocatehealth.org') === 'Ari Ball');
  ok('unique first name resolves ("Ari" -> Ari Ball)', r('Ari') === 'Ari Ball');
  ok('display first name resolves ("Maggie" -> Maggie Scirica)', r('Maggie') === 'Maggie Scirica');
  ok('EMAIL first name resolves ("Margaret" -> Maggie Scirica)', r('Margaret') === 'Maggie Scirica',
     'display names and email names diverge at Advocate; both must resolve');
  ok('surname resolves ("Scirica" -> Maggie Scirica)', r('Scirica') === 'Maggie Scirica');
  ok('a 1-2 char fragment does NOT prefix-match', r('A') === null, 'too loose a prefix would bind the wrong person');
  const amb = G('ownerAmbiguity');
  ok('ownerAmbiguity is defined', typeof amb === 'function');
  if (typeof amb === 'function') {
    ctxAmb = amb('Hossam/Maggie');
    ok('ownerAmbiguity returns null for an unmatched string', amb('Nobody At All') === null);
  }
  ok('an ambiguous two-person string does not silently resolve', r('Hossam/Maggie') === null,
     'it should raise a validation error; it must never pick one');
  ok('unknown name returns null, does not throw', r('Nobody At All') === null);
}

const upsertSrc = typeof G('upsertPerson') === 'function' ? G('upsertPerson').toString() : '';
ok('upsertPerson requires an email', /Email is required/.test(upsertSrc));
ok('upsertPerson guards against id collisions',
   /while\s*\(/.test(upsertSrc) && /some\(/.test(upsertSrc),
   'must append a suffix when a slug is taken');

// ---------------------------------------------------------------- 4b. new-person form (Rev 16)
console.log('\n# Inline new-person form (Rev 16)');
ok('the two chained prompts are gone', !/prompt\('New assignee name/.test(main));
ok('inline form fields exist', /f_np_first/.test(html) && /f_np_last/.test(html) && /f_np_email/.test(html));
ok('the form is inline, not a second modal',
   /id="f_newperson"/.test(html) && !/openModal\([^)]*newperson/i.test(main),
   'one overlay: a second modal would destroy the task being edited');
ok('all three fields are required before save', /first name, last name and email are all required/i.test(main));
ok('an existing email offers the existing person', /already on file for/i.test(main));
ok('ambiguity blocks the save', /matches more than one person/i.test(main));

// ================================================================ REV 17
// Written BEFORE the implementation, per REV17.md, as todoCheck, then promoted
// to hard ok() once each passed. Items 6 and 7 are visual and the brief skips
// them — except the multi-day DATE MATH, which is logic, not CSS.

// ---------------------------------------------------------------- 6. ownerId backfill (item 1)
console.log('\n# ownerId backfill (Rev 17, item 1)');
const backfill = G('backfillTaskOwnerIds');
ok('backfillTaskOwnerIds is defined', typeof backfill === 'function');
if (typeof backfill === 'function') {
  T.setST({
    people: [
      { id: 'maggie-scirica', name: 'Maggie Scirica', email: 'Margaret.Scirica@Advocatehealth.org', active: true },
      { id: 'ari-ball', name: 'Ari Ball', email: 'Ariana.Ball@advocatehealth.org', active: true },
    ],
    tasks: [
      { id: 't1', owner: 'Ari', ownerEmail: 'Ariana.Ball@advocatehealth.org' }, // email set, id missing
      { id: 't2', owner: 'Maggie' },                                            // both missing
      { id: 't3', owner: 'Hossam/Maggie' },                                     // ambiguous
      { id: 't4', owner: 'Ari', ownerId: 'pinned', ownerEmail: 'x@y.z' },       // already resolved
      { id: 't5' },                                                             // no owner at all
    ],
  });
  const changed = backfill();
  const byId = id => (T.st.tasks || []).find(t => t.id === id) || {};
  ok('backfills ownerId even when ownerEmail is ALREADY present',
     byId('t1').ownerId === 'ari-ball',
     'exactly the case the Rev 16 migration skipped, because it gated on !ownerEmail');
  ok('backfills ownerId and ownerEmail together when both are missing',
     byId('t2').ownerId === 'maggie-scirica' && /Margaret/i.test(byId('t2').ownerEmail || ''));
  ok('leaves an ambiguous owner string alone', byId('t3').ownerId == null,
     'findPerson binds only when exactly one person matches; the backfill must not guess');
  ok('never overwrites an ownerId that is already set', byId('t4').ownerId === 'pinned');
  ok('ignores a task with no owner', byId('t5').ownerId == null);
  ok('reports how many tasks it changed', changed === 2);
}
ok('the backfill runs through the normal save path, not a direct state write',
   /backfillTaskOwnerIds\(\)/.test(main) && /function migrateNotificationsState[\s\S]{0,500}?save\(\)/.test(main),
   'tasks all carry ids, so OMS_DIFF emits ordinary update operations and the audit trail is kept');

// ---------------------------------------------------------------- 7. Retired status (item 2)
console.log('\n# Retired task status (Rev 17, item 2)');
const stBf = G('stB'), tds = G('taskDisplayStatus'), ovdT = G('overdueTasks'), ets = G('eventTaskStats');
ok('Retired is offered in the task status picker', />Retired<\/option>/.test(main));
ok('taskDisplayStatus is defined', typeof tds === 'function');
if (typeof tds === 'function') {
  ok('a past-due Retired task is NOT overdue', tds({ status: 'Retired', due: '2020-01-01' }) === 'Retired',
     'retired work is withdrawn, not late');
  ok('a past-due Not Started task IS still overdue', tds({ status: 'Not Started', due: '2020-01-01' }) === 'Overdue');
  ok('a past-due Complete task is not overdue', tds({ status: 'Complete', due: '2020-01-01' }) === 'Complete');
}
if (typeof ovdT === 'function') {
  ok('the dashboard overdue count excludes Retired',
     ovdT([{ status: 'Retired', due: '2020-01-01' }, { status: 'Not Started', due: '2020-01-01' }]).length === 1);
}
if (typeof stBf === 'function') {
  const cls = s => (String(stBf(s)).match(/class="b ([a-z0-9]+)"/) || [])[1];
  ok('Retired has its own badge class, not the grey default',
     !!cls('Retired') && cls('Retired') !== cls('Not Started') && cls('Retired') !== cls('Complete'));
  ok('that badge class is actually styled in the stylesheet',
     !!cls('Retired') && new RegExp('\\.' + cls('Retired') + '\\{').test(html));
}
if (typeof ets === 'function') {
  T.setST({ tasks: [
    { id: 'a', sourceEventId: 'e1', status: 'Complete' },
    { id: 'b', sourceEventId: 'e1', status: 'Retired' },
    { id: 'c', sourceEventId: 'e1', status: 'In Progress' },
  ] });
  const s1 = ets('e1');
  ok('eventTaskStats excludes Retired from the done numerator', s1.done === 1,
     'three tasks closed as Complete on 5 Sept were never delivered; the numerator must not carry them');
  ok('eventTaskStats reports retired separately', s1.retired === 1);
  ok('eventTaskStats does not silently count Retired as open', s1.open === 1);
}

// ---------------------------------------------------------------- 8. Recurring + categories (item 3)
console.log('\n# Recurring flag and user-maintained categories (Rev 17, item 3)');
ok('the event form carries a Recurring control', /f_recurring/.test(html));
ok('saveModal persists recurring as a boolean, not a string',
   /recurring:\s*(?:!!|gc\()/.test(main),
   'the Outlook calendar sync will populate this field');
const cats = G('eventCategories');
ok('eventCategories is defined', typeof cats === 'function');
if (typeof cats === 'function') {
  T.setST({ events: [{ id: 'e1', category: 'Retreats' }, { id: 'e2', category: 'Cabinet' }] });
  const list = cats();
  ok('built-in categories are still offered', list.includes('Cabinet') && list.includes('FEC'));
  ok('a category used by an event but not built in is offered', list.includes('Retreats'),
     'a category one user adds must reach everyone WITHOUT a new synced collection');
  ok('the category list has no duplicates', new Set(list).size === list.length);
  ok('cadence is not folded into the category list', !list.includes('Recurring'),
     'a category holds one value; Recurring is a separate boolean for exactly this reason');
}
// Rev 18 note: this once matched any openModal call mentioning "categor", which
// caught the legitimate standalone Categories manager. The real invariant is
// narrower - the EVENT FORM's category control must not open a dialog, because
// that would replace the event being edited.
ok('a category is added inline, not through a second modal',
   /f_cat_new/.test(html) && /id="f_newcat"/.test(html) &&
   !/function omsToggleNewCat[\s\S]{0,400}?openModal\(/.test(main),
   'one overlay, one #mbody');
ok('the categories manager is not reachable from inside the event form',
   !/function openEvModal[\s\S]{0,4000}?openCategoriesModal\(/.test(main),
   'opening it mid-edit would destroy the event being edited');

// ---------------------------------------------------------------- 9. Saved views (item 4)
console.log('\n# User-editable filters, saved per user (Rev 17, item 4)');
const saveV = G('omsSaveView'), applyV = G('omsApplyView'), delV = G('omsDeleteView'),
      listV = G('omsSavedViews'), writeV = G('omsWriteViews'), viewUser = G('omsViewUser');
ok('the saved-view functions are defined',
   [saveV, applyV, delV, listV, writeV].every(f => typeof f === 'function'));
ok('views are keyed per user, not shared across the browser',
   typeof viewUser === 'function' && /OMS_USER/.test(String(viewUser)));
if (typeof writeV === 'function' && typeof listV === 'function' &&
    typeof applyV === 'function' && typeof delV === 'function') {
  // applyV re-renders, and the render functions read ST; give them a live shape.
  T.setST({ tasks: [], events: [], sops: [], people: [] });
  writeV([{ id: 'v1', scope: 'del', name: 'My overdue', filters: { st: 'Overdue', ow: 'All', q: '' } }]);
  ok('a saved view round-trips out of storage',
     listV('del').length === 1 && listV('del')[0].name === 'My overdue');
  ok('views are scoped, so calendar views do not leak into Deliverables', listV('cal').length === 0);
  applyV('v1');
  ok('applying a view sets the live filter state', T.fn('delSt') === 'Overdue');
  delV('v1');
  ok('a view can be deleted', listV('del').length === 0);
  ok('unparseable stored views degrade to none, they do not throw', (() => {
    // localStorage lives in the vm sandbox, not in this file's scope.
    try { sandbox.localStorage.setItem('cao_oms_views', '{not json'); return listV('del').length === 0 }
    catch (e) { return false }
    finally { sandbox.localStorage.removeItem('cao_oms_views') }
  })());
}
ok('saved views add no synced collection',
   COLLECTIONS.length === 15 && !COLLECTIONS.some(c => /^(saved)?views$/i.test(c)),
   'Rev 18 owns the sync surface; Rev 17 must not widen it');

// ---------------------------------------------------------------- 10. Auto-extending horizon (item 5)
console.log('\n# Auto-extending calendar horizon (Rev 17, item 5)');
const span = G('calYearSpan');
ok('calYearSpan is defined', typeof span === 'function');
if (typeof span === 'function') {
  const y = new Date().getFullYear();
  const s1 = span([{ date: y + '-03-01' }, { date: (y + 3) + '-05-01' }]);
  ok('an event beyond the loaded range extends the horizon', s1.includes(y + 3));
  ok('the extended horizon has no gaps', s1.includes(y + 1) && s1.includes(y + 2));
  ok('the span is contiguous and ascending', s1.every((v, i) => i === 0 || v === s1[i - 1] + 1));
  ok('the current year is always present', span([{ date: (y + 2) + '-01-01' }]).includes(y));
  ok('an end date past the start year extends the horizon too',
     span([{ date: y + '-12-30', endDate: (y + 1) + '-01-02' }]).includes(y + 1));
  ok('a wild out-of-range date does not explode the grid',
     span([{ date: y + '-01-01' }, { date: (y + 400) + '-01-01' }]).length <= 12,
     'a typo like 2426 must not render hundreds of year blocks');
  ok('no events yields no year blocks', span([]).length === 0);
  // Caught by rendering it, not by a test: gap-filling BACKWARDS turned one
  // stray 2020 due date into eleven years of mostly empty month blocks.
  const back = span([{ date: '2020-01-01' }, { date: y + '-06-01' }]);
  ok('a single old date does not gap-fill the past', !back.includes(2022) && !back.includes(y - 1),
     'the past is kept compact; only the forward horizon is filled in');
  ok('an old date is still shown as its own year block', back.includes(2020) && back.includes(y));
}

// ---------------------------------------------------------------- 11. Multi-day spanning (item 6)
// The brief skips 6 as visual. The date MATH underneath it is not visual, and
// is exactly the kind of logic the gw/rob defect taught us to exercise.
console.log('\n# Multi-day event spanning, date logic only (Rev 17, item 6)');
const inMonth = G('calOccursInMonth'), dayLabel = G('calDayLabel');
ok('calOccursInMonth is defined', typeof inMonth === 'function');
if (typeof inMonth === 'function') {
  const e = { date: '2026-12-30', endDate: '2027-01-02' };
  ok('a spanning event appears in its START month', inMonth(e, 11, 2026) === true);
  ok('a spanning event ALSO appears in its END month', inMonth(e, 0, 2027) === true,
     'buildCalGrid filtered on a single date, so it rendered once, in its start month');
  ok('a spanning event does not appear in unrelated months', inMonth(e, 5, 2026) === false);
  ok('a single-day event still appears exactly once',
     inMonth({ date: '2026-06-10' }, 5, 2026) === true && inMonth({ date: '2026-06-10' }, 6, 2026) === false);
  ok('an endDate earlier than the start date is ignored, not honoured',
     inMonth({ date: '2026-06-10', endDate: '2026-01-01' }, 0, 2026) === false);
}
if (typeof dayLabel === 'function') {
  ok('the day label clips the range to the month shown',
     dayLabel({ date: '2026-12-30', endDate: '2027-01-02' }, 11, 2026) === '30-31' &&
     dayLabel({ date: '2026-12-30', endDate: '2027-01-02' }, 0, 2027) === '1-2');
  ok('a single-day event shows a bare day number',
     dayLabel({ date: '2026-06-10' }, 5, 2026) === '10');
}

// ================================================================ REV 18
// Category management. Written before the implementation, as todoCheck, then
// promoted to ok(). The fixtures below are the LIVE production shape read from
// canonical state at revision 61 on 6 Sept 2026 — including the SOM collision,
// which was really there, not invented for the test.
console.log('\n# Category codes must disambiguate (Rev 18)');
const glyphMap = G('categoryGlyphMap'), catGlyphF = G('catGlyph'),
      catColorF = G('catColor'), catBadgeF = G('catBadge'),
      renameCat = G('renameCategory'), catCount = G('categoryEventCount'),
      evCats = G('eventCategories');

ok('categoryGlyphMap is defined', typeof glyphMap === 'function');
if (typeof glyphMap === 'function' && typeof evCats === 'function') {
  T.setST({ events: [
    { id: 'e1', category: 'SOM Events' },
    { id: 'e2', category: 'School of Medicine Events' },
    { id: 'e3', category: 'Chairs' },
    { id: 'e4', category: 'Chair Meetings' },
    { id: 'e5', category: "Dean's Office" },
  ] });
  const m = glyphMap(), codes = Object.values(m);
  ok('no two categories share a code', new Set(codes).size === codes.length,
     'the legend only works if the code actually disambiguates; colour must never be the sole cue');
  ok('every offered category has a code', evCats().every(c => !!m[c]));
  ok('built-ins keep their documented codes',
     m['SOM Events'] === 'SOM' && m['Advocate BOD'] === 'ADV' &&
     m['WFUBSM BOD'] === 'BSM' && m['WFU BOT'] === 'BOT' && m['Board Meeting'] === 'BRD');
  ok('the category that collided in production is disambiguated',
     !!m['School of Medicine Events'] && m['School of Medicine Events'] !== 'SOM',
     'both derive to SOM; the built-in keeps it and the added one must not shadow it');
  ok('the map is deterministic across calls',
     JSON.stringify(glyphMap()) === JSON.stringify(m),
     'every user computes the legend locally, so it must come out identical for everyone');
  ok('a built-in never loses its code to an added category',
     m['Chairs'] === 'CHR' && m['Chair Meetings'] !== 'CHR');
}

console.log('\n# Category colour is derived, never grey by accident (Rev 18)');
if (typeof catColorF === 'function' && typeof catBadgeF === 'function') {
  ok('a built-in keeps its palette class', catColorF('Cabinet') === 'ccab' && catColorF('FEC') === 'cfec');
  ok('a built-in keeps its badge class', catBadgeF('Cabinet') === 'br3');
  ok('an added category still gets a real palette class',
     /^c[a-z0-9]+$/.test(catColorF('School of Medicine Events')),
     'a renamed category must not silently fall back to grey');
  ok('colour derivation is stable for the same name',
     catColorF("Dean's Office") === catColorF("Dean's Office"));
  ok('the derived grid class is actually styled',
     new RegExp('\\.' + catColorF("Dean's Office") + '\\{').test(html));
  ok('the derived badge class is actually styled',
     new RegExp('\\.' + catBadgeF("Dean's Office") + '\\{').test(html));
}

console.log('\n# Renaming and merging categories (Rev 18)');
ok('renameCategory is defined', typeof renameCat === 'function');
if (typeof renameCat === 'function' && typeof catCount === 'function') {
  T.setST({ events: [
    { id: 'e1', category: 'School of Medicine Events' },
    { id: 'e2', category: 'School of Medicine Events' },
    { id: 'e3', category: 'Cabinet' },
  ], tasks: [], people: [] });
  ok('categoryEventCount reports real usage', catCount('School of Medicine Events') === 2);
  const n = renameCat('School of Medicine Events', 'SOM Events');
  ok('rename rewrites every event carrying the category', n === 2);
  ok('renaming into an EXISTING category merges them',
     T.st.events.filter(e => e.category === 'SOM Events').length === 2,
     'this is the 8-event School of Medicine Events / SOM Events duplicate in production');
  ok('events on other categories are untouched',
     (T.st.events.find(e => e.id === 'e3') || {}).category === 'Cabinet');
  ok('the old category is no longer offered',
     typeof evCats === 'function' && !evCats().includes('School of Medicine Events'));
  ok('renaming to the same name is a no-op', renameCat('Cabinet', 'Cabinet') === 0);
  ok('renaming to a blank name is a no-op', renameCat('Cabinet', '   ') === 0);
  ok('renaming an unused category changes nothing', renameCat('Nothing At All', 'X') === 0);
  ok('a blank source is a no-op', renameCat('', 'X') === 0);
}
ok('a rename saves through the normal path, not a direct state write',
   /function renameCategory[\s\S]{0,700}?save\(\)/.test(main),
   'events all carry ids, so OMS_DIFF emits ordinary update operations');
ok('the categories manager is its own dialog, opened from the toolbar',
   /openCategoriesModal\(\)/.test(main) && /t==='cats'/.test(main));
ok('the event form still adds a category inline',
   /f_cat_new/.test(html), 'one overlay: adding mid-edit must not open a second dialog');
ok('renaming is blocked for read-only users',
   /function openCategoriesModal[\s\S]{0,200}?OMS_IS_EDITOR\(\)/.test(main));

// ================================================================ REV 19
// Written before the implementation, as todoCheck, then promoted to ok().
// Four items, none of them on the sync path: notification subject standard,
// cross-source import de-duplication, and the two Weekly Brief defects found
// while investigating OPS-005.

// ---------------------------------------------------------------- subject standard (DEC-012)
console.log('\n# Notification subject standard (Rev 19, DEC-012)');
const subjOf = G('notificationSubject'), fmtLong = G('fmtLong');
ok('notificationSubject is defined', typeof subjOf === 'function');
ok('fmtLong is defined', typeof fmtLong === 'function');
if (typeof fmtLong === 'function') {
  ok('fmtLong renders a scannable date', fmtLong('2026-09-08') === 'Tue 8 Sep 2026',
     'the due date must survive subject truncation, so it is spelled out');
  ok('fmtLong is blank-safe', fmtLong('') === '' && fmtLong(null) === '');
}
if (typeof subjOf === 'function') {
  const hi = { title: 'OMS go-live triage', owner: 'Ari Ball', due: '2026-09-08', priority: 'High' };
  const lo = { title: 'Cabinet scorecards', owner: 'Maggie Scirica', due: '2026-05-18', priority: 'Medium' };
  const s1 = subjOf(hi, false), s2 = subjOf(lo, true), s3 = subjOf({ title: 'No date', owner: 'X' }, false);
  ok('every subject leads with the OMS marker', s1.startsWith('OMS | ') && s2.startsWith('OMS | ') && s3.startsWith('OMS | '),
     'DEC-012: OMS must be clearly stated in the subject');
  ok('high priority is called out immediately after the marker',
     s1.startsWith('OMS | HIGH PRIORITY | ') && !/HIGH PRIORITY/.test(s2));
  ok('the due date is front-loaded, before the title',
     s1.indexOf('Due Tue 8 Sep 2026') < s1.indexOf('OMS go-live triage'),
     'format B: what survives truncation must be the deadline, not the title tail');
  ok('a new assignment and a reassignment are distinguishable',
     /\| New assignment \|/.test(s1) && /\| Reassigned \|/.test(s2));
  ok('the subject carries title and owner', /OMS go-live triage/.test(s1) && /Ari Ball/.test(s1));
  ok('a missing due date degrades gracefully', /Due not set/.test(s3));
  ok('the old subject shape is gone', !/New OMS assignment:/.test(main) && !/OMS reassignment:/.test(main));
}

// ---------------------------------------------------------------- cross-source import de-dup (OPS-016)
console.log('\n# Cross-source import de-duplication (Rev 19, OPS-016)');
const xdup = G('crossSourceDuplicates');
ok('crossSourceDuplicates is defined', typeof xdup === 'function');
if (typeof xdup === 'function') {
  // the real production shape: the two workbooks record the same event differently
  T.setST({ events: [
    { id: 'm1', source: 'Maggie', title: 'White Coat - CLT', date: '2026-07-25' },
    { id: 'm2', source: 'Maggie', title: 'State of the School', date: '2026-03-19' },
    { id: 'a9', source: 'Ari', title: 'Existing Ari row', date: '2026-07-25' },
  ] });
  const hits = xdup([{ title: 'White Coat Ceremony - CLT', date: '2026-07-25' }], 'Ari');
  ok('a same-day near-title match against the OTHER source is flagged', hits.length === 1,
     'White Coat Ceremony - CLT vs White Coat - CLT, both on 2026-07-25, is a real production duplicate');
  ok('the flag names both sides', hits.length === 1 &&
     /White Coat Ceremony/.test(hits[0].incoming) && /White Coat - CLT/.test(hits[0].existing));
  ok('rows from the SAME source are not flagged',
     xdup([{ title: 'Existing Ari row', date: '2026-07-25' }], 'Ari').length === 0,
     'the import replaces its own source wholesale, so self-collisions are expected');
  ok('a different date is not a duplicate',
     xdup([{ title: 'White Coat - CLT', date: '2026-08-25' }], 'Ari').length === 0);
  ok('an unrelated title on the same day is not a duplicate',
     xdup([{ title: 'Budget review', date: '2026-07-25' }], 'Ari').length === 0);
  ok('a clean import returns nothing', xdup([], 'Ari').length === 0);
  ok('a row with no date is ignored, not crashed on',
     xdup([{ title: 'White Coat - CLT', date: '' }], 'Ari').length === 0);
}
ok('the import warns before replacing, and does not silently drop rows',
   /crossSourceDuplicates\(/.test(main) && /function confirmImport[\s\S]{0,900}?crossSourceDuplicates/.test(main),
   'both workbooks are canonical for their own source, so the import must report the clash, never resolve it');

// ---------------------------------------------------------------- Weekly Brief week (OPS-020)
console.log('\n# Weekly Brief opens on the current week (Rev 19, OPS-020)');
const bws = G('briefWeekStart');
ok('briefWeekStart is defined', typeof bws === 'function');
if (typeof bws === 'function') {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - d.getDay());
  const cur = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  T.setST({ briefWeek: '2026-06-16', events: [], tasks: [] });
  ok('a stale stored week is replaced by the current week', bws() === cur,
     'canonical held 2026-06-16, twelve weeks stale, so the Brief was rendering mid-June');
  T.setST({ briefWeek: '2099-01-04', events: [], tasks: [] });
  ok('a deliberately chosen future week is respected', bws() === '2099-01-04',
     'the picker must still allow any week');
  T.setST({ events: [], tasks: [] });
  ok('an absent stored week falls back to the current week, not a hardcoded 2026 date', bws() === cur);
  ok('the 2026-06-04 hardcoded fallback is gone', !/briefWeek\|\|'2026-06-04'/.test(main));
}

// ---------------------------------------------------------------- Weekly Brief deliverables (OPS-021)
console.log('\n# Weekly Brief shows deliverables due that week (Rev 19, OPS-021)');
const btd = G('briefTasksDue');
ok('briefTasksDue is defined', typeof btd === 'function');
if (typeof btd === 'function') {
  T.setST({ events: [], tasks: [
    { id: 't1', title: 'OMS go-live triage', owner: 'Ari Ball', due: '2026-09-08', priority: 'High', status: 'Not Started' },
    { id: 't2', title: 'Also this week', owner: 'Maggie Scirica', due: '2026-09-12', priority: 'Medium', status: 'In Progress' },
    { id: 't3', title: 'Next week', owner: 'X', due: '2026-09-14', priority: 'Low', status: 'Not Started' },
    { id: 't4', title: 'Retired one', owner: 'X', due: '2026-09-09', priority: 'Low', status: 'Retired' },
    { id: 't5', title: 'No due date', owner: 'X', due: '', priority: 'Low', status: 'Not Started' },
  ] });
  const got = btd('2026-09-06');
  ok('deliverables due in the displayed week are returned', got.length === 2,
     'the 8 Sept go-live triage was invisible in the Brief before this');
  ok('the week boundary is inclusive at both ends',
     got.some(t => t.id === 't1') && got.some(t => t.id === 't2'));
  ok('a deliverable due the following week is excluded', !got.some(t => t.id === 't3'));
  ok('a Retired deliverable is excluded', !got.some(t => t.id === 't4'),
     'consistent with Rev 17: retired work is withdrawn, not outstanding');
  ok('a deliverable with no due date is excluded', !got.some(t => t.id === 't5'));
  ok('an empty week returns nothing, and does not throw', btd('2030-01-06').length === 0);
}
ok('rBrief actually renders the deliverables section',
   /function rBrief[\s\S]{0,4000}?briefTasksDue\(/.test(main),
   'the function existing is not enough; the Brief must show it');

// ---------------------------------------------------------------- en-US only (OPS-022)
// Standard set 6 Sept 2026: all OMS text is en-US, not en-GB. Rev 17-19 had
// introduced 18 "colour" and 3 "grey" into the legend, the User Guide and the
// revision log. This is a guard so the standard is enforced rather than
// remembered.
//
// Deliberately NOT checked: "centre" and "cancelled". Both can appear
// legitimately in imported Outlook or workbook data (a venue name, an event
// title), and a guard that fires on real data would be turned off. If a proper
// noun ever trips one of the words below, exempt it here rather than reverting
// the standard.
console.log('\n# en-US spelling standard (OPS-022)');
const EN_GB = [
  'colour', 'behaviour', 'favourite', 'honour', 'neighbour',
  'organis', 'recognis', 'normalis', 'prioritis', 'summaris', 'customis', 'utilis', 'apologis',
  'licence', 'defence', 'pretence', 'analyse', 'paralyse', 'catalogue',
  'programme', 'travelling', 'labelled', 'modelling', 'whilst', 'amongst',
];
const found = EN_GB.filter(w => new RegExp(w, 'i').test(html));
const greyHits = (html.match(/\bgrey\b/gi) || []).length;
ok('no en-GB spellings in the artifact', found.length === 0,
   found.length ? 'found: ' + found.join(', ') : '');
ok('grey is spelled gray', greyHits === 0, greyHits ? greyHits + ' occurrence(s) of "grey"' : '');
ok('the en-US guard actually looks at the shipped text',
   html.length > 100000 && EN_GB.length >= 20,
   'a guard over an empty string would pass vacuously');
// the CSS property is "color" and must survive any spelling sweep
ok('the CSS color property is intact', /color:var\(--mu\)/.test(html) && /background:#f3f4f6;color:#374151/.test(html),
   'a careless colour->color replacement could corrupt the stylesheet');

// ================================================================ REV 21
// The sync-path release. Two items only. REV19-001 is deliberately absent:
// reading lib/core.js showed /api/operation takes ONE operation, so batching is
// a gateway change, and the real cost is two GitHub round trips per operation
// (OPS-023). Assertions written first, as the brief requires for anything
// touching sync.

console.log('\n# Sync path left intact (Rev 21)');
// The single most important assertion in this release: this change must not
// have disturbed OMS_SYNC_ONCE, which carries the id-less-record guard.
const syncSrc21 = typeof G('OMS_SYNC_ONCE') === 'function' ? G('OMS_SYNC_ONCE').toString() : '';
ok('OMS_SYNC_ONCE still carries the id-less guard on BOTH exit paths',
   (syncSrc21.match(/OMS_UNSYNCABLE\(\)/g) || []).length >= 2 &&
   /Records with no id cannot be synced/.test(syncSrc21) &&
   /Saved, but records with no id cannot be synced/.test(syncSrc21),
   'CLAUDE.md: if you touch OMS_SYNC_ONCE, keep the check on both exit paths');
ok('the operation loop is still sequential, REV19-001 deferred',
   /for\(const op of ops\)await OMS_POST\(op\)/.test(main),
   'batching needs a gateway change; parallelising here was rejected pending OPS-023');
ok('the beforeunload guard did not require editing OMS_SYNC_ONCE',
   !/OMS_SYNC_INFLIGHT/.test(syncSrc21),
   'the counter lives in OMS_QUEUE_SYNC so the guarded function is untouched');

console.log('\n# beforeunload guard while a save is pending (Rev 21, REV19-003)');
const inflightPending = G('OMS_SYNC_PENDING');
ok('OMS_SYNC_PENDING is defined', typeof inflightPending === 'function');
ok('a beforeunload listener is registered',
   /addEventListener\('beforeunload'/.test(main) || /addEventListener\("beforeunload"/.test(main));
ok('the listener consults the pending state rather than always firing',
   /beforeunload[\s\S]{0,320}?OMS_SYNC_PENDING\(\)/.test(main),
   'warning on every close would train people to click through it');
ok('the listener sets returnValue, which is what actually shows the prompt',
   /beforeunload[\s\S]{0,400}?returnValue/.test(main));
ok('OMS_QUEUE_SYNC tracks work in flight',
   /function OMS_QUEUE_SYNC[\s\S]{0,500}?OMS_SYNC_INFLIGHT\+\+/.test(main) &&
   /function OMS_QUEUE_SYNC[\s\S]{0,700}?finally/.test(main),
   'incremented on queue, decremented in finally so a rejection still clears it');
if (typeof inflightPending === 'function') {
  sandbox.localStorage.removeItem('cao_oms_v140_pending');
  ok('nothing pending means no warning', inflightPending() === false);
  sandbox.localStorage.setItem('cao_oms_v140_pending', '{"state":{}}');
  ok('unsynced work left on the browser still warns', inflightPending() === true,
     'the Rev 15 pending key is the other half of this: work saved locally but not confirmed');
  sandbox.localStorage.removeItem('cao_oms_v140_pending');
  ok('an unreadable storage does not throw', (() => {
    try { return inflightPending() === false } catch (e) { return false }
  })());
}

console.log('\n# Faster confirmation polling (Rev 21, REV19-002)');
const pollMs = G('OMS_POLL_MS');
const waitSrc = typeof G('OMS_WAIT_FOR') === 'function' ? G('OMS_WAIT_FOR').toString() : '';
ok('OMS_POLL_MS is defined', Array.isArray(pollMs) && pollMs.length > 0);
if (Array.isArray(pollMs)) {
  ok('the first check happens well before the old one second', pollMs[0] < 500,
     'the old loop slept a flat 1000 ms before it looked even once');
  ok('the schedule backs off rather than hammering the gateway',
     pollMs[pollMs.length - 1] >= 1000 && pollMs.every((v, i) => i === 0 || v >= pollMs[i - 1]),
     'each poll is a full state fetch, so early checks are cheap only if they stop being frequent');
  ok('every delay is a sane positive number', pollMs.every(v => typeof v === 'number' && v >= 100 && v <= 5000),
     'a zero would spin the loop');
}
ok('the flat one-second sleep is gone', !/for\(let n=0;n<15;n\+\+\)\{await new Promise\(r=>setTimeout\(r,1000\)\)/.test(main));
ok('the wait still gives up rather than looping forever',
   /throw new Error\('Canonical confirmation is still pending'\)/.test(main) && /waited</.test(waitSrc),
   'a hung consolidator must still surface as Unsynced');
ok('the total budget is at least the old fifteen seconds',
   /2\d000/.test(waitSrc) || /[2-9]\d000/.test(waitSrc),
   'confirmations were observed at about ten seconds, so the window must comfortably exceed that');

// ---------------------------------------------------------------- 5. release metadata
console.log('\n# Release metadata');
const revs = [...html.matchAll(/\{rev:(\d+),/g)].map(m => +m[1]);
const badge = (html.match(/vbadge">(v[\d.]+)/) || [])[1];
ok('version badge present', !!badge);
ok('badge appears exactly once', badge ? html.split(badge).length - 1 === 1 : false);
ok('rev log is strictly decreasing', revs.every((v, i) => i === 0 || revs[i - 1] > v));

// ---------------------------------------------------------------- summary
console.log('\n' + '='.repeat(52));
console.log('SMOKE: %d passed, %d failed, %d known-broken (TODO)', pass, fail, todo);
console.log('badge %s   top rev %s', badge, revs[0]);
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
