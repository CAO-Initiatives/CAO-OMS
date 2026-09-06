# CAO-OMS architecture fidelity review — 6 September 2026

Commissioned by `docs/ARCHITECTURE-REVIEW-BRIEF.md`. Carried out by a session
that did not write the code under review.

The question was not "is this good code". It was **does the code do what the
documents claim it does**. Everything below is either something I ran or
something I read, and every finding names the command that shows it.

Reproduction scripts are in `docs/review-2026-09-06/`. They are deliberately
outside `test/` so that nothing here changes what the release gate does.

---

## 1. What was verified, and how

### 1.1 Ground truth was re-derived, not accepted

The brief's own ground-truth table was wrong in two places. Both were wrong the
same way — the author recorded the tip of the branch they had been working on
rather than the merge commit that landed it.

| Brief said | Live, 6 Sept | |
|---|---|---|
| Client `main` = `57c366e` | `4d180ea` (the brief itself; docs-only) | stale, harmless |
| Gateway `main` = `6bb4769` | **`d519c39`** — `6bb4769` is the tip of `oms-049-dictatable-passwords`, merged as PR #11 | **wrong** |
| Data `main` = `dd0ccb5` | **`44631bf`** — merge of PR #7 | **wrong** |
| `ops-029-scrub-plaintext-password` open | **merged.** `git diff dd0ccb5 44631bf` = one snapshot pair added, 2 lines removed from `state/oms-state.json`, `revision` untouched | **resolved** |
| `inbox` branch not in use | confirmed; README at `658c21d` is accurate | holds |
| `core.autocrlf` false | confirmed | holds |

This matters beyond pedantry: the brief instructed a fresh session to trust
those SHAs, and section 5 asked that session to work on a pull request that no
longer existed.

### 1.2 The live artifact

```
curl -sL https://cao-initiatives.github.io/CAO-OMS/oms.html | sha256sum
ff2ef091e43a38bf04361e64e47548aaf02fdd478d6f092beb01540aedba8048
```

Byte-identical to the working tree (`cmp` clean), 318737 bytes, badge v1.24.0,
top rev 35. Live equals `main` equals the working tree. Note the served host is
`cao-initiatives.github.io` — with the second `i`; the misspelling that appears
in the gateway's `.env.example` resolves to a 404.

### 1.3 Canonical state

`state/oms-state.json` revision **75**, schemaVersion 2; `state/manifest.json`
stateRevision **75** — in step. Manifest `status`: `conflicts-present`.
`conflicts/unresolved/` holds 53 records; `operations/processed/` holds 604
files; `snapshots/` holds 151 files totalling 8.4 MB.
`auth/users.json` holds 6 accounts — one admin, five editors, **no viewer**.

### 1.4 Every instrument was tested before it was trusted

| Instrument | Result |
|---|---|
| `node test/smoke.mjs oms.html` | 458 passed, 0 failed, 0 TODO |
| `./scripts/release_gate.sh HEAD` | GATE PASSED — 13 numbered checks, 31 preflight, 29 text claims |
| `python test/text_claims_negative.py` | 12 passed — check 12 still catches real drift |
| `python test/no_counts_negative.py` | 12 passed — check 13 still catches real drift |
| `python scripts/validate_canonical.py` (data) | 54 checks, 0 failed |
| Client CI run 43 on `57c366e` | success |
| Canonical gate workflow | 8 runs, 0 failures |

Read in full: `CLAUDE.md`, `RECOVERY.md`, `lib/core.js`, all six `api/*.js`,
`vercel.json`, `.env.example`, `scripts/consolidate.py`,
`scripts/validate_canonical.py`, both data workflows, the single client
workflow, both `.gitattributes`, and the `inbox` branch README.

### 1.5 What held

Most of what this project claims about itself is true, and several of the
load-bearing pieces are better than their documentation suggests. Verified
against the real `scripts/consolidate.py` in a throwaway repo
(`docs/review-2026-09-06/probe_consolidator.py`, 13 assertions, 0 failed):

- a create for an id the store already holds produces a **conflict record**,
  not a duplicate row;
- the same create against a collection holding **id-less** rows *does* append a
  duplicate — the `gw` 8→9 probe, still reproducible;
- the consolidator refuses to run when `revision != stateRevision`, with or
  without a pending inbox;
- an id-less record cannot be addressed by a delete;
- an update cannot remove a key — `dict.update()` can null it, never drop it;
- a replayed operation file is dropped before it can manufacture a conflict or
  bump the revision;
- one revision increment per batch, conflicts and invalid operations included.

And on the client (`probe-client-claims.mjs`): `OMS_MAP` drops id-less records
exactly as documented; `findPerson` resolves display names, divergent email
names (Margaret→Maggie, Ariana→Ari) and unambiguous first names, and refuses
unknown ones; `ownerAmbiguity` reports a name matching two people and stays
silent otherwise; `openModal` writes into a single `#mbody` inside a single
`#overlay`; no en-GB spellings survive anywhere in the client artifact.

`RECOVERY.md` is the strongest document in the three repositories. The
`inbox` branch README is the second. Both describe what went wrong and why
without softening it.

---

## 2. Findings, ordered by consequence

---

### F1 — The Rev 35 reconciler cannot fire on the only path that starts it

