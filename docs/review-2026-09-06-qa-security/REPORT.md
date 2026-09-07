# CAO OMS: QA, architecture and security review, 6 to 7 September 2026

**Reviewer:** Claude Fable 5.1, in a Claude Code session with the three repositories on disk, a signed-in Chrome session on the deployed application, and the Vercel project.
**Artifact under review at start:** `oms.html` Rev 49 / v1.32.0, SHA-256 `00bd4e3f…`, canonical revision 76.
**Artifact at end:** `oms.html` Rev 54 / v1.37.0, SHA-256 `a2b24d12…`, served and verified; canonical revision 84 and rising.
**Authorization from Hossam:** find and fix everything; writes to the live application with named test records, cleaned up; PRs for the gateway and data repositories; Vercel read access.

This report replaces the two-thread chat review the handoff of 6 Sept described. Both scopes (§5 general review, §6 security review) were run here against the source, and the QA lane the handoff excluded was run against the deployed system.

---

## 1. Bottom line

The system as handed over had four defects in the sync path that could lose or misreport a user's work, one of them silently reporting "Save successful" over a lost edit; a client-side escaping function that left every attribute open to a quote in ordinary text; the initial-password formula published in the public artifact; an Admin Console whose three access controls did not reach the account they described; a workbook importer that rebuilt every event on re-import and broke every task link; and a consolidator workflow that failed on the most ordinary multi-record save and left work waiting for a cron.

All of it is fixed and deployed: five client releases (Rev 50 to Rev 54), one gateway PR (OMS-063, merged and deployed on Vercel), and two data-repository PRs (OPS-038, OPS-039, merged). Every fix is asserted in a suite and, where it concerns text, bound to the code by gate check 12. The smoke suite grew from 596 to 863 assertions and the text-claims manifest from 54 to 92 bindings; read the totals from the commands, not from here.

Three things need Hossam:

1. **Five of six accounts are still on their initial password** (D-02). Until each person sets one, the read path of canonical state is protected by a password that was derivable from a public file until Rev 51 this evening. This is an operational action, not code.
2. **`OMS_USERS_JSON` is still set in the Vercel project** (seen in the environment variable list; value not opened). The gateway's own comment says to delete it once `auth/users.json` exists, so that a missing file fails loudly instead of reverting the roster to the seed. Deleting a production variable is your call.
3. **Two decisions recorded below** (§7): the Key Dates import now refuses a workbook whose year cannot be established rather than guessing, and the consolidator now restarts from the tip of `main` instead of rebasing. Both are behavior changes you should know about.

---

## 2. What shipped

| Where | What | Commit / PR | Verified live |
|---|---|---|---|
| Client Rev 50, v1.33.0 | Sync path: idle watch unblocked at boot; field-level merge reachable; edits made during confirmation kept; per-record conflict handling; gate threshold R-01 | `c2abc77` | `19e72e23…` served |
| Client Rev 51, v1.34.0 | Client security: `esc()` escapes quotes; link scheme allow-list; random initial-password suggestion; sign-out clears local copy; role from `/api/me`; forced-change redirect; nested escapes; role UI re-applied on every render | `78407c6` | `ef0cb9ff…` served |
| Gateway OMS-063 | Role-change action; sessions end when the password changes; credential guard walks the whole payload; payload caps and unsafe keys; login timing oracle; commit-message sanitizing; pinned actions | PR #20, merged, Vercel production | `role` action answers 404 for an unknown id |
| Data OPS-038 | Consolidator treats a changed field with no base value as a conflict; workflow actions pinned; RECOVERY.md corrected | PR #15, merged | canonical gate passed |
| Client Rev 52, v1.35.0 | Admin Console: Access Level reaches the account; Deactivate blocks sign-in; Delete removes the account; duplicate guard and slug ids; null base values for new keys | `60c78a8` | `1887591a…` served |
| Client Rev 53, v1.36.0 | Importer: matched rows keep id, status, end date and time, notes; year from the sheet; skip-list works; date validation; real rollback; size guard; one word "Standing" | `a2c812d` | `3b4134a5…` served |
| Data OPS-039 | Consolidator starts from the tip of `main` and restarts instead of rebasing | PR #16, merged | run 619 onward all green |
| Client Rev 54, v1.37.0 | Thirty-six correctness and accessibility findings, plus the live-found "own create treated as conflict" | `30b0660` | `a2b24d12…` served |

Rollback baseline for the client is any earlier tag: `./scripts/rollback.sh v1.32.0` restores the artifact this review started from.

