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
const ALERTS = [];
const store = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i],
           get length() { return m.size; } };
};
// Rev 23: elements are CACHED by id and remember what was written to them.
// getElementById used to hand back a fresh throwaway every call, so nothing a
// renderer produced could be inspected - which is why every assertion until now
// had to read the source text instead of the output. FIELDS lets a form be
// filled in before saveModal is called.
const FIELDS = {};
const el = (id) => ({ _id: id, textContent: '', innerHTML: '', className: '', style: {},
                    get value() { return FIELDS[id] !== undefined ? FIELDS[id] : ''; },
                    set value(v) { FIELDS[id] = v; },
                    // Rev 32 put a checkbox on the add-user form and gc() reads
                    // .checked. Without this every box reads unticked and the
                    // sign-in branch could never be exercised. dataset backs the
                    // "stop suggesting once it is typed over" behaviour.
                    get checked() { return !!FIELDS['@' + id]; },
                    set checked(v) { FIELDS['@' + id] = !!v; },
                    dataset: {},
                    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
                    appendChild: noop, setAttribute: noop, getAttribute: () => null,
                    addEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
                    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }), focus: noop, click: noop });
const ELS = {};

const sandbox = {
  console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
  Map, Set, Promise, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  requestAnimationFrame: noop, fetch: () => Promise.reject(new Error('smoke: network disabled')),
  alert: m => ALERTS.push(String(m)), confirm: () => true, prompt: () => null,
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
  getElementById: id => (ELS[id] || (ELS[id] = el(id))),
  querySelector: () => null, querySelectorAll: () => [],
  createElement: () => el('_tmp'), addEventListener: noop, body: el('_body'), documentElement: el('_html'),
  head: el('_head'), title: '', readyState: 'complete', cookie: '',
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
  ok('applying a view sets the live filter state', T.fn('taskSt') === 'Overdue');
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
// Rev 37 renamed the loop variable (it now posts `fresh`, the operations not
// already with the gateway), so the old exact-string match no longer applied.
// What must hold is the PROPERTY, not the spelling: one await per operation,
// in a serial loop, and no Promise.all/allSettled anywhere near the post path.
ok('the operation loop is still sequential, REV19-001 deferred',
   /for\(const op of \w+\)\s*\{?\s*await OMS_POST\(op\)/.test(syncSrc21) &&
   !/Promise\.(all|allSettled)\s*\(/.test(syncSrc21),
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
// Sliced rather than distance-matched: the previous form asserted that
// "finally" appeared within 700 characters of the function name, so it broke
// when the function grew for an unrelated reason. What matters is that the
// counter goes up on entry and comes down in a finally, whatever the length.
const queueSyncSrc = (() => {
  const i = main.indexOf('function OMS_QUEUE_SYNC');
  if (i < 0) return '';
  const j = main.indexOf('return OMS_SYNC_CHAIN}', i);
  return j < 0 ? '' : main.slice(i, j);
})();
ok('OMS_QUEUE_SYNC body was located', queueSyncSrc.length > 0);
ok('OMS_QUEUE_SYNC tracks work in flight',
   /OMS_SYNC_INFLIGHT\+\+/.test(queueSyncSrc) &&
   /\.finally\(/.test(queueSyncSrc) &&
   /OMS_SYNC_INFLIGHT-1/.test(queueSyncSrc),
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

// ================================================================ REV 22
// One vocabulary. The tab already read "Tasks" while the code, the notification
// copy and the Weekly Brief still said "Deliverable", so the app called the same
// thing two names depending on where you looked.

console.log('\n# One vocabulary: tasks, not deliverables (Rev 22)');
// The revision log is history and must NOT be rewritten, so it is excluded.
const revLogStart = html.indexOf('const OMS_REV_LOG');
const revLogEnd = html.indexOf('];', revLogStart);
const outsideRevLog = html.slice(0, revLogStart) + html.slice(revLogEnd);
ok('no user-facing text says deliverable', !/\b[Dd]eliverable/.test(outsideRevLog),
   (outsideRevLog.match(/\b[Dd]eliverable\w*/g) || []).slice(0, 6).join(', '));
ok('the revision log keeps its history intact',
   /\b[Dd]eliverable/.test(html.slice(revLogStart, revLogEnd)),
   'past entries are an audit record; rewriting them would falsify what shipped');

console.log('\n# Tab and handler renamed (Rev 22)');
ok('the tab id is tasks, not del', /id="tasks" class="tab/.test(html) && !/id="del" class="tab/.test(html));
ok('the nav button navigates to tasks', /go\('tasks'\)/.test(html) && !/go\('del'\)/.test(html));
ok('the tab order array uses tasks', /'sops','tasks','guide'/.test(main) && !/'sops','del','guide'/.test(main));
ok('renderTab dispatches on tasks', /t==='tasks'\)rTasks\(\)/.test(main) && !/t==='del'\)rDel\(\)/.test(main));
ok('the render function is rTasks', /function rTasks\(/.test(main) && !/function rDel\(/.test(main));
// Scoped outside the revision log: an entry explaining this rename legitimately
// names the old variable, and prose about code is not code.
const codeOnly = (() => { const a = main.indexOf('const OMS_REV_LOG'); const b = main.indexOf('];', a);
  return a < 0 ? main : main.slice(0, a) + main.slice(b); })();
ok('the filter state is renamed', /taskQ|taskSt|taskOw/.test(codeOnly) && !/\bdelQ\b|\bdelSt\b|\bdelOw\b/.test(codeOnly));
ok('rTasks writes into the renamed element', /getElementById\('tasks'\)/.test(main));

console.log('\n# Delete helpers left alone (Rev 22)');
// delItem and delEv mean DELETE, not deliverable. Renaming them would be a
// misreading of the abbreviation and would break every call site.
ok('delItem survives untouched', /function delItem\(/.test(main) && (main.match(/delItem\(/g) || []).length >= 4,
   'del here abbreviates delete, not deliverable');
ok('delEv survives untouched', /function delEv\(/.test(main) && (main.match(/delEv\(/g) || []).length >= 2);

console.log('\n# Notification copy uses the new vocabulary (Rev 22)');
const subjFn = G('notificationSubject');
if (typeof subjFn === 'function') {
  ok('an untitled task is called a task, not a deliverable',
     /Untitled task/.test(subjFn({ owner: 'X', due: '2026-09-08' })));
}
ok('the assignment body says task', /You have been assigned a new OMS task/.test(main));
ok('the reassignment body says task', /An OMS task has been reassigned to you/.test(main));
ok('the body label says Task', /'Task: '\+/.test(main));

console.log('\n# Weekly Brief wording (Rev 22)');
ok('the Brief section is titled Tasks Due This Week', /Tasks Due This Week/.test(html));
ok('the empty state says tasks', /No tasks due this week/.test(main));

// ================================================================ REV 23
// Four register items, written as assertions before any of them was built.
// OMS-008 comes first on purpose: OMS-007 and OMS-011 both name Category in
// their acceptance criteria, so neither can be satisfied until it exists.

console.log('\n# Category is one shared vocabulary, not a second list (OMS-008)');
// Reusing the event category list is the whole point. A task created from an
// Advocate BOD event should be findable alongside that event, and the Rev 18
// rename/merge manager should govern both. Two parallel lists would drift.
const evCats23 = G('eventCategories');
ok('eventCategories is defined', typeof evCats23 === 'function');
if (typeof evCats23 === 'function') {
  T.setST({ events: [{ id: 'e1', category: 'Cabinet' }], tasks: [{ id: 't1', category: 'Site Visits' }] });
  const catList = evCats23();
  ok('a category used only by a TASK still appears in the list',
     catList.includes('Site Visits'),
     'without this a task-only category vanishes on reload, leaving a task on a category nobody can pick');
  ok('event categories are still listed', catList.includes('Cabinet'));
  ok('the list is de-duplicated', new Set(catList).size === catList.length);
}

console.log('\n# Renaming a category moves tasks too (OMS-008)');
const renameCat23 = G('renameCategory');
ok('renameCategory is defined', typeof renameCat23 === 'function');
if (typeof renameCat23 === 'function') {
  T.setST({ events: [{ id: 'e1', category: 'Old Name' }],
            tasks: [{ id: 't1', category: 'Old Name' }, { id: 't2', category: 'Other' }] });
  const moved = renameCat23('Old Name', 'New Name');
  const stR = T.st;
  ok('the event was renamed', stR.events[0].category === 'New Name');
  ok('the TASK was renamed as well', stR.tasks[0].category === 'New Name',
     'a rename that skipped tasks would strand them on a category no longer offered');
  ok('an unrelated task is untouched', stR.tasks[1].category === 'Other');
  ok('the count returned covers both collections', moved === 2,
     'the confirm dialog quotes this number, so it must not understate the blast radius');
}

console.log('\n# The rename dialog states the real blast radius (OMS-008)');
const catTaskCount = G('categoryTaskCount');
const catEvCount = G('categoryEventCount');
ok('categoryTaskCount is defined', typeof catTaskCount === 'function');
if (typeof catTaskCount === 'function' && typeof catEvCount === 'function') {
  T.setST({ events: [{ id: 'e1', category: 'X' }, { id: 'e2', category: 'X' }], tasks: [{ id: 't1', category: 'X' }] });
  ok('event count keeps its meaning', catEvCount('X') === 2);
  ok('task count is reported separately', catTaskCount('X') === 1);
}

console.log('\n# Category on the task form (OMS-008)');
ok('the task form has a category control', /id="f_task_cat"/.test(main));
ok('the task form offers a new category inline, not in a second dialog',
   /id="f_task_cat_new"/.test(main),
   'CLAUDE.md: one overlay, one #mbody - a second modal would destroy the task being edited');
ok('the task save persists the category', /category:_tcat/.test(main));
ok('a task created from an event inherits that event category',
   /sourceEvent\?sourceEvent\.category/.test(main),
   'the link exists so the work can be found alongside its meeting');

console.log('\n# Tasks can be filtered by category (OMS-008)');
ok('a category filter variable exists', /\btaskCat\b/.test(main));
ok('the category filter is applied when the list is built',
   /taskCat!=='All'/.test(main));

console.log('\n# Sorting (OMS-007)');
const sortTasks = G('sortTasks');
ok('sortTasks is defined', typeof sortTasks === 'function');
if (typeof sortTasks === 'function') {
  const srows = [
    { id: 'a', title: 'Beta',  owner: 'Zoe', due: '2026-03-01', priority: 'Low',    _s: 'Complete',    category: 'B' },
    { id: 'b', title: 'alpha', owner: 'Ari', due: '2026-01-01', priority: 'High',   _s: 'Overdue',     category: 'C' },
    { id: 'c', title: 'Gamma', owner: 'Mag', due: '2026-02-01', priority: 'Medium', _s: 'In Progress', category: 'A' },
  ];
  const ids = (k, d) => sortTasks(srows.slice(), k, d).map(r => r.id).join('');
  ok('title sorts case-insensitively', ids('title', 'asc') === 'bac',
     'ASCII order would put Beta and Gamma ahead of alpha');
  ok('title reverses', ids('title', 'desc') === 'cab');
  ok('due date sorts chronologically', ids('due', 'asc') === 'bca');
  ok('priority sorts High to Low, not alphabetically', ids('priority', 'asc') === 'bca',
     'alphabetical would read High, Low, Medium and be useless');
  ok('status sorts by urgency, not alphabetically', ids('status', 'asc') === 'bca',
     'Overdue first, then In Progress, then Complete');
  ok('owner sorts alphabetically', ids('owner', 'asc') === 'bca');
  ok('category sorts alphabetically', ids('category', 'asc') === 'cab');
  ok('sortTasks does not mutate its input', (() => {
    const src = srows.slice(); const before = src.map(r => r.id).join('');
    sortTasks(src, 'due', 'asc');
    return src.map(r => r.id).join('') === before;
  })(), 'rTasks sorts the filtered list; mutating the caller would scramble it');
  ok('an unknown key falls back instead of throwing',
     Array.isArray(sortTasks(srows.slice(), 'nonsense', 'asc')) &&
     sortTasks(srows.slice(), 'nonsense', 'asc').length === 3);
  const blanks = [{ id: 'x', due: '' }, { id: 'y', due: '2026-01-01' }];
  ok('a blank due date sorts last, not first',
     sortTasks(blanks.slice(), 'due', 'asc').map(r => r.id).join('') === 'yx',
     'an undated task is not the most urgent thing in the office');
}
ok('the table headers are clickable', /omsSortTasks\(/.test(main));
ok('the active sort is visible in the header', /sort-ind/.test(main),
   'a sort you cannot see is a sort you cannot trust');

console.log('\n# Checklist export (OMS-011)');
const groups = G('checklistGroups');
ok('checklistGroups is defined', typeof groups === 'function');
if (typeof groups === 'function') {
  const g = groups([
    { id: '1', title: 'A', sourceEventId: 'e1', sourceEventTitle: 'Board Meeting' },
    { id: '2', title: 'B', sourceEventId: 'e1', sourceEventTitle: 'Board Meeting' },
    { id: '3', title: 'C', sourceEventId: '',   sourceEventTitle: '' },
  ]);
  ok('tasks are grouped by their source event', g.length === 2);
  ok('the event group keeps the event name',
     g.some(x => x.name === 'Board Meeting' && x.items.length === 2));
  ok('unlinked tasks are grouped, not dropped',
     g.some(x => x.items.length === 1 && /not linked/i.test(x.name)),
     'dropping them would silently shorten the checklist');
  const order = groups([
    { id: '1', title: 'A', sourceEventId: '', sourceEventTitle: '' },
    { id: '2', title: 'B', sourceEventId: 'e1', sourceEventTitle: 'Zeta' },
  ]);
  ok('the unlinked group sorts last', /not linked/i.test(order[order.length - 1].name));
}
ok('every field the acceptance criteria names is in the checklist', (() => {
  const i = main.indexOf('function checklistHtml');
  if (i < 0) return false;
  const seg = main.slice(i, i + 3000);
  return /\.title/.test(seg) && /\.owner/.test(seg) && /\.due/.test(seg) &&
         /_s\b/.test(seg) && /\.notes/.test(seg) && /\.category/.test(seg);
})(), 'title, owner, due date, status, notes, category');
ok('the checklist has something to tick', /&#9744;/.test(main),
   'a checklist without boxes is a list');
ok('the export reflects the filters on screen', /exportChecklist/.test(main));

console.log('\n# New-item intake (OMS-001)');
const newItemSrc = typeof G('openNewItem') === 'function' ? G('openNewItem').toString() : '';
ok('openNewItem handles every type the cards offer',
   ['inc', 'fr', 'brd', 'dl'].every(t => new RegExp("'" + t + "'").test(newItemSrc)),
   'Board and Upcoming Deadlines rendered a + Add button that silently did nothing');
ok('an unrecognized type fails loudly rather than doing nothing',
   /cannot be added/i.test(newItemSrc),
   'the old function set MC and returned, so the click merely looked broken');
ok('intake is reachable from the toolbar, not only from a card',
   /openNewItem\('inc'\)/.test(main) && (main.match(/openNewItem\(/g) || []).length >= 3);
ok('the intake status is a fixed list, not free text', /INTAKE_STATUSES/.test(main));
ok('New is the staging status a new item lands in', /INTAKE_STATUSES=\['New'/.test(main));
ok('the intake save enforces its required fields', (() => {
  const b = main.indexOf("} else if(t==='inc')");
  return b > -1 && /is required/.test(main.slice(b, b + 1600));
})(), 'acceptance criteria: required fields enforced. Scoped to the inc branch: the admin People form already says "Name is required", which a whole-file match would have mistaken for this.');
ok('the required-field check runs BEFORE the record is pushed', (() => {
  const b = main.indexOf("} else if(t==='inc')");
  if (b < 0) return false;
  const seg = main.slice(b, b + 1600);
  const guard = seg.search(/is required/), push = seg.indexOf('ST.incoming.push');
  return guard > -1 && push > -1 && guard < push;
})(), 'validating after the push would leave a blank row behind');
ok('the other intake forms enforce their required field too', (() => {
  const b = main.indexOf("} else if(t==='fr')");
  if (b < 0) return false;
  const seg = main.slice(b, b + 1200);
  const guard = seg.search(/is required/), push = seg.indexOf('ST.forReview.push');
  return guard > -1 && push > -1 && guard < push;
})());


// ---------------------------------------------------------------- Rev 23 rendered output
// Everything above reads the source. These read what the code actually PRODUCES.
// Rev 17's backward calendar gap-filling passed every assertion written for it
// and was only visible once something was rendered and looked at.
console.log('\n# What the Tasks tab actually renders (Rev 23)');
const FIXTURE = () => ({
  events: [{ id: 'e1', title: 'Advocate Board Meeting', date: '2026-09-10', category: 'Advocate BOD' },
           { id: 'e2', title: 'Cabinet Retreat', date: '2026-09-15', category: 'Cabinet' }],
  tasks: [
    { id: 't1', title: 'Draft the board deck', owner: 'Ari Ball', due: '2026-08-01', priority: 'High',   status: 'In Progress', category: 'Advocate BOD', notes: 'Needs finance sign-off', sourceEventId: 'e1', sourceEventTitle: 'Advocate Board Meeting' },
    { id: 't2', title: 'apply venue deposit', owner: 'Maggie Scirica', due: '2026-09-20', priority: 'Low', status: 'Not Started', category: 'Cabinet', notes: '', sourceEventId: 'e2', sourceEventTitle: 'Cabinet Retreat' },
    { id: 't3', title: 'Zebra report', owner: 'Ari Ball', due: '', priority: 'Medium', status: 'Not Started', category: '', notes: 'none', sourceEventId: '', sourceEventTitle: '' },
    { id: 't4', title: 'Book travel', owner: 'Terry Hales', due: '2026-09-12', priority: 'Medium', status: 'Complete', category: 'Advocate BOD', notes: '', sourceEventId: 'e1', sourceEventTitle: 'Advocate Board Meeting' },
    { id: 't5', title: 'Retired item', owner: 'Ari Ball', due: '2026-07-01', priority: 'High', status: 'Retired', category: 'Site Visits', notes: '', sourceEventId: '', sourceEventTitle: '' },
  ],
  people: [], sops: [], gw: [], rob: [], incoming: [], agendas: [], board: [], deadlines: [],
  forReview: [], fyis: [], assignments: [], notifications: [], assignmentHistory: [],
});
const draw = () => { T.fn('rTasks()'); return ELS['tasks'] ? ELS['tasks'].innerHTML : ''; };
const titlesIn = h => [...h.matchAll(/<strong>([^<]+)<\/strong>/g)].map(m => m[1]);

if (typeof G('rTasks') === 'function') {
  T.setST(FIXTURE());
  T.fn("taskSort=''"); T.fn("taskSortDir='asc'"); T.fn("taskCat='All'");
  T.fn("taskSt='All'"); T.fn("taskOw='All'"); T.fn("taskQ=''");
  const out = draw();
  ok('the Tasks tab renders every task', titlesIn(out).length === 5, titlesIn(out).length + ' rows');
  ok('the header and the first row agree on column count', (() => {
    const th = (out.match(/<th[ >]/g) || []).length;
    const row = out.slice(out.indexOf('<tr><td><strong>'));
    const td = (row.slice(0, row.indexOf('</tr>')).match(/<td[ >]/g) || []).length;
    return th === 7 && td === 7;
  })(), 'a column added to one and not the other silently skews every row');
  ok('a categorized task shows its badge', />Advocate BOD</.test(out));
  ok('an uncategorized task shows a dash, never the word undefined', /&mdash;/.test(out) && !/undefined/.test(out));
  ok('the category filter offers only categories in use on tasks',
     /taskCat=this\.value/.test(out) && out.includes('>Site Visits<'),
     'Site Visits is used by a task and by no event, so it must still be offered');

  T.fn("taskSort='title'");
  ok('sorting by title reaches the rendered rows',
     titlesIn(draw()).join('|') === 'apply venue deposit|Book travel|Draft the board deck|Retired item|Zebra report',
     titlesIn(draw()).join('|'));
  T.fn("taskSort='due'");
  const dueOrder = titlesIn(draw());
  ok('the undated task renders LAST under a due sort', dueOrder[dueOrder.length - 1] === 'Zebra report', dueOrder.join('|'));
  T.fn("taskSortDir='desc'");
  const marked = draw();
  ok('the sorted column is marked, and only that one',
     (marked.match(/sort-ind/g) || []).length === 1 && /&#9660;/.test(marked));
  T.fn("taskSort=''"); T.fn("taskSortDir='asc'");

  T.fn("taskCat='Advocate BOD'");
  ok('the category filter narrows the rendered table', titlesIn(draw()).length === 2, titlesIn(draw()).join('|'));
  T.fn("taskCat='All'");
}

console.log('\n# What the checklist actually contains (OMS-011)');
if (typeof G('checklistHtml') === 'function' && typeof G('omsTaskRows') === 'function') {
  T.setST(FIXTURE());
  T.fn("taskSort=''"); T.fn("taskCat='All'"); T.fn("taskSt='All'"); T.fn("taskOw='All'"); T.fn("taskQ=''");
  const cl = G('checklistHtml')(G('omsTaskRows')());
  ok('one tick box per task', (cl.match(/&#9744;/g) || []).length === 5);
  ok('groups are named and counted', /Advocate Board Meeting \(2\)/.test(cl) && /Cabinet Retreat \(1\)/.test(cl));
  ok('unlinked tasks are grouped and sorted last',
     /Not linked to an event \(2\)/.test(cl) &&
     cl.lastIndexOf('Not linked to an event') > cl.lastIndexOf('Cabinet Retreat'));
  ok('the checklist shows the DISPLAY status, agreeing with the table',
     /Overdue/.test(cl) && !/>In Progress</.test(cl),
     't1 is overdue against TODAY, so printing its stored In Progress would contradict the Tasks tab');
  ok('a task with no due date reads as text, not as a blank cell', /No date/.test(cl));
  ok('nothing renders as undefined', !/undefined/.test(cl));
}

console.log('\n# Intake validation blocks the write, it does not merely warn (OMS-001)');
if (typeof G('openNewItem') === 'function' && typeof G('saveModal') === 'function') {
  const cases = [
    ['inc', 'incoming',  { f_item: '   ' },                  { f_item: 'Real item', f_source: 'Email', f_status: 'New' }],
    ['fr',  'forReview', { f_item: '' },                     { f_item: 'Review this', f_by: 'Ari' }],
    ['brd', 'board',     { f_board: '', f_item: 'x' },       { f_board: 'Advocate', f_item: 'Agenda due', f_status: 'New' }],
    ['dl',  'deadlines', { f_deadline: 'x', f_dl_due: '' },  { f_deadline: 'Comms plan', f_dl_due: '2026-10-01', f_status: 'New' }],
  ];
  for (const [type, coll, bad, good] of cases) {
    T.setST(FIXTURE());
    Object.keys(FIELDS).forEach(k => delete FIELDS[k]); ALERTS.length = 0;
    G('openNewItem')(type); Object.assign(FIELDS, bad); G('saveModal')();
    ok(type + ': an invalid form writes nothing at all', T.st[coll].length === 0,
       T.st[coll].length + ' rows were written anyway');
    ok(type + ': and says which field is missing', ALERTS.some(a => /required/i.test(a)), ALERTS.join(' | '));

    Object.keys(FIELDS).forEach(k => delete FIELDS[k]); ALERTS.length = 0;
    G('openNewItem')(type); Object.assign(FIELDS, good); G('saveModal')();
    ok(type + ': a valid form writes exactly one row', T.st[coll].length === 1, T.st[coll].length + ' rows');
    if (T.st[coll].length === 1) {
      ok(type + ': the new row carries an id, so it can sync', !!T.st[coll][0].id,
         'OMS_MAP drops id-less records and the collection would never sync in either direction');
    }
  }
  ALERTS.length = 0;
  G('openNewItem')('nonsense');
  ok('an unhandled card type says so instead of doing nothing',
     ALERTS.some(a => /cannot be added/i.test(a)), ALERTS.join(' | '));
}


// ================================================================ REV 24
// Three register items that are really one theme: what happens next. A task
// that cannot start yet, the handoff when its prerequisite lands, and the
// nudge before a due date. Assertions written before any of it was built.

console.log('\n# Task dependencies (OMS-013)');
const prereqOf = G('taskPrereq');
const blocked = G('isBlocked');
ok('taskPrereq is defined', typeof prereqOf === 'function');
ok('isBlocked is defined', typeof blocked === 'function');
if (typeof blocked === 'function' && typeof prereqOf === 'function') {
  T.setST({ events: [], people: [], sops: [], tasks: [
    { id: 'a', title: 'Draft remarks', status: 'In Progress' },
    { id: 'b', title: 'Build slides', status: 'Not Started', dependsOn: 'a' },
    { id: 'c', title: 'Standalone', status: 'Not Started' },
    { id: 'd', title: 'After done', status: 'Not Started', dependsOn: 'x-done' },
    { id: 'x-done', title: 'Finished prereq', status: 'Complete' },
    { id: 'e', title: 'After retired', status: 'Not Started', dependsOn: 'x-ret' },
    { id: 'x-ret', title: 'Dropped prereq', status: 'Retired' },
    { id: 'f', title: 'Dangling', status: 'Not Started', dependsOn: 'nonexistent' },
  ] });
  const byId = i => T.st.tasks.find(t => t.id === i);
  ok('a task waiting on unfinished work is blocked', blocked(byId('b')) === true);
  ok('a task with no prerequisite is not blocked', blocked(byId('c')) === false);
  ok('a COMPLETE prerequisite unblocks', blocked(byId('d')) === false);
  ok('a RETIRED prerequisite unblocks', blocked(byId('e')) === false,
     'work that was dropped must not freeze its dependent forever');
  ok('a dangling prerequisite does not block', blocked(byId('f')) === false,
     'a deleted prerequisite must not strand the dependent');
  ok('taskPrereq resolves the prerequisite record',
     (prereqOf(byId('b')) || {}).id === 'a');
  ok('taskPrereq returns null for a dangling reference', prereqOf(byId('f')) === null);
  ok('a done task is never blocked',
     blocked({ id: 'z', status: 'Complete', dependsOn: 'a' }) === false);
  ok('a retired task is never blocked',
     blocked({ id: 'z', status: 'Retired', dependsOn: 'a' }) === false);
  // Only the DIRECT prerequisite is consulted, which is what makes cycles
  // structurally impossible rather than merely unlikely.
  T.setST({ events: [], people: [], sops: [], tasks: [
    { id: 'p', title: 'P', status: 'Not Started', dependsOn: 'q' },
    { id: 'q', title: 'Q', status: 'Not Started', dependsOn: 'p' },
  ] });
  ok('a dependency cycle does not hang or overflow', (() => {
    try { return blocked(T.st.tasks[0]) === true && blocked(T.st.tasks[1]) === true; }
    catch (e) { return false; }
  })(), 'only the direct prerequisite is consulted, so recursion is impossible');
}

console.log('\n# Blocked is a display status (OMS-013)');
const disp = G('taskDisplayStatus');
if (typeof disp === 'function') {
  T.setST({ events: [], people: [], sops: [], tasks: [
    { id: 'a', title: 'prereq', status: 'Not Started' },
    { id: 'b', title: 'dep', status: 'Not Started', dependsOn: 'a', due: '2020-01-01' },
  ] });
  ok('Blocked takes precedence over Overdue', disp(T.st.tasks[1]) === 'Blocked',
     'the actionable fact is that it cannot be started, not that it is late');
  ok('an unblocked overdue task still reads Overdue',
     disp({ id: 'z', status: 'Not Started', due: '2020-01-01' }) === 'Overdue');
}
ok('the Blocked filter chip exists', /'Blocked'/.test(main));
ok('Blocked has its own badge style', /bblk|Blocked':'b/.test(main));

console.log('\n# The dependency cannot be self-referential or destructive (OMS-013)');
ok('the task form offers a prerequisite control', /id="f_dependsOn"/.test(main));
ok('a task cannot depend on itself', /cannot depend on itself/i.test(main));
ok('deleting a prerequisite clears its dependents', /dependsOn=''/.test(main) || /dependsOn:''/.test(main),
   'a dangling reference must not be left behind, the same way delEv clears sourceEventId');

console.log('\n# Handoff notification when a prerequisite completes (OMS-014)');
const handoff = G('notifyDependentsOnCompletion');
ok('notifyDependentsOnCompletion is defined', typeof handoff === 'function');
if (typeof handoff === 'function') {
  T.setST({ events: [], sops: [],
    people: [{ id: 'ari-ball', name: 'Ari Ball', email: 'a@x.org' }],
    notifications: [], assignmentHistory: [],
    tasks: [
      { id: 'a', title: 'Draft remarks', status: 'Complete' },
      { id: 'b', title: 'Build slides', status: 'Not Started', dependsOn: 'a', owner: 'Ari Ball', ownerEmail: 'a@x.org' },
      { id: 'c', title: 'Unrelated', status: 'Not Started', owner: 'Ari Ball', ownerEmail: 'a@x.org' },
    ] });
  const made = handoff(T.st.tasks[0], { status: 'In Progress' });
  ok('completing a prerequisite notifies its dependent', made === 1, 'made=' + made);
  ok('the notification names the unblocked task',
     (T.st.notifications[0] || {}).taskId === 'b');
  ok('it does not notify unrelated tasks', T.st.notifications.length === 1);
  // idempotence: completing something already complete must not re-notify
  const again = handoff(T.st.tasks[0], { status: 'Complete' });
  ok('a task already complete does not re-notify', again === 0,
     're-saving a completed task would otherwise send a duplicate every time');
  T.setST({ events: [], sops: [], people: [], notifications: [], assignmentHistory: [],
    tasks: [ { id: 'a', title: 'P', status: 'Complete' },
             { id: 'b', title: 'D', status: 'Not Started', dependsOn: 'a', owner: 'Nobody', ownerEmail: '' } ] });
  ok('a dependent with no email is skipped, not failed',
     handoff(T.st.tasks[0], { status: 'Not Started' }) === 0 && T.st.notifications.length === 0);
}

console.log('\n# Due-date reminders (OMS-006)');
const dueSoon = G('tasksDueSoon');
ok('tasksDueSoon is defined', typeof dueSoon === 'function');
if (typeof dueSoon === 'function') {
  const iso = d => { const x = new Date(G('TODAY')); x.setDate(x.getDate() + d);
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  T.setST({ events: [], sops: [], people: [], notifications: [], tasks: [
    { id: 'soon',    title: 'Due in two days', status: 'Not Started', due: iso(2),  owner: 'A', ownerEmail: 'a@x' },
    { id: 'today',   title: 'Due today',       status: 'Not Started', due: iso(0),  owner: 'A', ownerEmail: 'a@x' },
    { id: 'far',     title: 'Due in ten days', status: 'Not Started', due: iso(10), owner: 'A', ownerEmail: 'a@x' },
    { id: 'done',    title: 'Already done',    status: 'Complete',    due: iso(1),  owner: 'A', ownerEmail: 'a@x' },
    { id: 'retired', title: 'Retired',         status: 'Retired',     due: iso(1),  owner: 'A', ownerEmail: 'a@x' },
    { id: 'overdue', title: 'Already overdue', status: 'Not Started', due: iso(-5), owner: 'A', ownerEmail: 'a@x' },
    { id: 'noemail', title: 'No address',      status: 'Not Started', due: iso(1),  owner: 'B', ownerEmail: '' },
  ] });
  const ids = dueSoon(3).map(t => t.id).sort().join(',');
  ok('due-soon covers today through the horizon', ids === 'soon,today', ids);
  ok('work already complete is excluded', !ids.includes('done'));
  ok('retired work is excluded', !ids.includes('retired'));
  ok('already-overdue work is excluded', !ids.includes('overdue'),
     'overdue is a different problem with its own surface; a reminder would be noise');
  ok('an owner with no address is excluded', !ids.includes('noemail'),
     'no address means no notification can be created, so listing it promises something undeliverable');
  ok('the horizon is a parameter, not a constant', dueSoon(14).length > dueSoon(3).length);
}
ok('reminders are NOT created on load', !/tasksDueSoon\(\)[\s\S]{0,80}createNotification/.test(main) &&
   !/OMS_BOOT[\s\S]{0,400}tasksDueSoon/.test(main),
   'writing to canonical when someone merely opens OMS is a write-on-read, and two people opening it at once would race');
ok('there is an explicit action to create reminder drafts', /createDueReminders/.test(main));
const mkRem = G('createDueReminders');
if (typeof mkRem === 'function') {
  const iso = d => { const x = new Date(G('TODAY')); x.setDate(x.getDate() + d);
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  T.setST({ events: [], sops: [], people: [], notifications: [], tasks: [
    { id: 'r1', title: 'Due soon', status: 'Not Started', due: iso(1), owner: 'A', ownerEmail: 'a@x' } ] });
  const n1 = mkRem(3);
  ok('an explicit run creates a reminder', n1 === 1 && T.st.notifications.length === 1);
  const n2 = mkRem(3);
  ok('running it again creates nothing for the same task and due date', n2 === 0 && T.st.notifications.length === 1,
     'otherwise every click would add another copy of the same reminder');
}


// ================================================================ REV 25
// Two items that were sized L and were actually S, because the data already
// existed and nothing rendered it. Assertions written before the build.

console.log('\n# Editor attribution resolves a raw actor id (OMS-022)');
const actorName = G('omsActorName');
ok('omsActorName is defined', typeof actorName === 'function');
if (typeof actorName === 'function') {
  T.setST({ events: [], tasks: [], sops: [], notifications: [], assignmentHistory: [],
    people: [
      { id: 'hossam-elsaie', name: 'Hossam Elsaie', email: 'hossam.elsaie@advocatehealth.org' },
      { id: 'ari-ball', name: 'Ari Ball', email: 'Ariana.Ball@advocatehealth.org' },
    ] });
  ok('an oms- prefixed slug resolves to a display name',
     actorName('oms-hossam-elsaie') === 'Hossam Elsaie');
  ok('a bare slug resolves too', actorName('hossam-elsaie') === 'Hossam Elsaie');
  // After OMS-043 the account id becomes an email, so _updatedBy will read
  // oms-<email>. Resolution has to survive that change without an edit.
  ok('an email-shaped actor id resolves, ready for OMS-043',
     actorName('oms-hossam.elsaie@advocatehealth.org') === 'Hossam Elsaie');
  ok('resolution is case-insensitive on the email',
     actorName('oms-ariana.ball@advocatehealth.org') === 'Ari Ball',
     'the directory stores Ariana.Ball with capitals');
  ok('an unknown actor degrades to the raw id, not to blank',
     actorName('oms-someone-else') === 'someone-else',
     'showing nothing would hide that the record WAS edited by somebody');
  ok('an empty actor yields an empty string', actorName('') === '' && actorName(null) === '');
}

console.log('\n# The attribution stamp (OMS-022)');
const stamp = G('recordStamp');
ok('recordStamp is defined', typeof stamp === 'function');
if (typeof stamp === 'function') {
  const s1 = stamp({ _updatedBy: 'oms-hossam-elsaie', _updatedAt: '2026-09-05T23:10:41Z' });
  ok('the stamp names who and when', /Hossam Elsaie/.test(s1) && /2026/.test(s1), s1);
  ok('a record with no metadata yields nothing', stamp({ id: 'x' }) === '');
  ok('a null record does not throw', stamp(null) === '');
  ok('a partial stamp still renders', /Hossam Elsaie/.test(stamp({ _updatedBy: 'oms-hossam-elsaie' })));
}
ok('the sync payload still strips the metadata', /delete o\._updatedBy/.test(main),
   'displaying it must not start round-tripping server-owned fields back as client edits');

console.log('\n# Assignment history is finally rendered (OMS-021)');
const histFor = G('assignmentHistoryFor');
ok('assignmentHistoryFor is defined', typeof histFor === 'function');
if (typeof histFor === 'function') {
  T.setST({ events: [], sops: [], notifications: [], people: [],
    tasks: [{ id: 't1', title: 'A task' }],
    assignmentHistory: [
      { id: 'h1', taskId: 't1', type: 'assignment_created', owner: 'Ari Ball',   at: '2026-07-01T10:00:00Z' },
      { id: 'h3', taskId: 't1', type: 'assignment_changed', owner: 'Maggie Scirica', at: '2026-08-01T10:00:00Z' },
      { id: 'h2', taskId: 't2', type: 'assignment_created', owner: 'Terry Hales', at: '2026-07-15T10:00:00Z' },
    ] });
  const rows = histFor('t1');
  ok('history is filtered to the task', rows.length === 2);
  ok('newest first', rows[0].id === 'h3', rows.map(r => r.id).join(','));
  ok('an unknown task yields an empty list', histFor('nope').length === 0);
  ok('it does not mutate the stored order',
     T.st.assignmentHistory[0].id === 'h1', 'sorting a copy, not the collection');
}
const histHtml = G('assignmentHistoryHtml');
ok('assignmentHistoryHtml is defined', typeof histHtml === 'function');
if (typeof histHtml === 'function' && typeof histFor === 'function') {
  const h = histHtml(histFor('t1'));
  ok('the history table renders rows', /<table>/.test(h) && (h.match(/<tr>/g) || []).length >= 3);
  ok('a reassignment is labelled as one', /Reassigned/.test(h));
  ok('a first assignment is labelled differently', /Assigned/.test(h));
  ok('nothing renders for an empty history', histHtml([]) === '');
  ok('no undefined leaks in', !/undefined/.test(h));
}
ok('the task dialog shows history inline, not in a second overlay',
   /assignmentHistoryHtml\(assignmentHistoryFor\(/.test(main),
   'CLAUDE.md: openModal replaces #mbody, so a second dialog would destroy the task being edited');
ok('the Admin Console carries the full history', /Assignment History/.test(main));
ok('the attribution stamp reaches the task dialog', /recordStamp\(/.test(main));


// ================================================================ REV 26
// A guide that matches the reader's access level, and one sign-off on every
// draft. The render harness covers these more thoroughly; these are the ones
// worth blocking a release over.

console.log('\n# One guide per access level (OMS-044)');
const guideOf = role => {
  T.fn("OMS_USER={role:'" + role + "'}");
  T.fn('_guideHtml=null'); T.fn('_guideRole=null');
  T.fn('rGuide()');
  return ELS['guide'] ? ELS['guide'].innerHTML : '';
};
if (typeof G('guideFor') === 'function') {
  T.setST({ events: [], tasks: [], people: [], sops: [], gw: [], rob: [], incoming: [], agendas: [],
            board: [], deadlines: [], forReview: [], fyis: [], assignments: [], notifications: [],
            assignmentHistory: [] });
  const viewer = guideOf('viewer'), editor = guideOf('editor'), admin = guideOf('admin');
  ok('all three guides render', viewer.length > 800 && editor.length > 800 && admin.length > 800);
  ok('they are three different documents', viewer !== editor && editor !== admin && viewer !== admin);
  ok('viewer is shortest, admin longest', viewer.length < editor.length && editor.length < admin.length,
     viewer.length + ' < ' + editor.length + ' < ' + admin.length);
  // The point of the split: a read-only guide must not teach steps its reader
  // will be refused when they try them.
  ok('the read-only guide does not teach editing or recovery',
     !/Sync pending|Unsynced|Admin Console|Hard delete/.test(viewer),
     'a viewer can never cause a save, so save-recovery advice is worse than noise');
  ok('the read-only guide still says what the account CAN do',
     /read-only/i.test(viewer) && /print/i.test(viewer) && /cannot add, edit or delete/i.test(viewer));
  ok('the editor guide covers what an editor does',
     ['Sync pending', 'Unsynced', 'Waiting on', 'Remind', 'Retired'].every(t => editor.includes(t)));
  ok('the editor guide omits the Admin Console', !editor.includes('Admin Console'));
  ok('the admin guide keeps the full technical detail',
     ['Admin Console', 'Hard delete', 'Records with no id', 'Revision Log'].every(t => admin.includes(t)));
  ok('the cache is keyed on role, not global',
     guideOf('viewer') === viewer && guideOf('admin') === admin,
     'a global cache would serve one role the other role guide');
}

console.log('\n# One sign-off on every draft (OMS-031, DEC-016)');
const signoff = G('OMS_MAIL_SIGNOFF');
ok('the sign-off exists', typeof signoff === 'string' && signoff.length > 40);
if (typeof signoff === 'string') {
  ok('it identifies CAO-OMS as the sender', /CAO-OMS/.test(signoff));
  ok('it carries the agreed Reply-To', /hossam\.elsaie@advocatehealth\.org/.test(signoff),
     'DEC-016. The From name belongs to the mailbox and cannot be set from a compose deeplink, so the body carries it');
  ok('it still says the message was machine-generated',
     /generated from the CAO Operations Management System/.test(signoff));
}
ok('assignment, handoff and reminder drafts all use it',
   (main.match(/OMS_MAIL_SIGNOFF/g) || []).length >= 4);


// ================================================================ REV 27
console.log('\n# One builder for every OMS subject line (Rev 27)');
const subj = G('omsSubject');
ok('omsSubject is defined', typeof subj === 'function');
if (typeof subj === 'function') {
  const t = { title: 'Draft the deck', owner: 'Ari Ball', due: '2026-09-08', priority: 'Medium' };
  ok('the standard order is OMS, priority, due, kind, task, owner',
     subj('New assignment', t) === 'OMS | Due Tue 8 Sep 2026 | New assignment | Draft the deck | Ari Ball',
     subj('New assignment', t));
  ok('HIGH PRIORITY is inserted for a high-priority task',
     /^OMS \| HIGH PRIORITY \| Due /.test(subj('Reminder', { ...t, priority: 'High' })));
  ok('and omitted otherwise', !/HIGH PRIORITY/.test(subj('Reminder', t)));
  ok('a missing due date reads "not set"', /Due not set/.test(subj('Reminder', { ...t, due: '' })));
  ok('a missing owner reads Unassigned', /Unassigned$/.test(subj('Reminder', { ...t, owner: '' })));
  ok('a missing title reads Untitled task', /Untitled task/.test(subj('Reminder', { ...t, title: '' })));
}
// The regression this release exists to prevent: Rev 24 built handoff and
// reminder subjects inline and both silently dropped HIGH PRIORITY, so an
// urgent task was nudged with a subject that looked routine.
ok('the subject standard is built in exactly ONE place',
   (main.match(/'OMS \| /g) || []).length === 1,
   'three copies is how the HIGH PRIORITY marker went missing from two of them');
ok('notificationSubject still exists for its callers', /function notificationSubject\(/.test(main));
if (typeof G('notificationSubject') === 'function') {
  ok('notificationSubject delegates rather than duplicating',
     /return omsSubject\(/.test(G('notificationSubject').toString()));
}


// ================================================================ REV 30
console.log('\n# Sign-in accounts in the Admin Console (OMS-048)');
ok('the account endpoint is called, not canonical state', /\/api\/users/.test(main),
   'sign-in accounts live in the gateway; ST.people is the directory');
ok('the client never asks for a salt or hash', !/\.salt\b/.test(main) && !/\baccounts\[[^\]]*\]\.hash/.test(main));
ok('an account list is cached and refreshable', /omsLoadAccounts\(/.test(main) && /OMS_ACCOUNTS/.test(main));
ok('accounts are matched to people by email', /omsAccountFor\(/.test(main));
// The trap this release exists to avoid: a directory flag that reads as revoked
// access while the person can still sign in.
ok('deactivating also blocks the sign-in', /omsToggleSignIn\(/.test(main));
ok('removing somebody removes their sign-in too', /omsRemoveSignIn\(/.test(main));
ok('the password dialog is a modal, not a prompt', /openAccountModal\(/.test(main) && !/prompt\(['"]Password/.test(main));
ok('a reset re-arms the forced change on the server, not the client',
   !/mustChangePassword\s*[:=]\s*true/.test(main),
   'the client must not be able to clear or set that flag; only the gateway writes it');
ok('the guide no longer says the console cannot issue a password',
   !/Issuing a new temporary password is not something the Admin Console can do/.test(html),
   'Rev 29 said that truthfully; Rev 30 made it false');
ok('the guide explains the lockout guards',
   /cannot disable or delete your own account/i.test(html) && /last active/i.test(html));


// ================================================================ REV 31
console.log('\n# The suggested password can be dictated (OMS-049)');
// ------------------------------------------------- Rev 33: one category vocabulary
// Ari's workbook and OMS grew different words for the same categories, and the
// importer used to pass the cell through untouched. These lock down the mapping
// and the derivation, because the failure is invisible: it produces a SECOND
// category that looks right next to the first.
{
  const canon = G('omsCanonicalCategory'), derive = G('omsDeriveCategory'), resolve = G('omsResolveImportCategory');
  ok('omsCanonicalCategory is defined', typeof canon === 'function');
  ok('omsDeriveCategory is defined', typeof derive === 'function');
  ok('omsResolveImportCategory is defined', typeof resolve === 'function');
  if (typeof canon === 'function') {
    ok("the workbook's 'School of Medicine Events' becomes SOM Events", canon('School of Medicine Events') === 'SOM Events');
    ok("the workbook's 'Chair Meetings' becomes Chairs", canon('Chair Meetings') === 'Chairs');
    ok('case and padding do not defeat the mapping', canon('  chair MEETINGS ') === 'Chairs');
    ok('a curly apostrophe maps the same as a straight one', canon('Dean\u2019s Office') === "Dean's Office");
    ok('a category already in OMS wording is left alone', canon('Advocate BOD') === 'Advocate BOD');
    ok('an unknown category is kept as typed, not forced to Other', canon('Vice Dean Forum') === 'Vice Dean Forum');
    ok('a blank stays blank rather than becoming Other', canon('') === '' && canon(null) === '');
  }
  if (typeof derive === 'function') {
    ok('a standing series beats a generic word: HA/HS Board Advance', derive('HA/HS Board Advance') === 'HA/HS');
    ok('CAO Grand Rounds is CAO Rounds, not a board', derive('CAO Grand Rounds - Macon') === 'CAO Rounds');
    ok('EB OOO is out of office, not a meeting', derive('EB OOO') === 'EB OOO');
    ok('Advocate Health Board is Advocate BOD', derive('Advocate Health Board Meeting') === 'Advocate BOD');
    ok('WFUBMC lands on WFUBSM BOD', derive('WFUBMC Committee/Board') === 'WFUBSM BOD');
    ok('White Coat Ceremony is an SOM event', derive('White Coat Ceremony') === 'SOM Events');
    ok('a bare board falls through to Board Meeting', derive('JCSU BOT Meeting Board') === 'Board Meeting');
    ok('an unrecognized title is honestly Other', derive('Emeritus Academy') === 'Other');
  }
  if (typeof resolve === 'function') {
    ok('an explicit workbook category wins over the guess',
       resolve('Cabinet', 'White Coat Ceremony') === 'Cabinet');
    ok('an explicit category is still translated first',
       resolve('School of Medicine Events', 'Random Title') === 'SOM Events');
    ok('a blank cell falls through to the title', resolve('', 'FEC Meeting') === 'FEC');
    ok('a literal Other is treated as no answer, not as a choice',
       resolve('Other', 'White Coat Ceremony') === 'SOM Events');
    ok('a blank cell and an unrecognizable title is Other', resolve('', 'Emeritus Academy') === 'Other');
  }
}

// ---------------------------------------------------------------- Rev 34
{
  // OMS-041: cadence is a second axis, not more categories.
  const rcal = String(G('rCal') || '');
  ok('OMS-041: the calendar filters on recurring, not on a new field',
     /calCadence==='standing'/.test(rcal) && /e\.recurring/.test(rcal));
  ok('OMS-041: standing and one-off partition the events', /calCadence==='oneoff'/.test(rcal));

  // OMS-015: an appended note must never destroy what is already there.
  const append = G('omsAppendNote');
  ok('omsAppendNote is defined', typeof append === 'function');
  if (typeof append === 'function') {
    const prior = 'Existing note from somebody else.';
    const out = append(prior, 'Chased this today');
    ok('the earlier note survives verbatim', out.indexOf(prior) === 0);
    ok('the addition lands on its own line', out.split('\n').length === 2);
    // Signed out in the harness, so the stamp carries the date alone. Both
    // shapes are accepted; what is NOT accepted is the dangling separator
    // that the first cut produced for every user, signed in or not.
    ok('the addition is dated', /^\[(.+ \u00b7 )?\d{2} \w{3}\] Chased this today$/.test(out.split('\n')[1]));
    ok('no attribution is claimed when nobody is signed in',
       !/\[\s*\u00b7/.test(out) && typeof G('omsMe') === 'function');
    ok('an empty addition changes nothing at all', append(prior, '   ') === prior);
    ok('a first note does not start with a blank line', append('', 'First').indexOf('[') === 0);
    ok('a null existing note is handled', typeof append(null, 'x') === 'string');
    // The defect this fixes: two people writing in turn must both survive.
    const two = append(append('', 'Ari note'), 'Maggie note');
    ok('two notes in sequence both survive', /Ari note/.test(two) && /Maggie note/.test(two));
  }

  // OMS-028: an overdue review has to be visible, not merely stored.
  const cell = G('sopReviewCell');
  ok('sopReviewCell is defined', typeof cell === 'function');
  if (typeof cell === 'function') {
    ok('a blank review date renders as a dash, not as overdue', /mdash/.test(cell({ reviewDue: '' })));
    ok('a past review date is flagged Overdue', /Overdue/.test(cell({ reviewDue: '2020-01-01' })));
    ok('a future review date is shown but not flagged',
       !/Overdue/.test(cell({ reviewDue: '2099-01-01' })) && cell({ reviewDue: '2099-01-01' }).length > 10);
  }
  const soon = G('sopsDueSoon');
  ok('sopsDueSoon is defined', typeof soon === 'function');

  // OMS-029: logging is inline in the queue, because a second modal would
  // destroy the first - the rule that put the new-person form in the task dialog.
  const notif = String(G('openNotificationsModal') || '');
  ok('OMS-029: the log form is inline in the existing modal, not a second one',
     /lc_subject/.test(notif) && (notif.match(/openModal\(/g) || []).length === 1);
  ok('OMS-029: a logged entry offers no draft button, having already been sent',
     /n\.type==='logged'/.test(notif));
  const logfn = G('omsLogCommunication');
  ok('omsLogCommunication is defined', typeof logfn === 'function');
  ok('OMS-029: logging reuses notifications rather than a new collection',
     /ST\.notifications\.unshift/.test(String(logfn || '')) &&
     !/ST\.communications/.test(String(logfn || '')));
}

// ------------------------------------------------- Rev 35: the sync heals itself
// Unsynced used to be terminal: OMS_WAIT_FOR gave up after 24 seconds and
// nothing checked again, so a late confirmation sat unnoticed until a manual
// reload. On 6 Sept that left a save showing Unsynced for eight minutes while
// it was already in canonical.
{
  ok('a reconciler exists', typeof G('OMS_START_RECONCILE') === 'function');
  ok('it can be stopped', typeof G('OMS_STOP_RECONCILE') === 'function');
  ok('adopting canonical is a named step, not inlined twice',
     typeof G('OMS_ADOPT_CANONICAL') === 'function');

  const rec = String(G('OMS_START_RECONCILE') || '');
  // Rev 36. This assertion used to read /_dirty\.size/.test(rec) — it asserted
  // the presence of the exact condition that made the reconciler inert, and
  // passed for the whole of Rev 35. The safety rule is now a named predicate,
  // and the assertion that matters is the executable one further down.
  ok('the adoption guard is a named predicate, not an inline flag test',
     /OMS_RECONCILE_SAFE\(\)/.test(rec) && typeof G('OMS_RECONCILE_SAFE') === 'function',
     '_dirty cannot distinguish unsent edits from unconfirmed ones');
  ok('it reschedules itself rather than running once', /setTimeout\(tick/.test(rec));
  ok('an expired session stops it, since waiting cannot fix that', /e\.auth/.test(rec));

  // Was a fixed 1400-character slice from the function's name, which broke the
  // moment a comment was added above the branch it was looking for. The
  // function's own source has no magic number in it.
  const queue = String(G('OMS_QUEUE_SYNC') || '');
  ok('landing in Unsynced starts the reconciler', /OMS_START_RECONCILE/.test(queue));
  ok('but only for a batch the gateway actually accepted (Rev 36)',
     /OMS_INFLIGHT\)\{OMS_SET_STATE\('Unsynced'/.test(queue) && /OMS_START_RECONCILE/.test(queue),
     'a batch that never left the browser cannot be healed by waiting');
  ok('and that branch no longer tells people not to reload',
     !/waiting to be folded into the shared record[^']*do not reload/i.test(queue));
  ok('a fresh sync stops the reconciler so the two never race',
     /OMS_SYNC_ONCE\(\)\{OMS_STOP_RECONCILE\(\)/.test(main));
  ok('the Unsynced message no longer tells people to sit and wait',
     /keeps checking every few seconds/.test(main) && !/is not yet confirmed in shared OMS\. Do not repeat the edit\.'/.test(main));

  // OMS-015 reachability: Rev 34 shipped Add note on SOPs only.
  const taskModal = String(G('openTaskModal') || '');
  ok('OMS-015: Add note is on the TASK form, where notes are actually written',
     /f_note_add/.test(taskModal) && /omsAddNoteTo/.test(taskModal));
  const sopModal = String(G('openSopModal') || '');
  ok('OMS-015: and still on the SOP form', /f_note_add/.test(sopModal));

  // EB OOO is availability, not a meeting.
  const rcal = String(G('rCal') || '');
  ok('out of office is hidden from the calendar by default',
     /calShowOoo/.test(rcal) && /'EB OOO'/.test(rcal));
  ok('and there is a control to bring it back', /calShowOoo=!calShowOoo/.test(rcal));
}

const suggest = G('omsSuggestedPassword');

// ---------------------------------------------------------------- Rev 32: Add User issues the sign-in
// Until Rev 32 this button wrote a directory row and stopped, so somebody could
// be "added" and still not be able to sign in. These exercise the function
// rather than reading it: the ORDER is the whole point of the fix.
const E = id => ctx.document.getElementById(id);
{
  const saveUser = G('saveAdminUser');
  ok('saveAdminUser is defined', typeof saveUser === 'function');
  ok('saveAdminUser is async - it awaits the gateway before writing the directory',
     typeof saveUser === 'function' && saveUser.constructor.name === 'AsyncFunction');

  const toggle = G('omsToggleAddSignIn');
  ok('omsToggleAddSignIn is defined', typeof toggle === 'function');
  if (typeof toggle === 'function') {
    toggle(false);
    ok('unticking the box hides the password field', E('au_pw_wrap').style.display === 'none');
    toggle(true);
    ok('reticking it shows the password field again', E('au_pw_wrap').style.display === '');
  }

  // The suggestion follows the name until an administrator types over it.
  const syncPw = G('omsSyncAddPw');
  ok('omsSyncAddPw is defined', typeof syncPw === 'function');
  if (typeof syncPw === 'function' && typeof suggest === 'function') {
    Object.keys(FIELDS).forEach(k => delete FIELDS[k]);
    E('au_pw').dataset = {};
    FIELDS['au_name'] = 'Clare Il’Giovine';
    syncPw();
    ok('the password fills in from the name', FIELDS['au_pw'] === suggest('Clare Il’Giovine'));
    ok('and it carries no punctuation that cannot be dictated',
       /^[A-Za-z]+-OMS-2026!$/.test(FIELDS['au_pw'] || ''));
    FIELDS['au_name'] = 'Jane Westgate';
    syncPw();
    ok('it keeps following the name while untouched', FIELDS['au_pw'] === suggest('Jane Westgate'));
    E('au_pw').dataset.touched = '1';
    FIELDS['au_name'] = 'Somebody Else';
    syncPw();
    ok('and stops the moment it is typed over', FIELDS['au_pw'] === suggest('Jane Westgate'));
  }

  // Exercise the save path with the gateway call stubbed at its seam.
  const realAction = ctx.omsAccountAction, realSave = ctx.save;
  const realClose = ctx.closeModal, realR = ctx.rAdmin;
  const order = [], calls = [], seenDir = [];
  const fill = (name, email, pw, wantSignIn) => {
    Object.keys(FIELDS).forEach(k => delete FIELDS[k]); ALERTS.length = 0;
    order.length = 0; calls.length = 0; seenDir.length = 0;
    E('au_pw').dataset = {};
    FIELDS['au_name'] = name; FIELDS['au_email'] = email;
    FIELDS['au_role'] = 'Program Manager'; FIELDS['au_access'] = 'editor';
    FIELDS['au_pw'] = pw; FIELDS['@au_signin'] = wantSignIn;
  };

  if (typeof saveUser === 'function' && T.st) {
    ctx.save = () => order.push('directory');
    ctx.closeModal = noop;
    ctx.rAdmin = noop;
    // Record the directory's size AT THE MOMENT the gateway is called. Watching
    // save() instead is not enough: moving the ST.people.push earlier keeps
    // save() last and the ordering would still look right.
    ctx.omsAccountAction = async (a, p) => {
      calls.push([a, p]); order.push('account');
      seenDir.push((T.st.people || []).length);
      return { ok: true };
    };

    T.st.people = [];
    fill('Jane Westgate', 'Jane.Westgate@advocatehealth.org', 'Westgate-OMS-2026!', true);
    await saveUser('');
    ok('a sign-in is requested when the box is ticked', calls.length === 1 && calls[0][0] === 'create');
    ok('the sign-in id is the email address, lowercased',
       calls.length === 1 && calls[0][1].id === 'jane.westgate@advocatehealth.org');
    ok('the access level chosen on the form is the one issued',
       calls.length === 1 && calls[0][1].role === 'editor');
    ok('the password on the form is the one issued',
       calls.length === 1 && calls[0][1].password === 'Westgate-OMS-2026!');
    ok('the account is created BEFORE the directory entry is written',
       order[0] === 'account' && order[1] === 'directory' && seenDir[0] === 0);
    ok('the person reaches the directory', (T.st.people || []).some(p => p.name === 'Jane Westgate'));
    ok('and the credential is handed over exactly once, in clear',
       ALERTS.filter(a => a.indexOf('Westgate-OMS-2026!') > -1).length === 1);

    // The failure that matters: the gateway refuses, so NOTHING is added.
    ctx.omsAccountAction = async () => { throw new Error('id already in use'); };
    T.st.people = [];
    fill('Terri Yates', 'Terri.Yates@advocatehealth.org', 'Yates-OMS-2026!', true);
    await saveUser('');
    ok('when the sign-in cannot be issued, no directory entry is left behind',
       (T.st.people || []).length === 0 && order.indexOf('directory') === -1);
    ok('and the administrator is told nothing was added',
       ALERTS.some(a => /Nothing was added/i.test(a)));

    // A short password never reaches the gateway.
    ctx.omsAccountAction = async (a, p) => {
      calls.push([a, p]); order.push('account'); seenDir.push((T.st.people || []).length); return { ok: true };
    };
    T.st.people = [];
    fill('Terry Hales', 'Terry.Hales@advocatehealth.org', 'short', true);
    await saveUser('');
    ok('a password under 12 characters is refused before the gateway is called',
       calls.length === 0 && (T.st.people || []).length === 0);
    ok('and the reason names the length', ALERTS.some(a => /12 characters/.test(a)));

    // Directory-only: some people need to be assignable and nothing more.
    T.st.people = [];
    fill('Erich Huang', 'Erich.Huang@advocatehealth.org', '', false);
    await saveUser('');
    ok('unticking the box adds the person without issuing a sign-in',
       calls.length === 0 && (T.st.people || []).some(p => p.name === 'Erich Huang'));
    ok('and no credential is read out for an account that was not created',
       !ALERTS.some(a => /Password:/.test(a)));

    // Editing an existing person must not mint a second account.
    T.st.people = [{ id: 'jane-westgate', name: 'Jane Westgate',
                     email: 'jane.westgate@advocatehealth.org', role: 'PM', accessRole: 'editor' }];
    fill('Jane Westgate', 'Jane.Westgate@advocatehealth.org', 'Westgate-OMS-2026!', true);
    await saveUser('jane-westgate');
    ok('editing an existing person issues no new account', calls.length === 0);
    ok('and the edit still lands', (T.st.people[0] || {}).role === 'Program Manager');

    ctx.omsAccountAction = realAction; ctx.save = realSave;
    ctx.closeModal = realClose; ctx.rAdmin = realR;
    Object.keys(FIELDS).forEach(k => delete FIELDS[k]); ALERTS.length = 0;
  }
}
ok('omsSuggestedPassword is defined', typeof suggest === 'function');
if (typeof suggest === 'function') {
  // Must agree with lastNameOf in the gateway's make-users.mjs. If these two
  // drift, the same person gets a different password depending on which route
  // issued it - which is the failure this release exists to prevent.
  const cases = [
    ["Clare Il'Giovine",   'Ilgiovine-OMS-2026!'],
    ["Anne-Marie O'Brien", 'Obrien-OMS-2026!'],
    ['Hossam Elsaie',      'Elsaie-OMS-2026!'],
    ['Maggie Scirica',     'Scirica-OMS-2026!'],
    ['Jane Westgate',      'Westgate-OMS-2026!'],
    ['Ari Ball',           'Ball-OMS-2026!'],
  ];
  for (const [name, expected] of cases)
    ok(`${name} yields ${expected}`, suggest(name) === expected, suggest(name));
  ok('no apostrophe survives into a password', !/'/.test(suggest("Clare Il'Giovine")));
  ok('a single name still works', suggest('Cher') === 'Cher-OMS-2026!');
  ok('an empty name degrades rather than throwing', suggest('') === 'User-OMS-2026!');
  ok('every suggestion clears the twelve-character minimum',
     cases.every(([n]) => suggest(n).length >= 12));
}

// ------------------------------------------- Rev 36: the reconciler, ACTUALLY RUN
// Every assertion this suite made about the Rev 35 reconciler was a regex over
// source text, and the reconciler was inert for the whole of Rev 35 regardless.
// It could not have been otherwise: the sandbox above stubs `setTimeout` to a
// no-op, so no timer-driven code in the artifact had ever been executed by any
// test. One of those assertions actively certified the defect.
//
// This block loads the artifact a SECOND time into its own context with a
// drivable clock and a scriptable gateway, and runs the thing.
console.log('\n# The reconciler, executed (Rev 36)');
{
  const build = () => {
    let now = 0, seq = 0;
    const timers = new Map();
    const calls = { state: 0, operation: 0 };
    const flush = async () => { for (let k = 0; k < 50; k++) await Promise.resolve(); };
    // Microtasks first: OMS_QUEUE_SYNC chains off a resolved promise, so on the
    // first call no timer exists yet and a scan-first loop would return at once.
    const advance = async (ms) => {
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
    };
    let canonical = { schemaVersion: 2, revision: 75, tasks: [{ id: 't1', title: 'Original', _version: 1 }] };
    const sb = {
      console: { log: noop, error: noop, warn: noop }, JSON, Math, Date, Object, Array,
      String, Number, Boolean, RegExp, Error, Map, Set, Promise, isNaN, parseInt, parseFloat,
      encodeURIComponent, decodeURIComponent, TextEncoder, TextDecoder, URL, URLSearchParams,
      setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
      clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval: noop,
      requestAnimationFrame: noop, alert: noop, confirm: () => true, prompt: () => null,
      localStorage: store(), sessionStorage: store(),
      location: { href: 'https://x.invalid/oms.html', replace: noop, search: '' },
      navigator: { userAgent: 'smoke' }, crypto: { subtle: {}, getRandomValues: a => a },
      fetch: async (url) => {
        if (String(url).endsWith('/api/state')) {
          calls.state++;
          return { ok: true, status: 200, headers: { get: () => null },
                   text: async () => JSON.stringify({ state: canonical, revision: canonical.revision, schemaVersion: 2 }) };
        }
        calls.operation++;
        return { ok: true, status: 202, text: async () => '{"accepted":true,"operationId":"x"}' };
      },
    };
    const F = {}, EL = {};
    const mk = id => ({ _id: id, textContent: '', innerHTML: '', className: '', style: {},
      get value() { return F[id] !== undefined ? F[id] : ''; }, set value(v) { F[id] = v; },
      get checked() { return !!F['@' + id]; }, set checked(v) { F['@' + id] = !!v; },
      dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      appendChild: noop, setAttribute: noop, getAttribute: () => null, addEventListener: noop,
      querySelector: () => null, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }), focus: noop, click: noop });
    sb.addEventListener = noop; sb.removeEventListener = noop; sb.dispatchEvent = () => true;
    sb.matchMedia = () => ({ matches: false, addEventListener: noop, addListener: noop });
    sb.window = sb; sb.globalThis = sb; sb.self = sb;
    sb.document = { getElementById: id => (EL[id] || (EL[id] = mk(id))), querySelector: () => null,
      querySelectorAll: () => [], createElement: () => mk('_t'), addEventListener: noop,
      body: mk('_b'), documentElement: mk('_h'), head: mk('_hd'), title: '', readyState: 'complete', cookie: '' };
    const c = vm.createContext(sb);
    new vm.Script(main + `\n;globalThis.__R={run(s){return eval(s)}};`, { filename: 'oms-clock.js' }).runInContext(c, { timeout: 15000 });
    const run = s => c.__R.run(s);
    run(`OMS_TOKEN=()=>'t';renderAll=()=>{};renderNotificationBadge=()=>{};OMS_LOCAL_SAVE=()=>{};
         OMS_TOAST=m=>{globalThis.__t=(globalThis.__t||[]);globalThis.__t.push(m)};
         OMS_SET_STATE=(s)=>{globalThis.__b=s};
         ST={schemaVersion:2,revision:75,tasks:[{id:'t1',title:'Original',_version:1}]};
         OMS_BASE=JSON.parse(JSON.stringify(ST));OMS_REVISION=75;_dirty.clear();`);
    return { run, advance, calls, setCanonical: v => { canonical = v; }, timers };
  };

  // ---- the real incident: post succeeds, the fold is slow, the wait gives up
  const h = build();
  h.run(`ST.tasks[0].title='Edited by me';_dirty.add('tasks');`);
  const p = h.run(`OMS_QUEUE_SYNC()`);
  await h.advance(40000);                       // burn the whole 24 s budget
  try { await p; } catch (_) {}

  ok('a stalled fold lands in Unsynced', h.run(`globalThis.__b`) === 'Unsynced', h.run(`globalThis.__b`));
  ok('the accepted batch is recorded, so the banner can tell the two cases apart',
     h.run(`typeof OMS_INFLIGHT!=='undefined'&&!!OMS_INFLIGHT`), 'OMS_INFLIGHT is null after a successful post');
  ok('_dirty is still non-empty here — this is why the old guard never fired',
     h.run(`_dirty.size`) > 0, 'if this is 0 the regression test below proves nothing');

  const before = h.calls.state;
  h.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Edited by me', _version: 2 }] });
  await h.advance(30000);                       // ten reconciler ticks

  ok('THE PROMISE: the reconciler polls canonical on its own', h.calls.state - before > 0,
     (h.calls.state - before) + ' calls to /api/state in 30 s');
  ok('THE PROMISE: it clears the banner without a reload', h.run(`globalThis.__b`) === 'Connected',
     h.run(`globalThis.__b`));
  ok('THE PROMISE: it adopts the confirmed revision', h.run(`OMS_REVISION`) === 76,
     'OMS_REVISION=' + h.run(`OMS_REVISION`));
  ok('and says so', (h.run(`globalThis.__t`) || []).includes('Save confirmed'));

  // ---- the rule it must not break: never adopt over something newly typed
  const h2 = build();
  h2.run(`ST.tasks[0].title='Edited by me';_dirty.add('tasks');`);
  const p2 = h2.run(`OMS_QUEUE_SYNC()`);
  await h2.advance(40000);
  try { await p2; } catch (_) {}
  h2.run(`ST.tasks[0].title='Typed while waiting';save();`);   // a NEW edit after the post
  const before2 = h2.calls.state;
  h2.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Edited by me', _version: 2 }] });
  await h2.advance(30000);
  ok('it does NOT adopt canonical over an edit typed since the post',
     h2.run(`ST.tasks[0].title`) === 'Typed while waiting',
     'adoption replaces ST wholesale and would have destroyed it');
  ok('OMS_RECONCILE_SAFE reports unsafe while that edit is outstanding',
     h2.run(`typeof OMS_RECONCILE_SAFE==='function'?OMS_RECONCILE_SAFE():null`) === false);

  // ---- Rev 36 / F2: a revision bump is not a confirmation
  // consolidate.py increments the revision once per batch "including
  // conflicts/invalid operations", so the old test (revision > start) called a
  // rejected operation, and somebody else's unrelated save, a success.
  {
    const landed = G('OMS_OPS_LANDED');
    ok('OMS_OPS_LANDED is defined', typeof landed === 'function');
    // Guarded so this block reports cleanly against an artifact that predates
    // the predicate, instead of aborting the run. The negative control has to
    // produce FAIL lines, not a stack trace.
    if (typeof landed === 'function') {
    const op = { entityType: 'tasks', entityId: 't1', action: 'update', baseVersion: 1,
                 changes: { title: 'Mine' } };
    const st = rows => ({ tasks: rows });
    ok('an update is applied when canonical holds the values it asked for',
       landed(st([{ id: 't1', title: 'Mine', _version: 2 }]), [op]) === 'applied');
    ok('...pending while canonical still holds the old value at the old version',
       landed(st([{ id: 't1', title: 'Original', _version: 1 }]), [op]) === 'pending');
    ok('...rejected when the record moved on without it',
       landed(st([{ id: 't1', title: 'Somebody else', _version: 2 }]), [op]) === 'rejected');
    const cr = { entityType: 'tasks', entityId: 't9', action: 'create', baseVersion: 0, changes: {} };
    ok('a create is pending until the row exists', landed(st([]), [cr]) === 'pending');
    ok('a create is applied once it does', landed(st([{ id: 't9', _version: 1 }]), [cr]) === 'applied');
    const del = { entityType: 'tasks', entityId: 't1', action: 'delete', baseVersion: 1 };
    ok('a delete is applied when the row is gone', landed(st([]), [del]) === 'applied');
    ok('a delete is rejected when the row was edited instead',
       landed(st([{ id: 't1', _version: 2 }]), [del]) === 'rejected');
    ok('one rejected operation rejects the batch',
       landed(st([{ id: 't1', title: 'Somebody else', _version: 2 }]), [cr, op]) === 'rejected');
    }
  }

  // ---- S2, executed: somebody else's save must not confirm mine
  const h4 = build();
  h4.run(`ST.tasks[0].title='My important edit';_dirty.add('tasks');`);
  const p4 = h4.run(`OMS_QUEUE_SYNC()`);
  await h4.advance(200);
  // A DIFFERENT user's save is folded in. Ours is still queued.
  h4.setCanonical({ schemaVersion: 2, revision: 76,
    tasks: [{ id: 't1', title: 'Original', _version: 1 }, { id: 't2', title: 'Someone else', _version: 1 }] });
  await h4.advance(40000);
  try { await p4; } catch (_) {}
  ok("another user's save is not mistaken for confirmation of mine",
     h4.run(`globalThis.__b`) !== 'Connected', 'banner=' + h4.run(`globalThis.__b`));
  ok('and my edit is still on screen rather than reverted',
     h4.run(`ST.tasks[0].title`) === 'My important edit', h4.run(`ST.tasks[0].title`));
  ok('no success toast for a save that has not landed',
     !(h4.run(`globalThis.__t`) || []).includes('Save successful'),
     JSON.stringify(h4.run(`globalThis.__t`)));
  // ...and when it finally lands, the reconciler confirms it for real.
  const before4 = h4.calls.state;
  h4.setCanonical({ schemaVersion: 2, revision: 77,
    tasks: [{ id: 't1', title: 'My important edit', _version: 2 }, { id: 't2', title: 'Someone else', _version: 1 }] });
  await h4.advance(15000);
  ok('once it really lands, the reconciler confirms it', h4.run(`globalThis.__b`) === 'Connected',
     'banner=' + h4.run(`globalThis.__b`) + ' after ' + (h4.calls.state - before4) + ' polls');

  // ---- Rev 37 / F2b: a second save must not re-send the outstanding batch
  // The live evidence: tasks/mql45rre6kn went to the gateway three times in
  // forty-one seconds on 5 Sept, identical changes and baseValues each time,
  // three operation ids. First applied, other two filed as conflicts. That
  // pattern is 51 of the 53 records in conflicts/unresolved.
  {
    const k = G('OMS_OP_KEY');
    ok('OMS_OP_KEY is defined', typeof k === 'function');
    if (typeof k === 'function') {
      const a = { entityType: 'tasks', entityId: 't1', action: 'update', baseVersion: 0, changes: { status: 'Complete' } };
      const b = { entityType: 'tasks', entityId: 't1', action: 'update', baseVersion: 0, changes: { status: 'Complete' } };
      const c = { entityType: 'tasks', entityId: 't1', action: 'update', baseVersion: 0, changes: { status: 'In Progress' } };
      ok('the same payload keys the same', k(a) === k(b));
      ok('a different value is a different operation', k(a) !== k(c),
         'two edits to one record with different values are two intentions');
    }
  }

  const h5 = build();
  h5.run(`ST.tasks[0].title='First edit';_dirty.add('tasks');`);
  const p5 = h5.run(`OMS_QUEUE_SYNC()`);
  await h5.advance(40000);                      // the fold stalls; batch outstanding
  try { await p5; } catch (_) {}
  const postsAfterFirst = h5.calls.operation;
  ok('the first save posted its operation', postsAfterFirst === 1, postsAfterFirst + ' posts');

  // The user edits something ELSE while the first is still unconfirmed.
  h5.run(`ST.tasks.push({id:'t2',title:'Second edit',_version:0});save();`);
  const p5b = h5.run(`OMS_QUEUE_SYNC()`);
  await h5.advance(40000);
  try { await p5b; } catch (_) {}

  ok('the second save posts only the NEW operation, not the outstanding one',
     h5.calls.operation === 2, h5.calls.operation + ' posts total — 3 means the batch was re-sent');
  ok('both operations are tracked as outstanding, so neither is forgotten',
     h5.run(`OMS_INFLIGHT?OMS_INFLIGHT.ops.length:0`) === 2,
     'outstanding=' + h5.run(`OMS_INFLIGHT?OMS_INFLIGHT.ops.length:0`));

  // Confirmation must wait for BOTH, not just the newest.
  h5.setCanonical({ schemaVersion: 2, revision: 76,
    tasks: [{ id: 't1', title: 'First edit', _version: 2 }] });   // t2 not folded yet
  await h5.advance(15000);
  ok('a partial fold is not a confirmation', h5.run(`globalThis.__b`) !== 'Connected',
     'banner=' + h5.run(`globalThis.__b`));
  h5.setCanonical({ schemaVersion: 2, revision: 77,
    tasks: [{ id: 't1', title: 'First edit', _version: 2 }, { id: 't2', title: 'Second edit', _version: 1 }] });
  await h5.advance(15000);
  ok('...and the full fold is', h5.run(`globalThis.__b`) === 'Connected',
     'banner=' + h5.run(`globalThis.__b`));

  // ---- operations that never reached the gateway must not promise self-healing
  const h3 = build();
  h3.run(`OMS_POST=async()=>{throw new Error('offline')};`);
  h3.run(`ST.tasks[0].title='Never sent';_dirty.add('tasks');`);
  const p3 = h3.run(`OMS_QUEUE_SYNC()`);
  await h3.advance(5000);
  try { await p3; } catch (_) {}
  ok('a batch that never reached the gateway leaves OMS_INFLIGHT null',
     h3.run(`typeof OMS_INFLIGHT==='undefined'?'absent':OMS_INFLIGHT`) === null);
  ok('...and no reconciler is started for it', h3.timers.size === 0,
     h3.timers.size + ' timers pending');
}

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