**Claimed.** `oms.html`, the Unsynced banner: *"Do not repeat the edit and do
not reload — OMS keeps checking every few seconds and will confirm this on its
own."* The User Guide repeats it. `test/text-claims.json` binds it
(`unsynced-self-heals`). Rev 35's log entry leads with it. Eight smoke
assertions cover it.

**True.** On the path that starts it, it never checks. The one escape is a
later *successful* save clearing `_dirty` and letting a still-scheduled tick
fire — but a successful save resolves the banner by itself, so the reconciler
contributes nothing there either.

`OMS_START_RECONCILE` has exactly one call site: the catch inside
`OMS_QUEUE_SYNC`. Its tick begins `if(!_dirty.size)`. Reaching that catch
requires `OMS_DIFF()` to have produced at least one operation, and `OMS_DIFF()`
produces operations only for collection types present in `_dirty`. `_dirty` is
cleared in five places — none of them on this path; `OMS_SYNC_ONCE` clears it
only *after* `OMS_WAIT_FOR` returns, and here `OMS_WAIT_FOR` threw.

So `_dirty` is guaranteed non-empty at the only call site, `!_dirty.size` is
guaranteed false, and the guard therefore blocks on every tick. This is a static
invariant, not a timing accident.

(Corrected after the Step 7 read, which noted this sentence originally read "the
guard is unconditionally true" — ambiguous polarity in the one sentence carrying
the finding's whole weight.)

The guard's intent is sound and its comment says so: *"Unsaved edits mean
adoption would overwrite them."* But `_dirty` cannot distinguish **edits not yet
sent** from **edits sent and awaiting confirmation**, and this path is always
the second. `save()` compounds it — it marks *every* collection dirty, not the
one that changed.

**Reproduction.** `node docs/review-2026-09-06/repro-reconciler.mjs`

```
PASS  _dirty is STILL non-empty when the reconciler starts  — _dirty.size=1
   clock advanced 120 s (40 reconciler ticks were scheduled)
   /api/state calls made by the reconciler: 0
   banner now: Unsynced
   OMS_REVISION now: 75  (canonical is at 76)
FAIL  THE PROMISE: the reconciler polls canonical
FAIL  THE PROMISE: the banner returns to Connected on its own
FAIL  THE PROMISE: the client adopts the confirmed revision

=== Positive control: same reconciler, _dirty empty ===
PASS  positive control: reconciler polls when _dirty is empty  — 1 state calls
PASS  positive control: reconciler adopts and reports Connected
```

The positive control matters: the mechanism works perfectly. It is only
unreachable.

**Why no test caught it.** `test/smoke.mjs` stubs `setTimeout` to `noop`, so no
timer-driven code in the artifact has ever been executed by any test. All eight
reconciler assertions are regexes over source text. One of them —
`ok('it refuses to adopt canonical over unsaved edits', /_dirty\.size/.test(rec))`
— asserts the presence of the very condition that disables it.

**Blast radius.** Rev 35 made this scenario *worse* than Rev 34. Rev 34's banner
read *"Your work is saved locally but is not yet confirmed in shared OMS. Do not
repeat the edit."* Rev 35 added **"and do not reload"** — and reload is the only
recovery that works, because `OMS_BOOT` re-fetches canonical from the gateway.
There is no `setInterval` anywhere in the artifact and no background re-sync, so
nothing else will ever clear the state. A Dean's-office user who follows the
on-screen instruction waits indefinitely.

**Confidence: high.** Static proof plus a dynamic reproduction with a working
positive control.

---

### F2 — A revision increase is treated as proof that *your* operation applied

**Claimed.** `CLAUDE.md`: *"Wait for `syncState` to read **Connected** and for
`OMS_REVISION` to increment."* The toast says "Save successful". Rev 15's whole
lesson, recorded in `CLAUDE.md`, is that *"a save producing no operations used to
report Connected"* must never happen again.

**True.** `OMS_WAIT_FOR` returns as soon as `Number(x.revision) > Number(startRevision)`.
`consolidate.py` increments `state["revision"]` once per batch — its own comment
says *"including conflicts/invalid operations"*, and probe C6b confirms a batch
of nothing but invalid operations still advances it.

A revision increase therefore proves only that **a consolidation ran**. The
client treats it as proof that *this* operation was applied, adopts canonical
wholesale, clears `_dirty`, deletes the local pending key, and reports success.

**Reproduction.** `node docs/review-2026-09-06/repro-confirmation.mjs`

```
=== S1: the operation is REJECTED, canonical advances anyway ===
   banner: Connected
   toasts: ["Save successful"]
   task title the user now sees: Original
FAIL  S1: the client does NOT report a rejected save as successful
FAIL  S1: the user is told their edit did not land
FAIL  S1: the edit is not silently replaced by the old value

=== S2: another user's unrelated save advances the revision first ===
   banner: Connected     toasts: ["Save successful"]
   task title the user now sees: Original
   _dirty after "confirmation": 0
FAIL  S2: another user's save is not mistaken for confirmation of mine
FAIL  S2: my edit survives

=== Control: the operation really was applied ===
PASS  control: a genuinely applied save reports Connected
PASS  control: and the edit is in the adopted state
```

`OMS_ASSERT_CURRENT` does not prevent this. It compares versions *before*
posting; the window that matters is between the post and the consolidation,
which is the documented 20–30 seconds.

**Blast radius, stated honestly.** The two scenarios differ sharply.

*S2 is common and mostly recoverable.* The operation is still queued and will
usually apply on the next consolidation. What the user sees is their edit
reverting on screen under a "Save successful" toast.

> **Corrected 6 Sept, after the Step 7 read.** This paragraph originally
> continued: *"The rational response is to redo the edit … These are not lost
> edits; they are the footprints of people re-doing work the interface told them
> had succeeded."* The independent reviewer objected that "same actor, same
> second" is far too fast for a human to notice a revert and redo ten records,
> and that the evidence therefore pointed away from the story built on it. That
> objection was correct. Re-reading the records in full rather than in sample:
>
> ```
> 16:02:21.645  deadlines mql45rrema6     16:02:34.226  deadlines mql45rrema6
> 16:02:22.575  tasks     mql45rrep5o     16:02:35.120  tasks     mql45rrep5o
> 16:02:23.793  tasks     mql45rre5g3     16:02:35.969  tasks     mql45rre5g3
>  … ten operations …                      … the same ten, same order …
> 16:02:31.349  tasks     ms7hxd7xvjr     16:02:43.567  tasks     ms7hxd7xvjr
> ```
>
> No human did that. **A whole batch was re-sent thirteen seconds later**, and
> the cause is mechanical — see F2b below. My original causal story was wrong;
> the corrected one is worse, because it needs no user error at all.

Of the 53 files in `conflicts/unresolved/`, 51 are same-field conflicts, and in
every one the value the operation *wanted* is identical to the value already in
canonical. What is established is that these are benign no-ops rather than lost
edits — not why they were sent twice. F2b answers that.

*S1 is rarer and lossy.* When the consolidator genuinely rejects the operation,
the edit exists nowhere afterwards — canonical never got it, `_dirty` was
cleared, the pending key was deleted — and the user was told it saved. I did not
find a confirmed instance of a real divergent edit lost this way, and I want to
be clear that I am reporting a mechanism, not a body count.

**Confidence: high** for the mechanism and for S2's link to the conflict
records. **Medium** on how often S1 has actually cost someone work — the
evidence I have shows benign duplicates, not divergent losses.

**Interaction with F1 — read this before fixing either.** The obvious fix is to
make `OMS_WAIT_FOR` verify that the operation actually applied. Done alone, that
converts today's false "Connected" into an honest "Unsynced" — which F1 has made
**terminal**. Fixing F2 first would make the system visibly worse. F1 first, then
F2.

---

### F2b — Any save while a batch is unconfirmed re-sends that whole batch

**Found by the Step 7 reviewer's objection, not by the review.** It was demanded
as the answer to "if nothing in the client retries, what produced same-second
duplicates?" — a question F2's original text did not notice it had raised.

**True.** `OMS_BASE` advances only on a *confirmed* sync. `save()` marks **every**
collection dirty. `OMS_DIFF()` compares `OMS_BASE` to `ST`. So while a batch is
unconfirmed, any subsequent save recomputes the diff against the stale base and
re-emits **every operation in the outstanding batch**, plus the new one.

**Reproduction — this is the live 5 Sept 16:02 record, and it is exact.** Ten
operations posted at 16:02:21–31; the identical ten, in the identical order, at
16:02:34–43. Thirteen seconds apart. `operations/processed/` holds the first
set; `conflicts/unresolved/` holds the second, all with the wanted value already
equal to canonical.

```bash
# in CAO-OMS-Data
python -c "...group conflicts/unresolved by createdAt..."   # see §Appendix
# 40 distinct entityIds across 53 conflict records; 12 ids appear twice
```

**Blast radius.** This is the generator of 51 of the 53 conflict records — a
month of them. No data was lost, because the resent operation always wanted what
canonical already held. But it doubles gateway writes during exactly the periods
when the consolidator is already struggling, and each duplicate is one more
chance to hit F6's rebase-abort. It also means the conflict log, the one place
that would show a *real* lost edit, is 96% noise.

**Confidence: high.** The doubled batch is in the data, in order, timestamped.

**Not fixed in Rev 36.** F1 and F2 reduce how often a user is *tempted* to save
again mid-flight, but the mechanism is untouched: a second edit during the
confirmation window still re-sends everything. See "then what" in §4.

---

### F3 — "Add Workstream" still creates a record with no id

**Claimed.** `CLAUDE.md`: *"`gw` (CAO Visibility) and `rob` (the Cadence grid)
had never synced, in either direction, until they were migrated on 5 Sept
2026."* `RECOVERY.md` documents that migration as the one legitimate direct
commit. Both treat it as closed.

**True.** The migration repaired the rows that existed. The code path that makes
new ones was not touched:

```js
} else if(t==='robws'){ ...
  if(id===0 || id!==null){ST.rob[id].ws=ws}
  else{ST.rob.push({ws:ws,cells:Array(12).fill(''),st:Array(12).fill('')})}
```

`openRobWsModal()` with no index sets `MC={type:'robws',id:null}`, so Add
Workstream takes the `else` branch and pushes a record with **no `id` field at
all** — the precise shape of the defect that hid in `gw` and `rob` for eleven
revisions.

**Reproduction.** `node docs/review-2026-09-06/repro-robws.mjs`

```
   modal context after opening Add Workstream: {"type":"robws","id":null}
   the new row: {"ws":"Digital Health Steering","cells":[...],"st":[...]}
FAIL  THE CONTRACT: every record in a synced collection has an id — id=undefined
PASS  the Rev 15 guard notices (this part works)  — ["rob"]
   operations OMS_DIFF produces for this change: []
FAIL  THE CONSEQUENCE: the new workstream produces no create operation

=== Control 1: the same handler in EDIT mode ===
PASS  control: editing keeps the existing id — rob-board-governance-rhythm
PASS  control: an edit DOES produce an update operation
=== Control 2: a collection that assigns ids (Deadlines) ===
PASS  control: a new Deadline gets an id — "mtq3yw0cxve"
PASS  control: and therefore produces a create operation
```

**Blast radius.** Contained but unpleasant. The Rev 15 guard does its job: the
banner reads Unsynced and names `rob`. But then F1 applies — the state is
terminal, the banner says not to reload, and every subsequent save in *any*
collection keeps reporting "Saved, but records with no id cannot be synced: rob"
until the page is reloaded, at which point the new workstream disappears. So the
Cadence grid cannot gain a workstream at all, and trying poisons the session.

`gw` is not affected: the client has no `ST.gw.push` — CAO Visibility rows are
read-only there. `rob` is the only reachable half.

`test/smoke.mjs` has no assertion mentioning workstream creation.

**Confidence: high.** Reproduced from the real handler with two working
controls.

---

### F4 — Gate check 12 binds a claim to a function's *existence*, never to its *reachability*

**Claimed.** `CLAUDE.md`: *"Descriptive text must be tied to the code it
describes."* `scripts/text_claims.py`: *"The guide hash check proves the guide
CHANGED. It cannot prove it became true. This does."*

**True.** It proves a substring exists somewhere in a 318 KB single-file
application. Nothing more. `c["code"] in html` is a flat search over the whole
artifact; the text side is the same search minus the revision log.

The brief already names one instance (event 6.3), and I verified it
independently rather than taking it on trust. At Rev 34 (`9429948`) the User
Guide said, unscoped: *"**Notes are added to, not typed over.** Use **Add note**
and what you write is appended on its own line … so two people writing on the
same record no longer overwrite one another."* The control existed at exactly one
offset in the artifact — inside the SOP dialog, immediately before
`function openTask…`. Running Rev 34's own check 12 against Rev 34's own
artifact: **27 checked, 0 failed.** Rev 35 added the second call site.

**Reproduction — the general case.** 13 of the 29 bindings name a function
definition. For each, leave the definition exactly where it is and rename every
*reference* to it, so the interface can no longer reach the behavior while the
guide goes on promising it.
`python docs/review-2026-09-06/probe_reach_vs_smoke.py`:

```
binding                                function                 refs   check 12   smoke
sortable-columns-are-described         omsSortTasks             6      passed     passed
unsynced-self-heals                    OMS_START_RECONCILE      1      passed     passed
attributed-notes-are-described         omsAppendNote            1      passed     passed
one-read-tier-is-stated                OMS_IS_EDITOR            8      passed     CAUGHT
retired-status-is-described            isRetired                7      passed     CAUGHT
blocked-status-is-described            isBlocked                2      passed     CAUGHT
   ... 13 rows total
orphaned and caught by NOTHING: 10
```

**Check 12 missed 13 of 13** — which the construction guarantees, since every
definition is left in place and check 12 searches for definitions. That number
restates `c["code"] in html`; it is not a discovery. The result that is not
definitional: the full local gate — 13 numbered checks, 31 preflight assertions
and 458 smoke assertions — missed **10 of 13**. Two of the
three catches (`isRetired`, `isBlocked`) were crashes in the smoke harness, not
coverage; only `OMS_IS_EDITOR` failed real assertions.

Concretely: all six `onclick="omsSortTasks(…)"` handlers can be removed while the
guide still promises "Sort any column" and the gate stays green. The single call
site of `OMS_START_RECONCILE` can be removed — reintroducing F1's incident
exactly — and nothing notices.

**Blast radius.** This is the meta-finding. Check 12 is a genuine advance over
what preceded it and it has caught real drift; the negative suite proves it still
does, and it still catches the common case where a feature is deleted outright
and its symbol goes with it. What it cannot see is drift in which a named symbol
survives but stops being reachable — the exact shape of the Rev 34 case — and
neither can anything else in the gate.

Rev 35 did add reachability assertions — but by hand, for one feature:
`ok('OMS-015: Add note is on the TASK form', /f_note_add/.test(taskModal) && …)`.
That is the right instinct applied one control at a time.

**Confidence: high.** Mechanical, repeatable, with a historical instance and a
synthetic sweep.

---

### F5 — The guard on `CLAUDE.md` does not run when `CLAUDE.md` is the only thing that changed

**Claimed.** `CLAUDE.md`: *"**Gate check 13 fails if a count is written back into
this file**."*

**True.** Check 13 works — `test/no_counts_negative.py` passes 12 of 12 and I
confirmed it. But `.github/workflows/oms-guide-check.yml` filters pushes to
`oms.html`, `index.html`, `data/**`, `test/**`, `scripts/**`,
`gate4_preflight.py` and itself. **`CLAUDE.md` is not in the list.** Client
releases go direct to `main` by policy, so no pull request rescues it.

**Reproduction.**

```bash
curl -s "https://api.github.com/repos/CAO-Initiatives/CAO-OMS/actions/runs?head_sha=$(git rev-parse e5d8fae)"
```

`total_count 1`, and the one run is `pages build and deployment`. The same holds
for `c2a8797`, the other CLAUDE.md-only commit. The commit message of `e5d8fae` is
**"CLAUDE.md: refresh figures that had drifted six revisions out of date"** — the
exact edit check 13 exists to police, deployed with zero checks run.

**Blast radius.** Low direct harm — this is a documentation guard, and the file
is not served. But a guard that cannot see its own subject's commits is a guard
that will report green forever, which is the failure mode `CLAUDE.md` itself
records for check 4.

**Confidence: high.** Confirmed against the live Actions API.

---

### F6 — The consolidator's rebase-abort path has no retry and nothing re-triggers it

**Claimed.** `.github/workflows/consolidate-oms.yml` (OPS-025) fixed the push
race: *"58 runs failed against 27 that succeeded."* The workflow comment states
the danger precisely: *"Had a burst's LAST operation lost the race, nothing would
have retriggered it: that work would have sat in the inbox unconsolidated while
the client reported Unsynced."*

**True for the push race. Not true for the abort path.** The five-attempt retry
loop covers a rejected push. But if the rebase itself conflicts, the workflow
aborts immediately with `exit 1` — no retry, no reschedule, and the same
"nothing re-triggers it" property the comment says was fixed.

**Reproduction — this already happened, after the fix shipped.**

OPS-025 merged at `c62e39f`, 2026-09-06 03:49:17 -0400. Consolidator run **#606**
started 2026-09-06 04:13:47 -0400 — 24 minutes later — and failed:

> Rebase conflict while folding operations into canonical state. Nothing was
> pushed and no operation was lost - the inbox is intact and will be
> reconsolidated. Investigate before rerunning.

It was rescued only because the client posted the same delete a second time,
triggering run #607. That second post is visible in canonical as the conflict
record `delete events/mtkdvtmktpq`, reason **"entity does not exist"**, detected
08:15:44Z — the first delete applied, the duplicate found nothing.

The whole chain is legible in the artifacts: consolidator aborts → operation
sits queued → client shows Unsynced (F1: terminal) → user redoes the edit →
duplicate operation → conflict record → revision bumps → client reports
"Save successful" (F2).

**Blast radius.** Since OPS-025, 6 consolidator runs and 1 failure; before it,
71 failures across ~605 runs. (The workflow comment's "58 failed against 27"
is a different, earlier window — the state when OPS-025 was written, not a
lifetime total. The two are compatible; the report originally quoted both
without saying so.) The retry is a real improvement and I do not want
to understate it. But the residual path is the dangerous one, it fired within
half an hour of the fix, and its recovery depends on somebody happening to save
something else.

**Confidence: high** on the mechanism and the single instance. **Low** on rate —
six runs is not a sample.

---

### F7 — Nothing revokes a session. "Disable sign-in blocks access" is not true for up to eight hours

**Claimed.** The User Guide: *"**Disable sign-in** blocks access without deleting
anything, and is reversible. **Deactivating or deleting someone in the directory
now blocks or removes their sign-in too** — previously it changed only the
directory, so a deactivated person could still log in."*

**True.** It blocks the *next* sign-in. It does nothing to the current one.

`makeSession` mints an HS256 JWT with `setExpirationTime("8h")` carrying the
role in the payload. `requireSession` does `jwtVerify` and returns
`{id, displayName, role}` from that payload. It never reads `auth/users.json`.
There is no `jti`, no token version, no denylist — I grepped `lib/core.js` and
all six endpoints for `revoke|jti|tokenVersion|blacklist|denylist`; the only
matches are comments about the GitHub *installation* token.

So for up to eight hours after an admin disables, deletes, or demotes an
account, the holder keeps exactly the access they had, including write access
through `/api/operation`, and **no action inside OMS ends it**.

One blunt lever does exist and is worth knowing about in an emergency: rotating
`SESSION_SECRET` in Vercel and redeploying invalidates every session at once,
including everybody else's. I did not verify it — §5, I did not open Vercel — but
it follows from `makeSession`/`requireSession` both reading that variable. Added
after the Step 7 read, which correctly objected that "no action available to an
administrator" overreached while the deployment configuration was out of scope.

**Blast radius.** This is the one finding whose worst case is not a data defect.
The realistic trigger is an urgent departure: an administrator disables the
account, the screen confirms it, and the person retains full editor access to
Dean's-office material until the token expires. The tooltip on the control is
accurate ("Block sign-in without removing the account") — the guide sentence
next to it is not.

**Confidence: high on the code, and I did not test it live.** Proving it would
mean disabling a real account on a production system, which I am not going to do
in a review. The code path is short and unambiguous.

---

### F8 — The OPS-029 scrub removed the password from one file out of thirty-seven

**Claimed.** Commit `7c9d173`: *"OPS-029: remove the plaintext password left in
canonical state … readable by everyone who can read shared state."*

**True.** It removed it from `state/oms-state.json`. The value is still present,
in clear, in **36 other files on `main` right now**: 2 files under
`operations/processed/` and 34 under `snapshots/`.

```bash
grep -rlF '<the value>' --include='*.json' .   # 36 files
```

The commit message argues that routing the scrub through the operation path
*"would PUBLISH the secret rather than remove it … kept forever in
operations/processed/"*. That publication had **already happened**.
`operations/processed/2026/09/06/2026-09-06T08-46-41-052Z-458c2600-….json` is a
`people` update carrying `tempPassword` in **both** `changes` and `baseValues`.

**The general form is the finding.** Every update sends `baseValues:
OMS_SANITIZE(before)` — the complete prior record, stripped only of `_version`,
`_updatedAt` and `_updatedBy` — and every consolidation batch copies the whole
state file into `snapshots/`. 161 of 604 processed operations carry
`baseValues`. Nothing prunes either directory, and no redaction path exists.
Anything that ever appears in a record is retained verbatim, forever, in a place
no scrub of canonical will reach.

**Blast radius, stated carefully.** Smaller than it sounds. The exposure is to
people with read access to the private `CAO-OMS-Data` repository, not to
everyone signed into OMS — `/api/state` serves only `state/oms-state.json`. And
the commit asserts the value was never a working credential for anyone, which I
have no way to verify or refute. What I can say is that the removal is
incomplete, that nobody noticed, and that nothing in the system would notice
next time.

**Confidence: high** on the residue and the mechanism; **the severity depends on
a claim I could not check.**

---

### F9 — The gateway has no CI at all

**Claimed.** `CLAUDE.md`: *"**Anything touching the gateway or `CAO-OMS-Data`
goes by PR.** Those have no rollback baseline."*

**True.** `CAO-OMS-Gateway` has no `.github/` directory. `package.json` defines
`check` (a `node --check` over every source file) and `test` (two real test
scripts, `test-password-change.mjs` and `test-admin-accounts.mjs`). **Nothing
runs either of them.** No workflow exists to run on a pull request.

So the repository the release policy protects *most* — because it has no
rollback baseline — is the only one of the three where the protection is a
review by the same agent that wrote the change, with no automated check behind
it. The client, which *can* be rolled back in one commit, has a 13-check gate
and 458 assertions.

**Blast radius.** A syntax error or a broken auth guard in `lib/core.js` reaches
production on merge. The tests that would have caught it exist and are sitting
in the repository unrun.

**Confidence: high.** `ls -la .github/` returns "No such file or directory".

---

### F10 — Hand-written counts came back, in the two places check 13 cannot see, and are already wrong

**Claimed.** `CLAUDE.md`: *"**No counts are written in this file, deliberately** …
a number in prose is a fact with no owner and nothing fails when it drifts."*

**True, and the rule was right.** Both of these are in `CAO-OMS-Data`, where
check 13 does not reach:

- `.github/workflows/canonical-gate.yml`, header comment
- `scripts/validate_canonical.py`, module docstring

Both say: *"The display artifact has 11 gate checks, 31 preflight assertions and
268 smoke assertions."* Live today: **13**, 31, **458**. Two of the three numbers
are wrong, one of them by 190.

**Blast radius.** Documentation only — but it is the exact failure the rule was
written to prevent, reproduced within a day, in a sibling repository, by the same
author. It is the strongest available argument that the rule should travel.

**Confidence: high.**

---

### F11 — 53 conflict records that nobody reads, and a status field latched on

**Claimed.** `README.md` (data): *"Unresolved conflicts are retained under
`conflicts/unresolved/`."* Retained — correctly. Nothing claims they are
surfaced.

**True, and that is the problem.** `consolidate.py` sets
`status = "conflicts-present" if any(CONFLICTS.glob("*.json"))`. Nothing ever
removes a conflict file, so the manifest has read `conflicts-present` since the
first one on 2026-08-04 and can never read `ready` again. No client reads the
field. No workflow alerts on it. The 53 records span a month.

Per F2 these are mostly benign duplicates — but that is a conclusion I reached
by reading them one by one today, a month after the first one landed, and it is
not a conclusion anyone was in a position to reach before. A genuinely lost edit
would look identical from outside.

**Blast radius.** The audit trail works; the alarm on it does not exist. A
latched status is the same as no status.

**Confidence: high.**

---

### F12 — Smaller drifts, each verified

| # | Claim and source | Reality |
|---|---|---|
| a | `INTEGRATION-STATUS.md` (gateway) lists as *"Deliberately not activated yet"*: replacement of the live `oms.html`, production create/update/delete, same-record conflict UI, automatic retry of unsynced operations | All four shipped. The last one is Rev 35's reconciler — which per F1 does not work, so the document is accidentally closer to true than intended |
| b | `.env.example`: `GITHUB_OWNER=CAO-Initatives`, `OMS_ALLOWED_ORIGIN=https://cao-initatives.github.io` | The org is `CAO-Initiatives`. Provisioning from this file gives 404s on every GitHub write and a CORS rejection of the real origin |
| c | `CLAUDE.md`: *"NO en-GB SPELLINGS"*, guarded since Rev 20 | The client is clean. `lib/core.js` and `consolidate-oms.yml` contain "organisation", "normalised", "serialises", "materialise". The guard is client-only |
| d | `CLAUDE.md`: *"Person ids are `slug(name)`"* | `slug("Clare Il'Giovine")` returns `clare-il-giovine`; canonical holds `clare-ilgiovine`. Existing ids are stable, so nothing is broken — but re-deriving an id for that person yields a different one, which would create a second directory entry |
| e | `CLAUDE.md`: *"The gateway appends on `create`"* | The gateway only queues; `consolidate.py` decides. A create for a known id is filed as a conflict. The duplicate is reachable only through id-less rows. The operational instruction ("do not make it reachable") is correct; the attribution is not |
| f | `snapshots/` growth | 151 files, 8.4 MB, one pair per consolidation batch, never pruned. Not a problem yet. Nothing bounds it, and F8 shows what accumulates there |

---

## 3. Findings considered and discarded

Six. Each was a real hypothesis that survived a first look and died on the
second.

**D1 — "A record with `id: ''` evades the id-less guard."** True as far as it
goes: `OMS_MAP` keeps it (`x.id != null` admits `''`), `OMS_UNSYNCABLE` does not
flag it (same test), and `OMS_DIFF` emits an operation with `entityId: ""` which
the gateway rejects with a hard 400 — a save that can never succeed.
**Killed:** I could find no path that assigns `''` to a record's own id. `slug()`
ends `|| uid()`, so even a punctuation-only name yields a generated id, and all
three `id:''` sites in the artifact are `ownerId` / `sourceEventId` foreign keys,
not primary ones. Worth one defensive line if that code is ever touched —
`validate_canonical.py` already tests `in (None, "")` while the client tests only
`== null` — but not a finding.

**D2 — "Check 12's revision-log excision can end early."**
`scripts/text_claims.py` cuts from `const OMS_REV_LOG` to the **first** `];`. A
rev-log summary containing those two characters would end the cut early and let
history be read as interface text — which would let a `requires_text` binding be
satisfied by the revision log, the precise failure `CLAUDE.md` records for check
4. **Killed as a live defect:** measured
(`docs/review-2026-09-06/probe_prose_cut.py`) — the first `];` *is* the true
array terminator, 1 byte of leakage, 0 rev entries. A latent fragility, not a
defect.

**D3 — "`OMS_MAP` collides numeric and string ids."** `m.set(String(x.id), x)`
means `1` and `"1"` overwrite each other and one record silently emits no
operation. **Killed:** every id in canonical is a string; there is no path that
writes a numeric one.

**D4 — "Mojibake in two `people.role` strings."** `Associate Vice President
Academic Operations � Academic Dean's Office`. **Killed:** the bytes are
`E2 80 A2` — U+2022, a deliberate bullet separator. My console could not render
it. Checking this cost two minutes and would have been an embarrassing finding.

**D5 — "The `inbox` branch still holds an unconsumed operation."** It does:
`operations/inbox/2026-09-06T16-01-48-281Z-….json`, and every consolidator run
still fetches and scans that branch. **Killed:** that basename is present in
`operations/processed/2026/09/06/`, so both the workflow's `find` and
`consolidate.py`'s `processed_names` set suppress it. Correct behavior, resting
entirely on filename-based dedupe.

**D6 — "CORS is open when `OMS_ALLOWED_ORIGIN` is unset."** `cors()` only
enforces `if(allowed && origin && origin!==allowed)`. **Killed as a finding**
because an origin check is not a security boundary against non-browser clients
in any case. My original text gave a second reason — that the variable "is set
in production (the client works)" — which the Step 7 read correctly called a
non-sequitur: an unset variable also lets the client work. I did not read the
variable (§5), and the discard never needed that claim.

---

## 4. Recommendations

Nothing here has been built. Rule 5 of the brief: findings first, the user
decides scope.

### Do now

**R1 — Fix F1 before anything else touches the sync path.** The narrow change is
to stop using `_dirty` to mean two different things. Track the operations that
were successfully POSTed but not yet confirmed, and let the reconciler adopt
when *those* are outstanding and no genuinely unsent edit is. The one-line
version — clearing `_dirty` in the catch — would work and would also throw away
the protection against overwriting real unsaved work, so it is the wrong shape.

> **Corrected 6 Sept, after the Step 7 read — and this one was caught mid-build.**
> As written above, R1 re-creates F2 inside the reconciler. The reviewer put it
> exactly: *"Adopting canonical while your operation is outstanding-and-possibly-
> unapplied is exactly what F2 condemns."* Making the reconciler fire while it
> still adopted on a bare `revision > from` would have moved that defect into a
> loop running every three seconds, where **any** unrelated save by **anybody**
> ends the watch and overwrites the user's screen while calling it a
> confirmation. Strictly worse than the inert version.
>
> So the F1-then-F2 sequencing in this report is wrong. The dependency is
> **mutual**: F1's remedy needs F2's verification built in from the start, not
> bolted on after. They are one change, and Rev 36 ships them together —
> `OMS_OPS_LANDED` is used by `OMS_WAIT_FOR` and by the reconciler tick, from
> the same commit.

Whatever is built, **the acceptance test must run the timer**, not match the
source. `repro-reconciler.mjs` is a working drivable-clock harness; the positive
control in it is the shape the smoke suite is missing.

**R2 — Correct the Unsynced banner today, independently of R1.** Removing "and
do not reload" is a text-only change that stops the interface steering people
away from the only recovery that works. It should not wait for the reconciler.

**R3 — Give `rob` ids at the point of creation (F3).** One expression:
`{id:'rob-'+slug(ws), ws, cells, st}`, matching the convention the 5 Sept
migration established. Guard for collision the way person ids do. Add a smoke
assertion that every collection's create path produces an id — the general
version, not one per collection.

### Do before go-live

**R4 — Make confirmation mean confirmation (F2), after R1.** `submitOperation`
already returns an `operationId` and the manifest already records
`lastOperationId`. Verifying that the posted entities carry `_version >
baseVersion` in the returned state is the cheaper route and needs no gateway
change. The failure mode of this fix is more Unsynced, which is exactly why R1
comes first.

**R5 — Decide what "Disable sign-in" is allowed to promise (F7).** Two honest
options: shorten the session so the gap is small enough to live with, or check
the account against `auth/users.json` inside `requireSession` and accept a read
per request. If neither is worth it, change the guide sentence to match the
tooltip, which is already accurate. What should not stand is a Dean's-office
administrator believing access ended when it did not.

**R6 — Run the gateway's existing tests on its pull requests (F9).** The tests
are written. A workflow that runs `npm run check && npm test` is a few lines and
closes the widest hole in the release policy.

**R7 — Retry the consolidator's abort path, or alert on it (F6).** At minimum,
a scheduled run that drains a non-empty inbox would remove the dependence on
somebody happening to save something else. Note the interaction: with R1 in
place, a stranded operation heals itself on the client side too.

### Do later

**R8 — Extend check 12 from existence to reachability (F4).** The generalizable
version of the assertion Rev 35 wrote by hand: let a binding name where the code
must be reachable from — `{"code": "omsAppendNote", "reachable_from":
["openTaskModal", "openSopModal"]}` — and check the reference appears inside
that function's source. It would have caught the Rev 34 case and 10 of the 13
orphanings. Feed each new form to `text_claims_negative.py` first; a check that
only ever passes is the failure this project has already had.

**R9 — Put the client's guards where they apply to all three repositories.**
Check 13 (no hand-written counts) and the en-GB guard are client-only, and both
have already been violated outside the client (F10, F12c). Add `CLAUDE.md` to
the client workflow's path filter while doing it (F5).

**R10 — Decide a retention policy for `snapshots/` and `operations/processed/`
(F8).** The audit trail should stay. Whether it should stay in full, forever,
including every prior value of every field, is a policy question for a
Dean's-office system, and right now it has been answered by default.

**R11 — Surface `conflicts/unresolved/` (F11).** Anything is better than
nothing: a count in the admin console, or a scheduled job that fails when the
directory is non-empty. Clear the 53 first, having read them.

### Deliberately not doing

- **Not recommending the `inbox` branch be re-attempted.** Option 3 in its own
  README — leave the split alone, the OPS-025 retry absorbs most of the race —
  is the right call, and F6 is better fixed by retrying the abort path than by
  reintroducing a two-writer topology.
- **Not recommending the 53 conflict records be backfilled or rewritten.**
  `RECOVERY.md` argues that a false entry in an audit trail is worse than a
  documented absence, and that argument holds here too.
- **Not recommending the plaintext value be purged from git history (F8).** A
  history rewrite of the canonical store, to remove a value the commit record
  says was never a working credential, is a large risk against a small return.
  Rotating anything that shares the pattern is the cheaper answer if that is a
  concern.
- **Not touching anything.** No code, no configuration, and no data was changed
  by this review. The only files added are this report and the reproductions
  beside it, both under `docs/`, which no gate reads.

---

## 5. What this review did not cover

- **The deployed gateway's runtime configuration.** I did not open Vercel. That
  `GITHUB_INBOX_BRANCH` is unset is inferred from repository evidence —
  operations after 16:01Z landed on `main`, not on `inbox` — not from reading the
  variable. F7 likewise is proven from source and was not tested against the
  running service.
- **Anything requiring a signed-in OMS session.** I did not sign in to
  production. `ST` and `OMS_REVISION` as the browser sees them, the role-aware
  guide as a viewer would receive it, and the admin console's live behavior are
  all unverified. **No `viewer` account has ever existed** — `auth/users.json`
  holds one admin and five editors — so the read-only path has never been
  exercised by a real credential by anyone, which is worth knowing before
  go-live.
- **The calendar importers and the category derivation** (Revs 33 and 34). Large
  surfaces, untouched here.
- **Correctness of canonical data.** I checked shape and invariants, not whether
  255 events and 18 tasks say true things.
- **`index.html` and the sign-in flow**, beyond what the gate asserts.
- **Rate limiting, request size limits and abuse resistance** at the gateway.
  `validateOperation` bounds `entityId` at 200 characters and bounds nothing
  else; I did not pursue it because every account is a known member of staff.
- **Performance and scale**, except where growth is unbounded (F12f).
- **Step 10.** The Fable 5.1 steelman and security pass is a separate exercise
  and should be given these findings to attack, not to confirm.

---

## Appendix — reproductions

All under `docs/review-2026-09-06/`. Node needs
`export PATH="$PATH:/c/Program Files/nodejs"` in Git Bash.

| Script | Establishes |
|---|---|
| `repro-reconciler.mjs` | F1, with a positive control |
| `repro-confirmation.mjs` | F2, both scenarios, with a control |
| `repro-robws.mjs` | F3, with two controls |
| `probe_reach_vs_smoke.py` | F4 against check 12 *and* the smoke suite |
| `probe_reachability.py` | F4 against check 12 alone |
| `probe_consolidator.py` | Section 1.5 — the consolidator claims that hold |
| `probe-client-claims.mjs` | Section 1.5 — the client claims that hold; D1, D3 |
| `probe_prose_cut.py` | D2 |
| `fn.py`, `ctx.py` | Helpers for reading the minified artifact |

The three `repro-*.mjs` scripts are expected to report failures — the failures
are the findings. `probe_consolidator.py` and `probe-client-claims.mjs` are
expected to pass except where noted in D1/D3.