---

## 3. Sync path (architecture)

The handoff named the sync path as the highest-value area. Five defects were found by reading, reproduced in `repro-sync-path.mjs` before any fix, fixed, and re-verified against the deployed system with test records.

| ID | Severity | Finding | Reproduced | Fixed | Live check |
|---|---|---|---|---|---|
| S-1 | High | Rev 44's idle refresh never ran: the boot migration's `save()` left all 15 collections dirty and `OMS_WATCH_SAFE()` refused for the life of the session. Verified live: 348 s after sign-in, 15 dirty, 0 reads. | Case 1 | Rev 50 | Fresh session: 0 dirty, watch safe |
| S-2 | High | Field-level merge was unreachable: `OMS_ASSERT_CURRENT` refused any update whose record version had moved, before posting. The guide promised different-field merges since Rev 44. | Case 2 | Rev 50 | Colleague changed notes, I changed the title: both survive, version 4, no alert |
| S-3 | High | An edit made while a save was confirming was overwritten by wholesale adoption, its dirty flag cleared, and the screen said "Save successful". | Case 3 | Rev 50 | Edit A, edit B 2.5 s later: both landed, toast "Save confirmed; sending your newer edit" |
| S-4 | High | One stale record discarded the whole batch, new records included. | Case 4 | Rev 50 | Conflicting title on B plus a priority change on A: B set aside and named, A kept and saved |
| S-5 | High | Found live: a save while an earlier create was still confirming raised the conflict alert for the user's own record. | Case 5 | Rev 54 | Smoke case; the live sequence that raised it no longer alerts |
| S-6 | Medium | A stale pending copy in `localStorage` survives a reload that adopts canonical, so the "Leave site?" prompt fires on a Connected page. Seen live. | — | Open, see §8 | — |
| S-7 | High (architecture) | A multi-record save is one gateway commit per record, so three runs; GitHub cancels the pending one and the third rebases into a conflict on `state/oms-state.json`. Work waits for the cron. Seen live: runs 616 / 617 / 618. | Live | OPS-039 | Runs 619 to 625 all succeeded, including a manual dispatch that drained the inbox |

Consolidator-side, OPS-038 closes the gap the client's field-level merge opened: a changed key with no base value is a conflict, not a pass (17 of 162 processed updates had carried such keys). The client sends `null` for a key the record did not have since Rev 52, so a genuinely new field still merges.

---

## 4. Security

Defensive review of first-party code. Discovery and fixes only.

| ID | Severity | Exploitable by | Finding | Fixed |
|---|---|---|---|---|
| E-01 | High | anonymous | `omsSuggestedPassword` returned surname + a fixed suffix inside the public artifact; anyone could compute the initial password of every unchanged account and, by signing in first, set the new one. | Rev 51: six random digits, still dictatable |
| E-03 | High | any editor, workbook supplier | `esc()` escaped `& < >` only; used in attribute position at about forty sites. | Rev 51: five characters, stringifies numbers |
| E-02 | High | any editor writes, any reader clicks | Stored links rendered straight into `href` with no scheme check (13 anchors). | Rev 51: http, https, mailto only; bare host gets https; refusal on save |
| D-01 / A-01 | High | admin only (consequence: a user who should have been demoted keeps rights) | No gateway role-change action; the console's Access Level wrote a field nothing read. | OMS-063 + Rev 52 |
| D-02 | High | anonymous | Five of six accounts on the documented initial password; no rate limiting (FAB-09 parked). | **Operational, open** |
| D-03 | High | any editor | Field-level merge checked only keys the client chose to put in `baseValues`. | OPS-038 + Rev 52 |
| D-04 | High | holder of a stolen token | Changing a password did not end existing sessions. | OMS-063: tokens issued before `passwordSetAt` are refused |
| A-02 / A-03 / D-05 | High | admin console | Deactivate set a flag authentication never read; Delete left the account live and unreachable. | Rev 52 |
| E-08 | Medium | anyone at the machine later | Sign-out left the full shared state in `localStorage`, twice. | Rev 51 |
| E-09 / E-11 | Medium | signed-in viewer | Role read from a sessionStorage blob; forced password change enforceable only on the sign-in page. | Rev 51: `/api/me` at boot; redirect when the flag is set |
| D-06 / D-07 | Medium | any editor | Credential guard top-level only; no payload caps; `__proto__` accepted as a key. | OMS-063 |
| D-09 | Medium | anonymous | Login timing distinguished unknown ids from real ones. | OMS-063 |
| E-04, E-05, E-06, E-07, C-06 | Medium | editor, workbook supplier | Unescaped interpolations (role class, import date, two dates, three date inputs); entity decoding through a detached textarea. | Rev 51 |
| E-10 / C-03 | Low | signed-in viewer (presentation only) | Read-only hiding re-applied only on tab change; any filter put the buttons back. | Rev 51 + Rev 54 |
| E-13 | Low | editor | Prompt-sourced email unvalidated. | Rev 51 |
| D-15, D-14, D-11 | Low | — | Commit message carried raw `entityId`; actions on moving tags; three prose claims false. | OMS-063, OPS-038 |
| D-10 | Medium | revoked account during a GitHub outage | Fail-open restores a disabled or deleted account for the token's life. Documented trade-off; unbounded. | **Open, recommend bounding staleness** |
| D-12 | Low | — | Revision increments on a batch of refused operations; `/api/state` does not expose `manifest.status`. | Open |

