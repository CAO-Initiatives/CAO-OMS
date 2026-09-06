#!/usr/bin/env node
/**
 * Step 3: the remaining testable client claims, each named with its source.
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
const sandbox = { console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
  Map, Set, Promise, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  requestAnimationFrame: noop, fetch: () => Promise.reject(new Error('network off')),
  alert: m => (sandbox.__alerts = sandbox.__alerts || []).push(String(m)),
  confirm: () => true, prompt: () => null, localStorage: store(), sessionStorage: store(),
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

// ---------------------------------------------------------------------------
console.log('\n### CLAUDE.md: "OMS_MAP drops records with no id ... zero operations in every direction"\n');
check('OMS_MAP drops id:null', run(`OMS_MAP([{id:null,a:1},{id:'x'}]).size`) === 1);
check('OMS_MAP drops a record with no id key at all', run(`OMS_MAP([{a:1},{id:'x'}]).size`) === 1);
check('OMS_UNSYNCABLE-style predicate flags id:null',
      run(`OMS_COLLECTIONS.filter(t=>Array.isArray({gw:[{a:1}]}[t])&&{gw:[{a:1}]}[t].some(x=>x&&x.id==null)).join()`) === 'gw');

console.log('\n### The same two tests, with id set to the EMPTY STRING\n');
check('OMS_MAP KEEPS a record whose id is "" (it is not null)',
      run(`OMS_MAP([{id:'',a:1}]).size`) === 1,
      'so it is not dropped, and the id-less guard is not what protects this case');
check('the id-less guard (x.id==null) does NOT flag id:""',
      run(`[{id:'',a:1}].some(x=>x&&x.id==null)`) === false,
      'OMS_UNSYNCABLE stays silent');
check('...and OMS_DIFF therefore emits an operation with entityId ""',
      (() => {
        run(`ST={gw:[{id:'',date:'2026-01-01'}]};OMS_BASE={gw:[]};_dirty.clear();_dirty.add('gw');`);
        const ops = run(`JSON.stringify(OMS_DIFF())`);
        return JSON.parse(ops).some(o => o.entityId === '');
      })(),
      'the gateway rejects it with 400 Invalid entityId; the canonical gate DOES catch id:"" but the client does not');

// ---------------------------------------------------------------------------
console.log('\n### CLAUDE.md: owner strings must match a directory person\n');
run(`ST={people:[{id:'maggie-scirica',name:'Maggie Scirica',email:'Margaret.Scirica@Advocatehealth.org',active:true},
              {id:'ari-ball',name:'Ari Ball',email:'Ariana.Ball@advocatehealth.org',active:true},
              {id:'jane-westgate',name:'Jane Westgate',email:'jane@westgatepr.com',active:true},
              {id:'rachel-woodside',name:'Rachel Woodside',email:'Rachel.Woodside@Advocatehealth.org',active:true}]};`);
const fp = n => run(`(function(){const p=findPerson(${JSON.stringify(n)});return p?p.id:null})()`);
check('findPerson binds a display name', fp('Maggie Scirica') === 'maggie-scirica', String(fp('Maggie Scirica')));
check('findPerson binds the divergent email name (Margaret vs Maggie)',
      fp('Margaret.Scirica@Advocatehealth.org') === 'maggie-scirica', String(fp('Margaret.Scirica@Advocatehealth.org')));
check('findPerson binds Ariana -> Ari', fp('Ariana.Ball@advocatehealth.org') === 'ari-ball',
      String(fp('Ariana.Ball@advocatehealth.org')));
check('findPerson binds a first name alone when unambiguous', fp('Maggie') === 'maggie-scirica', String(fp('Maggie')));
check('findPerson refuses an unknown name', fp('Nobody At All') === null, String(fp('Nobody At All')));
if (typeof run(`typeof ownerAmbiguity`) === 'string' && run(`typeof ownerAmbiguity`) === 'function') {
  run(`ST.people.push({id:'rachel-woodside-2',name:'Rachel Woodside',email:'r.woodside@example.org',active:true})`);
  const amb = run(`JSON.stringify(ownerAmbiguity('Rachel Woodside'))`);
  check('ownerAmbiguity reports a name matching two people', amb && amb !== 'null' && amb !== 'undefined', amb);
  check('...and stays silent for a unique name', ['null', 'undefined', '""'].includes(String(run(`JSON.stringify(ownerAmbiguity('Maggie Scirica'))`))),
        String(run(`JSON.stringify(ownerAmbiguity('Maggie Scirica'))`)));
} else {
  check('ownerAmbiguity exists', false, 'not a function');
}

// ---------------------------------------------------------------------------
console.log('\n### CLAUDE.md: person ids are slug(name) with -2/-3 on collision\n');
const slug = n => run(`slug(${JSON.stringify(n)})`);
check('slug("Clare Il\'Giovine")', slug("Clare Il'Giovine") === 'clare-ilgiovine', String(slug("Clare Il'Giovine")));
check('slug("Terri Yates")', slug('Terri Yates') === 'terri-yates', String(slug('Terri Yates')));
check('slug of a punctuation-only name is EMPTY',
      slug('!!!') === '' || slug('!!!') === '-' , JSON.stringify(slug('!!!')) +
      '  <- an id-shaped hole if any path uses slug() unguarded');

// ---------------------------------------------------------------------------
console.log('\n### CLAUDE.md: one overlay, one #mbody — openModal replaces innerHTML\n');
const om = run(`String(openModal)`);
check('openModal writes innerHTML rather than appending', /innerHTML\s*=/.test(om));
check('there is exactly one mbody in the document markup',
      (html.match(/id="mbody"/g) || []).length === 1,
      (html.match(/id="mbody"/g) || []).length + ' occurrences');
check('there is exactly one modal overlay element',
      (html.match(/id="modal"/g) || []).length === 1,
      (html.match(/id="modal"/g) || []).length + ' occurrences');

// ---------------------------------------------------------------------------
console.log('\n### CLAUDE.md: gw ids are gw-<YYYY-MM-DD>, rob ids are rob-<slug>\n');
check('the gw id form appears in the code', /['"`]gw-['"`]?\s*\+|gw-\$\{/.test(main) || /'gw-'\+/.test(main),
      'searched for a gw- prefix construction');
check('the rob id form appears in the code', /'rob-'\+|rob-\$\{/.test(main));

// ---------------------------------------------------------------------------
console.log('\n### Rev 20: en-US only, with a guard\n');
const GB = ['organis', 'recognis', 'normalis', 'summaris', 'behaviour', 'colour', 'centre',
            'licence', 'favourite', 'apologise', 'analyse', 'catalogue', 'programme', 'serialis',
            'materialis', 'prioritis'];
const found = GB.filter(w => new RegExp(w, 'i').test(html));
check('no en-GB spellings in the client artifact', found.length === 0, found.join(', '));

console.log('\n' + '='.repeat(66));
console.log(failures ? `CLIENT CLAIMS: ${failures} failed` : 'CLIENT CLAIMS: all held');
console.log('='.repeat(66));
