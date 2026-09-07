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
// Rev 54 (C-02). A DST off-by-one cannot be measured under whatever timezone
// the machine running the suite happens to be set to, and process.env.TZ has
// no effect once the first Date has been constructed. A child process does.
import { execFileSync } from 'node:child_process';

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
// Rev 65 added taskTemplates, a collection the consolidator and the operation
// schema had carried since the data side was built; sixteen is the new count.
// Rev 70 added categories, the shared category vocabulary. Seventeen now.
ok('saved views add no synced collection',
   COLLECTIONS.length === 17 && !COLLECTIONS.some(c => /^(saved)?views$/i.test(c)),
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
// Rev 70 added the shared-record rename and its explanation between the loops
// and the save, so the window widened. The assertion's point is unchanged: the
// rename must go through save(), not write state directly.
ok('a rename saves through the normal path, not a direct state write',
   /function renameCategory[\s\S]{0,1600}?save\(\)/.test(main),
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
// Rev 54 (C-09). aria-labelledby is an ARIA attribute name, not OMS prose,
// and it has one legal spelling. Exempt that exact literal and nothing else.
const ARIA_EXEMPT = 'aria-labelledby';
const spellScan = html.split(ARIA_EXEMPT).join('aria-dialogLabelRef');
const found = EN_GB.filter(w => new RegExp(w, 'i').test(spellScan));
ok('the spelling exemption covers the ARIA attribute and nothing else',
   html.split(ARIA_EXEMPT).length - 1 === (html.match(/labelled/gi) || []).length,
   'every occurrence of "labelled" in the artifact must be that attribute');
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
ok('every nav button names its own tab, and the name is tasks',
   /data-tab="tasks"/.test(html) && !/data-tab="del"/.test(html),
   'Rev 54 (C-16) removed the positional order array; the same rename invariant is now on the button itself');
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
  const guard = seg.search(/is required/), push = seg.indexOf("omsIntakeUpsert('incoming'");
  return guard > -1 && push > -1 && guard < push;
})(), 'validating after the push would leave a blank row behind');
ok('the other intake forms enforce their required field too', (() => {
  const b = main.indexOf("} else if(t==='fr')");
  if (b < 0) return false;
  const seg = main.slice(b, b + 1200);
  const guard = seg.search(/is required/), push = seg.indexOf("omsIntakeUpsert('forReview'");
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
  // Rev 63: the filter moved into omsCalItems, which rCal and the export both read.
  const rcal = String(G('omsCalItems') || '');
  ok('OMS-041: the calendar filters on recurring, not on a new field',
     /calCadence==='standing'/.test(rcal) && /e\.recurring/.test(rcal));
  ok('OMS-041: standing and one-off partition the events', /calCadence==='oneoff'/.test(rcal));

  // Rev 47 (OMS-041). Two sentences promised an Outlook calendar sync that has
  // never existed - one on the Event form, one in the User Guide - and that is
  // why 248 of 255 events carry no cadence at all: the interface told people
  // not to bother ticking the box. The revision log records the removal, so
  // search the prose OUTSIDE it, the same cut check 12 makes.
  {
    const cut = html.indexOf('const OMS_REV_LOG');
    const end = cut > -1 ? html.indexOf('];', cut) : -1;
    const prose = (cut > -1 && end > -1) ? html.slice(0, cut) + html.slice(end) : html;
    ok('OMS-041: nothing claims an Outlook sync populates cadence',
       !/sync populates this field/.test(prose));
    ok('OMS-041: nothing claims cadence is filled in automatically',
       !/fills this in automatically/.test(prose));
    ok('OMS-041: the form says plainly that cadence is set by hand',
       /Nothing fills this in for you/.test(prose));
    ok('OMS-041: and says cadence is carried forward through a re-import',
       /carried forward/.test(prose));
  }

  // Rev 48 (OMS-041). Cadence had no route onto the 248 events lacking it. The
  // workbooks carry no cadence column, and a source replacement rebuilt every
  // row from the workbook, so a hand-ticked box was erased by the next import.
  const derive = G('omsDeriveCadence');
  const cadFor = G('omsCadenceFor');
  ok('omsDeriveCadence is defined', typeof derive === 'function');
  ok('omsCadenceFor is defined', typeof cadFor === 'function');
  if (typeof derive === 'function') {
    ok('a Weekly Series title reads as standing', derive('Academic Cabinet Meeting | Weekly Series'));
    ok('a Quarterly title reads as standing', derive('Steering Committee | Quarterly Meeting'));
    ok('a MONTHLY title reads as standing, whatever the case',
       derive("DEAN'S LEADERSHIP MEETINGS (MONTHLY): Research Plan"));
    ok('bi-weekly is caught with and without the hyphen',
       derive('Ops sync bi-weekly') && derive('Ops sync biweekly'));
    // The false positives that made title-derivation worth constraining: every
    // one of these is a real row in the live Ari workbook.
    ok('OMS-041: an ANNUAL event is not standing - a gala is a one-off',
       !derive('Annual Match Day celebration') && !derive('Emeriti Faculty Holiday Brunch'));
    ok('OMS-041: a named lecture series is not standing',
       !derive('President’s Leadership Series – Wake Forest University'));
    ok('a word merely containing a cadence word does not match',
       !derive('Biweeklyish') && !derive('Semimonthlyish'));
    ok('an empty or missing title is not standing', !derive('') && !derive(null));
  }
  if (typeof cadFor === 'function') {
    const savedST = T.st;
    T.setST({ ...(savedST || {}), events: [
      { id: 'e1', source: 'Ari', title: 'Chairs Meeting', date: '2026-10-01', recurring: true },
      { id: 'e2', source: 'Ari', title: 'One Off Thing', date: '2026-10-02', recurring: false },
    ] });
    const carried = cadFor({ title: 'Chairs Meeting', date: '2026-10-01' }, 'Ari');
    ok('OMS-041: cadence already in OMS is carried forward through a re-import',
       carried.on === true && /already in OMS/.test(carried.why));
    ok('and a row previously marked NOT standing stays that way',
       cadFor({ title: 'One Off Thing', date: '2026-10-02' }, 'Ari').on === false);
    const derived = cadFor({ title: 'Cabinet | Weekly Series', date: '2026-10-03' }, 'Ari');
    ok('an unseen row falls through to the title', derived.on === true && /from the title/.test(derived.why));
    ok('a plain unseen row is not standing',
       cadFor({ title: 'DEAC Gala', date: '2026-10-04' }, 'Ari').on === false);
    // What the importer sets on the row beats both, in either direction.
    ok('OMS-041: an explicit choice in the preview overrides the carry-forward',
       cadFor({ title: 'Chairs Meeting', date: '2026-10-01', _cadence: false }, 'Ari').on === false);
    ok('...and overrides the title',
       cadFor({ title: 'DEAC Gala', date: '2026-10-04', _cadence: true }, 'Ari').on === true);
    ok('carry-forward is scoped to the same source',
       cadFor({ title: 'Chairs Meeting', date: '2026-10-01' }, 'Maggie').on === false);
    T.setST(savedST);
  }
  const prev = String(G('showImportPreview') || '');
  // Rev 53 (R-13) unified three words onto Standing. Rev 68 moved the whole
  // vocabulary to Recurring on Hossam's instruction - one word still, and now
  // the same word as the stored field, which has always been `recurring`.
  ok('OMS-041: the import preview shows a Recurring column', /<th>Recurring<\/th>/.test(prev));
  ok('OMS-041: and computes it through omsCadenceFor', /omsCadenceFor\(/.test(prev));
  ok('OMS-041: every row can be marked or unmarked in the preview',
     /toggleImportCadence\(/.test(prev) && typeof G('toggleImportCadence') === 'function');
  // Rev 53 (R-06). Cadence is still written onto the replacement event, but a
  // value the title rule merely worked out is no longer stored as a decision:
  // `false` is written only when a person settled it.
  ok('OMS-041: the import writes cadence onto the replacement events',
     /ev\.recurring=cad\.on/.test(String(G('confirmImport') || '')));

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

  // Rev 46 (OMS-047). "Defined" was the ONLY thing asserted about sopsDueSoon,
  // and an orphan satisfies it: the function shipped in Rev 34 and was called
  // from nowhere for twelve revisions while the guide described the feature.
  // Assert the call chain, not the existence.
  const card = G('sopReviewCard');
  ok('sopReviewCard is defined', typeof card === 'function');
  ok('OMS-047: the dashboard is what renders the SOP review card',
     /sopReviewCard\(\)/.test(String(G('rDash') || '')));
  ok('OMS-047: the card is what calls sopsDueSoon',
     /sopsDueSoon\(/.test(String(card || '')));
  if (typeof soon === 'function' && typeof card === 'function') {
    const savedST = T.st;
    const three = [
      { id: 's1', process: 'Overdue one', owner: 'Maggie', reviewDue: '2020-01-01', notes: '' },
      { id: 's2', process: 'Far future', owner: 'Ari', reviewDue: '2099-01-01', notes: '' },
      { id: 's3', process: 'No date', owner: 'Hossam', reviewDue: '', notes: 'renewal paperwork' },
    ];
    ok('the harness can substitute ST', T.setST({ ...(savedST || {}), sops: three }) === true);
    const picked = soon(30).map(s => s.id);
    ok('sopsDueSoon returns a review date already past', picked.indexOf('s1') !== -1);
    ok('sopsDueSoon excludes a date beyond the window', picked.indexOf('s2') === -1);
    ok('sopsDueSoon excludes a record carrying no review date', picked.indexOf('s3') === -1);
    const withDue = card();
    ok('the card names the lapsed procedure and flags it',
       /Overdue one/.test(withDue) && /Overdue/.test(withDue));
    T.setST({ ...(savedST || {}), sops: [three[2]] });
    const empty = card();
    ok('OMS-047: with no review date anywhere the card says so rather than vanishing',
       /No SOP has a review date yet/.test(empty) && /class="card"/.test(empty));
    T.setST({ ...(savedST || {}), sops: [three[1]] });
    ok('with every date beyond the window the card says that instead',
       /more than 30 days away/.test(card()));
    T.setST(savedST);
  }

  // Rev 49 (OMS-049, OMS-028). Retirement on events and SOPs, reusing the
  // task predicate rather than growing a second vocabulary for one idea.
  {
    const retired = G('isRetired');
    const field = G('omsStatusField');
    ok('isRetired reads a generic record, not just a task',
       typeof retired === 'function' && retired({ status: 'Retired' }) === true &&
       retired({ status: 'Current' }) === false && retired({}) === false && retired(null) === false);
    ok('omsStatusField is defined', typeof field === 'function');
    if (typeof field === 'function') {
      const cur = field('f_x', ''), ret = field('f_x', 'Retired');
      ok('a record with no status defaults to Current, not Retired',
         /Current<\/option>/.test(cur) && !/selected[^>]*>Retired/.test(cur));
      ok('an already-retired record opens on Retired', /selected>Retired/.test(ret));
      ok('the control says what Retired does and what Delete does',
         /drops it out of/.test(cur) && /Delete removes it permanently/.test(cur));
    }
    // OMS-049: the point of retiring is leaving the numbers people decide from.
    ok('OMS-049: retired events leave the dashboard 30-day count',
       /!isRetired\(e\)/.test(String(G('rDash') || '')));
    ok('OMS-049: and leave the Weekly Brief',
       /!isRetired\(e\)/.test(String(G('rBrief') || '')));
    ok('OMS-049: the event form carries the Status control',
       /f_ev_status/.test(String(G('openEvModal') || '')));
    ok('OMS-049: and the save path writes it, defaulting to Current',
       /status:gv\('f_ev_status'\)\|\|'Current'/.test(String(G('saveModal') || '')));
    // The marker lives in the two builders, not in rCal itself - grid and list
    // are separate render paths and Rev 34 already shipped a control on one
    // surface out of two, so assert BOTH rather than the caller.
    ok('OMS-049: a retired event is marked, not hidden, in the month grid',
       /bret">Retired/.test(String(G('buildCalGrid') || '')));
    ok('OMS-049: and in the list view',
       /bret">Retired/.test(String(G('buildCalList') || '')));

    // OMS-028 / DEC-022: one shared category list, not an SOP taxonomy.
    const sopModal = String(G('openSopModal') || '');
    ok('OMS-028: the SOP form offers a category', /f_sop_cat/.test(sopModal));
    ok('OMS-028: drawn from the SHARED list, not a private one',
       /eventCategories\(\)/.test(sopModal));
    ok('OMS-028: and a status', /f_sop_status/.test(sopModal));
    const cats = G('eventCategories');
    ok('OMS-028: the shared list is derived from SOPs too, so an SOP-only category survives',
       /ST\.sops/.test(String(cats || '')));
    if (typeof cats === 'function') {
      const savedST = T.st;
      T.setST({ ...(savedST || {}), events: [], tasks: [],
                sops: [{ id: 's1', process: 'P', category: 'Only On An SOP' }] });
      ok('...proven: a category used by nothing but an SOP is still offered',
         cats().indexOf('Only On An SOP') !== -1);
      T.setST(savedST);
    }
    const rsops = String(G('rSOPs') || '');
    ok('OMS-028: the SOPs table shows the category', /<th>Category<\/th>/.test(rsops));
    ok('OMS-028: and can be filtered by it', /sopCat/.test(rsops));
    ok('OMS-028: a retired SOP is marked rather than hidden',
       /isRetired\(s\)\?' <span class="b bret">Retired<\/span>'/.test(rsops));
    const hay2 = G('sopHaystack');
    if (typeof hay2 === 'function') {
      ok('OMS-028: search reaches the category as well',
         hay2({ process: 'P', category: 'Chairs' }).indexOf('chairs') !== -1);
    }
  }

  // OMS-028: the search must read what the table puts on screen.
  const hay = G('sopHaystack');
  ok('sopHaystack is defined', typeof hay === 'function');
  if (typeof hay === 'function') {
    const s = { process: 'Annual Report', owner: 'Hossam', notes: 'signed off by Rachel' };
    ok('OMS-028: the haystack carries the notes, which the table renders',
       hay(s).indexOf('rachel') !== -1);
    ok('the haystack still carries process and owner',
       hay(s).indexOf('annual report') !== -1 && hay(s).indexOf('hossam') !== -1);
    ok('a match cannot span the seam between two fields',
       hay({ process: 'Annual', owner: 'Report' }).indexOf('annualreport') === -1);
    ok('a missing field does not become the literal word undefined',
       hay({ process: 'Annual Report' }).indexOf('undefined') === -1);
    ok('OMS-028: the SOPs table filters through sopHaystack',
       /sopHaystack\(/.test(String(G('omsSopRows') || '')) && /omsSopRows\(/.test(String(G('rSOPs') || '')));
  }

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
  // Rev 39 moved the scheduling into OMS_RECONCILE_SCHEDULE so the backoff has
  // one home, which broke the previous /setTimeout\(tick/ match on this
  // function's source. That is the third source-text assertion in this suite to
  // fail for a rename rather than a regression. The property is proved by
  // execution further down — a timer is still pending after a simulated hour —
  // and this is now only a cheap structural check that the step exists.
  ok('it reschedules itself rather than running once',
     /OMS_RECONCILE_SCHEDULE\(tick\)/.test(rec) && typeof G('OMS_RECONCILE_SCHEDULE') === 'function',
     'see "but it has NOT given up" below for the assertion that actually runs it');
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
  // Rev 68. Hossam removed the filter: out-of-office entries are ordinary
  // events now. Nothing may filter them out, and no chip may offer to.
  const rcal = String(G('omsCalItems') || '');
  ok('Rev 68: nothing filters out-of-office entries off the calendar any more',
     !/calShowOoo/.test(rcal) && !/String\(e\.category\|\|''\)!=='EB OOO'/.test(main));
  ok('Rev 68: ...while the Dashboard 30-day counter still excludes them, which is a different question',
     /e\.category!=='EB OOO'/.test(String(G('rDash') || '')));
  ok('Rev 68: and the Out of office chip is gone from the toolbar',
     !/>Out of office<\/div>/.test(html) && !/calShowOoo/.test(main));
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
    ok('the password fills in from the name', /^Ilgiovine-\d{6}-OMS!$/.test(FIELDS['au_pw'] || ''), FIELDS['au_pw']);
    ok('and it carries no punctuation that cannot be dictated',
       /^[A-Za-z]+-\d{6}-OMS!$/.test(FIELDS['au_pw'] || ''));
    const randPart = (FIELDS['au_pw'] || '').split('-')[1];
    FIELDS['au_name'] = 'Jane Westgate';
    syncPw();
    ok('it keeps following the name while untouched', FIELDS['au_pw'] === 'Westgate-' + randPart + '-OMS!', FIELDS['au_pw']);
    ok('Rev 51: the random part is kept for the life of the dialog, so what the admin reads out is what was set', (FIELDS['au_pw'] || '').split('-')[1] === randPart);
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


    // ---- Rev 52: the Admin Console's controls reach the account they describe.
    {
      const dea = G('adminDeactivate'), act = G('adminActivate'), del = G('adminHardDelete');
      ok('Rev 52: deactivate, reactivate and delete are async - they await the gateway', [dea, act, del].every(f => typeof f === 'function' && f.constructor.name === 'AsyncFunction'));
      ctx.omsAccountAction = async (a, p) => { calls.push([a, p]); return { ok: true }; };
      // Edit: a changed access level goes to the gateway first.
      T.fn(`OMS_ACCOUNTS=[{id:'jane.westgate@advocatehealth.org',role:'editor',disabled:false},{id:'boss@x.org',role:'admin',disabled:false}]`);
      T.st.people = [{ id: 'jane-westgate', name: 'Jane Westgate', email: 'jane.westgate@advocatehealth.org', role: 'PM', accessRole: 'editor', active: true },
                     { id: 'boss', name: 'The Boss', email: 'boss@x.org', role: 'Dean', accessRole: 'admin', active: true }];
      fill('Jane Westgate', 'jane.westgate@advocatehealth.org', '', false); FIELDS['au_access'] = 'viewer'; calls.length = 0;
      await saveUser('jane-westgate');
      ok('Rev 52: changing the access level calls the gateway role action', calls.length === 1 && calls[0][0] === 'role' && calls[0][1].role === 'viewer' && calls[0][1].id === 'jane.westgate@advocatehealth.org', JSON.stringify(calls));
      ok('Rev 52: ...and the directory follows', T.st.people[0].accessRole === 'viewer');
      T.fn(`OMS_ACCOUNTS[0].role='viewer'`); // the stub did not refresh the account list; the real call does
      calls.length = 0; FIELDS['au_access'] = 'viewer';
      await saveUser('jane-westgate');
      ok('Rev 52: an unchanged level makes no gateway call', calls.length === 0);
      ctx.omsAccountAction = async () => { throw new Error('That is the last active administrator.'); };
      fill('The Boss', 'boss@x.org', '', false); FIELDS['au_access'] = 'viewer'; ALERTS.length = 0;
      await saveUser('boss');
      ok('Rev 52: a refused role change leaves the directory alone and says so', T.st.people[1].accessRole === 'admin' && ALERTS.some(a => /NOT changed/.test(a)), JSON.stringify(ALERTS));
      // Deactivate blocks the account first; a refusal leaves the flag alone.
      ctx.omsAccountAction = async (a, p) => { calls.push([a, p]); return { ok: true }; }; calls.length = 0;
      await dea('jane-westgate');
      ok('Rev 52: deactivate blocks the sign-in account', calls.length === 1 && calls[0][0] === 'disable', JSON.stringify(calls));
      ok('Rev 52: ...and then marks the directory row', T.st.people[0].active === false);
      T.fn(`OMS_ACCOUNTS[0].disabled=true`); calls.length = 0;
      await act('jane-westgate');
      ok('Rev 52: reactivate restores the sign-in account', calls.length === 1 && calls[0][0] === 'enable' && T.st.people[0].active === true, JSON.stringify(calls));
      T.fn(`OMS_ACCOUNTS[0].disabled=false`);
      ctx.omsAccountAction = async () => { throw new Error('You cannot disable your own account.'); }; ALERTS.length = 0;
      await dea('jane-westgate');
      ok('Rev 52: a refused block leaves the person active', T.st.people[0].active === true && ALERTS.some(a => /Not deactivated/.test(a)));
      // Delete removes the account first and stops if it cannot.
      ctx.omsAccountAction = async (a, p) => { calls.push([a, p]); return { ok: true }; }; calls.length = 0;
      await del('jane-westgate');
      ok('Rev 52: delete removes the sign-in account', calls.length === 1 && calls[0][0] === 'delete' && calls[0][1].id === 'jane.westgate@advocatehealth.org', JSON.stringify(calls));
      ok('Rev 52: ...and then the directory row', !T.st.people.some(p => p.id === 'jane-westgate'));
      T.st.people.push({ id: 'jane-westgate', name: 'Jane Westgate', email: 'jane.westgate@advocatehealth.org', role: 'PM', accessRole: 'editor', active: true });
      ctx.omsAccountAction = async () => { throw new Error('gateway down'); }; ALERTS.length = 0;
      await del('jane-westgate');
      ok('Rev 52: when the account cannot be removed the row stays', T.st.people.some(p => p.id === 'jane-westgate') && ALERTS.some(a => /NOT removed/.test(a)), JSON.stringify(ALERTS));
      ALERTS.length = 0; calls.length = 0; ctx.omsAccountAction = async (a, p) => { calls.push([a, p]); return { ok: true }; };
      await del('boss');
      ok('Rev 52: an account that is really an admin cannot be deleted, whatever the directory says', calls.length === 0 && T.st.people.some(p => p.id === 'boss') && ALERTS.some(a => /Administrator/.test(a)));
      // Add: a duplicate is refused; a new id follows the slug convention.
      T.fn(`OMS_ACCOUNTS=[]`); calls.length = 0; ALERTS.length = 0;
      fill('Jane Westgate', 'Jane.Westgate@advocatehealth.org', '', false);
      await saveUser('');
      ok('Rev 52: adding somebody already in the directory is refused', T.st.people.filter(p => p.name === 'Jane Westgate').length === 1 && ALERTS.some(a => /already in the directory/.test(a)));
      fill('Terri Yates', 'Terri.Yates@advocatehealth.org', '', false);
      await saveUser('');
      const ty = T.st.people.find(p => p.name === 'Terri Yates');
      ok('Rev 52: a new person gets a slug id', !!ty && ty.id === 'terri-yates', ty && ty.id);
      fill('Terri Yates', 'Another.Yates@advocatehealth.org', '', false);
      await saveUser('');
      ok('Rev 52: a same-name different-address person is refused as a duplicate by name', T.st.people.filter(p => p.name === 'Terri Yates').length === 1);
      ok('Rev 52: the Edit dialog draws the level from the account', /const acctE=omsAccountFor\(p\.email\)/.test(main) && !/\(p\.accessRole\|\|'editor'\)==='viewer'/.test(main));
      ok('Rev 52: a key the record did not have carries an explicit null base value', /base\[k\]=a\[k\]===undefined\?null:a\[k\]/.test(main));
      const ck = G('OMS_CHANGED_KEYS')({ id: 't1', title: 'a' }, { id: 't1', title: 'a', category: 'X' });
      ok('Rev 52: ...seen at the seam', ck.keys.join() === 'category' && ck.base.category === null && ck.changes.category === 'X', JSON.stringify(ck));
    }

    // ---- Rev 56 (found live): a confirming sync replaced ST while the gateway call was in flight.
    {
      const dea = G('adminDeactivate'), act = G('adminActivate');
      T.fn(`OMS_ACCOUNTS=[{id:'jane.westgate@advocatehealth.org',role:'editor',disabled:false}]`);
      T.st.people = [{ id: 'jane-westgate', name: 'Jane Westgate', email: 'jane.westgate@advocatehealth.org', role: 'PM', accessRole: 'editor', active: true }];
      // The stub does what OMS_REBASE_LOCAL does at confirmation: ST becomes a fresh copy.
      ctx.omsAccountAction = async () => { T.fn(`ST=JSON.parse(JSON.stringify(ST))`); return { ok: true }; };
      await dea('jane-westgate');
      ok('Rev 56: deactivate lands on the record ST holds after the await', T.st.people[0].active === false);
      T.fn(`OMS_ACCOUNTS[0].disabled=true`);
      await act('jane-westgate');
      ok('Rev 56: reactivate lands on the record ST holds after the await', T.st.people[0].active === true);
      T.fn(`OMS_ACCOUNTS[0].disabled=false`);
      fill('Jane Westgate', 'jane.westgate@advocatehealth.org', '', false); FIELDS['au_access'] = 'viewer';
      await saveUser('jane-westgate');
      ok('Rev 56: an access-level change lands on the record ST holds after the await', T.st.people[0].accessRole === 'viewer');
      ctx.omsAccountAction = realAction;
    }
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
  // Rev 51 (E-01): the suffix is no longer fixed. The surname part must still be
  // dictatable and the middle part must be six random digits, so a name no longer
  // determines a password. The fixed '-OMS-2026!' shape must not come back.
  const cases = [
    ["Clare Il'Giovine",   'Ilgiovine'],
    ["Anne-Marie O'Brien", 'Obrien'],
    ['Hossam Elsaie',      'Elsaie'],
    ['Maggie Scirica',     'Scirica'],
    ['Jane Westgate',      'Westgate'],
    ['Ari Ball',           'Ball'],
  ];
  for (const [name, expected] of cases)
    ok(`${name} yields ${expected}-dddddd-OMS!`, new RegExp('^' + expected + '-\\d{6}-OMS!$').test(suggest(name)), suggest(name));
  ok('no apostrophe survives into a password', !/'/.test(suggest("Clare Il'Giovine")));
  ok('a single name still works', /^Cher-\d{6}-OMS!$/.test(suggest('Cher')));
  ok('an empty name degrades rather than throwing', /^User-\d{6}-OMS!$/.test(suggest('')));
  // The sandbox's getRandomValues is an identity stub; give it real entropy for this check.
  ctx.crypto.getRandomValues = a => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 4294967296); return a; };
  ok('Rev 51: two suggestions for the same name differ', suggest('Ari Ball') !== suggest('Ari Ball') || suggest('Ari Ball') !== suggest('Ari Ball'));
  ok('Rev 51: the published fixed suffix is gone from the generator', !/OMS-2026!/.test(String(suggest)));
  ok('Rev 51: esc() escapes all five characters', G('esc')('<a href="x" title=\'y\'>&') === '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;');
  ok('Rev 51: esc() does not throw on a number', G('esc')(3400) === '3400');
  ok('Rev 51: safeUrl refuses a script scheme and keeps web and mail links',
     G('safeUrl')('javascript:1') === '' && G('safeUrl')('https://a.b/c') === 'https://a.b/c' && G('safeUrl')('mailto:x@y.z') === 'mailto:x@y.z' && G('safeUrl')('data:text/html,x') === '');
  ok('Rev 51: safeLink prefixes a bare host with https', G('safeLink')('example.org/p') === 'https://example.org/p');
  ok('Rev 51: decodeHtmlEntities uses no DOM and decodes the entities the app emits',
     G('decodeHtmlEntities')('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &mdash; &#x41;&#66; &bogus;') === 'a & b <c> "d" \'e\' \u2014 AB &bogus;');
  ok('Rev 51: every link anchor goes through safeUrl', (html.match(/href="\$\{esc\(safeUrl\([a-z]\.link\)\)\}"/g) || []).length === 13 && !/href="\$\{esc\([a-z]\.link\)\}"/.test(html));
  ok('Rev 51: sign-out clears the local copy of shared state', /function OMS_SIGN_OUT\(\)[\s\S]{0,600}?localStorage\.removeItem\(OMS_LOCAL_KEY\)/.test(main));
  ok('Rev 51: the unread second copy of state is no longer written', !/localStorage\.setItem\('cao_oms_v132_startup_fixed'/.test(main));
  ok('Rev 51: boot asks the gateway who this is', /OMS_GATEWAY\+'\/api\/me'/.test(main));
  ok('Rev 51: boot sends an unchanged initial password back to sign in', /mustChangePassword===true\)\{location\.replace\('\.\/index\.html\?reason=password'\)/.test(main));
  ok('Rev 51: the Reset control guard is gone with the control', !/btn-reset/.test(main));
  ok('Rev 51: no interpolation lands in a value= or href= attribute unescaped', !/(value|href)="\$\{(?!esc\()/.test(html));
  ok('every suggestion clears the twelve-character minimum',
     cases.every(([n]) => suggest(n).length >= 12));
}

// ---------------------------------- Rev 38: every create path assigns an id
// The 5 Sept 2026 migration gave ids to the gw and rob rows that existed. It
// could not give one to a row that did not exist yet, and Add Workstream went
// on pushing {ws,cells,st} with no id for three more revisions. OMS_MAP keeps a
// record only when id != null, so such a row emits no operation in any
// direction: it never reaches canonical and it is gone on the next reload.
console.log('\n# Every create path assigns an id (Rev 38)');
{
  // The general form first. A literal pushed into a synced collection must
  // carry an id, whatever the collection is - this is the assertion that would
  // have caught rob, and that catches the next one without being rewritten.
  const pushes = [...main.matchAll(/ST\.([a-zA-Z]+)\.push\(\{([^}]*)/g)];
  ok('at least one collection push site is present to check', pushes.length > 0);
  for (const [, coll, body] of pushes) {
    ok(`ST.${coll}.push assigns an id`, /\bid\s*:/.test(body),
       `OMS_MAP drops records with no id, so this row could never sync — pushed {${body.slice(0, 60)}`);
  }

  const robId = G('omsRobId');
  ok('omsRobId is defined', typeof robId === 'function');
  if (typeof robId === 'function') {
    T.setST({ rob: [] });
    ok('it follows the documented rob-<slug> form',
       robId('Board Governance Rhythm') === 'rob-board-governance-rhythm', robId('Board Governance Rhythm'));
    T.setST({ rob: [{ id: 'rob-board-governance-rhythm' }] });
    ok('a collision gets -2 rather than overwriting',
       robId('Board Governance Rhythm') === 'rob-board-governance-rhythm-2', robId('Board Governance Rhythm'));
    T.setST({ rob: [{ id: 'rob-board-governance-rhythm' }, { id: 'rob-board-governance-rhythm-2' }] });
    ok('and then -3', robId('Board Governance Rhythm') === 'rob-board-governance-rhythm-3');
    T.setST({ rob: [] });
    ok('a name with no letters or digits still yields a usable id',
       /^rob-.+/.test(robId('!!!')) && robId('!!!') !== 'rob-', robId('!!!'));
  }

  // And the behaviour, through the real handler.
  const before = T.st;
  T.setST({ rob: [{ id: 'rob-existing', ws: 'Existing', cells: Array(12).fill(''), st: Array(12).fill('') }] });
  const openWs = G('openRobWsModal'), saveM = G('saveModal');
  if (typeof openWs === 'function' && typeof saveM === 'function') {
    openWs();                                   // Add Workstream — no index
    ctx.document.getElementById('f_rob_ws').value = 'Digital Health Steering';
    try { saveM(); } catch (e) { /* renderers need more DOM than this harness has */ }
    const rows = T.st.rob;
    ok('Add Workstream creates a row', rows.length === 2, rows.length + ' rows');
    ok('THE CONTRACT: the new workstream has an id',
       rows.every(r => r.id != null), JSON.stringify(rows[rows.length - 1] || {}).slice(0, 90));
    ok('...of the documented form', String((rows[1] || {}).id).startsWith('rob-'), String((rows[1] || {}).id));
    ok('...so it produces a create operation instead of nothing',
       (() => { const m = G('OMS_MAP'); return m ? m(rows).size === 2 : false; })(),
       'OMS_MAP must keep both rows for the diff to see the new one');
    openWs(0);                                  // Edit — index 0
    ctx.document.getElementById('f_rob_ws').value = 'Existing, renamed';
    try { saveM(); } catch (e) {}
    ok('editing still renames in place and keeps the id',
       T.st.rob[0].ws === 'Existing, renamed' && T.st.rob[0].id === 'rob-existing',
       JSON.stringify(T.st.rob[0]).slice(0, 80));
  }
  T.setST(before);
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
    const calls = { state: 0, operation: 0, posted: [], revision: 0, batches: 0, revisionStatus: 0, batchStatus: 0, canonStatus: '' };
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
      fetch: async (url, o) => {
        if (String(url).endsWith('/api/state')) {
          calls.state++;
          return { ok: true, status: 200, headers: { get: () => null },
                   text: async () => JSON.stringify({ state: canonical, revision: canonical.revision, schemaVersion: 2 }) };
        }
        if (String(url).endsWith('/api/revision')) {
          calls.revision++;
          if (calls.revisionStatus) return { ok: false, status: calls.revisionStatus, text: async () => '{}' };
          return { ok: true, status: 200, text: async () => JSON.stringify({ revision: canonical.revision, status: calls.canonStatus || 'ready' }) };
        }
        calls.operation++;
        let body = null; try { body = JSON.parse(o.body); } catch (_) {}
        if (body && Array.isArray(body.operations)) {
          calls.batches++;
          if (calls.batchStatus) return { ok: false, status: calls.batchStatus, text: async () => '{"error":"Invalid entityType"}' };
          for (const op of body.operations) calls.posted.push(op);
          return { ok: true, status: 202, text: async () => JSON.stringify({ accepted: true, batch: true, batchId: 'b', operationIds: body.operations.map((_, i) => 'x' + i), operationId: 'x0' }) };
        }
        if (body) calls.posted.push(body);
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

  // ---- Rev 39: the watch must be cheap as well as persistent
  // Every reconciler tick is one /api/state, which is one GitHub contents read
  // against an installation limit of 5,000 an hour, shared with sign-in, every
  // save and the consolidator's own pushes. A flat 3 s poll cost 1,200 an hour
  // per stuck client. Rev 36 made that real load for the first time by making
  // the reconciler actually fire.
  {
    const ms = G('OMS_RECONCILE_MS');
    ok('the reconcile interval is a backoff, not a single number', Array.isArray(ms), typeof ms);
    if (Array.isArray(ms)) {
      ok('it starts fast enough to feel immediate', ms[0] <= 3000, ms[0] + 'ms');
      ok('it is non-decreasing', ms.every((v, i) => i === 0 || v >= ms[i - 1]), JSON.stringify(ms));
      ok('it slows to minutes rather than seconds', ms[ms.length - 1] >= 300000, ms[ms.length - 1] + 'ms');
    }
  }

  // Measured, not asserted from the table: drive a stuck client for one hour.
  const h6 = build();
  h6.run(`ST.tasks[0].title='Stuck';_dirty.add('tasks');`);
  const p6 = h6.run(`OMS_QUEUE_SYNC()`);
  await h6.advance(40000);
  try { await p6; } catch (_) {}
  ok('the client is in the reconciling state', h6.run(`globalThis.__b`) === 'Unsynced');
  const base6 = h6.calls.state;
  await h6.advance(3600 * 1000);                 // one hour, canonical never moves
  const perHour = h6.calls.state - base6;
  ok('an unconfirmed client costs far less than the 5,000/hour budget allows',
     perHour <= 60, perHour + ' /api/state calls in the first hour (flat 3s would be 1200)');
  ok('but it has NOT given up — a hard stop would restore the terminal Unsynced',
     h6.timers.size > 0, 'no timer pending: the watch stopped');
  // ...and it still heals when canonical finally catches up, an hour late.
  h6.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Stuck', _version: 2 }] });
  await h6.advance(700 * 1000);
  ok('a confirmation an hour later is still noticed', h6.run(`globalThis.__b`) === 'Connected',
     'banner=' + h6.run(`globalThis.__b`));

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

  // ---- Rev 41: a 403 is not an expired session
  // OMS_POST reported EVERY 403 as auth:true, so a read-only account trying to
  // save was told its session had expired - false, and signing in again would
  // change nothing. The gateway's password-change refusal (OMS-053) would have
  // been reported the same way, or worse, fallen through to the generic
  // Unsynced wording that says to press Save again.
  for (const [label, status, body, expect] of [
    ["a read-only refusal", 403, '{"error":"read_only"}', "Read only"],
    ["a password-change refusal", 403, '{"error":"Set a new password before changing shared data. Sign out and sign in again - OMS will ask you for one.","code":"password_change_required"}', "Password change required"],
    ["a genuine 401", 401, '{"error":"Session expired or invalid"}', "Authentication required"],
  ]) {
    const h = build();
    h.run(`OMS_POST_STATUS=${status}; OMS_POST_BODY=${JSON.stringify(body)};`);
    // Re-point fetch at a refusing gateway for the operation endpoint only.
    h.run(`(function(){const f=fetch;globalThis.fetch=async(u,o)=>{
      if(String(u).endsWith('/api/operation'))return{ok:false,status:OMS_POST_STATUS,text:async()=>OMS_POST_BODY};
      return f(u,o)};})()`);
    h.run(`ST.tasks[0].title='Blocked edit';_dirty.add('tasks');`);
    const p = h.run(`OMS_QUEUE_SYNC()`);
    await h.advance(5000);
    try { await p; } catch (_) {}
    ok(`${label} reports "${expect}"`, h.run(`globalThis.__b`) === expect,
       'banner=' + h.run(`globalThis.__b`));
    if (status === 403) {
      ok(`${label} does not start the reconciler - waiting cannot fix it`,
         h.timers.size === 0, h.timers.size + ' timers pending');
      ok(`${label} leaves the edit on screen`,
         h.run(`ST.tasks[0].title`) === 'Blocked edit', h.run(`ST.tasks[0].title`));
    }
  }
  {
    const h = build();
    const src = h.run(`String(OMS_POST)`);
    ok('the password-change branch keys off the gateway code, not its wording',
       /code===.password_change_required./.test(src),
       'prose changes whenever somebody improves it; the code does not');
  }

  // ---- Rev 44a: an update sends only the keys that changed
  // Sending the whole record defeated the one piece of concurrency control the
  // consolidator has. consolidate.py raises a same-field conflict when a key is
  // in BOTH baseValues and changes and canonical has moved; send every key and
  // every key overlaps, so two people editing DIFFERENT fields of the same
  // record collide and one loses. Verified against the real consolidator.
  {
    const h = build();
    h.run(`ST={schemaVersion:2,revision:75,tasks:[{id:'t1',title:'A',notes:'',owner:'Maggie Scirica',_version:1}]};
           OMS_BASE=JSON.parse(JSON.stringify(ST));OMS_REVISION=75;_dirty.clear();`);
    h.run(`ST.tasks[0].notes='B typed a note';_dirty.add('tasks');`);
    const ops = JSON.parse(h.run(`JSON.stringify(OMS_DIFF())`));
    ok('one update is produced', ops.length === 1 && ops[0].action === 'update');
    ok('changes carries ONLY the field that changed',
       JSON.stringify(Object.keys(ops[0].changes)) === '["notes"]',
       JSON.stringify(Object.keys(ops[0].changes)));
    ok('baseValues carries the same key, so the overlap test still works',
       JSON.stringify(Object.keys(ops[0].baseValues)) === '["notes"]',
       JSON.stringify(Object.keys(ops[0].baseValues)));
    ok('...holding the value it had before', ops[0].baseValues.notes === '');
    ok('untouched fields are not sent at all',
       !('title' in ops[0].changes) && !('owner' in ops[0].changes));

    // A create has nothing to diff against and must still send everything.
    h.run(`ST.tasks.push({id:'t9',title:'New',notes:'n',_version:0});`);
    const ops2 = JSON.parse(h.run(`JSON.stringify(OMS_DIFF())`));
    const cr = ops2.find(o => o.action === 'create');
    ok('a create still sends the whole record', cr && cr.changes.title === 'New' && cr.changes.notes === 'n');

    // No change at all must still produce nothing.
    h.run(`OMS_BASE=JSON.parse(JSON.stringify(ST));`);
    ok('an identical record produces no operation',
       JSON.parse(h.run(`JSON.stringify(OMS_DIFF())`)).length === 0);
  }

  // ---- Rev 44b: somebody else's change arrives without a save or a reload
  // Before this the client fetched shared state only at sign-in, during a save,
  // and while the reconciler ran. An hour idle made zero calls and the screen
  // stayed stale until you saved something.
  {
    const h = build();
    h.run(`globalThis.__b='Connected';OMS_START_WATCH();`);
    const before = h.calls.state;
    h.setCanonical({ schemaVersion: 2, revision: 80,
      tasks: [{ id: 't1', title: 'Original', _version: 1 }, { id: 't2', title: 'From a colleague', _version: 1 }] });
    await h.advance(70000);
    ok('an idle session polls for other people\'s work', h.calls.state - before > 0,
       (h.calls.state - before) + ' calls');
    ok('and adopts it', h.run(`ST.tasks.length`) === 2, h.run(`ST.tasks.length`) + ' tasks');
    ok('...moving to the shared revision', h.run(`OMS_REVISION`) === 80, h.run(`OMS_REVISION`));

    // The cost has to stay small: this runs in every open tab.
    const h2 = build();
    h2.run(`globalThis.__b='Connected';OMS_START_WATCH();`);
    const b2 = h2.calls.state;
    await h2.advance(3600 * 1000);
    ok('an hour of idling costs about sixty reads, not thousands',
       h2.calls.state - b2 <= 70, (h2.calls.state - b2) + ' in an hour');
  }

  // ---- Rev 44b: and it must never adopt over work in progress
  {
    const h = build();
    h.run(`globalThis.__b='Connected';ST.tasks[0].title='I am typing';_dirty.add('tasks');OMS_START_WATCH();`);
    h.setCanonical({ schemaVersion: 2, revision: 90, tasks: [{ id: 't1', title: 'Theirs', _version: 9 }] });
    await h.advance(200000);
    ok('it does not adopt while there are unsaved edits',
       h.run(`ST.tasks[0].title`) === 'I am typing', h.run(`ST.tasks[0].title`));
    ok('OMS_WATCH_SAFE says why', h.run(`OMS_WATCH_SAFE()`) === false);

    const h3 = build();
    h3.run(`globalThis.__b='Connected';_dirty.clear();
            OMS_INFLIGHT={ops:[{entityType:'tasks',entityId:'t1',action:'update',baseVersion:1,changes:{}}],seq:0,from:75};
            OMS_START_WATCH();`);
    h3.setCanonical({ schemaVersion: 2, revision: 90, tasks: [{ id: 't1', title: 'Theirs', _version: 9 }] });
    await h3.advance(200000);
    ok('nor while a batch is still with the gateway',
       h3.run(`ST.tasks[0].title`) === 'Original', h3.run(`ST.tasks[0].title`));
  }

  // ---- Rev 50: the four sync-path defects the Fable 5.1 QA pass reproduced.
  // Each of these FAILED against Rev 49 (docs/review-2026-09-06-qa-security/repro-sync-path.mjs).
  // save() is not called here because the harness's advance() awaits each timer
  // callback and the debounce callback returns the whole sync chain; the two
  // lines that save() runs are inlined instead.
  {
    // Case 1. Boot must not leave every collection dirty, or the idle watch never runs.
    const h = build();
    h.run(`ST={schemaVersion:2,revision:75,tasks:[{id:'t1',title:'Original',_version:1}],people:[{id:'p1',name:'P',email:'p@x',active:true}],notifications:[],assignmentHistory:[]};
           OMS_BASE=JSON.parse(JSON.stringify(ST));_dirty.clear();OMS_SYNC_READY=false;
           migrateNotificationsState();if(!OMS_DIFF().length)_dirty.clear();OMS_SYNC_READY=true;`);
    ok('Rev 50: a boot migration that changed nothing leaves nothing dirty', h.run(`_dirty.size`) === 0, h.run(`_dirty.size`) + ' dirty');
    ok('Rev 50: the boot sequence carries that guard', /migrateNotificationsState\(\);[\s\S]{0,700}?if\(!OMS_DIFF\(\)\.length\)_dirty\.clear\(\);OMS_SYNC_READY=true;/.test(main));
    ok('Rev 50: ...so the idle watch may run on a fresh session', h.run(`OMS_WATCH_SAFE()`) === true);
  }
  {
    // Case 2. Different fields on one record must merge, not conflict.
    const h = build();
    h.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Colleague title', notes: '', _version: 2 }] });
    h.run(`ST.tasks[0].notes='';OMS_BASE=JSON.parse(JSON.stringify(ST));ST.tasks[0].notes='My note';OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p = h.run(`OMS_QUEUE_SYNC()`);
    await h.advance(3000);
    ok('Rev 50: an edit to a different field is posted, not refused', h.calls.operation === 1, h.calls.operation + ' posted');
    ok('Rev 50: ...rebased onto the current version', h.run(`OMS_INFLIGHT&&OMS_INFLIGHT.ops[0].baseVersion`) === 2);
    ok('Rev 50: ...and the note is still on screen', h.run(`ST.tasks[0].notes`) === 'My note');
    h.setCanonical({ schemaVersion: 2, revision: 77, tasks: [{ id: 't1', title: 'Colleague title', notes: 'My note', _version: 3 }] });
    await h.advance(30000); try { await p; } catch (_) {}
    ok('Rev 50: ...and the merged record is adopted as Connected', h.run(`globalThis.__b`) === 'Connected' && h.run(`ST.tasks[0].title`) === 'Colleague title', h.run(`globalThis.__b`));
  }
  {
    // Case 2b. The same field IS still a conflict, and the error names it.
    const h = build();
    h.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Colleague title', _version: 2 }] });
    h.run(`ST.tasks[0].title='Mine';OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p = h.run(`OMS_QUEUE_SYNC()`);
    await h.advance(3000); try { await p; } catch (_) {}
    ok('Rev 50: the same field is still refused', h.calls.operation === 0 && h.run(`ST.tasks[0].title`) === 'Colleague title', h.calls.operation + ' posted');
    ok('Rev 50: ...and the conflict toast names the field', /\(title\)/.test(JSON.stringify(h.run(`globalThis.__t||[]`))), JSON.stringify(h.run(`globalThis.__t`)));
  }
  {
    // Case 3. An edit made while a save is confirming is kept and sent, not overwritten.
    const h = build();
    h.run(`ST.tasks.push({id:'t2',title:'Second',_version:1});OMS_BASE=JSON.parse(JSON.stringify(ST));`);
    h.setCanonical({ schemaVersion: 2, revision: 75, tasks: [{ id: 't1', title: 'Original', _version: 1 }, { id: 't2', title: 'Second', _version: 1 }] });
    h.run(`ST.tasks[0].title='Edit A';OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p1 = h.run(`OMS_QUEUE_SYNC()`);
    await h.advance(1500);
    h.run(`ST.tasks[1].title='Edit B';OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p2 = h.run(`OMS_QUEUE_SYNC()`);
    h.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Edit A', _version: 2 }, { id: 't2', title: 'Second', _version: 1 }] });
    await h.advance(5000);
    ok('Rev 50: the edit typed during confirmation survives adoption', h.run(`ST.tasks[1].title`) === 'Edit B', JSON.stringify(h.run(`ST.tasks[1].title`)));
    ok('Rev 50: ...is marked dirty for the next sync', h.run(`_dirty.has('tasks')`) === true);
    h.setCanonical({ schemaVersion: 2, revision: 77, tasks: [{ id: 't1', title: 'Edit A', _version: 2 }, { id: 't2', title: 'Edit B', _version: 2 }] });
    await h.advance(30000); try { await p1; await p2; } catch (_) {}
    ok('Rev 50: ...and both edits reached the gateway', h.calls.operation === 2, h.calls.operation + ' posted');
    ok('Rev 50: ...ending Connected', h.run(`globalThis.__b`) === 'Connected', h.run(`globalThis.__b`));
  }
  {
    // Case 4. One stale record must not discard the rest of the batch.
    const h = build();
    h.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Colleague title', _version: 2 }] });
    h.run(`ST.tasks[0].title='Stale';ST.tasks.push({id:'n1',title:'New one'});OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p = h.run(`OMS_QUEUE_SYNC()`);
    await h.advance(3000);
    ok('Rev 50: the stale record is reverted to canonical', h.run(`ST.tasks[0].title`) === 'Colleague title', h.run(`ST.tasks[0].title`));
    ok('Rev 50: ...but the new record is kept', h.run(`ST.tasks.some(t=>t.id==='n1')`) === true);
    h.setCanonical({ schemaVersion: 2, revision: 77, tasks: [{ id: 't1', title: 'Colleague title', _version: 2 }, { id: 'n1', title: 'New one', _version: 1 }] });
    await h.advance(30000); try { await p; } catch (_) {}
    ok('Rev 50: ...and posted on its own', h.calls.posted.some(o => o.action === 'create' && o.entityId === 'n1'), h.calls.operation + ' posted');
  }

  // ---- Rev 54: an operation already in canonical is neither a conflict nor re-sent.
  {
    const h = build();
    h.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Original', _version: 1 }, { id: 'n1', title: 'New one', _version: 1 }] });
    // OMS_BASE lacks n1 (the create is still "ours"), canonical already holds it: the previous batch landed.
    h.run(`ST.tasks.push({id:'n1',title:'New one'});ST.tasks[0].notes='A later note';OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p = h.run(`OMS_QUEUE_SYNC()`);
    await h.advance(3000);
    ok('Rev 54: a create that already landed raises no conflict', h.run(`globalThis.__b`) !== 'Conflict', h.run(`globalThis.__b`));
    ok('Rev 54: ...and is not re-sent', h.calls.posted.filter(o => o.action === 'create').length === 0, h.calls.posted.map(o => o.action).join(','));
    ok('Rev 54: ...while the new edit is', h.calls.posted.some(o => o.entityId === 't1' && o.changes.notes === 'A later note'));
    h.setCanonical({ schemaVersion: 2, revision: 77, tasks: [{ id: 't1', title: 'Original', notes: 'A later note', _version: 2 }, { id: 'n1', title: 'New one', _version: 1 }] });
    await h.advance(30000); try { await p; } catch (_) {}
    ok('Rev 54: ...ending Connected', h.run(`globalThis.__b`) === 'Connected', h.run(`globalThis.__b`));
  }

  // ---- Rev 55: every read of the link field goes through safeLink (the SOP branch was missed in Rev 51 and found live)
  ok('Rev 55: every link field read is normalized on save', (main.match(/gv\('f_link'\)/g) || []).length === (main.match(/safeLink\(gv\('f_link'\)\)/g) || []).length && (main.match(/gv\('f_link'\)/g) || []).length >= 4, (main.match(/gv\('f_link'\)/g) || []).length + ' reads, ' + (main.match(/safeLink\(gv\('f_link'\)\)/g) || []).length + ' through safeLink');
  // ---- Rev 55: a stale pending copy does not survive a boot that adopts canonical
  {
    const h = build();
    h.run(`OMS_SET_STATE=(s,c,d)=>{globalThis.__b=s;globalThis.__d=d||''};localStorage.setItem(OMS_PENDING_KEY, JSON.stringify({state:{},revision:70,error:'Canonical confirmation is still pending',savedAt:'2026-09-07T02:35:25.982Z',reached:true}));sessionStorage.setItem('cao_oms_session','t');sessionStorage.setItem('cao_oms_user','{}');`);
    const p = h.run(`OMS_BOOT()`); await h.advance(200); try { await p; } catch (_) {}
    ok('Rev 55: a pending copy whose operations had reached the gateway is cleared at boot', h.run(`localStorage.getItem(OMS_PENDING_KEY)`) === null);
    ok('Rev 55: ...quietly', !/never reached/.test(h.run(`globalThis.__d||''`)), h.run(`globalThis.__d`));
    ok('Rev 55: ...so the close prompt no longer fires', h.run(`OMS_SYNC_PENDING()`) === false);
    const h2 = build();
    h2.run(`OMS_SET_STATE=(s,c,d)=>{globalThis.__b=s;globalThis.__d=d||''};localStorage.setItem(OMS_PENDING_KEY, JSON.stringify({state:{},revision:70,error:'offline',savedAt:'2026-09-07T02:35:25.982Z',reached:false}));sessionStorage.setItem('cao_oms_session','t');sessionStorage.setItem('cao_oms_user','{}');`);
    const p2 = h2.run(`OMS_BOOT()`); await h2.advance(200); try { await p2; } catch (_) {}
    ok('Rev 55: a pending copy that never reached the gateway is cleared too', h2.run(`localStorage.getItem(OMS_PENDING_KEY)`) === null);
    ok('Rev 55: ...and the banner says the work was not restored, with its time', /never reached shared OMS/.test(h2.run(`globalThis.__d||''`)) && /2026/.test(h2.run(`globalThis.__d||''`)), h2.run(`globalThis.__d`));
    ok('Rev 55: the pending copy records whether the batch reached the gateway', /reached:!!OMS_INFLIGHT/.test(main));
    // Found live: Create sign-in for an existing person ran as a password reset because openModal replaced MC and lost the mode.
    const h3 = build();
    h3.run(`ST.people=[{id:'p1',name:'Test Person',email:'t@x.org',active:true}];openAccountModal('create','p1');`);
    ok('Rev 55: opening the account dialog in create mode keeps the mode through openModal', h3.run(`MC.type==='acct'&&MC.mode==='create'`), h3.run(`JSON.stringify(MC)`));
    h3.run(`openAccountModal('reset','p1');`);
    ok('Rev 55: ...and reset mode likewise', h3.run(`MC.mode==='reset'`));
    h3.run(`openTaskModal();`);
    ok('Rev 55: a different dialog does not inherit a stale mode', h3.run(`MC.mode===undefined`), h3.run(`JSON.stringify(MC)`));
  }

  // ---- Rev 59 (FAB-39): a refusal nothing can cure leaves no pending copy behind
  for (const [flag, label] of [['readOnly', 'Read only'], ['mustChange', 'Password change required']]) {
    const h = build();
    h.run(`OMS_POST=async()=>{throw Object.assign(new Error('refused'),{${flag}:true,status:403})};`);
    h.run(`ST.tasks[0].title='Typed by somebody who cannot save';OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p = h.run(`OMS_QUEUE_SYNC()`); await h.advance(3000); try { await p; } catch (_) {}
    ok('Rev 59: a ' + flag + ' refusal shows its banner', h.run(`globalThis.__b`) === label, h.run(`globalThis.__b`));
    ok('Rev 59: ...and arms no pending copy', h.run(`localStorage.getItem(OMS_PENDING_KEY)`) === null);
    ok('Rev 59: ...so the close prompt stays quiet', h.run(`OMS_SYNC_PENDING()`) === false);
  }

  // ---- Rev 60: one request per save, a revision peek before a state fetch, and an older gateway still works.
  {
    // A save touching three records is ONE POST carrying three operations.
    const h = build();
    h.run(`ST.tasks[0].title='Edited';ST.tasks.push({id:'n1',title:'New'});ST.notifications=[{id:'m1',subject:'s'}];OMS_BASE.notifications=[];OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p = h.run(`OMS_QUEUE_SYNC()`);
    await h.advance(1500);
    ok('Rev 60: three changed records go out as one batch request', h.calls.batches === 1 && h.calls.operation === 1, h.calls.batches + ' batches, ' + h.calls.operation + ' POSTs');
    ok('Rev 60: ...carrying all three operations', h.calls.posted.length === 3 && h.calls.posted.some(o => o.entityId === 'n1') && h.calls.posted.some(o => o.entityId === 'm1'), h.calls.posted.map(o => o.entityType + '/' + o.entityId).join(','));
    ok('Rev 60: ...and the whole batch is in flight together', h.run(`OMS_INFLIGHT&&OMS_INFLIGHT.ops.length`) === 3, h.run(`OMS_INFLIGHT&&OMS_INFLIGHT.ops.length`));
    h.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Edited', _version: 2 }, { id: 'n1', title: 'New', _version: 1 }], notifications: [{ id: 'm1', subject: 's', _version: 1 }] });
    await h.advance(30000); try { await p; } catch (_) {}
    ok('Rev 60: ...ending Connected', h.run(`globalThis.__b`) === 'Connected', h.run(`globalThis.__b`));
    ok('Rev 60: the gateway is remembered as batch-capable', h.run(`OMS_BATCH_OK`) === true);
  }
  {
    // A single changed record is still a single POST: no envelope for one operation.
    const h = build();
    h.run(`ST.tasks[0].title='Solo';OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p = h.run(`OMS_QUEUE_SYNC()`);
    await h.advance(1500);
    ok('Rev 60: one record is one plain operation, not a batch of one', h.calls.batches === 0 && h.calls.operation === 1 && h.calls.posted[0].entityId === 't1');
    h.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Solo', _version: 2 }] });
    await h.advance(30000); try { await p; } catch (_) {}
  }
  {
    // An older gateway refuses the envelope with 400: fall back to one operation per POST, and stay there.
    const h = build();
    h.calls.batchStatus = 400;
    h.run(`ST.tasks[0].title='Edited';ST.tasks.push({id:'n1',title:'New'});OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p = h.run(`OMS_QUEUE_SYNC()`);
    await h.advance(1500);
    ok('Rev 60: a gateway that refuses the batch shape gets the operations one by one', h.calls.batches === 1 && h.calls.posted.length === 2 && h.calls.operation === 3, h.calls.batches + ' batch attempts, ' + h.calls.operation + ' POSTs, ' + h.calls.posted.length + ' ops');
    ok('Rev 60: ...and is remembered, so the next save does not try again', h.run(`OMS_BATCH_OK`) === false);
    h.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Edited', _version: 2 }, { id: 'n1', title: 'New', _version: 1 }] });
    await h.advance(30000); try { await p; } catch (_) {}
    ok('Rev 60: ...and the save still confirms', h.run(`globalThis.__b`) === 'Connected', h.run(`globalThis.__b`));
  }
  {
    // A read-only refusal of a batch is still reported as read-only, not as an old gateway.
    const h = build();
    h.run(`(function(){const f=fetch;globalThis.fetch=async(u,o)=>{
      if(String(u).endsWith('/api/operation'))return{ok:false,status:403,text:async()=>'{"error":"read_only","code":"read_only"}'};
      return f(u,o)};})()`);
    h.run(`ST.tasks[0].title='Edited';ST.tasks.push({id:'n1',title:'New'});OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p = h.run(`OMS_QUEUE_SYNC()`);
    await h.advance(5000); try { await p; } catch (_) {}
    ok('Rev 60: a 403 on a batch is the account refusal it is', h.run(`globalThis.__b`) === 'Read only', h.run(`globalThis.__b`));
    ok('Rev 60: ...and does not mark the gateway as batch-incapable', h.run(`OMS_BATCH_OK`) === null);
  }
  {
    // While a save confirms, the pollers ask /api/revision and read the state only once it has moved.
    const h = build();
    h.run(`ST.tasks[0].title='Edited';OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p = h.run(`OMS_QUEUE_SYNC()`);
    await h.advance(6000);
    ok('Rev 60: the confirmation wait peeks at the revision', h.calls.revision >= 5, h.calls.revision + ' peeks');
    ok('Rev 60: ...and fetches no state while the revision has not moved (the one read is the pre-flight version check)', h.calls.state === 1, h.calls.state + ' state fetches');
    h.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Edited', _version: 2 }] });
    await h.advance(30000); try { await p; } catch (_) {}
    ok('Rev 60: ...then reads the state exactly once more to confirm', h.calls.state === 2 && h.run(`globalThis.__b`) === 'Connected', h.calls.state + ' state fetches, ' + h.run(`globalThis.__b`));
  }
  {
    // A gateway without /api/revision: the pollers read the state as they always did.
    const h = build();
    h.calls.revisionStatus = 404;
    h.run(`ST.tasks[0].title='Edited';OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p = h.run(`OMS_QUEUE_SYNC()`);
    await h.advance(6000);
    ok('Rev 60: a 404 on /api/revision is asked once and remembered', h.calls.revision === 1 && h.run(`OMS_REVISION_EP`) === false, h.calls.revision + ' peeks');
    ok('Rev 60: ...and the state is polled instead', h.calls.state >= 5, h.calls.state + ' state fetches');
    h.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Edited', _version: 2 }] });
    await h.advance(30000); try { await p; } catch (_) {}
    ok('Rev 60: ...and the save confirms', h.run(`globalThis.__b`) === 'Connected', h.run(`globalThis.__b`));
  }
  {
    // The idle watch peeks too, and adopts only when the revision has moved.
    const h = build();
    h.run(`OMS_START_WATCH()`);
    await h.advance(61000);
    ok('Rev 60: an idle tick with nothing new is one revision peek and no state read', h.calls.revision === 1 && h.calls.state === 0, h.calls.revision + ' peeks, ' + h.calls.state + ' states');
    h.setCanonical({ schemaVersion: 2, revision: 80, tasks: [{ id: 't1', title: 'Somebody else', _version: 2 }] });
    await h.advance(61000);
    ok('Rev 60: ...and a moved revision is read and adopted', h.calls.state === 1 && h.run(`ST.tasks[0].title`) === 'Somebody else' && h.run(`OMS_REVISION`) === 80, h.calls.state + ' states, ' + h.run(`ST.tasks[0].title`));
    h.run(`OMS_STOP_WATCH()`);
  }
  {
    // D-12: the consolidator's verdict on the shared record reaches the banner.
    const h = build();
    h.calls.canonStatus = 'conflicts-present';
    h.run(`ST.tasks[0].title='Edited';OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p = h.run(`OMS_QUEUE_SYNC()`);
    await h.advance(1500);
    h.setCanonical({ schemaVersion: 2, revision: 76, tasks: [{ id: 't1', title: 'Edited', _version: 2 }] });
    await h.advance(30000); try { await p; } catch (_) {}
    ok('Rev 60: Connected still, with the shared-record status in the banner', h.run(`globalThis.__b`) === 'Connected' && /conflicts-present/.test(h.run(`OMS_CONN_HINT()`)), h.run(`OMS_CONN_HINT()`));
    h.calls.canonStatus = 'ready';
    h.run(`OMS_CANON_STATUS='ready'`);
    ok('Rev 60: ...and nothing when the record is ready', h.run(`OMS_CONN_HINT()`) === '');
  }
  ok('OMS-060: the dialog footer is sticky to the bottom of the scrolling dialog',
     /\.mft\{[^}]*position:sticky;bottom:0;background:#fff/.test(html));

// ---- Rev 61: bulk status, duplicate, remembered screen, and the Dashboard counters.
console.log('\n# Rev 61: acting on many rows, copying one, and coming back to where you were');
{
  const seed = () => {
    T.fn("ST.tasks=[" +
      "{id:'b1',title:'One',owner:'Hossam Elsaie',status:'Not Started',due:'2030-01-01',_version:1}," +
      "{id:'b2',title:'Two',owner:'Hossam Elsaie',status:'Not Started',due:'2030-01-01',_version:1}," +
      "{id:'b3',title:'Three',owner:'Somebody Else',status:'Not Started',due:'2030-01-01',_version:1}]");
    T.fn("taskSt='All';taskOw='All';taskCat='All';taskQ='';taskSel.clear();_dirty.clear()");
  };

  seed();
  T.fn("taskSel.add('b1');taskSel.add('b2');taskSel.add('b3')");
  ok('Rev 61: every selected row is acted on when the filter shows them all',
     G('omsSelectedShown')().length === 3, G('omsSelectedShown')().length + ' shown');

  // A selection made before the filter narrowed must not act on hidden records.
  T.fn("taskOw='Somebody Else'");
  ok('Rev 61: a selection outside the current filter is ignored',
     G('omsSelectedShown')().join(',') === 'b3', G('omsSelectedShown')().join(','));
  T.fn("taskOw='All'");

  // The bulk change goes through the ordinary save path: dirty marked once.
  seed();
  T.fn("taskSel.add('b1');taskSel.add('b2')");
  T.fn("omsBulkStatus('In Progress')");
  const st = id => (T.st.tasks.find(x => x.id === id) || {}).status;
  ok('Rev 61: the selected rows take the new status', st('b1') === 'In Progress' && st('b2') === 'In Progress',
     st('b1') + '/' + st('b2'));
  ok('Rev 61: an unselected row is untouched', st('b3') === 'Not Started', st('b3'));
  ok('Rev 61: it marks the collection dirty once, so the save is one batch',
     T.fn("_dirty.has('tasks')") === true && T.fn('_dirty.size') === 1, T.fn('_dirty.size') + ' collections');
  ok('Rev 61: the selection is cleared after it is applied', T.fn('taskSel.size') === 0);
  ok('Rev 61: it never writes a status onto a record it was not given',
     T.st.tasks.every(x => ['Not Started', 'In Progress'].includes(x.status)));

  // Nothing to do is not an error, and must not queue an empty save.
  seed();
  T.fn("taskSel.add('b1')");
  T.fn("omsBulkStatus('Not Started')");
  ok('Rev 61: setting the status a row already has changes nothing',
     T.fn('_dirty.size') === 0, T.fn('_dirty.size') + ' collections dirty');

  // Duplicate.
  seed();
  T.fn("ST.tasks[0].status='Complete';ST.tasks[0].dependsOn='b2';ST.tasks[0]._updatedBy='someone'");
  const before = T.st.tasks.length;
  T.fn("omsDuplicate('tasks','b1')");
  ok('Rev 61: Copy adds exactly one record', T.st.tasks.length === before + 1, T.st.tasks.length + ' tasks');
  const copy = T.st.tasks[T.st.tasks.length - 1];
  ok('Rev 61: ...with a new id', copy.id && copy.id !== 'b1', copy.id);
  ok('Rev 61: ...a name that says it is a copy', /\(copy\)$/.test(copy.title), copy.title);
  ok('Rev 61: ...starting at Not Started rather than inheriting a completion',
     copy.status === 'Not Started', copy.status);
  ok('Rev 61: ...waiting on nothing', !copy.dependsOn, copy.dependsOn);
  ok('Rev 61: ...and claiming none of the original history',
     copy._version === undefined && copy._updatedBy === undefined);
  ok('Rev 61: the original is left exactly as it was',
     T.st.tasks[0].status === 'Complete' && T.st.tasks[0].id === 'b1');

  // At risk is a window, not a stored status.
  T.fn("ST.tasks=[{id:'r1',title:'Soon',status:'Not Started',due:'" +
       new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) + "'}," +
       "{id:'r2',title:'Later',status:'Not Started',due:'2099-01-01'}," +
       "{id:'r3',title:'Soon but done',status:'Complete',due:'" +
       new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) + "'}]");
  T.fn("taskSt='At risk';taskOw='All';taskCat='All';taskQ=''");
  const risk = G('omsTaskRows')().map(x => x.id);
  ok('Rev 61: At risk selects work due within three days', risk.includes('r1'), risk.join(','));
  ok('Rev 61: ...not work due far off', !risk.includes('r2'), risk.join(','));
  ok('Rev 61: ...and not work already finished', !risk.includes('r3'), risk.join(','));
  ok('Rev 61: no record actually carries At risk as a status',
     T.st.tasks.every(x => x.status !== 'At risk'));
  // At risk must NOT inherit the reminder path's exclusion of owners with no
  // email. That exclusion is right for drafts and wrong for a risk counter,
  // because unassigned work is the likeliest to slip.
  T.fn("ST.tasks=[{id:'u1',title:'Nobody owns this',status:'Not Started',due:'" +
       new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) + "'}]");
  ok('Rev 61: unassigned work still counts as at risk',
     G('tasksAtRisk')(3).length === 1, G('tasksAtRisk')(3).length + ' at risk');
  ok('Rev 61: ...while the reminder path still skips it, having nobody to write to',
     G('tasksDueSoon')(3).length === 0, G('tasksDueSoon')(3).length + ' reminders');

  // The Dashboard counters land on the list they counted.
  T.fn("taskSt='All';taskQ='noise';taskCat='Cabinet'");
  T.fn("omsShowTasks('Overdue')");
  ok('Rev 61: a counter sets its own filter', T.fn('taskSt') === 'Overdue', T.fn('taskSt'));
  ok('Rev 61: ...and clears the filters that would hide its rows',
     T.fn('taskQ') === '' && T.fn('taskCat') === 'All', T.fn('taskQ') + '/' + T.fn('taskCat'));
  ok('Rev 61: ...and lands on the task screen', T.fn('curTab') === 'tasks', T.fn('curTab'));

  // Remembered screen and filters. The harness element mock answers false to
  // every classList.contains, so it is told which ids are real tabs; the product
  // check itself is left exactly as it ships.
  T.fn("['dash','tasks','admin','import'].forEach(id=>{document.getElementById(id).classList.contains=(c)=>c==='tab'})");
  T.fn("taskSt='Blocked';taskOw='All';taskSort='due';taskSortDir='desc';dashMine=true;curTab='tasks';omsSavePrefs()");
  T.fn("taskSt='All';taskSort='';taskSortDir='asc';dashMine=false;curTab='dash'");
  const back = G('omsRestorePrefs')();
  ok('Rev 61: the remembered tab comes back', back === 'tasks', String(back));
  ok('Rev 61: ...and the filters with it',
     T.fn('taskSt') === 'Blocked' && T.fn('taskSort') === 'due' && T.fn('taskSortDir') === 'desc',
     T.fn('taskSt') + '/' + T.fn('taskSort') + '/' + T.fn('taskSortDir'));
  ok('Rev 61: ...including the Mine scope', T.fn('dashMine') === true);
  ok('Rev 61: preferences never reach the synced state',
     !JSON.stringify(T.st).includes('cao_oms_prefs'));

  // A tab this account may not open must not be restored onto.
  T.fn("curTab='admin';omsSavePrefs()");
  T.fn("OMS_USER={role:'editor',displayName:'An Editor'}");
  ok('Rev 61: an editor is not restored onto the Admin tab',
     G('omsRestorePrefs')() === null, String(G('omsRestorePrefs')()));
  T.fn("curTab='import';omsSavePrefs()");
  T.fn("OMS_USER={role:'viewer',displayName:'A Viewer'}");
  ok('Rev 61: a viewer is not restored onto Import',
     G('omsRestorePrefs')() === null, String(G('omsRestorePrefs')()));
  T.fn("OMS_USER={role:'admin',displayName:'Hossam Elsaie'}");

  // A stored tab that no longer exists must not blank the screen.
  T.fn("curTab='nosuchtab';omsSavePrefs()");
  ok('Rev 61: an unknown stored tab is refused rather than rendered',
     G('omsRestorePrefs')() === null);
  T.fn("curTab='dash';omsSavePrefs()");

  // Read-only accounts get no bulk controls and no copy.
  T.fn("OMS_USER={role:'viewer',displayName:'A Viewer'}");
  T.fn("ST.tasks=[{id:'v1',title:'One',status:'Not Started',_version:1}];taskSel.clear();taskSel.add('v1');_dirty.clear()");
  T.fn("omsBulkStatus('Complete')");
  ok('Rev 61: a viewer cannot bulk-change status',
     T.st.tasks[0].status === 'Not Started' && T.fn('_dirty.size') === 0, T.st.tasks[0].status);
  const n0 = T.st.tasks.length;
  T.fn("omsDuplicate('tasks','v1')");
  ok('Rev 61: a viewer cannot copy a record', T.st.tasks.length === n0, T.st.tasks.length + ' tasks');
  T.fn("OMS_USER={role:'admin',displayName:'Hossam Elsaie'}");
  T.fn("_dirty.clear();taskSel.clear()");
}
ok('Rev 61: the counters are real buttons, not clickable divs',
   /<button type="button" class="kpi r klk"/.test(html) && /<button type="button" class="kpi y klk"/.test(html));
ok('Rev 61: the bulk bar is hidden from print', /class="bulkbar no-print"/.test(html));

// ---- Rev 62: what the Rev 61 review found.
console.log('\n# Rev 62: the Mine counter and the list it opens agree; the row of five collapses; Copy says what it does');
{
  T.fn("ST.people=[{id:'hossam-elsaie',name:'Hossam Elsaie',email:'hossam.elsaie@advocatehealth.org',active:true}," +
       "{id:'maggie-scirica',name:'Maggie Scirica',email:'Margaret.Scirica@Advocatehealth.org',active:true}]");
  // Live canonical (revision 103) holds both 'Hossam Elsaie' and 'Hossam' as owner strings.
  T.fn("ST.tasks=[{id:'m1',title:'Long form',owner:'Hossam Elsaie',status:'Not Started',due:'2030-01-01'}," +
       "{id:'m2',title:'Short form',owner:'Hossam',status:'Not Started',due:'2030-01-01'}," +
       "{id:'m3',title:'Somebody else',owner:'Maggie',status:'Not Started',due:'2030-01-01'}]");
  T.fn("OMS_USER={role:'admin',displayName:'Hossam Elsaie'};dashMine=true;taskSt='All';taskOw='All';taskCat='All';taskQ=''");
  const counted = G('omsMineOnly')(T.st.tasks).length;
  ok('Rev 62: the Dashboard counter resolves both spellings to the signed-in person', counted === 2, counted + ' counted');
  T.fn("omsShowTasks('All')");
  ok('Rev 62: the counter sends the Tasks screen the resolved Mine filter, not a display name',
     T.fn('taskOw') === T.fn('OMS_MINE_OWNER'), T.fn('taskOw'));
  const listed = G('omsTaskRows')().length;
  ok('Rev 62: ...and the list shows exactly what was counted', listed === counted, listed + ' listed vs ' + counted + ' counted');
  T.fn("taskOw='Hossam Elsaie'");
  ok('Rev 62: a plain owner string still filters by string, as before',
     G('omsTaskRows')().length === 1, G('omsTaskRows')().length + ' rows');
  T.fn("taskOw=OMS_MINE_OWNER;dashMine=false");
  ok('Rev 62: the Tasks Mine filter does not depend on the Dashboard chip',
     G('omsTaskRows')().length === 2, G('omsTaskRows')().length + ' rows');
  T.fn("taskOw='All';taskSel.clear();_dirty.clear();ST.people=[]");
}
ok('Rev 62: the five counters use a class, not an inline width', /<div class="g5" style="margin-bottom:14px">/.test(html)
   && !/class="g4" style="grid-template-columns:repeat\(5,1fr\)/.test(html));
ok('Rev 62: ...and that class collapses at both breakpoints with the other grids',
   /@media\(max-width:900px\)\{\.g2,\.g3,\.g4,\.g5,\.cal-grid\{grid-template-columns:1fr 1fr\}/.test(html)
   && /@media\(max-width:600px\)\{\.g2,\.g3,\.g4,\.g5,\.cal-grid\{grid-template-columns:1fr\}/.test(html));
ok('Rev 62: the Mine tooltip no longer claims the cards below narrow', !/The counters and the lists below/.test(html));
ok('Rev 62: the Copy control says the copy is saved at once', /is saved to shared OMS at once/.test(html)
   && !/opens for editing\. Nothing is sent\./.test(html));

// ---- Rev 63: export any grid; the Key Dates period has no upper limit.
console.log('\n# Rev 63: every grid exports what it shows, and the Key Dates period is unbounded');
{
  T.fn("globalThis.__snap=JSON.stringify({t:ST.tasks,e:ST.events,s:ST.sops,r:ST.rob,rev:OMS_REVISION})");
  T.fn("globalThis.XLSX={utils:{book_new:()=>({s:[]}),aoa_to_sheet:a=>({a}),book_append_sheet:(wb,ws,n)=>wb.s.push({n,a:ws.a})},writeFile:(wb,f)=>{globalThis.__xl={wb,f}}}");
  T.fn("ST.tasks=[{id:'x1',title:'Alpha',owner:'Hossam Elsaie',status:'Not Started',due:'2030-01-01',category:'Cabinet',_version:1}," +
       "{id:'x2',title:'Beta',owner:'Somebody',status:'Complete',due:'2030-01-02',_version:1}];" +
       "taskSt='All';taskOw='All';taskCat='All';taskQ='';taskSort='';taskSortDir='asc';OMS_REVISION=777;OMS_USER={role:'admin',displayName:'Hossam Elsaie'}");
  T.fn("omsExportTasks()");
  const xl = T.fn('globalThis.__xl');
  ok('Rev 63: the Tasks export is named for the screen and the day', /^OMS-Tasks-\d{4}-\d{2}-\d{2}\.xlsx$/.test(xl.f), xl.f);
  ok('Rev 63: ...holds a header and one row per task shown', xl.wb.s[0].a.length === 3 && xl.wb.s[0].a[0][0] === 'Title', xl.wb.s[0].a.length + ' rows');
  ok('Rev 63: ...and a second sheet recording the canonical revision',
     xl.wb.s[1].n === 'About this export' && xl.wb.s[1].a.some(r => r[0] === 'Canonical revision' && r[1] === 777));
  ok('Rev 63: ...and who exported it', xl.wb.s[1].a.some(r => r[0] === 'Exported by' && r[1] === 'Hossam Elsaie'));
  T.fn("taskSt='Complete';omsExportTasks()");
  ok('Rev 63: the export follows the current filter',
     T.fn('globalThis.__xl.wb.s[0].a.length') === 2 && T.fn('globalThis.__xl.wb.s[0].a[1][0]') === 'Beta', T.fn('globalThis.__xl.wb.s[0].a.length') + ' rows');
  ok('Rev 63: ...and says which filter it followed',
     /Status: Complete/.test(T.fn('globalThis.__xl.wb.s[1].a.find(r=>r[0]==="Filter and sort")[1]')));
  T.fn("taskSt='All';ST.events=[{id:'e1',title:'Gamma',date:'2030-03-03',source:'Ari',category:'Cabinet',recurring:true}," +
       "{id:'e2',title:'Hidden',date:'2030-03-04',source:'Maggie',category:'EB OOO'}];calSrc='overlay';calCadence='all';calSearch='';omsExportCalendar()");
  const cal = T.fn('globalThis.__xl');
  // Rev 68: the OOO row is no longer hidden, so it exports with the rest.
  ok('Rev 63 / Rev 68: the Calendar export holds every row the screen shows, out-of-office included',
     cal.wb.s[0].a.length === 5 && cal.wb.s[0].a.some(r => r[3] === 'Hidden'), cal.wb.s[0].a.length + ' rows');
  ok('Rev 63: ...sorted by date with a Standing column', cal.wb.s[0].a[1][3] === 'Alpha' && cal.wb.s[0].a[3][3] === 'Gamma' && cal.wb.s[0].a[3][4] === 'Yes');
  T.fn("calSrc='ari';omsExportCalendar()");
  ok('Rev 63: ...and follows the source chip', T.fn('globalThis.__xl.wb.s[0].a.length') === 2, T.fn('globalThis.__xl.wb.s[0].a.length') + ' rows');
  T.fn("calSrc='overlay';ST.sops=[{id:'s1',process:'Proc A',category:'Ops',owner:'X',reviewDue:'2030-05-05'},{id:'s2',process:'Proc B',category:'Other'}];sopQ='';sopCat='Ops';omsExportSops()");
  ok('Rev 63: the SOP export follows its category filter',
     T.fn('globalThis.__xl.wb.s[0].a.length') === 2 && T.fn('globalThis.__xl.wb.s[0].a[1][1]') === 'Proc A');
  T.fn("sopCat='All';ST.rob=[{id:'rob-a',ws:'WS A',cells:['one'].concat(Array(11).fill('')),st:['ip'].concat(Array(11).fill(''))}];omsExportRob()");
  ok('Rev 63: the Cadence export writes the status in brackets beside the text, one column per month',
     T.fn('globalThis.__xl.wb.s[0].a[1][1]') === 'one [In Progress]' && T.fn('globalThis.__xl.wb.s[0].a[0].length') === 13);
  T.fn("ST.people=[{id:'p1',name:'A Person',email:'a@x.org',role:'Ops',active:true}];omsExportPeople()");
  ok('Rev 63: the Directory export lists people with their sign-in state',
     T.fn('globalThis.__xl.wb.s[0].a.length') === 2 && T.fn('globalThis.__xl.wb.s[0].a[1][0]') === 'A Person');
  T.fn("OMS_USER={role:'editor',displayName:'An Editor'};globalThis.__xl=null;omsExportPeople()");
  ok('Rev 63: ...and only an administrator gets it', T.fn('globalThis.__xl') === null);
  T.fn("OMS_USER={role:'viewer',displayName:'A Viewer'};omsExportTasks()");
  ok('Rev 63: a read-only account may export what it can read', !!T.fn('globalThis.__xl'));
  T.fn("OMS_USER={role:'admin',displayName:'Hossam Elsaie'};delete globalThis.XLSX");
  ok('Rev 63: without the library the export refuses instead of throwing', (() => { try { T.fn('omsExportTasks()'); return true; } catch (e) { return false; } })());
  ok('Rev 63: rCal draws from the same list the export reads', /function rCal\(\)\{ const ev=omsCalItems\(\);/.test(main));
  ok('Rev 63: rSOPs draws from the same list the export reads', /function rSOPs\(\)\{ let f=omsSopRows\(\);/.test(main));
  ok('Rev 63: the Key Dates period has no upper limit', !/months>24/.test(main) && /omsApplyKeyDatesRange/.test(main));
  T.fn("const __s=JSON.parse(globalThis.__snap);ST.tasks=__s.t;ST.events=__s.e;ST.sops=__s.s;ST.rob=__s.r;OMS_REVISION=__s.rev;ST.people=[];_dirty.clear();taskSel.clear()");
}
// ---- Rev 65: one search box, and task templates.
console.log('\n# Rev 65: one search box across four record types, and templates applied on a hand-made event only');
{
  T.fn("globalThis.__snap65=JSON.stringify({t:ST.tasks,e:ST.events,s:ST.sops,p:ST.people,tt:ST.taskTemplates||null})");
  T.fn("ST.people=[{id:'hossam-elsaie',name:'Hossam Elsaie',email:'hossam.elsaie@advocatehealth.org',role:'Strategy',active:true},{id:'gone',name:'Cabinet Ghost',email:'g@x.org',active:false}];" +
       "ST.tasks=[{id:'t1',title:'Prep cabinet deck',owner:'Hossam Elsaie',status:'Not Started',due:'2030-01-01'},{id:'t2',title:'Cabinet scorecards',owner:'Ari Ball',status:'In Progress'},{id:'t3',title:'Unrelated',owner:'x',notes:'mentions cabinet in notes',status:'Not Started'}];" +
       "ST.events=[{id:'e1',title:'Cabinet meeting',date:'2030-02-02',category:'Cabinet'},{id:'e2',title:'Cabinet retired',date:'2030-02-03',status:'Retired'}];" +
       "ST.sops=[{id:'s1',process:'Cabinet agenda process',owner:'Hossam Elsaie'}]");
  const g = G('omsGlobalSearch')('cab');
  ok('Rev 65: groups come back in a fixed order', g.map(x => x.type).join(',') === 'tasks,events,sops', g.map(x => x.type).join(','));
  ok('Rev 65: a title that starts with the query ranks above one that contains it',
     g[0].items[0].id === 't2' && g[0].items[1].id === 't1', g[0].items.map(i => i.id).join(','));
  ok('Rev 65: a match in a secondary field ranks last', g[0].items[2].id === 't3' && g[0].items[2].rank === 3);
  ok('Rev 65: a retired event is not offered', g[1].items.length === 1 && g[1].items[0].id === 'e1');
  ok('Rev 65: an inactive person is not offered', !g.some(x => x.type === 'people'));
  ok('Rev 65: a person is found by name', G('omsGlobalSearch')('hoss').some(x => x.type === 'people' && x.items[0].id === 'hossam-elsaie'));
  ok('Rev 65: one character is too little to search on', G('omsGlobalSearch')('c').length === 0);
  ok('Rev 65: no group holds more than five', G('omsGlobalSearch')('e').every(x => x.items.length <= 5));

  T.fn("ST.taskTemplates=[{id:'tpl-x',name:'X',category:'Cabinet',lines:[{title:'Agenda',offsetDays:-7,owner:'Hossam Elsaie',priority:'High'},{title:'Minutes',offsetDays:2}]},{id:'tpl-y',name:'Y',category:'Other',lines:[{title:'Nope'}]}]");
  ok('Rev 65: templates are matched by event category', G('omsTemplatesFor')('Cabinet').length === 1 && G('omsTemplatesFor')('Board').length === 0);
  ok('Rev 65: a template id follows the tpl-<slug> convention and does not collide',
     G('omsTemplateId')('X') === 'tpl-x-2' && G('omsTemplateId')('Board meeting prep') === 'tpl-board-meeting-prep');
  ok('Rev 65: days are added on the calendar, across a month boundary', G('omsAddDays')('2030-03-01', -1) === '2030-02-28' && G('omsAddDays')('2030-01-31', 1) === '2030-02-01');
  const n0 = T.st.tasks.length;
  const made = G('omsApplyTemplates')({ id: 'e9', title: 'Cabinet in March', date: '2030-03-10', category: 'Cabinet' });
  const mine = T.st.tasks.filter(t => t.sourceEventId === 'e9');
  ok('Rev 65: applying a template creates one linked task per line', made === 2 && T.st.tasks.length === n0 + 2 && mine.length === 2, made + ' made');
  ok('Rev 65: ...dated from the event', mine.map(t => t.due).join(',') === '2030-03-03,2030-03-12', mine.map(t => t.due).join(','));
  ok('Rev 65: ...owner resolved through the directory', mine[0].ownerId === 'hossam-elsaie' && mine[0].ownerEmail === 'hossam.elsaie@advocatehealth.org');
  ok('Rev 65: ...priority kept, or Medium when the line has none', mine[0].priority === 'High' && mine[1].priority === 'Medium');
  ok('Rev 65: ...starting at Not Started in the event\'s category, waiting on nothing',
     mine.every(t => t.status === 'Not Started' && t.category === 'Cabinet' && t.dependsOn === '' && t.sourceEventTitle === 'Cabinet in March'));
  ok('Rev 65: a category with no template creates nothing', G('omsApplyTemplates')({ id: 'e8', title: 'x', date: '2030-03-10', category: 'Board' }) === 0);
  ok('Rev 65: the offer names the count and the lines', /Create the 2 standard tasks for Cabinet/.test(G('omsTemplateOfferHtml')('Cabinet')) && G('omsTemplateOfferHtml')('Board') === '');
  ok('Rev 65: the collection syncs like the others', T.fn("OMS_COLLECTIONS.includes('taskTemplates')") === true);
  const importFns = (main.match(/function (\w*[Ii]mport\w*)\(/g) || []).map(m => m.replace(/^function /, '').replace(/\($/, ''));
  ok('Rev 65: no importer applies a template (' + importFns.length + ' import functions checked)',
     importFns.length > 3 && importFns.every(n => !/omsApplyTemplates|omsTemplatesFor/.test(String(G(n) || ''))));
  ok('Rev 65: only the NEW-event branch of the save applies a template',
     /\}else\{ST\.events\.push\(o\);[^]*?omsApplyTemplates\(o\)/.test(String(G('saveModal'))) && (String(G('saveModal')).match(/omsApplyTemplates\(/g) || []).length === 1);
  ok('Rev 65: the Add Event dialog carries the offer only for a new event', /id="f_tpl_block">\$\{id\?'':omsTemplateOfferHtml\(e\.category\)\}/.test(String(G('openEvModal'))));
  T.fn("const __s=JSON.parse(globalThis.__snap65);ST.tasks=__s.t;ST.events=__s.e;ST.sops=__s.s;ST.people=__s.p;if(__s.tt)ST.taskTemplates=__s.tt;else delete ST.taskTemplates;_dirty.clear()");
}
{
  const csp = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/) || [])[1] || '';
  ok('Rev 66 (FAB-08): the artifact carries a Content Security Policy', csp.length > 0);
  ok('Rev 66: it names only the gateway for connections', /connect-src 'self' https:\/\/cao-oms-gateway\.vercel\.app;/.test(csp) && !/connect-src[^;]*\*/.test(csp));
  ok('Rev 66: it names the pinned SheetJS host for scripts and nothing else external', /script-src 'self' 'unsafe-inline' https:\/\/cdn\.sheetjs\.com;/.test(csp));
  ok('Rev 66: plugins and base changes are refused', /object-src 'none'/.test(csp) && /base-uri 'self'/.test(csp));
  ok('Rev 66: the inline search icon still loads', /img-src 'self' data:/.test(csp));
  ok('Rev 66: the policy sits before the first stylesheet and script', html.indexOf('http-equiv="Content-Security-Policy"') < html.indexOf('<style>') && html.indexOf('http-equiv="Content-Security-Policy"') < html.indexOf('<script'));
  const idx = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok('Rev 66: the sign-in page carries one too, naming the same gateway', /Content-Security-Policy/.test(idx) && /connect-src 'self' https:\/\/cao-oms-gateway\.vercel\.app/.test(idx));
}
// ---- Rev 67 (FAB-40): typing must not destroy the box being typed into.
console.log('\n# Rev 67: a search box survives being typed into');
{
  // Behavioural, not textual: the helper is actually run against the harness
  // element mock, which is given a focus() and a setSelectionRange() that record
  // what happened. The product code is exactly as it ships.
  T.fn("globalThis.__pe=document.getElementById('probe-box');" +
       "globalThis.__pe.selectionStart=3;globalThis.__pe.selectionEnd=5;" +
       "globalThis.__pe.setSelectionRange=function(a,b){globalThis.__caret=[a,b]};" +
       "globalThis.__pe.focus=function(){document.activeElement=globalThis.__pe};" +
       "document.activeElement=globalThis.__pe;globalThis.__ran=0;globalThis.__caret=null");
  T.fn("omsRerenderKeepingCaret('probe-box',function(){globalThis.__ran++})");
  ok('Rev 67: the render still runs', T.fn('globalThis.__ran') === 1, T.fn('globalThis.__ran') + ' renders');
  ok('Rev 67: ...and focus is back on the box afterwards',
     T.fn("document.activeElement===document.getElementById('probe-box')") === true);
  ok('Rev 67: ...with the caret exactly where it was, not reset to the end',
     T.fn('JSON.stringify(globalThis.__caret)') === '[3,5]', T.fn('JSON.stringify(globalThis.__caret)'));
  // Restoring focus to a box nobody was typing in would steal it from wherever
  // the person actually is.
  T.fn("document.activeElement=document.getElementById('somewhere-else');globalThis.__ran=0");
  T.fn("omsRerenderKeepingCaret('probe-box',function(){globalThis.__ran++})");
  ok('Rev 67: a render nobody was typing into does not steal focus',
     T.fn('globalThis.__ran') === 1 &&
     T.fn("document.activeElement===document.getElementById('somewhere-else')") === true);
  // A missing element must not throw and take the whole render down with it.
  T.fn("globalThis.__ran=0");
  ok('Rev 67: an id that matches nothing renders anyway rather than throwing',
     (() => { try { T.fn("omsRerenderKeepingCaret('no-such-box',function(){globalThis.__ran++})");
                    return T.fn('globalThis.__ran') === 1 } catch (e) { return false } })());

  // All three self-re-rendering boxes route through it, by id.
  ok('Rev 67: the Tasks box refocuses itself by its own id',
     /id="task-search"[^>]*oninput="taskQ=this\.value;omsSavePrefs\(\);omsRerenderKeepingCaret\('task-search',rTasks\)"/.test(html));
  ok('Rev 67: the SOPs box refocuses itself by its own id',
     /id="sop-search"[^>]*oninput="sopQ=this\.value;omsRerenderKeepingCaret\('sop-search',rSOPs\)"/.test(html));
  ok('Rev 67: the Calendars box refocuses itself by its own id',
     /omsRerenderKeepingCaret\('cal-search',rCal\)/.test(String(G('calSearchInput'))));
  // The Rev 12 mechanism, which is the thing that quietly failed.
  ok('Rev 67: no search path restores focus from a frame callback any more',
     !/requestAnimationFrame/.test(String(G('calSearchInput'))) &&
     !/requestAnimationFrame/.test(String(G('omsRerenderKeepingCaret'))));
  // The five choice controls that redraw their own screen keep focus too.
  ok('Rev 67: the Tasks Owner and Category filters keep focus after a choice',
     /id="task-owner"[^>]*omsRerenderKeepingCaret\('task-owner',rTasks\)/.test(html) &&
     /id="task-cat"[^>]*omsRerenderKeepingCaret\('task-cat',rTasks\)/.test(html));
  ok('Rev 67: so does the SOPs category filter and the Weekly Brief week picker',
     /id="sop-cat"[^>]*omsRerenderKeepingCaret\('sop-cat',rSOPs\)/.test(html) &&
     /id="brief-week"[^>]*omsRerenderKeepingCaret\('brief-week',rBrief\)/.test(html));
  ok('Rev 67: the bulk-status picker resets itself before the redraw, not after',
     /id="task-bulk"[^>]*onchange="const v=this\.value;this\.value='';omsRerenderKeepingCaret\('task-bulk',function\(\)\{omsBulkStatus\(v\)\}\)"/.test(html));
  // The header box is correct by construction: it paints a sibling panel.
  ok('Rev 67: the header box still paints a separate panel rather than its own container',
     /getElementById\('gsres'\)/.test(String(G('omsGlobalSearchInput'))) &&
     !/renderAll\(|rTasks\(|rCal\(|rSOPs\(/.test(String(G('omsGlobalSearchInput'))));
}
// ---- Rev 68: the calendar filters, and categories you can add and remove.
console.log('\n# Rev 68: out of office is ordinary, Standing is Recurring, categories can be added and deleted');
{
  T.fn("globalThis.__s68=JSON.stringify({e:ST.events,t:ST.tasks,s:ST.sops})");
  T.fn("ST.events=[{id:'o1',title:'Dean away',date:'2030-04-01',category:'EB OOO',source:'Ari'}," +
       "{id:'o2',title:'Cabinet',date:'2030-04-02',category:'Cabinet',source:'Ari',recurring:true}];" +
       "ST.tasks=[];ST.sops=[];calSrc='overlay';calCadence='all';calSearch=''");
  const ids = () => G('omsCalItems')().map(e => e.id);
  ok('Rev 68: an out-of-office entry is on the calendar like any other event',
     ids().includes('o1'), ids().join(','));
  T.fn("calCadence='standing'");
  ok('Rev 68: the Recurring chip still filters on the stored recurring flag',
     ids().join(',') === 'o2', ids().join(','));
  T.fn("calCadence='oneoff'");
  ok('Rev 68: ...and One-off still shows the rest, out-of-office included', ids().join(',') === 'o1');
  T.fn("calCadence='all'");
  ok('Rev 68: the chip reads Recurring and keeps its circular arrow',
     /&#8635; Recurring<\/div>/.test(html) && !/>&#8635; Standing only<\/div>/.test(html));

  // Categories: add, reject a duplicate, delete only what nothing uses.
  T.fn("ST.events=[{id:'c1',title:'x',date:'2030-05-05',category:'Cabinet'}];ST.tasks=[];ST.sops=[]");
  T.fn("localStorage.removeItem('cao_oms_categories');_cgKey=null");
  const has = c => G('eventCategories')().includes(c);
  T.fn("document.getElementById('cat_new').value='Board Retreat';omsAddCategory()");
  ok('Rev 68: a category can be added from the Categories dialog', has('Board Retreat'));
  const before = G('eventCategories')().length;
  T.fn("document.getElementById('cat_new').value='board retreat';omsAddCategory()");
  ok('Rev 68: ...and a duplicate is refused whatever its case',
     G('eventCategories')().length === before && ALERTS.some(a => /already on the list/.test(a)));
  const idxOf = c => G('eventCategories')().indexOf(c);
  T.fn('omsDeleteCategory(' + idxOf('Board Retreat') + ')');
  ok('Rev 68: an unused category can be deleted', !has('Board Retreat'));
  ALERTS.length = 0;
  T.fn("ST.events=[{id:'c2',title:'y',date:'2030-05-06',category:'Away Day'}];_cgKey=null");
  ok('Rev 68: a category is on the list because a record carries it', has('Away Day'));
  T.fn('omsDeleteCategory(' + idxOf('Away Day') + ')');
  ok('Rev 68: ...and deleting one still in use is refused, with the counts',
     has('Away Day') && ALERTS.some(a => /still used by 1 event/.test(a)), ALERTS.join(' | '));
  ALERTS.length = 0;
  T.fn("localStorage.setItem('cao_oms_categories',JSON.stringify(['Board Meeting']));_cgKey=null");
  T.fn('omsDeleteCategory(' + idxOf('Board Meeting') + ')');
  ok('Rev 68: a built-in is never deletable, however it got onto the custom list',
     has('Board Meeting') && ALERTS.some(a => /built-in/.test(a)), ALERTS.join(' | '));
  ok('Rev 68: the add box keeps focus, so the guard has nothing to find',
     /omsRerenderKeepingCaret\('cat_new',omsRefreshCatSection\)/.test(main));
  T.fn("localStorage.removeItem('cao_oms_categories');_cgKey=null");
  T.fn("const __x=JSON.parse(globalThis.__s68);ST.events=__x.e;ST.tasks=__x.t;ST.sops=__x.s;_dirty.clear()");
  ALERTS.length = 0;
}
// Rev 69. Rev 68 claimed one word and left three strings a user can actually
// read still saying "standing": the Cadence line on an export's About sheet,
// the import preview's Mark/Not toggle buttons, and one guide sentence. The
// internal token calCadence==='standing' and the importer's title-word regex
// are deliberately unchanged and are not user-facing.
// Scoped to strings a user can actually read. Two CODE COMMENTS legitimately
// discuss "a standing series" and "not a standing meeting" while explaining the
// importer's title rule, and a blanket search flags those, so the check names
// the surfaces instead: the preview's toggle buttons and the export's Cadence line.
// Outside OMS_REV_LOG, which is append-only history and legitimately quotes the
// very strings this removed - the Rev 69 release note names all three, and an
// unscoped check therefore fails on its own changelog the moment it ships.
const _lg = html.indexOf('const OMS_REV_LOG=[');
const outsideLog = _lg < 0 ? html : html.slice(0, _lg) + html.slice(html.indexOf('\n];', _lg));
ok('Rev 69: no control or export still says standing',
   !/Mark standing/.test(outsideLog) && !/Not standing/.test(outsideLog)
   && !/'standing only'/.test(outsideLog));
ok('Rev 69: ...and the guide sentence about an annual gala says recurring',
   /not a recurring meeting\.<\/li>/.test(html) || /one-off, not a recurring meeting/.test(html));
ok('Rev 69: ...while the internal filter token and the importer word list are untouched',
   /calCadence==='standing'/.test(main) && /standing\|recurring/.test(main));

// ---- Rev 70: categories are shared canonical data.
console.log('\n# Rev 70: a category one person adds is everybody\'s');
{
  T.fn("globalThis.__s70=JSON.stringify({e:ST.events,t:ST.tasks,s:ST.sops,c:ST.categories||null})");
  T.fn("ST.events=[];ST.tasks=[];ST.sops=[];ST.categories=[];localStorage.removeItem('cao_oms_categories');_cgKey=null;_dirty.clear()");
  const cats = () => G('eventCategories')();
  T.fn("document.getElementById('cat_new').value='Board Retreat';omsAddCategory()");
  ok('Rev 70: Add writes a record into the shared collection, not localStorage',
     T.st.categories.length === 1 && T.st.categories[0].name === 'Board Retreat'
     && T.fn("localStorage.getItem('cao_oms_categories')") === null,
     JSON.stringify(T.st.categories));
  ok('Rev 70: ...with an id of its own, so it can be synced like any record',
     /^cat-board-retreat$/.test(T.st.categories[0].id), T.st.categories[0].id);
  ok('Rev 70: ...and the collection is marked dirty so the save actually goes',
     T.fn("_dirty.has('categories')") === true);
  ok('Rev 70: ...and it appears on the list', cats().includes('Board Retreat'));

  // A rename is an update to the record AND a rewrite of what uses it.
  T.fn("ST.tasks=[{id:'k1',title:'x',category:'Board Retreat'}];_dirty.clear()");
  const moved = G('renameCategory')('Board Retreat', 'Board Away Day');
  ok('Rev 70: a rename rewrites the records carrying the old name', moved === 1, moved + ' moved');
  ok('Rev 70: ...and renames the shared record in place, keeping its id',
     T.st.categories[0].name === 'Board Away Day' && T.st.categories[0].id === 'cat-board-retreat',
     JSON.stringify(T.st.categories[0]));
  // The case the old code lost: nothing uses it, so k is 0 and it returned early.
  T.fn("ST.tasks=[];_dirty.clear()");
  const none = G('renameCategory')('Board Away Day', 'Away Day');
  ok('Rev 70: renaming a category NOTHING uses still persists',
     none === 0 && T.st.categories[0].name === 'Away Day', none + '/' + T.st.categories[0].name);
  ok('Rev 70: ...and still queues a save', T.fn('_dirty.size') > 0);

  // Delete removes the shared record for everybody.
  T.fn("_dirty.clear()");
  T.fn('omsDeleteCategory(' + G('eventCategories')().indexOf('Away Day') + ')');
  ok('Rev 70: deleting a shared category removes the record',
     T.st.categories.length === 0 && !cats().includes('Away Day'), JSON.stringify(T.st.categories));
  ok('Rev 70: ...and marks the collection dirty', T.fn("_dirty.has('categories')") === true);

  // The legacy per-browser list is still read, and can be promoted.
  T.fn("ST.categories=[];localStorage.setItem('cao_oms_categories',JSON.stringify(['Old Local']));_cgKey=null;_dirty.clear()");
  ok('Rev 70: a category added before this shipped is still on the list', cats().includes('Old Local'));
  T.fn('omsShareCategory(' + G('eventCategories')().indexOf('Old Local') + ')');
  ok('Rev 70: Share promotes it to the shared collection',
     T.st.categories.length === 1 && T.st.categories[0].name === 'Old Local');
  ok('Rev 70: ...and takes it out of this browser, so it cannot come back twice',
     JSON.parse(T.fn("localStorage.getItem('cao_oms_categories')") || '[]').length === 0);
  ok('Rev 70: ...and it appears exactly once on the list',
     cats().filter(c => c === 'Old Local').length === 1);

  // A viewer may not change the shared vocabulary.
  T.fn("OMS_USER={role:'viewer',displayName:'A Viewer'};_dirty.clear();ST.categories=[]");
  T.fn("document.getElementById('cat_new').value='Sneaky';omsAddCategory()");
  ok('Rev 70: a read-only account cannot add a shared category',
     T.st.categories.length === 0 && T.fn('_dirty.size') === 0);
  T.fn("OMS_USER={role:'admin',displayName:'Hossam Elsaie'}");
  T.fn("const __y=JSON.parse(globalThis.__s70);ST.events=__y.e;ST.tasks=__y.t;ST.sops=__y.s;if(__y.c)ST.categories=__y.c;else delete ST.categories;localStorage.removeItem('cao_oms_categories');_cgKey=null;_dirty.clear()");
  ALERTS.length = 0;
}
ok('Rev 70: categories sync like every other collection',
   /'assignmentHistory','taskTemplates','categories'\]/.test(main));
ok('Rev 70: the dialog says where each category lives, and offers Share for a local one',
   /onclick="omsShareCategory\(\$\{i\}\)"/.test(html) && /this computer only/.test(html));

ok('Rev 68: the Categories dialog offers Add and Delete, and says what each does',
   /id="cat_new"/.test(html) && /onclick="omsAddCategory\(\)"/.test(html)
   && /onclick="omsDeleteCategory\(\$\{i\}\)"/.test(html)
   && /take effect at once and need no Save/.test(html));

ok('Rev 65: the header carries the search box', /<input class="srch gsin" id="gsearch"/.test(html) && /id="gsres" class="gsres" hidden/.test(html));

ok('Rev 64: below 600 px the header wraps and form fields reach 16 px, so a phone neither scrolls sideways nor zooms on focus',
   /@media\(max-width:600px\)\{header\{flex-wrap:wrap[^}]*\}\.hr\{flex-wrap:wrap\}/.test(html)
   && /#mbody input,#mbody select,#mbody textarea\{font-size:16px\}/.test(html));
ok('Rev 64: the phone rule does not touch the desktop header', /header\{background:var\(--nv\);color:#fff;padding:12px 20px;display:flex;justify-content:space-between;align-items:center;position:sticky/.test(html));
ok('Rev 63: five Export buttons, one per grid',
   (html.match(/onclick="omsExport(Tasks|Calendar|Sops|Rob|People)\(\)"/g) || []).length === 5,
   (html.match(/onclick="omsExport(Tasks|Calendar|Sops|Rob|People)\(\)"/g) || []).length + ' found');
  {
    const h = build();
    h.run(`OMS_POST=async()=>{throw new Error('offline')};ST.tasks[0].title='Really unsent';OMS_EDIT_SEQ++;OMS_COLLECTIONS.forEach(t=>_dirty.add(t));`);
    const p = h.run(`OMS_QUEUE_SYNC()`); await h.advance(3000); try { await p; } catch (_) {}
    ok('Rev 59: an ordinary failure still arms the pending copy', h.run(`localStorage.getItem(OMS_PENDING_KEY)`) !== null);
  }

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

// ================================================================ REV 53
// The workbook importer. Every assertion here stands for a defect that was in
// the shipped artifact and that the rest of this suite did not see.
console.log('\n# Workbook importer (Rev 53)');
{
  const savedST53 = T.st;
  const cut53 = html.indexOf('const OMS_REV_LOG');
  const end53 = cut53 > -1 ? html.indexOf('];', cut53) : -1;
  const prose53 = (cut53 > -1 && end53 > -1) ? html.slice(0, cut53) + html.slice(end53) : html;
  const ciSrc = String(G('confirmImport') || '');
  const prevSrc = String(G('showImportPreview') || '');

  // ---- B-02: three random characters is not enough for a 182-row import
  const uid53 = G('uid');
  ok('B-02: uid is defined', typeof uid53 === 'function');
  if (typeof uid53 === 'function') {
    const n = 20000, seen = new Set();
    for (let i = 0; i < n; i++) seen.add(uid53());
    ok('B-02: 20000 ids minted back to back are all distinct', seen.size === n,
       seen.size + ' of ' + n + ' - a collision here is a record OMS_MAP drops in silence');
    ok('B-02: the random tail is eight characters wide',
       /Math\.random\(\)\.toString\(36\)\.slice\(2,10\)/.test(String(uid53)));
  }

  // ---- B-04: the sheet skip list never skipped anything
  ok('B-04: the sheet skip list is lower-cased on BOTH sides',
     /includes\(String\(s\)\.toLowerCase\(\)\)/.test(String(G('processImportFile') || '')));

  // ---- B-06/B-13/B-14: dates that are not dates
  const xl53 = G('xlSerialToDate');
  ok('B-06: xlSerialToDate is defined', typeof xl53 === 'function');
  if (typeof xl53 === 'function') {
    ok('B-06: a real slash date still parses', xl53('3/4/2026') === '2026-03-04');
    ok('B-06: a two-digit year is still expanded', xl53('3/4/26') === '2026-03-04');
    ok('B-06: an ISO cell still passes through', xl53('2026-03-04') === '2026-03-04');
    ok('B-06: an ISO timestamp is trimmed to the date', xl53('2026-03-04T09:00:00Z') === '2026-03-04');
    ok('B-06: 13/45/2026 is REFUSED, not turned into 2026-13-45',
       xl53('13/45/2026') === '', 'this one rendered NaN on the Dean-facing calendar');
    ok('B-06: an impossible ISO date is refused', xl53('2026-13-45') === '');
    ok('B-06: 2/30 is refused - the round trip through Date catches it', xl53('2/30/2026') === '');
    ok('B-14: an unanchored match no longer wins - free text is refused',
       xl53('week of 3/4 or 3/5, TBC') === '' && xl53('next Tuesday') === '');
    ok('B-13: serial 0 is refused rather than becoming 1899-12-30',
       xl53(0) === '' && xl53(-5) === '' && xl53(0.5) === '');
    ok('B-06: a real serial still converts',
       xl53(45000) === new Date(Math.round((45000 - 25569) * 86400 * 1000)).toISOString().slice(0, 10));
    ok('B-06: an empty cell is still empty', xl53('') === '' && xl53(null) === '');
  }
  ok('B-06: a workbook row whose date cell cannot be read is counted, not swallowed',
     /_importDropped\+\+/.test(String(G('parseEventsSheet') || '')) && /_importDropped/.test(prevSrc));

  // ---- B-05/B-12: the year was hard-coded
  ok('B-05: no hard-coded 2026/2027 pair survives in the Key Dates parser',
     !/colIndex<12\?2026:2027/.test(main));
  const baseYear = G('omsImportBaseYear'), colYears = G('omsKeyDateColumnYears'), lead53 = G('parseKeyDateLead');
  ok('B-05: omsImportBaseYear is defined', typeof baseYear === 'function');
  if (typeof baseYear === 'function') {
    ok('B-05: the year comes from the sheet name', baseYear('2028 Key Dates', []) === 2028);
    ok('B-05: or from the first few cells', baseYear('Key Dates', [['', 'Planning calendar 2029']]) === 2029);
    ok('Rev 58: a date lead deeper in the sheet does not become the year', baseYear('Key Dates', [['Key Dates Calendar'], ['January', 'February'], ['Q1'], ['3/19\nState of the School'], [''], ['1/11/2027 (confirm)\nState of the School']]) === 0);
    ok('Rev 58: a date expression in the header rows is not a year either', baseYear('Key Dates', [['Planning 1/1/2027 - 12/31/2027']]) === 0);
    ok('B-05/Rev 57: a sheet stating no year returns 0, and the parser hands the question back instead of refusing',
       baseYear('Key Dates', [['Q1', 'Q2']]) === 0 && /if\(!range\|\|!range\.start\|\|!range\.end\)return null/.test(String(G('parseKeyDatesSheet') || '')));
    ok('Rev 57: the import path asks for the period when the parser hands back null', /parsed===null\)\{_importPendingKD=\{sheet,name:wb\.SheetNames\[0\]\};showKeyDatesRangePicker\(/.test(main));
    ok('Rev 57: the picker and its apply step exist', typeof G('showKeyDatesRangePicker') === 'function' && typeof G('omsApplyKeyDatesRange') === 'function');
    ok('Rev 57: a date the sheet places outside the given period is dropped and counted', /if\(range&&range\.start&&range\.end&&\(date<range\.start\|\|date>range\.end\)\)\{_importOutside\+\+;_importDropped\+\+;return\}/.test(main));
    ok('Rev 57: no column may roll past the end year of the period', /if\(colYears\[c\]>endY\)colYears\[c\]=endY/.test(main));
  }
  if (typeof lead53 === 'function') {
    ok('B-05: the base year is used, not 2026', lead53('9/3', 2028) === '2028-09-03');
    ok('B-05: an explicit year in the cell still wins', lead53('9/3/2030', 2028) === '2030-09-03');
    ok('B-05: a full month name still parses', lead53('March 3', 2028) === '2028-03-03');
    ok('B-12: an abbreviated month parses',
       lead53('Mar 3', 2028) === '2028-03-03' && lead53('Sept 3', 2028) === '2028-09-03' && lead53('Sep 3', 2028) === '2028-09-03');
    ok('B-12: an ordinal suffix parses', lead53('March 3rd', 2028) === '2028-03-03' && lead53('Jan 1st', 2028) === '2028-01-01');
    ok('B-05: an impossible date is still refused', lead53('2/30', 2028) === '');
    ok('B-05: a line with no date is still refused', lead53('Board materials due', 2028) === '');
  }
  if (typeof colYears === 'function') {
    ok('B-05: a month running backwards rolls the year forward',
       colYears([['Sep 1\nA', 'Oct 1\nB', 'Jan 5\nC', 'Feb 2\nD']], 2026).join() === '2026,2026,2027,2027');
    ok('B-05: a sheet running forwards stays in its own year',
       colYears([['Jan 5\nA', 'Jun 1\nB', 'Dec 1\nC']], 2027).join() === '2027,2027,2027');
  }

  // ---- B-07: a numeric cell reaching ST.events as a Number
  ok('B-07: every mapped scalar is stringified, not only the title',
     /ev\[mapped\]=\(mapped==='date'/.test(String(G('parseEventsSheet') || '')));

  // ---- R-05: the carry-forward key
  const priorFor = G('omsPriorEventFor');
  ok('R-05: omsPriorEventFor is defined', typeof priorFor === 'function');
  if (typeof priorFor === 'function') {
    T.setST({ events: [
      { id: 'keep-1', source: 'Ari', title: 'Cabinet  Meeting', date: '2026-10-01', status: 'Retired', endDate: '2026-10-02', endTime: '4:00 PM', recurring: true },
      { id: 'keep-2', source: 'Ari', title: 'Dean’s Forum', date: '2026-10-05' },
      { id: 'keep-3', source: 'Ari', title: 'Academic Cabinet Advance and Strategy Session Day One', date: '2026-11-02' },
      { id: 'amb-1', source: 'Ari', title: 'Ambiguous Long Title That Runs Past Forty Chars One', date: '2026-12-01' },
      { id: 'amb-2', source: 'Ari', title: 'Ambiguous Long Title That Runs Past Forty Chars Two', date: '2026-12-01' },
      { id: 'mag-1', source: 'Maggie', title: 'Cabinet Meeting', date: '2026-10-01' },
    ], tasks: [] });
    const idOf = (row, src) => { const p = priorFor(row, src || 'Ari'); return p ? p.id : null; };
    ok('R-05: internal whitespace does not defeat the match',
       idOf({ title: 'Cabinet Meeting', date: '2026-10-01' }) === 'keep-1');
    ok('R-05: a straight apostrophe matches a curly one',
       idOf({ title: "Dean's Forum", date: '2026-10-05' }) === 'keep-2');
    ok('R-05: a title edited past the exact key still matches on date and its first 40 characters',
       idOf({ title: 'Academic Cabinet Advance and Strategy Session Day Two', date: '2026-11-02' }) === 'keep-3');
    ok('R-05: an ambiguous loose match is refused - two candidates is not a match',
       idOf({ title: 'Ambiguous Long Title That Runs Past Forty Chars Three', date: '2026-12-01' }) === null);
    ok('R-05: a different date is never a match',
       idOf({ title: 'Cabinet Meeting', date: '2026-10-08' }) === null);
    ok('R-05: the lookup is scoped to the source being replaced',
       idOf({ title: 'Cabinet Meeting', date: '2026-10-01' }, 'Maggie') === 'mag-1');
  }

  // ---- R-06: a derived value is a proposal, not a decision
  const cadFor53 = G('omsCadenceFor');
  if (typeof cadFor53 === 'function') {
    ok('R-06: a title-derived answer is marked undecided',
       cadFor53({ title: 'Cabinet | Weekly Series', date: '2026-01-09' }, 'Ari').decided === false);
    ok('R-06: so is the default false', cadFor53({ title: 'DEAC Gala', date: '2026-01-09' }, 'Ari').decided === false);
    ok('R-06: a preview toggle IS a decision',
       cadFor53({ title: 'DEAC Gala', date: '2026-01-09', _cadence: true }, 'Ari').decided === true);
    ok('R-06: and so is a value already on the record',
       cadFor53({ title: 'Cabinet Meeting', date: '2026-10-01' }, 'Ari').decided === true);
    ok('R-05: the carry-forward now survives a whitespace edit',
       cadFor53({ title: 'Cabinet  Meeting ', date: '2026-10-01' }, 'Ari').on === true);
  }
  ok('R-06: confirmImport stores cadence only when it is on or decided',
     /if\(cad\.on\|\|cad\.decided\)ev\.recurring=cad\.on/.test(ciSrc),
     'a derived false stored as a decision outranks the title rule for ever');

  // ---- B-03 / B-11 / R-02: a matched row keeps its event
  ok('B-03: a matched row reuses the prior id, so task links survive',
     /id:\(prior&&prior\.id\)\|\|uid\(\)/.test(ciSrc));
  ok('B-03: a prior id is lent to at most one row',
     /lent\.has\(String\(prior\.id\)\)/.test(ciSrc), 'two kept duplicates must not share an id');
  ok('R-02: Status is carried forward, so a re-import cannot un-retire an event',
     /if\(prior\.status\)ev\.status=prior\.status/.test(ciSrc));
  ok('B-11: End Date and End Time are carried forward',
     /if\(prior\.endDate\)ev\.endDate=prior\.endDate/.test(ciSrc) && /if\(prior\.endTime\)ev\.endTime=prior\.endTime/.test(ciSrc));
  ok('B-11: a note on the record survives a workbook row that carries none',
     /notes:r\.notes\|\|\(prior&&prior\.notes\)\|\|''/.test(ciSrc));

  // ---- B-03: how many task links a replacement would break
  const orph = G('omsImportOrphanedTasks');
  ok('B-03: omsImportOrphanedTasks is defined', typeof orph === 'function');
  if (typeof orph === 'function') {
    T.setST({ events: [
      { id: 'e-keep', source: 'Ari', title: 'Kept', date: '2026-03-01' },
      { id: 'e-gone', source: 'Ari', title: 'Dropped', date: '2026-03-02' },
      { id: 'e-mag', source: 'Maggie', title: 'Other source', date: '2026-03-03' },
    ], tasks: [
      { id: 't1', title: 'a', sourceEventId: 'e-keep' },
      { id: 't2', title: 'b', sourceEventId: 'e-gone' },
      { id: 't3', title: 'c', sourceEventId: 'e-gone' },
      { id: 't4', title: 'd', sourceEventId: 'e-mag' },
      { id: 't5', title: 'e' },
    ] });
    ok('B-03: tasks on an event no incoming row matches are counted as orphaned',
       orph([{ title: 'Kept', date: '2026-03-01', _status: 'new' }], 'Ari') === 2);
    ok('B-03: nothing is orphaned when every event is matched',
       orph([{ title: 'Kept', date: '2026-03-01', _status: 'new' },
             { title: 'Dropped', date: '2026-03-02', _status: 'new' }], 'Ari') === 0);
    ok('B-03: a row the preview will SKIP does not keep its event alive',
       orph([{ title: 'Kept', date: '2026-03-01', _status: 'new' },
             { title: 'Dropped', date: '2026-03-02', _status: 'skip' }], 'Ari') === 2);
    ok('B-03: the other calendar source is not counted',
       orph([], 'Ari') === 3, 'three of the five tasks belong to Ari events');
  }
  ok('B-03: the number is on screen in the preview and in the confirm prompt',
     /omsImportOrphanedTasks\(/.test(prevSrc) && /omsImportOrphanedTasks\(/.test(ciSrc));
  ok('B-03: the prompt no longer claims non-calendar data is simply unchanged',
     !/Tasks and all non-calendar data will remain unchanged/.test(ciSrc));
  ok('B-03: it says what happens to a task link instead',
     /loses its source-event link/.test(ciSrc));

  // ---- B-08: the import must not discard other people's pending work
  ok('B-08: the import no longer clears every dirty collection',
     !/_dirty\.clear\(\)/.test(ciSrc) && /_dirty\.add\('events'\)/.test(ciSrc),
     'a task edited a moment earlier was never sent');

  // ---- B-09: a safety check that can fail, and can undo
  const snap53 = G('snapshotProtectedCollections'),
        verify53 = G('verifyProtectedCollections'),
        restore53 = G('restoreProtectedCollections');
  ok('B-09: restoreProtectedCollections is defined', typeof restore53 === 'function');
  if (typeof snap53 === 'function' && typeof verify53 === 'function' && typeof restore53 === 'function') {
    T.setST({ events: [{ id: 'e1', source: 'Ari', title: 'A', date: '2026-01-01' }],
              tasks: [{ id: 't1', title: 'T' }], sops: [] });
    const s = snap53();
    ok('B-09: the snapshot covers events too, so a rollback can restore them',
       Object.prototype.hasOwnProperty.call(s, 'events'));
    ok('B-09: an untouched state verifies', verify53(s) === true);
    T.fn("ST.events.push({id:'e2',source:'Ari',title:'B',date:'2026-01-02'})");
    ok('B-09: a change to events alone is not a failure - events are what is being replaced',
       verify53(s) === true);
    T.fn("ST.tasks.push({id:'t2',title:'sneaked in'})");
    ok('B-09: a change to a protected collection DOES fail verification', verify53(s) === false,
       'the old guard compared collections nothing between the two calls could touch');
    restore53(s);
    ok('B-09: and the snapshot puts every collection back',
       (T.st.tasks || []).length === 1 && (T.st.events || []).length === 1);
  }
  ok('B-09: the failure path restores before it claims nothing was saved',
     /restoreProtectedCollections\(protectedSnapshot\);alert\('Safety check failed\. Replacement was not saved/.test(ciSrc));
  ok('B-09: the events array is built before ST.events is assigned',
     ciSrc.indexOf('const nextEvents=') > -1 &&
     ciSrc.indexOf('const nextEvents=') < ciSrc.indexOf('ST.events=nextEvents'));
  ok('B-09: verification runs before the write, not after it',
     ciSrc.indexOf('verifyProtectedCollections(protectedSnapshot)') < ciSrc.indexOf('ST.events=nextEvents'));

  // ---- B-10: a workbook that would shrink a calendar
  ok('B-10: the Events path has a replacement-size guard',
     /SIZE CHECK/.test(ciSrc) && /currentCount>=10&&selected\.length\*2<currentCount/.test(ciSrc));
  ok('B-10: it demands a typed REPLACE and names both numbers',
     /Type REPLACE to remove \$\{currentCount\} records and keep only \$\{selected\.length\}/.test(ciSrc));
  ok('B-10: and the guide describes it', /typed out a second time with both numbers/.test(prose53));

  // ---- B-16: short titles were colliding
  const xdup53 = G('crossSourceDuplicates'), dupStop = G('DUP_STOP');
  ok('B-16: the stop list covers the words that made short titles collide',
     ['annual', 'committee', 'board', 'office', 'dean', 'advance', 'retreat', 'call', 'review']
       .every(w => dupStop && dupStop.has(w)));
  if (typeof xdup53 === 'function') {
    T.setST({ events: [
      { id: 'm9', source: 'Maggie', title: 'Board Retreat Charlotte Airport', date: '2026-05-05' },
      { id: 'm10', source: 'Maggie', title: 'Convocation', date: '2026-05-06' },
      { id: 'm11', source: 'Maggie', title: 'White Coat - CLT', date: '2026-07-25' },
    ], tasks: [] });
    ok('B-16: one shared token between two multi-token titles is NOT a duplicate',
       xdup53([{ title: 'Committee Review Charlotte Winston', date: '2026-05-05' }], 'Ari').length === 0,
       'one hit over a minimum size of two scored 0.5 and passed');
    ok('B-16: a genuinely one-token title is still matched on the token it has',
       xdup53([{ title: 'Convocation Ceremony', date: '2026-05-06' }], 'Ari').length === 1);
    ok('B-16: the real production duplicate is still caught',
       xdup53([{ title: 'White Coat Ceremony - CLT', date: '2026-07-25' }], 'Ari').length === 1);
  }

  // ---- R-08: the regex and the guide have to agree
  const der53 = G('omsDeriveCadence');
  if (typeof der53 === 'function') {
    ok('R-08: daily is a cadence word', der53('Daily huddle'));
    ok('R-08: biweekly without a hyphen is a cadence word', der53('Ops sync biweekly'));
    ok('R-08: bimonthly, with and without the hyphen', der53('Bimonthly review') && der53('Bi-monthly review'));
    ok('R-08: annual is still deliberately excluded',
       !der53('Annual Match Day celebration'), 'a gala once a year is not a standing meeting');
    ok('R-08: a word merely containing a cadence word still does not match',
       !der53('Biweeklyish') && !der53('Semimonthlyish') && !der53('Dailyish'));
  }
  ok('R-08: the guide lists exactly the words the regex matches',
     /Daily, Weekly, Bi-weekly, Monthly, Bi-monthly, Quarterly, Semi-annual, Standing or Recurring/.test(prose53));

  // ---- R-09: the chip counted rows that would never be written
  ok('R-09: the Standing chip counts selected rows only',
     /const standingCount=rows\.filter\(r=>\(r\._status==='new'\|\|r\._status==='force'\)&&omsCadenceFor/.test(prevSrc));
  ok('R-09: and the chip renders that count', /\$\{standingCount\} Recurring/.test(prevSrc));

  // ---- R-13: one word for one bit
  ok('R-13 / Rev 68: the preview column is Recurring',
     /<th>Recurring<\/th>/.test(prevSrc) && !/<th>Cadence<\/th>/.test(prevSrc) && !/<th>Standing<\/th>/.test(prevSrc));
  ok('R-13 / Rev 68: the event form label is Recurring', /<label>Recurring<\/label>/.test(prose53));
  ok('R-13 / Rev 68: one word still, and no screen calls this bit Standing any more',
     !/<em>Standing<\/em>/.test(prose53) && !/Standing meeting/.test(html) && !/&#8635; Standing/.test(html),
     'Rev 53 unified on Standing; Rev 68 moved the same single word to Recurring');
  ok('R-13: the stored field name is unchanged', /id="f_recurring"/.test(html) && /e\.recurring/.test(main));

  T.setST(savedST53);
}

// ================================================================ REV 52
// Correctness pass of 6 September 2026. Every assertion here pins a defect
// that shipped and passed the whole gate, so each one names what was wrong
// rather than what the code now looks like.

console.log('\n# Rev 54: dates (C-02, C-14, R-12)');
{
  const dF = G('dFrom'), tISO = G('todayISO'), iso = G('isoDate');
  ok('todayISO and isoDate are defined', typeof tISO === 'function' && typeof iso === 'function');
  if (typeof iso === 'function') {
    ok('isoDate zero-pads month and day', iso(new Date(2026, 0, 5)) === '2026-01-05', iso(new Date(2026, 0, 5)));
  }
  if (typeof tISO === 'function') {
    const T0 = G('TODAY');
    ok('todayISO is the LOCAL day, not the UTC one',
       tISO() === T0.getFullYear() + '-' + String(T0.getMonth() + 1).padStart(2, '0') + '-' + String(T0.getDate()).padStart(2, '0'),
       'toISOString() is already tomorrow west of Greenwich for the whole evening');
  }
  ok('no surface derives "today" from toISOString any more',
     !/new Date\(\)\.toISOString\(\)\.slice\(0,10\)/.test(main),
     'four SOP and checklist sites and four intake sites did');

  // C-02. The off-by-one is a property of the fall-back boundary, so it is
  // measured under a timezone that HAS one rather than under whatever the
  // machine running the suite happens to be set to. A child process is the
  // only way to change TZ after the first Date has been constructed.
  const probe = (fn) => execFileSync(process.execPath, ['-e',
    "const NOW=new Date(2026,8,6);" +
    "const TODAY=new Date(NOW.getFullYear(),NOW.getMonth(),NOW.getDate(),12,0,0);" +
    "const dp=s=>new Date(s+'T12:00:00');" +
    "console.log(Math." + fn + "((dp('2026-11-05')-TODAY)/86400000))"],
    { env: Object.assign({}, process.env, { TZ: 'America/New_York' }), encoding: 'utf8' }).trim();
  ok('CONTROL: 6 Sept to 5 Nov 2026 is 60 calendar days', probe('round') === '60', probe('round'));
  ok('CONTROL: Math.ceil reads it as 61 across the fall-back boundary', probe('ceil') === '61',
     'the clocks give back an hour and ceil rounds that hour up to a whole day');
  ok('C-02: dFrom rounds, so it is exact either side of the boundary',
     /Math\.round\(\(dp\(s\)-TODAY\)\/86400000\)/.test(main) && !/Math\.ceil\(\(dp\(s\)-TODAY\)/.test(main));
  if (typeof dF === 'function') {
    const T0 = G('TODAY');
    const at = n => { const x = new Date(T0); x.setDate(x.getDate() + n);
      return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    let bad = null;
    for (let n = -400; n <= 400 && bad === null; n++) if (dF(at(n)) !== n) bad = n + ' -> ' + dF(at(n));
    ok('C-02: dFrom(N days from today) === N for every day in a 800-day window', bad === null, bad || '');
  }
}

console.log('\n# Rev 54: sorting, statuses and saved views (C-04, C-11, C-05, R-07)');
{
  const st = G('sortTasks');
  if (typeof st === 'function') {
    const rows = [{ id: 'x', due: '', owner: '', category: '' },
                  { id: 'y', due: '2026-01-01', owner: 'Ari', category: 'A' },
                  { id: 'z', due: '2026-02-01', owner: 'Zoe', category: 'B' }];
    const ids = (k, d) => st(rows.slice(), k, d).map(r => r.id).join('');
    ok('C-04: a blank due date sorts last ascending', ids('due', 'asc') === 'yzx', ids('due', 'asc'));
    ok('C-04: and last DESCENDING too', ids('due', 'desc') === 'zyx', ids('due', 'desc'));
    ok('C-04: a blank owner sorts last in both directions',
       ids('owner', 'asc') === 'yzx' && ids('owner', 'desc') === 'zyx');
    ok('C-04: a blank category sorts last in both directions',
       ids('category', 'asc') === 'yzx' && ids('category', 'desc') === 'zyx');
    const unk = [{ id: 'u', priority: 'Wat', _s: 'Wat' }, { id: 'h', priority: 'High', _s: 'Overdue' }];
    ok('C-04: an unrecognized priority sorts last in both directions',
       st(unk.slice(), 'priority', 'asc').map(r => r.id).join('') === 'hu' &&
       st(unk.slice(), 'priority', 'desc').map(r => r.id).join('') === 'hu');
    ok('C-04: and an unrecognized status likewise',
       st(unk.slice(), 'status', 'asc').map(r => r.id).join('') === 'hu' &&
       st(unk.slice(), 'status', 'desc').map(r => r.id).join('') === 'hu');
  }

  const order = G('omsTaskStatusOrder'), STL = G('OMS_TASK_STATUSES');
  ok('C-11: OMS_TASK_STATUSES is finally read by something',
     Array.isArray(STL) && typeof order === 'function');
  if (Array.isArray(STL) && typeof order === 'function') {
    ok('C-11: the chip order is the display order it has always had',
       order().join(',') === 'In Progress,Not Started,Complete,Retired', order().join(','));
    ok('C-11: the chips are built from the constant, not a second copy',
       /'All','Overdue','At risk','Blocked',\.\.\.omsTaskStatusOrder\(\)/.test(main));
    ok('C-11: and so is the Status box on the task form',
       /OMS_TASK_STATUSES\.map\(/.test(String(G('openTaskModal') || '')));
    ok('C-11: no hardcoded status list survives in rTasks or the form',
       !/'In Progress','Not Started','Complete','Retired'/.test(main));
  }

  const vf = G('omsViewFilters');
  if (typeof vf === 'function') {
    T.fn("calCadence='standing'");
    const f = vf('cal');
    ok('C-05: a saved calendar view records the cadence filter', f.cad === 'standing', JSON.stringify(f));
    // Rev 68 removed the out-of-office filter, so a view no longer carries one.
    ok('Rev 68: and no longer records an out-of-office filter', f.ooo === undefined, JSON.stringify(f));
    T.fn("calCadence='all'");
    const av = G('omsApplyView'), wv = G('omsWriteViews');
    if (typeof av === 'function' && typeof wv === 'function') {
      T.setST({ events: [], tasks: [], sops: [], people: [] });
      wv([{ id: 'cv', scope: 'cal', name: 'Recurring', filters: { src: 'ari', view: 'grid', q: '', cad: 'standing', ooo: true } }]);
      av('cv');
      ok('C-05: applying it restores the cadence filter', T.fn('calCadence') === 'standing', T.fn('calCadence'));
      // A view saved before Rev 68 still carries ooo. It must be ignored, not
      // resurrect a filter the screen no longer has.
      ok('Rev 68: an ooo key on an older saved view is ignored, not honored',
         T.fn("typeof calShowOoo") === 'undefined');
      wv([{ id: 'cv2', scope: 'cal', name: 'Old', filters: { src: 'ari', view: 'grid', q: '' } }]);
      av('cv2');
      ok('C-05: a view saved before this shipped restores to "show everything"',
         T.fn('calCadence') === 'all');
      wv([]);
    }
  }

  // C-05b / R-07. A filter the control cannot display is a table that looks
  // empty for no stated reason.
  if (typeof G('rTasks') === 'function') {
    T.setST({ events: [], sops: [], people: [], notifications: [],
      tasks: [{ id: 't1', title: 'Live', owner: 'Ari Ball', category: 'Cabinet', status: 'Not Started', due: '' }] });
    T.fn("taskSort=''"); T.fn("taskSortDir='asc'"); T.fn("taskSt='All'"); T.fn("taskQ=''");
    T.fn("taskOw='All'"); T.fn("taskCat='Category That Went Away'");
    const out = T.fn('rTasks()'), h = ELS['tasks'].innerHTML;
    ok('C-05: a category filter that no longer exists is still shown as selected',
       /selected>Category That Went Away</.test(h),
       'the select read All while the table showed nothing, so the control was lying');
    T.fn("taskCat='All'"); T.fn("taskOw='Somebody Who Left'");
    T.fn('rTasks()');
    ok('C-05: and an owner filter that no longer exists likewise',
       /selected>Somebody Who Left</.test(ELS['tasks'].innerHTML));
    T.fn("taskOw='All'");
    T.setST({ events: [], sops: [], people: [], notifications: [],
      tasks: [{ id: 't1', title: 'Nobody owns this', owner: '', category: '', status: 'Not Started', due: '' }] });
    T.fn("taskCat='All'"); T.fn('rTasks()');
    ok('A-06: the owner filter names the unassigned bucket instead of offering a blank option',
       /<option value="" >\(unassigned\)<\/option>|<option value="" selected>\(unassigned\)<\/option>/.test(ELS['tasks'].innerHTML),
       'A-06 makes unassigned tasks ordinary, so the filter that collects them has to be readable');
  }
  if (typeof G('rSOPs') === 'function') {
    T.setST({ events: [], tasks: [], people: [], notifications: [],
      sops: [{ id: 's1', process: 'Live SOP', category: 'Cabinet', owner: '', notes: '' }] });
    T.fn("sopQ=''"); T.fn("sopCat='Category That Went Away'");
    T.fn('rSOPs()');
    ok('R-07: the SOP category filter tells the truth the same way',
       /selected>Category That Went Away</.test(ELS['sops'].innerHTML));
    T.fn("sopCat='All'");
  }
}

console.log('\n# Rev 54: Retired means retired (A-19, C-07, R-03, R-10)');
{
  const ets = G('eventTaskStats');
  if (typeof ets === 'function') {
    T.setST({ tasks: [
      { id: 'a', sourceEventId: 'e1', status: 'Complete' },
      { id: 'b', sourceEventId: 'e1', status: 'Retired' },
      { id: 'c', sourceEventId: 'e1', status: 'In Progress' }] });
    const st = ets('e1');
    ok('A-19: eventTaskStats reports an active count', st.active === 2, JSON.stringify(st));
    ok('A-19: total still counts everything, for the Linked Tasks box', st.total === 3);
    ok('A-19: the calendar pill divides by active, not total',
       /\$\{stats\.open\}\/\$\{stats\.active\}/.test(main) && !/\$\{stats\.open\}\/\$\{stats\.total\}/.test(main),
       'retiring work used to make an event look LESS complete');
    ok('A-19: and so does the calendar list row',
       /eventTaskStats\(e\.id\)\.done\}\/\$\{eventTaskStats\(e\.id\)\.active\}/.test(main));
  }
  const tci = G('taskCalendarItems');
  if (typeof tci === 'function') {
    T.setST({ tasks: [{ id: 't9', title: 'Dropped', due: '2026-09-10', status: 'Retired' }] });
    const item = tci()[0] || {};
    ok('C-07: a task calendar item carries its status', item.status === 'Retired', JSON.stringify(item));
    const isR = G('isRetired');
    ok('C-07: so isRetired can see it', typeof isR === 'function' && isR(item) === true);
    ok('C-07: and the Retired marker is no longer withheld from tasks',
       !/!e\.isTask&&isRetired\(e\)/.test(main),
       'a retired task rendered on the month grid as an ordinary pill');
    ok('C-07: the marker is still on both calendar surfaces',
       /bret">Retired/.test(String(G('buildCalGrid') || '')) &&
       /bret">Retired/.test(String(G('buildCalList') || '')));
  }
  const soon = G('sopsDueSoon'), card = G('sopReviewCard');
  if (typeof soon === 'function' && typeof card === 'function') {
    const T0 = G('TODAY');
    const at = n => { const x = new Date(T0); x.setDate(x.getDate() + n);
      return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    T.setST({ events: [], tasks: [], people: [], notifications: [], sops: [
      { id: 'sa', process: 'Live one', reviewDue: at(5), owner: '', notes: '' },
      { id: 'sb', process: 'Withdrawn one', reviewDue: at(-40), status: 'Retired', owner: '', notes: '' }] });
    const got = soon(30).map(x => x.id);
    ok('R-03: sopsDueSoon excludes a Retired procedure', got.indexOf('sb') === -1, got.join(','));
    ok('R-03: and still returns the live one', got.indexOf('sa') !== -1);
    T.setST({ events: [], tasks: [], people: [], notifications: [],
      sops: [{ id: 'sb', process: 'Withdrawn one', reviewDue: at(-40), status: 'Retired', owner: '', notes: '' }] });
    ok('R-03: with nothing but a Retired SOP the card does not claim a date is on file',
       /No SOP has a review date yet/.test(card()),
       'saying "every review is more than 30 days away" would be a different lie');
    ok('C-14: the review horizon is built from TODAY with setDate, not from a UTC instant',
       /const lim=new Date\(TODAY\);lim\.setDate\(lim\.getDate\(\)\+days\)/.test(main));
  }
  const field = G('omsStatusField');
  if (typeof field === 'function') {
    ok('R-10: the Status hint describes the badge, which is what is drawn',
       /marked with a Retired badge/.test(field('f_x', '')) && !/struck through/.test(field('f_x', '')),
       'only .bret carries the line-through; the row never did');
    // A-21
    const odd = field('f_x', 'Under review');
    ok('A-21: an unrecognized status is kept as a selected option',
       /<option selected>Under review<\/option>/.test(odd), odd);
    ok('A-21: and Current is NOT also preselected', !/<option selected>Current<\/option>/.test(odd));
    ok('A-21: a blank status still defaults to Current',
       /<option selected>Current<\/option>/.test(field('f_x', '')));
    ok('A-21: and Retired still opens on Retired', /selected>Retired/.test(field('f_x', 'Retired')));
  }
}

console.log('\n# Rev 54: the save path (A-04, A-07, A-13, A-14, A-17)');
{
  const save = G('saveModal'), openT = G('openTaskModal');
  const clear = () => { Object.keys(FIELDS).forEach(k => delete FIELDS[k]); ALERTS.length = 0; };
  if (typeof save === 'function' && typeof openT === 'function') {
    // A-04: fields the form does not carry must survive an edit.
    T.setST({ events: [], sops: [], people: [], notifications: [], assignmentHistory: [],
      tasks: [{ id: 'k1', title: 'Old title', owner: '', status: 'Not Started', priority: 'Medium',
                due: '', notes: '', category: '', dependsOn: '', sourceEventId: '', sourceEventTitle: '',
                _version: 7, _updatedBy: 'oms-ari-ball', _updatedAt: '2026-09-01T00:00:00Z' }] });
    clear(); openT('k1');
    FIELDS.f_title = 'New title';
    try { save(); } catch (e) {}
    const k1 = T.st.tasks[0] || {};
    ok('A-04: editing a task keeps _version', k1._version === 7, JSON.stringify(k1).slice(0, 140));
    ok('A-04: and _updatedBy, which is the whole of Rev 25 attribution', k1._updatedBy === 'oms-ari-ball');
    ok('A-04: and _updatedAt, which Rev 44 field-level merge reads', k1._updatedAt === '2026-09-01T00:00:00Z');
    ok('A-04: while the edited field is the edited field', k1.title === 'New title');
    ok('A-04: the task branch spreads the previous record, like ev and sop',
       /const o=Object\.assign\(\{\},previous\|\|\{\},\{id:id\|\|uid\(\)/.test(main));

    // A-07: nothing that writes may run before the cheap refusals.
    T.setST({ events: [], sops: [], notifications: [], assignmentHistory: [], tasks: [],
      people: [{ id: 'ari-ball', name: 'Ari Ball', email: 'a@x.org', active: true }] });
    clear(); openT();
    FIELDS.f_title = '   ';
    FIELDS.f_owner = '__new__';
    FIELDS.f_np_first = 'Brand'; FIELDS.f_np_last = 'New'; FIELDS.f_np_email = 'brand.new@x.org';
    try { save(); } catch (e) {}
    ok('A-07: abandoning at "Title required" creates no person',
       (T.st.people || []).length === 1, JSON.stringify((T.st.people || []).map(p => p.name)));
    ok('A-07: and no task', (T.st.tasks || []).length === 0);
    ok('A-07: and it says which field is missing', ALERTS.some(a => /Title required/i.test(a)), ALERTS.join(' | '));
    ok('A-07: title is validated before the owner block in the source',
       main.indexOf("if(!String(_title||'').trim()){alert('Title required')") <
       main.indexOf("if(ownerName==='__new__'){"));

    // A-17: a two-task cycle is refused where it would be created.
    T.setST({ events: [], sops: [], people: [], notifications: [], assignmentHistory: [], tasks: [
      { id: 'A', title: 'Task A', status: 'Not Started', dependsOn: '', owner: '', priority: 'Medium', due: '', notes: '', category: '', sourceEventId: '', sourceEventTitle: '' },
      { id: 'B', title: 'Task B', status: 'Not Started', dependsOn: 'A', owner: '', priority: 'Medium', due: '', notes: '', category: '', sourceEventId: '', sourceEventTitle: '' }] });
    clear(); openT('A');
    FIELDS.f_title = 'Task A'; FIELDS.f_dependsOn = 'B'; FIELDS.f_owner = '';
    try { save(); } catch (e) {}
    ok('A-17: A cannot be made to wait on B while B waits on A',
       String((T.st.tasks[0] || {}).dependsOn || '') === '', JSON.stringify(T.st.tasks[0] || {}).slice(0, 120));
    ok('A-17: and it says why', ALERTS.some(a => /waiting on each other|already waiting on this one/i.test(a)),
       ALERTS.join(' | '));
    ok('A-17: a one-way dependency still saves',
       (() => { clear(); openT('A'); FIELDS.f_title = 'Task A'; FIELDS.f_dependsOn = ''; FIELDS.f_owner = '';
                try { save(); } catch (e) {}
                clear(); openT('B'); FIELDS.f_title = 'Task B'; FIELDS.f_dependsOn = 'A'; FIELDS.f_owner = '';
                try { save(); } catch (e) {}
                return String((T.st.tasks.find(t => t.id === 'B') || {}).dependsOn) === 'A'; })());
    // Scoped to the CODE comment. The Rev 24 revision-log entry legitimately
    // repeats the claim it made at the time; the log is append-only history.
    ok('A-17: the code comment no longer claims a cycle is structurally impossible',
       !/That is what\s+makes a dependency cycle structurally impossible/.test(main) &&
       /corrects what this comment used to claim/.test(main));

    // A-14: a record that has gone must refuse, not write to index -1.
    T.setST({ events: [], sops: [], people: [], notifications: [], assignmentHistory: [],
      tasks: [{ id: 'gone', title: 'Here for now', status: 'Not Started', owner: '', priority: 'Medium', due: '', notes: '', category: '', dependsOn: '', sourceEventId: '', sourceEventTitle: '' }] });
    clear(); openT('gone');
    T.setST({ events: [], sops: [], people: [], notifications: [], assignmentHistory: [], tasks: [] });
    FIELDS.f_title = 'Edited after deletion'; FIELDS.f_owner = '';
    try { save(); } catch (e) {}
    ok('A-14: a task deleted under the open form refuses instead of writing index -1',
       (T.st.tasks || []).length === 0 && !Object.prototype.hasOwnProperty.call(T.st.tasks, '-1'),
       JSON.stringify(T.st.tasks));
    ok('A-14: and says the record has gone', ALERTS.some(a => /no longer in shared OMS/i.test(a)), ALERTS.join(' | '));
    ok('A-14: all three record branches capture the index rather than indexing blind',
       !/ST\.events\[ST\.events\.findIndex\(x=>x\.id===id\)\]=o/.test(main) &&
       !/ST\.sops\[ST\.sops\.findIndex\(x=>x\.id===id\)\]=o/.test(main) &&
       !/ST\.tasks\[ST\.tasks\.findIndex\(x=>x\.id===id\)\]=o/.test(main));

    // A-13: a category typed on a form that is then refused is not remembered.
    sandbox.localStorage.removeItem('cao_oms_categories');
    T.setST({ events: [], sops: [], people: [], notifications: [], assignmentHistory: [], tasks: [] });
    clear();
    const openEv = G('openEvModal');
    if (typeof openEv === 'function') {
      openEv();
      FIELDS.f_title = ''; FIELDS.f_date = '';
      FIELDS.f_cat = '__new__'; FIELDS.f_cat_new = 'Invented On A Refused Form';
      try { save(); } catch (e) {}
      ok('A-13: a refused event does not leave its new category behind',
         !String(sandbox.localStorage.getItem('cao_oms_categories') || '').includes('Invented On A Refused Form'),
         String(sandbox.localStorage.getItem('cao_oms_categories')));
      clear(); openEv();
      FIELDS.f_title = 'Real event'; FIELDS.f_date = '2026-10-01';
      FIELDS.f_cat = '__new__'; FIELDS.f_cat_new = 'Kept Because It Saved';
      try { save(); } catch (e) {}
      ok('A-13: a saved event does remember it',
         String(sandbox.localStorage.getItem('cao_oms_categories') || '').includes('Kept Because It Saved'),
         String(sandbox.localStorage.getItem('cao_oms_categories')));
      sandbox.localStorage.removeItem('cao_oms_categories');
    }
  }
}

console.log('\n# Rev 54: owners and notifications (A-05, A-06, A-10, A-15, A-16, A-18)');
{
  const fp = G('findPerson'), osh = G('ownerSelectHtml');
  if (typeof fp === 'function') {
    T.setST({ people: [{ id: 'gone-person', name: 'Gone Person', email: 'gone@x.org', active: false }] });
    ok('A-05: a deactivated person is invisible to the default lookup', fp('Gone Person') === null);
    ok('A-05: but RESOLUTION can find them', (fp('Gone Person', true) || {}).id === 'gone-person',
       'otherwise every save of a task they still own prompts for an address already on file');
    const up = G('upsertPerson');
    if (typeof up === 'function') {
      const again = up('Gone Person', 'gone@x.org', '');
      ok('A-05: re-adding them revives the record rather than minting a duplicate id',
         (T.st.people || []).length === 1 && (again || {}).id === 'gone-person',
         JSON.stringify((T.st.people || []).map(p => p.id)));
    }
  }
  if (typeof osh === 'function') {
    T.setST({ people: [{ id: 'ari-ball', name: 'Ari Ball', email: 'a@x.org', active: true }] });
    const blank = osh('');
    ok('A-06: a new task opens on (unassigned), not on the first person in the directory',
       /<option value="" selected>\(unassigned\)<\/option>/.test(blank.replace(/\s+selected/, ' selected')),
       blank.slice(0, 160));
    ok('A-06: an owned task still opens on its owner',
       /<option selected>Ari Ball<\/option>/.test(osh('Ari Ball')));
    ok('A-06: the directory list still offers only active people',
       /p\.active!==false/.test(String(osh)));
  }
  const epo = G('ensurePersonForOwner');
  if (typeof epo === 'function') {
    T.setST({ people: [] });
    ok('A-06: ensurePersonForOwner refuses an empty owner instead of prompting for nobody',
       epo('') === null && epo('   ') === null && (T.st.people || []).length === 0);
  }

  const cnt = G('createNotificationForTask');
  if (typeof cnt === 'function') {
    T.setST({ tasks: [], notifications: [], assignmentHistory: [], people: [] });
    cnt({ id: 'n1', title: 'Work', owner: 'Ari Ball', ownerEmail: 'a@x.org' },
        { id: 'n1', title: 'Work', owner: '', ownerEmail: '' });
    const n = T.st.notifications[0] || {};
    ok('A-15: assigning an UNASSIGNED task is a new assignment, not a reassignment',
       n.type === 'assignment_created', n.type);
    ok('A-15: the subject says so too', /New assignment/.test(String(n.subject || '')), String(n.subject));
    ok('A-15: and the first line of the body', /You have been assigned a new OMS task/.test(String(n.body || '')));
    ok('A-15: the history records it as a first assignment',
       (T.st.assignmentHistory[0] || {}).type === 'assignment_created');
    T.setST({ tasks: [], notifications: [], assignmentHistory: [], people: [] });
    cnt({ id: 'n2', title: 'Work', owner: 'Maggie Scirica', ownerEmail: 'm@x.org' },
        { id: 'n2', title: 'Work', owner: 'Ari Ball', ownerEmail: 'a@x.org' });
    ok('A-15: a genuine handover is still a reassignment',
       (T.st.notifications[0] || {}).type === 'assignment_changed');
  }

  const mark = G('markNotificationSent');
  if (typeof mark === 'function') {
    T.setST({ tasks: [], people: [], notifications: [
      { id: 'q1', type: 'due_reminder', status: 'sent_by_user', sentAt: '2026-09-01T10:00:00Z' }] });
    mark('q1');
    ok('A-16: Mark Sent on something already sent does not rewrite sentAt',
       (T.st.notifications[0] || {}).sentAt === '2026-09-01T10:00:00Z',
       'the queue recorded the last click rather than when the draft went out');
  }

  const stale = G('omsStaleDueReminders'), mkRem2 = G('createDueReminders');
  if (typeof stale === 'function' && typeof mkRem2 === 'function') {
    const T0 = G('TODAY');
    const at = n => { const x = new Date(T0); x.setDate(x.getDate() + n);
      return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    T.setST({ events: [], sops: [], people: [], notifications: [], tasks: [
      { id: 'rr', title: 'Due soon', status: 'Not Started', due: at(1), owner: 'Ari Ball', ownerEmail: 'a@x.org' }] });
    mkRem2(3);
    ok('A-10: the first owner gets a reminder', T.st.notifications.length === 1);
    const prev = { id: 'rr', owner: 'Ari Ball', ownerEmail: 'a@x.org' };
    T.st.tasks[0].owner = 'Maggie Scirica'; T.st.tasks[0].ownerEmail = 'm@x.org';
    const k = stale(T.st.tasks[0], prev);
    ok('A-10: reassigning marks the old owner\'s unsent reminder stale', k === 1 &&
       (T.st.notifications[0] || {}).status === 'stale', JSON.stringify(T.st.notifications[0] || {}).slice(0, 120));
    ok('A-10: so the bell stops counting it',
       (T.st.notifications || []).filter(n => n.status === 'pending').length === 0);
    const made = mkRem2(3);
    ok('A-10: and the NEW owner gets their own reminder', made === 1 &&
       (T.st.notifications[0] || {}).recipientEmail === 'm@x.org',
       'the old key had no recipient in it, so Remind called the job done and told nobody');
    ok('A-10: the idempotency key now carries the recipient',
       /String\(x\.recipientEmail\|\|''\)\.toLowerCase\(\)===String\(t\.ownerEmail\|\|''\)\.toLowerCase\(\)/.test(main));
    ok('A-10: the queue explains a stale row rather than offering to send it',
       /The task changed hands before this was sent/.test(String(G('openNotificationsModal') || '')));
  }

  const handoff2 = G('notifyDependentsOnCompletion');
  if (typeof handoff2 === 'function') {
    T.setST({ events: [], sops: [], notifications: [], assignmentHistory: [], people: [], tasks: [
      { id: 'p', title: 'Prerequisite', status: 'Retired' },
      { id: 'd', title: 'Dependent', status: 'Not Started', dependsOn: 'p', owner: 'Ari Ball', ownerEmail: 'a@x.org' }] });
    const made = handoff2(T.st.tasks[0], { status: 'In Progress' });
    ok('A-18: RETIRING a prerequisite notifies its dependents too', made === 1, 'made=' + made);
    const body = String((T.st.notifications[0] || {}).body || '');
    ok('A-18: and says the work was withdrawn, not delivered',
       /withdrawn, not delivered/.test(body), body.slice(0, 160));
    ok('A-18: retiring something already Retired does not re-notify',
       handoff2(T.st.tasks[0], { status: 'Retired' }) === 0);
    T.setST({ events: [], sops: [], notifications: [], assignmentHistory: [], people: [], tasks: [
      { id: 'p', title: 'Prerequisite', status: 'Complete' },
      { id: 'd', title: 'Dependent', status: 'Not Started', dependsOn: 'p', owner: 'Ari Ball', ownerEmail: 'a@x.org' }] });
    handoff2(T.st.tasks[0], { status: 'In Progress' });
    ok('A-18: completing still says now Complete',
       /now Complete/.test(String((T.st.notifications[0] || {}).body || '')));
  }
}

console.log('\n# Rev 54: categories, the Brief and the shell (R-04, A-12, C-08, C-15, C-16, C-10, C-13)');
{
  const ren = G('renameCategory'), sopCount = G('categorySopCount');
  ok('R-04: categorySopCount exists', typeof sopCount === 'function');
  if (typeof ren === 'function' && typeof sopCount === 'function') {
    T.setST({ events: [], tasks: [], people: [], notifications: [],
      sops: [{ id: 's1', process: 'Only an SOP uses this', category: 'Orphan Cat', owner: '', notes: '' }] });
    ok('A-12: a category used only by procedures is counted', sopCount('Orphan Cat') === 1);
    const moved = ren('Orphan Cat', 'Renamed Cat');
    ok('R-04: renaming moves the SOP', moved === 1 && T.st.sops[0].category === 'Renamed Cat',
       'a SOP-only category reported "No records changed" and was stranded');
    ok('R-04: the dialog has a SOPs column',
       /<th style="text-align:right">SOPs<\/th>/.test(main));
    ok('R-04: and the confirmation quotes the SOP count',
       /' SOP'\+\(ks===1\?'':'s'\)/.test(main));
  }

  const brief = String(G('rBrief') || '');
  ok('C-08: the Weekly Brief spans a multi-day event that began before the week',
     /calEventEnd\(e\)>=wkS&&dp\(e\.date\)<=wkE/.test(brief),
     'the filter tested the start date only, so a Saturday-to-Tuesday board meeting was missing all week');
  ok('C-08: and still excludes OOO and Retired', /e\.category!=='EB OOO'&&!isRetired\(e\)/.test(brief));
  ok('C-15: paging the Brief no longer writes to shared state',
     !/ST\.briefWeek=this\.value;save\(\)/.test(main),
     'a viewer was refused, and everyone else queued a sync, merely to look at another week');
  ok('C-15: briefWeekView alone drives the view',
     /onchange="briefWeekView=this\.value;omsRerenderKeepingCaret\('brief-week',rBrief\)"/.test(main));
  ok('C-15: briefWeekStart still reads the stored default',
     /ST\.briefWeek/.test(String(G('briefWeekStart') || '')));

  ok('C-16: the nav highlight reads the button, not an array position',
     /b\.dataset&&b\.dataset\.tab===t/.test(String(G('go') || '')),
     'hiding Admin and Import shifted every index for a non-admin session');
  ok('C-16: every nav button carries its tab name',
     (html.match(/data-tab="/g) || []).length === 10, (html.match(/data-tab="/g) || []).length + ' found');

  ok('C-10: calItemClick is gone', typeof G('calItemClick') !== 'function' && !/function calItemClick\(/.test(main));
  ok('C-10: calItemDelete is gone', typeof G('calItemDelete') !== 'function' && !/function calItemDelete\(/.test(main));
  ok('C-10: cycleRob is gone', typeof G('cycleRob') !== 'function' && !/function cycleRob\(/.test(main),
     'it is the single-click cycle Rev 14 removed because it WAS the OMS-003 defect');
  ok('C-10/Rev 57: omsRemoveSignIn is NOT gone (it is wired from adminHardDelete)', /function omsRemoveSignIn\(/.test(main));
  ok('Rev 57: buildSeed and its seed arrays are gone - canonical is the only source of records', !/function buildSeed\(/.test(main) && !/const ARI=\[/.test(main) && !/const MAGGIE=\[/.test(main));
  ok('Rev 57: the bootstrap roster is the one administrator', (() => { const sp = G('seedPeople'); if (typeof sp !== 'function') return false; const r = sp(); return r.length === 1 && r[0].accessRole === 'admin' && !/lola/i.test(JSON.stringify(r)); })());

  ok('C-13: the guide hero no longer quotes a version number',
     !/Version 1\.4\.0 adds individual OMS sign-in/.test(html),
     'the badge is the version; a number written into prose has no owner');
}

console.log('\n# Rev 54: intake rows can be removed, and the form says so (A-08)');
{
  const ab = G('abSec');
  if (typeof ab === 'function') {
    T.setST({ gw: [], assignments: [], agendas: [], fyis: [], events: [], tasks: [], sops: [],
      people: [], notifications: [], assignmentHistory: [], rob: [],
      incoming: [{ id: 'i1', n: '1', item: 'An incoming thing', source: 'Email', status: 'New', link: '', input: '' }],
      forReview: [{ id: 'f1', n: '1', item: 'A review thing', inputNeeded: 'x', requestedBy: 'Ari', link: '', notes: '' }],
      board: [{ id: 'b1', n: '1', boardName: 'Advocate', item: 'A board thing', status: 'New', link: '', notes: '' }],
      deadlines: [{ id: 'd1', n: '1', deadline: 'A deadline', owner: '', dueDate: '2026-10-01', status: 'New', link: '', notes: '' }] });
    const pairs = [['inc', 'incoming', 'i1'], ['fr', 'forReview', 'f1'], ['brd', 'board', 'b1'], ['dl', 'deadlines', 'd1']];
    for (const [type, coll, id] of pairs) {
      const out = ab('X', type);
      ok('A-08: ' + type + ' rows offer Delete',
         out.indexOf("delItem('" + coll + "','" + id + "')") !== -1, out.slice(0, 200));
      ok('A-08: ' + type + ' Edit and Delete sit inside a no-print wrapper so a viewer never sees them',
         /<span class="no-print"><button class="btn bn bxs" onclick="openIntakeEdit\('[a-z]+','[^']+'\)"[^>]*>Edit<\/button> <button class="btn br2 bxs" onclick="delItem\('/.test(out), out.slice(out.indexOf('<span class="no-print">'), out.indexOf('<span class="no-print">') + 160));
    }
    const del = G('delItem');
    ok('A-08: delItem handles these collections', typeof del === 'function');
    if (typeof del === 'function') {
      try { del('incoming', 'i1'); } catch (e) { /* renderAll needs more DOM than this harness has */ }
      ok('A-08: and actually removes the row', (T.st.incoming || []).length === 0);
    }
  }
  ok('Rev 57: the intake hint now points at Edit, and no longer says the status is fixed at entry',
     /Open <strong>Edit<\/strong> on the row to change the status/.test(html) && !/the status set here is the status the row keeps/.test(html));
  {
    // Rev 57: the Edit dialog prefills from the row and the save merges over it.
    T.st.incoming = [{ id: 'i9', n: '1', dateAdded: '2026-09-01', item: 'Renamed <b>x</b>', source: 'Src', status: 'Pending', input: 'in', link: '' }];
    const oie = G('openIntakeEdit');
    ok('Rev 57: openIntakeEdit exists', typeof oie === 'function');
    if (typeof oie === 'function') {
      oie('inc', 'i9');
      const body = E('mbody').innerHTML;
      ok('Rev 57: the dialog is prefilled and escaped', /value="Renamed &lt;b&gt;x&lt;\/b&gt;"/.test(body) && /<option selected>Pending<\/option>/.test(body), body.slice(0, 200));
      ok('Rev 57: ...and carries the row id', T.fn('MC.id') === 'i9' && T.fn('MC.type') === 'inc');
      G('omsIntakeUpsert')('incoming', { id: 'zzz', n: '9', dateAdded: '2030-01-01', item: 'Renamed 2', source: 'Src2', status: 'Pending', link: '', input: 'in2' });
      const row = T.st.incoming[0];
      ok('Rev 57: the save merges over the row, keeping id, number and date added', T.st.incoming.length === 1 && row.id === 'i9' && row.n === '1' && row.dateAdded === '2026-09-01' && row.item === 'Renamed 2' && row.input === 'in2', JSON.stringify(row));
      T.fn("MC={type:'inc',id:'gone'}");
      G('omsIntakeUpsert')('incoming', { id: 'q', item: 'orphan' });
      ok('Rev 57: a row that vanished is refused, not re-created', T.st.incoming.length === 1);
      T.fn("MC={type:'inc',id:null}");
      G('omsIntakeUpsert')('incoming', { id: 'n2', n: '2', dateAdded: '2026-09-07', item: 'Fresh', source: '', status: 'New', link: '', input: '' });
      ok('Rev 57: with no id the save still creates', T.st.incoming.length === 2 && T.st.incoming[1].id === 'n2');
    }
  }
}

console.log('\n# Rev 54: the dialog and the keyboard (A-20, C-09)');
{
  ok('C-09: the overlay is announced as a dialog',
     /class="modal" role="dialog" aria-modal="true" aria-labelledby="mtitle"/.test(html));
  ok('C-09: chips and pills are focusable and named as buttons',
     (html.match(/<div tabindex="0" role="button" class="(chip|pill)/g) || []).length === 12,
     (html.match(/<div tabindex="0" role="button" class="(chip|pill)/g) || []).length + ' found');
  ok('C-09: one delegated handler gives them Enter and Space',
     /t\.closest\('\.chip,\.pill'\)/.test(main) && /e\.key!=='Enter'&&e\.key!==' '/.test(main),
     'chips are rebuilt by innerHTML on every render, so per-element handlers would not survive');
  ok('C-09: Escape still closes first', /if\(e\.key==='Escape'\)\{closeModal\(\);return\}/.test(main));
  ok('C-09: openModal moves focus into the dialog',
     /b\.querySelector\('input,select,textarea,button,\[href\]'\)/.test(String(G('openModal') || '')));
  ok('C-09: and closeModal gives it back',
     /_mcReturnFocus/.test(String(G('closeModal') || '')));
  ok('C-09: every label in the record forms names its control',
     (() => { const forms = main.slice(main.indexOf('function openEvModal'), main.indexOf('function saveModal'));
              return !/<label>(?!&nbsp;)[^<>]*<\/label><(?:input|select|textarea)\b[^>]*\bid="/.test(forms); })(),
     'an unlabeled input is read out as nothing at all');
  const leave = G('omsLeaveForm');
  ok('A-20: omsLeaveForm exists', typeof leave === 'function');
  // Rev 65: the header search result is a fourth way out of an open dialog.
  ok('A-20: the four cross-links out of an open dialog go through it',
     (main.match(/omsLeaveForm\(function\(\)\{/g) || []).length === 4,
     (main.match(/omsLeaveForm\(function\(\)\{/g) || []).length + ' found');
  ok('A-20: one delegated listener marks the open form dirty',
     /\['input','change'\]\.forEach\(ev=>document\.addEventListener\(ev,/.test(main) &&
     /MC\)MC\.dirty=true/.test(main));
  ok('A-20: opening and closing both clear it',
     /MC=\{type,id,dirty:false\}/.test(main) && /if\(MC\)MC\.dirty=false/.test(main));
  if (typeof leave === 'function' && typeof G('openModal') === 'function') {
    G('openModal')('T', '<div></div>', 'ev', null);
    ctx.__T.fn('MC').dirty = true;
    let ran = false;
    leave(() => { ran = true; });
    ok('A-20: confirm() answers yes in this harness, so the cross-link proceeds and the flag clears',
       ran === true && ctx.__T.fn('MC').dirty === false);
  }
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