Confirmed clean: no dynamic code execution; SheetJS SRI pin matches the CDN file byte for byte; no secrets in either page or the data seed; sign-in page autocomplete, error text and token clearing sound; `mutateAuthFile` concurrency correct; no salt or hash reachable through any endpoint; workflows fork-safe with the App key only in Vercel.

Parked decisions (FAB-08 CSP, FAB-09 scrypt parameters and rate limiting, DEC-017 reads on an initial password, DEC-009, DEC-025) were not reopened. Two notes: FAB-09's "hash comparison" half was already constant-time; DEC-017's premise that initial passwords would be short-lived has not held (D-02).

---

## 5. Client correctness (general review)

Grouped; every row is fixed in the release named unless marked open.

**Save paths (Rev 54):** task branch rebuilt the record instead of merging (A-04); vanished record silently discarded (A-14); new task pre-assigned to the first person with a notification queued (A-06); person created before the task validated (A-07); deactivated people invisible to owner resolution (A-05); dependency cycles creatable (A-17); four intake sections create-only (A-08, delete added); status coerced to Current (A-21); category remembered before validation (A-13).

**Retired (Rev 54):** Retired SOPs counted in SOP Reviews Due (R-03); Retired task rendered as an ordinary calendar pill (C-07); linked-task counts included Retired (A-19); "struck through" hint (R-10). The brief's claim that R-02 and R-03 were the only Retired gaps was wrong: C-07 was a third.

**Dates (Rev 54):** `dFrom` off by one across the fall-back clock change (C-02); four UTC "today" sites, not three (C-14 adds the printed checklist to R-12); Weekly Brief missed multi-day events that began before the week (C-08).

**Notifications (Rev 54):** reminder key ignored the recipient (A-10); first assignment worded as reassignment (A-15); re-marking rewrote `sentAt` (A-16); retiring a prerequisite unblocked dependents silently (A-18).

**Views, sorting, categories (Rev 54):** descending sorts put blanks first (C-04); saved calendar views dropped two filters and a stale saved category showed All over an empty table (C-05, R-07); rename skipped SOPs and the dialog counted them as nothing (R-04, A-12).

**Importer (Rev 53):** the full B-series. The three that mattered most: every re-import minted new ids and orphaned every linked task (B-03); `uid()` had about a one-in-three collision chance on a 182-row import and `OMS_MAP` drops the loser silently (B-02); the Key Dates year was a hard-coded 2026 (B-05). Also R-02, R-05, R-06, R-08, R-09, R-13.

**Dead code (Rev 54):** `calItemClick`, `calItemDelete`, `cycleRob` removed; `omsRemoveSignIn` wired (Rev 52); `OMS_TASK_STATUSES` now drives the status lists; the `btn-reset` guard for a control removed in Rev 9 deleted (Rev 51). `buildSeed` remains, deliberately, as the seed.

**Accessibility (Rev 54):** labels associated with inputs, chips and pills keyboard-operable, dialog role and focus management. Zero `aria-`, `tabindex`, `role=` and `for=` attributes before.

**Process:** the release gate skipped its guide, badge and rev-log checks on any diff of five lines or fewer (R-01); Rev 47 shipped that way. Threshold now zero (Rev 50).

---

## 6. Live QA lane

Run against the deployed Rev 52 to Rev 54 with records named `QA-FABLE-2026-09-06 …`, all removed at the end (see §9).

