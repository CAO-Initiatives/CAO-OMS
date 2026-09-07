# Rev 17 (client) — build brief

**Target: `v1.7.0`, rev 17.** Read `CLAUDE.md` first; it holds the repo rules and the traps. This file holds only what Rev 17 is.

Baseline is `v1.6.0`, rev 16, `oms.html` 166,165 bytes, SHA-256 `369ed11eb5aa86493cc338b02d4e79f2e40b595c8c609384c6ab05f4f88a88b9`. That is also the rollback target.

`2.0.0` is reserved for the Dean's Office production go-live and must not be spent here.

---

## The nine items

Ordered by how much they can hurt. Build in this order; the risky ones deserve a fresh head.

**1. `ownerId` backfill across the 17 existing tasks.** Every owner string now resolves through the Rev 16 ladder, so set `ownerId` from `findPerson(t.owner).id` wherever it is missing. Decouples notification routing from display-name changes.

> **Do this through the normal client save path.** Tasks have ids, so `OMS_DIFF` emits proper update operations. The 5 Sept rule that canonical migrations must bypass the ops path applied *only* because `gw`/`rob` records had **no** ids. Reaching for a direct `state/oms-state.json` edit here would be over-applying that lesson and would bypass the audit trail for no reason.

**2. Retired task status.** Status vocabulary is currently exactly `Complete` / `In Progress` / `Not Started`, and `eventTaskStats` counts done only on an exact match to `Complete`. Three tasks were closed as `Complete` on 5 Sept that were never delivered, so every completion figure on a Dean-facing dashboard overstates delivery. Add `Retired`: excluded from overdue counts, excluded from the done numerator, visibly distinct.

**3. `Recurring` boolean on events, plus a free user-maintained category list.** A category holds one value, so cadence must not be folded into it — that forces false choices like "is this Cabinet or Recurring?". Outlook reports recurrence natively on every event; when it was written this sentence promised that a calendar sync would populate the field. No such sync was ever built, Rev 47 removed the two interface sentences that promised it, and since Rev 48 the field is set by hand or derived from the title at import.

**4. User-editable filters, saved per user.**

**5. Auto-extending horizon.** Users may create events beyond the loaded range and the system extends automatically rather than refusing.

**6. Multi-day event spanning in grid mode.** Confirmed **not built**: `buildCalGrid` filters events by a single `date` (`d.getMonth()===m`), so a multi-day event renders once, on its start date, in its start month. `endDate` and `endTime` exist from Rev 14 and appear in list mode's Ends column, but the grid ignores them. Needs a date-range loop.

**7. Grid legend, with colour paired to a glyph** so colour is never load-bearing. Red/green status coding fails for colour-blind readers, and there is no legend in the grid today.

**8. `OMS-026` Dean briefing export.** Blocked on a decision, not on build. Rachel Woodside owns it — OMS task `mtp0y4e2wik`, due 19 Sept. Three candidates: print the Weekly Brief as-is, a generated PDF with a fixed layout, or slides. The export path differs for each, so building before the answer means building twice.

**9. QA sign-off on `OMS-032`, `033`, `034`, `035`, `036`.** Already in the product; they need exercising by real users, not code. Email drafted to Maggie and Ari listing all eight QA items with a pass criterion each.

---

## Assertions first

Write the assertion in `test/smoke.mjs` **before** the implementation, for items **1, 2, 3, 4 and 5** — anything touching sync, save, or owner resolution. The Rev 16 pattern worked: the five TODOs *were* the spec, and flipping them to PASS was the completion signal. Promote each to a hard `ok()` once it passes.

Skip assertions for **6 and 7**. They are visual, and a smoke assertion would only restate the CSS.

Current baseline: **36 assertions, 0 failed, 0 TODO.**

---

## NOT in Rev 17

The three sync-path fixes are **quarantined to Rev 18**: batch the POSTs (currently `for(const op of ops) await OMS_POST(op)`, so latency scales linearly with change count), poll more often, and add a `beforeunload` guard while a save is pending. `OMS_SYNC_ONCE` carries the id-less-record guard established on 5 Sept and is the highest-risk surface in the codebase. Bundling those fixes here would mean a sync regression could only be reverted by also losing everything above.

Rev 18 also carries the Power Automate flows, notification relay first.

---

## Shipping it

```bash
node test/smoke.mjs oms.html          # behaviour
./scripts/release_gate.sh HEAD~1      # form
./scripts/release.sh 1.7.0 "Rev 17 (client). ..."
./scripts/verify_live.sh <sha256>
```

`release.sh` takes a full semantic version, refuses anything that is not a strict increase, refuses to push if either check fails, and tags the release. **The repo has no tags yet — `v1.7.0` will be the first.**

Client releases go **direct to `main`**. A PR is required only for the gateway or `CAO-OMS-Data`.

---

## After it is live

*(Corrected 7 Sept 2026.)* This section once said to start the "calendar sync" after Rev 17 shipped. That sync was never built: Outlook is not a source OMS reads from, the two interface sentences that promised it were removed in Rev 47, and DEC-007 records that the workbooks own Ari's and Maggie's events while the Dean's Outlook is consulted by hand. The `Recurring` field is set on the event form or derived from the title at import (Rev 48, Rev 53).

Then regenerate the canonical backlog workbook to reflect the Rev 17/18 split.