| Case | Result | Evidence |
|---|---|---|
| Sign-in state on a fresh session | Pass | Rev 52: dirty 0, watch safe, role admin from `/api/me` |
| Single-record save confirms | Pass | Task B create: Connected, revision 78 → 79, about 20 s |
| Multi-record save (task + notification + history) | **Fail on Rev 52 / old workflow, then Pass** | Runs 616 applied, 617 cancelled, 618 rebase conflict; two operations stranded; client honestly Unsynced; drained by a manual dispatch of the OPS-039 workflow (revision 78) |
| Edit made while an earlier save is confirming | Pass | Both titles in canonical, revisions 80 and 81 |
| Concurrent edit, different fields | Pass | Colleague note via gateway (v3), my title (v4); no alert |
| Concurrent edit, same field, plus an unrelated edit | Pass | Alert names `tasks <id> (title)`; B reverts to the colleague's; A's priority kept and saved |
| Own create still confirming, then a second save | **Fail on Rev 52, fixed in Rev 54** | Conflict alert for the user's own record; froze the tab behind `alert()` |
| Stale pending copy after reload | **Fail, open (S-6)** | `cao_oms_v140_pending` from 02:35 still present on a Connected page; "Leave site?" fires |
| Unassigned task | Pass | First owner option blank; no notification queued |
| Admin Console: add, sign-in, role, deactivate, reactivate, delete | See §6.1 | |
| Escaping and links | See §6.1 | |
| Retire flows | See §6.1 | |

### 6.1 Remaining live cases

_Filled in below as they complete._

---

## 7. Decisions taken that you should know about

1. **Key Dates import refuses when no year can be established** (B-05). The brief said both "fall back to the current year" and "refuse"; those cannot both hold, and guessing the year is the exact defect. The upload card states the rule. Flip to a fallback if you prefer.
2. **The consolidator starts from the tip of `main` and restarts on a rejected push** (OPS-039). Rebasing canonical state was the failure; there is no merge now. Never force-pushes.
3. **An administrator's password reset ends the holder's live sessions** (OMS-063, D-04). A reset is known to the administrator, so the old session should not outlive it.
4. **Standing** is the one word for the recurring flag across the importer and the event form (R-13). The stored field stays `recurring`.
5. **Deactivate now blocks the sign-in account first** and refuses if the gateway refuses (self, last admin). The directory flag only follows a successful block.

---

## 8. Open items

| ID | What | Recommendation | Effort |
|---|---|---|---|
| D-02 | Five accounts on initial passwords | Each person signs in and sets one; then delete `OMS_USERS_JSON` from Vercel | Ops |
| S-6 | Stale pending copy survives a boot that adopts canonical; "Leave site?" fires on a Connected page | On boot, clear the pending copy when its operations had reached the gateway; otherwise show a one-time banner naming the time of the work that was not sent | S |
| D-10 | Fail-open on an unreadable auth file is unbounded | Refuse writes when the last successful read is older than about 15 minutes; keep reads | M |
| D-12 | Revision bumps on refused batches; `manifest.status` unread | Return `manifest.status` from `/api/state`; confirm on `operationId` | M |
| — | Viewer role has never been exercised by a real account | Create one test viewer and run the read-only cases from a second browser profile | Ops + QA |
| — | Import lane on a real workbook | Preview-only run of the Events and Key Dates workbooks on Rev 53 (no confirm) | QA |

---

## 9. Test records and cleanup

_Filled in on completion._

---

## 10. Contradictions to the handoff

- §4c "the two real gaps are R-02 and R-03": a third Retired gap existed (C-07).
- §4a R-05 "cadence carry-forward reaches 0 of 248 rows": the key is symmetric; the mechanism is title divergence and whitespace, now normalized, with a second-chance match (Rev 53). The row should be re-scoped rather than closed as stated.
- §4b "seedPeople is latent": true, but `buildSeed` is about 1,650 lines of dead seed data that nothing loads; left in place as the documented seed.
- Rev 44's log entry says the field-level merge "is true now"; it was true only inside the seconds between the client's version check and the fold (S-2).
- Rev 45's log says the unescaped interpolations were "escaped now"; the function they relied on did not escape quotes (E-03).
- The handoff's §2 states the gate's check 12 held 54 bindings and the suite 596 assertions. Both were correct when written and both changed the same day, which is the argument CLAUDE.md already makes for not writing counts in prose.

---

## 11. Files in this folder

- `repro-sync-path.mjs`: five reproductions against `oms.html`; all pass at Rev 54, all five failed at the revision they name.
- `REPORT.md`: this document.
