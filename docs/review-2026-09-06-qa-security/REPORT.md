# CAO OMS: QA, architecture and security review, 6 to 7 September 2026

**Reviewer:** Claude Fable 5.1, in a Claude Code session with the three repositories on disk, a signed-in Chrome session on the deployed application, and the Vercel project.
**Artifact under review at start:** `oms.html` Rev 49 / v1.32.0, SHA-256 `00bd4e3f…`, canonical revision 76.
**Artifact at end:** `oms.html` Rev 56 / v1.39.0, SHA-256 `37e940b9…`, served and verified; canonical revision 93.
**Authorization from Hossam:** find and fix everything; writes to the live application with named test records, cleaned up; PRs for the gateway and data repositories; Vercel read access.

This report replaces the two-thread chat review the handoff of 6 Sept described. Both scopes (§5 general review, §6 security review) were run here against the source, and the QA lane the handoff excluded was run against the deployed system. Every figure below was read from a command, a repository or the running application during this session.

---

## 1. Bottom line

The system as handed over had four defects in the sync path that could lose or misreport a user's work, one of them reporting "Save successful" over a lost edit; an escaping function that left every attribute open to a quote in ordinary text; the initial-password formula published in the public artifact; an Admin Console whose access controls did not reach the account they described, and whose Create sign-in dialog had always run as a password reset; a workbook importer that rebuilt every event on re-import and broke every task link; and a consolidator workflow that failed on the most ordinary multi-record save and left work waiting for a cron.

All of it is fixed and deployed: seven client releases (Rev 50 to Rev 56), one gateway PR (OMS-063, merged and deployed on Vercel), and two data-repository PRs (OPS-038, OPS-039, merged). Every fix is asserted in a suite and, where it concerns text, bound to the code by gate check 12. Read the suite and binding totals from the commands; they moved several times today.

Three things need Hossam:

1. **Five of six accounts are still on their initial password** (D-02). Until each person sets one, the read path of canonical state is protected by a password that was derivable from a public file until Rev 51. Operational, not code.
2. **`OMS_USERS_JSON` is still set in the Vercel project.** Seen by name in the environment variable list; the value was not opened. The gateway's own comment says to delete it once `auth/users.json` exists, so that a missing file fails loudly instead of reverting the roster to the seed. Deleting a production variable is your call.
3. **Behavior changes recorded in §7**, two of them worth a conscious yes: the Key Dates import refuses a workbook whose year cannot be established, and the consolidator restarts from the tip of `main` instead of rebasing.

---

## 2. What shipped

| Where | What | Commit / PR | Verified |
|---|---|---|---|
| Client Rev 50, v1.33.0 | Sync path: idle watch unblocked at boot; field-level merge reachable; edits made during confirmation kept; per-record conflict handling; gate threshold (R-01) | `c2abc77` | `19e72e23…` served |
| Client Rev 51, v1.34.0 | Client security: `esc()` escapes quotes; link scheme allow-list; random initial-password suggestion; sign-out clears the local copy; role from `/api/me`; forced-change redirect; nested escapes; role UI re-applied on every render | `78407c6` | `ef0cb9ff…` served |
| Gateway OMS-063 | Role-change action; sessions end when the password changes; credential guard walks the whole payload; payload caps and unsafe keys; login timing oracle; commit-message sanitizing; pinned actions | PR #20, merged, on Vercel production | `role` action answers 404 for an unknown id |
| Data OPS-038 | A changed field with no base value is a conflict; workflow actions pinned; RECOVERY.md corrected | PR #15, merged | canonical gate passed |
| Client Rev 52, v1.35.0 | Admin Console: Access Level reaches the account; Deactivate blocks sign-in; Delete removes the account; duplicate guard and slug ids; null base values for new keys | `60c78a8` | `1887591a…` served |
| Client Rev 53, v1.36.0 | Importer: matched rows keep id, status, end date and time, notes; year from the sheet; skip-list works; date validation; real rollback; size guard; one word "Standing" | `a2c812d` | `3b4134a5…` served |
| Data OPS-039 | Consolidator starts from the tip of `main` and restarts instead of rebasing | PR #16, merged | runs 619 onward all green, including a manual dispatch |
| Client Rev 54, v1.37.0 | Thirty-six correctness and accessibility findings, plus the live-found "own create treated as a conflict" | `30b0660` | `a2b24d12…` served |
| Client Rev 55, v1.38.0 | Live-found: Create sign-in always ran as a reset; SOP link site missed the scheme check; stale pending copy outlived its work | `773529b` | `ff31ef4a…` served |
| Client Rev 56, v1.39.0 | Live-found: Admin Console functions held a stale record across an await while a sync replaced the state | `3037b29` | `37e940b9…` served |

Rollback baseline for the client is any earlier tag: `./scripts/rollback.sh v1.32.0` restores the artifact this review started from.

---

## 3. Sync path (architecture)

The handoff named the sync path as the highest-value area. The defects below were found by reading, reproduced in `repro-sync-path.mjs` before any fix, fixed, and re-verified against the deployed system with test records.

| ID | Severity | Finding | Reproduced | Fixed | Live check |
|---|---|---|---|---|---|
| S-1 | High | Rev 44's idle refresh never ran: the boot migration's `save()` left all 15 collections dirty and `OMS_WATCH_SAFE()` refused for the life of the session. Live before the fix: 348 s after sign-in, 15 dirty, 0 reads. | Case 1 | Rev 50 | Fresh session on Rev 52 and later: 0 dirty, watch safe |
| S-2 | High | Field-level merge was unreachable: `OMS_ASSERT_CURRENT` refused any update whose record version had moved, before posting. The guide had promised different-field merges since Rev 44. | Case 2 | Rev 50 | Colleague changed notes through the gateway (v3), I changed the title from an open dialog (v4): both survive, no alert |
| S-3 | High | An edit made while a save was confirming was overwritten by wholesale adoption, its dirty flag cleared, and the screen said "Save successful". | Case 3 | Rev 50 | Edit A, edit B 2.5 s later: both landed (revisions 80, 81), toast "Save confirmed; sending your newer edit" |
| S-4 | High | One stale record discarded the whole batch, new records included. | Case 4 | Rev 50 | Conflicting title on B plus a priority change on A in one save: B set aside and named with its field, A kept and saved |
| S-5 | High | Found live: a save while an earlier create was still confirming raised the conflict alert for the user's own record, and the alert froze the tab. | Case 5 | Rev 54 | The sequence that raised it no longer alerts |
| S-6 | Medium | Found live: the pending copy in `localStorage` survived a reload that adopted canonical, so a Connected page kept asking "Leave site?"; work that never reached the gateway was discarded on reload with nothing said. | Smoke | Rev 55 | Reload on Rev 55: copy cleared, no prompt |
| S-7 | High (architecture) | Found live: a multi-record save is one gateway commit per record, so three consolidator runs; GitHub cancels the pending one and the third rebases into a conflict on `state/oms-state.json`. Work waited for the cron, which did not fire on time. Runs 616 / 617 / 618. | Live | OPS-039 | Runs 619 to 625 all succeeded; a manual dispatch drained the inbox in 15 s |
| S-8 | Medium | Found live: Admin Console functions found a record, awaited the gateway, then wrote to it; a sync confirming during the await had replaced the state, so the write landed on an orphan. Reactivate restored the account and lost the directory flag. | Smoke | Rev 56 | Suite replaces the state inside the stubbed gateway call |

Consolidator-side, OPS-038 closes the gap the client's field-level merge opened: a changed key with no base value is a conflict, not a pass (17 of 162 processed updates had carried such keys). The client sends `null` for a key the record did not have since Rev 52, so a genuinely new field still merges.

---

## 4. Security

Defensive review of first-party code. Discovery and fixes only; nothing here is exploit material.

| ID | Severity | Exploitable by | Finding | Fixed |
|---|---|---|---|---|
| E-01 | High | anonymous | `omsSuggestedPassword` returned surname + a fixed suffix inside the public artifact; anyone could compute the initial password of every unchanged account and, by signing in first, set the new one. | Rev 51: six random digits, still dictatable |
| E-03 | High | any editor, workbook supplier | `esc()` escaped `& < >` only; used in attribute position at about forty sites. | Rev 51 |
| E-02 | High | any editor writes, any reader clicks | Stored links rendered straight into `href` with no scheme check (13 anchors); the SOP save path was missed in Rev 51 and found live. | Rev 51 + Rev 55 |
| D-01 / A-01 | High | admin console | No gateway role-change action; the console's Access Level wrote a field nothing read. | OMS-063 + Rev 52 |
| D-02 | High | anonymous | Five of six accounts on the documented initial password; no rate limiting (FAB-09 parked). | **Operational, open** |
| D-03 | High | any editor | Field-level merge checked only keys the client chose to put in `baseValues`. | OPS-038 + Rev 52 |
| D-04 | High | holder of a stolen token | Changing a password did not end existing sessions. | OMS-063 |
| A-02 / A-03 / D-05 | High | admin console | Deactivate set a flag authentication never read; Delete left the account live and unreachable. | Rev 52 |
| — | High | admin console | Create sign-in for an existing person always ran as a password reset (`openModal` replaced `MC` and lost the mode). Found live. | Rev 55 |
| E-08 | Medium | anyone at the machine later | Sign-out left the full shared state in `localStorage`, twice. | Rev 51 |
| E-09 / E-11 | Medium | signed-in viewer | Role read from a sessionStorage blob; forced password change enforceable only on the sign-in page. | Rev 51 |
| D-06 / D-07 | Medium | any editor | Credential guard top-level only; no payload caps; `__proto__` accepted as a key. | OMS-063 |
| D-09 | Medium | anonymous | Login timing distinguished unknown ids from real ones. | OMS-063 |
| E-04 to E-07, C-06 | Medium | editor, workbook supplier | Unescaped interpolations; entity decoding through a detached textarea. | Rev 51 |
| E-10 / C-03 | Low | signed-in viewer (presentation) | Read-only hiding re-applied only on tab change. | Rev 51 + Rev 54 |
| E-13 | Low | editor | Prompt-sourced email unvalidated. | Rev 51 |
| D-15, D-14, D-11 | Low | — | Raw `entityId` in commit messages; actions on moving tags; three false prose claims. | OMS-063, OPS-038 |
| D-10 | Medium | revoked account during a GitHub outage | Fail-open restores a disabled or deleted account for the token's life; documented, unbounded. | **Open** |
| D-12 | Low | — | Revision increments on a batch of refused operations; `manifest.status` unread. | Open |

Confirmed clean: no dynamic code execution; SheetJS SRI pin matches the CDN file byte for byte; no secrets in either page or the data seed; sign-in page autocomplete, error text and token clearing sound; `mutateAuthFile` concurrency correct; no salt or hash reachable through any endpoint; workflows fork-safe with the App key only in Vercel.

Parked decisions (FAB-08 CSP, FAB-09 scrypt parameters and rate limiting, DEC-017 reads on an initial password, DEC-009, DEC-025) were not reopened. Two notes: FAB-09's "hash comparison" half was already constant-time; DEC-017's premise that initial passwords would be short-lived has not held (D-02).

---

## 5. Client correctness (general review)

Every row is fixed in the release named unless marked open.

**Save paths (Rev 54):** task branch rebuilt the record instead of merging (A-04); vanished record silently discarded (A-14); new task pre-assigned to the first person with a notification queued (A-06); person created before the task validated (A-07); deactivated people invisible to owner resolution (A-05); dependency cycles creatable (A-17); four intake sections create-only (A-08, delete added); status coerced to Current (A-21); category remembered before validation (A-13).

**Retired (Rev 54):** Retired SOPs counted in SOP Reviews Due (R-03); Retired task rendered as an ordinary calendar pill (C-07); linked-task counts included Retired (A-19); "struck through" hint (R-10). The brief's claim that R-02 and R-03 were the only Retired gaps was wrong: C-07 was a third.

**Dates (Rev 54):** `dFrom` off by one across the fall-back clock change (C-02); four UTC "today" sites, not three (C-14 adds the printed checklist to R-12); Weekly Brief missed multi-day events that began before the week (C-08).

**Notifications (Rev 54):** reminder key ignored the recipient (A-10); first assignment worded as reassignment (A-15); re-marking rewrote `sentAt` (A-16); retiring a prerequisite unblocked dependents silently (A-18).

**Views, sorting, categories (Rev 54):** descending sorts put blanks first (C-04); saved calendar views dropped two filters and a stale saved category showed All over an empty table on Tasks and SOPs (C-05, R-07); rename skipped SOPs and the dialog counted them as nothing (R-04, A-12).

**Importer (Rev 53):** the full B-series. The three that mattered most: every re-import minted new ids and orphaned every linked task (B-03); `uid()` had about a one-in-three collision chance on a 182-row import and `OMS_MAP` drops the loser silently (B-02); the Key Dates year was a hard-coded 2026 (B-05). Also R-02, R-05, R-06, R-08, R-09, R-13.

**Dead code:** `calItemClick`, `calItemDelete`, `cycleRob` removed and `OMS_TASK_STATUSES` now drives the status lists (Rev 54); `omsRemoveSignIn` wired (Rev 52); the `btn-reset` guard for a control removed in Rev 9 deleted (Rev 51). `buildSeed` remains, deliberately, as the seed.

**Accessibility (Rev 54):** labels associated with inputs, chips and pills keyboard-operable, dialog role and focus management. The shipped artifact had no `aria-`, `tabindex`, `role=` or `for=` attributes at all.

**Process:** the release gate skipped its guide, badge and rev-log checks on any diff of five lines or fewer (R-01); Rev 47 shipped that way. Threshold now zero (Rev 50). It stopped Rev 56 for exactly that reason this evening, and the release went out only after the guide sentence was added.

---

## 6. Live QA lane

Run against the deployed Rev 52 to Rev 55 with records named `QA-FABLE-2026-09-06 …` and a person named `QA Fable Testperson`, all removed at the end (§9).

| Case | Result | Evidence |
|---|---|---|
| Fresh sign-in state | Pass | Rev 52+: dirty 0, watch safe, role admin from `/api/me` |
| Single-record save confirms | Pass | Task B create: Connected, revision 78 to 79, about 20 s |
| Multi-record save (task + notification + history) | **Fail on the old workflow, then Pass** | Runs 616 applied, 617 cancelled, 618 rebase conflict; two operations stranded; client honestly Unsynced; drained by a manual dispatch of the OPS-039 workflow (revision 78). Later multi-record saves all confirmed |
| Edit made while an earlier save is confirming | Pass | Both titles in canonical, revisions 80 and 81 |
| Concurrent edit, different fields | Pass | Colleague note via gateway (v3), my title (v4); no alert |
| Concurrent edit, same field, plus an unrelated edit | Pass | Alert names `tasks <id> (title)`; B reverts to the colleague's; A's priority kept and saved (v5) |
| Own create still confirming, then a second save | **Fail on Rev 52, fixed Rev 54** | Conflict alert for the user's own record; froze the tab behind `alert()` |
| Stale pending copy after reload | **Fail on Rev 54, fixed Rev 55** | Copy from 02:35 still present on a Connected page; "Leave site?" fired. Rev 55: cleared quietly |
| Unassigned task | Pass | First owner option blank; no notification queued |
| Escaping | Pass | Title with quotes, tags and an ampersand renders as literal text; zero injected elements |
| Link scheme on save | **Fail on the SOP path, fixed Rev 55** | `javascript:` stored verbatim by the SOP branch; render-side filter still refused it |
| Retire a task | Pass | Retired badge on the calendar pill and the table row; excluded from counts |
| Admin: add person (directory only) | Pass | Slug id `qa-fable-testperson`; duplicate check active |
| Admin: create sign-in for an existing person | **Fail on Rev 54, fixed Rev 55** | "That person has no sign-in account." from the reset path; on Rev 55 the account is created as viewer with the change flag set and a six-digit random middle |
| Admin: change access level | Pass | Dialog shows the account's level; gateway role changed to editor; directory follows |
| Admin: deactivate | Pass | Account disabled through the gateway, then the directory flag |
| Admin: reactivate | **Fail on Rev 55, fixed Rev 56** | Account enabled; directory flag lost to a stale reference (S-8) |
| Admin: delete | Pass | Account removed first, then the row; account count back to six |

Not exercised, and why: a viewer account signing in (no viewer exists and I do not type credentials); the import preview on the real workbooks (file upload through the browser tool was not attempted with the time left); sign-out (would have ended the session I was using).

---

## 7. Decisions taken that you should know about

1. **Key Dates import refuses when no year can be established** (B-05). Guessing the year is the exact defect. The upload card states the rule. Flip to a fallback if you prefer.
2. **The consolidator starts from the tip of `main` and restarts on a rejected push** (OPS-039). There is no merge now, and never a force-push.
3. **An administrator's password reset ends the holder's live sessions** (OMS-063, D-04).
4. **Standing** is the one user-facing word for the recurring flag (R-13). The stored field stays `recurring`.
5. **Deactivate blocks the sign-in account first** and refuses if the gateway refuses (self, last admin).
6. **The release gate no longer has a cosmetic exemption.** Every change to `oms.html` needs the badge, the log and the guide.

---

## 8. Open items

| ID | What | Recommendation | Effort |
|---|---|---|---|
| D-02 | Five accounts on initial passwords | Each person signs in and sets one; then delete `OMS_USERS_JSON` from Vercel | Ops |
| D-10 | Fail-open on an unreadable auth file is unbounded | Refuse writes when the last successful read is older than about 15 minutes; keep reads | M |
| D-12 | Revision bumps on refused batches; `manifest.status` unread | Return `manifest.status` from `/api/state`; confirm on `operationId` | M |
| — | Cron drain observed not to fire on time | Consider a second `workflow_dispatch` trigger from the gateway after each accepted operation, or accept the OPS-039 behavior (the next save drains) | S |
| — | Viewer role never exercised by a real account | Create one test viewer and run the read-only cases from a second browser profile | Ops + QA |
| — | Import lane on the real workbooks | Preview-only run of the Events and Key Dates workbooks on Rev 53 or later | QA |
| — | Register rows | New workbook rows start at OMS-060 per CLAUDE.md; the finding IDs in this report (S-, E-, D-, A-, B-, C-) are review-local and should be mapped when the rows are minted | Ops |

---

## 9. Test records and cleanup

Created and removed during the lane, all through the application's own paths:

- Tasks `QA-FABLE-2026-09-06 Task A` (id `mtqmo0172oa`) and `… Task B` (id `mtqnj12p2tqn3vbi`), with the notification and assignment-history row Task A's owner assignment generated.
- SOP `QA-FABLE-2026-09-06 SOP (link test)` (id `mtqnsgsspywa43b0`).
- Person `QA Fable Testperson` (`qa-fable-testperson`, `qa.fable.testperson@example.invalid`) and its sign-in account.

Verified in canonical at revision 93: no task, SOP, person, notification or history row matching the QA names remains; collection counts are back to the pre-review baseline (events 255, tasks 18, SOPs 32, people 8, notifications 4, assignment history 4); the account list is back to six. The processed-operations log and snapshots in `CAO-OMS-Data` retain the operations, as they retain everything; none carries a credential.

---

## 10. Contradictions to the handoff

- §4c "the two real gaps are R-02 and R-03": a third Retired gap existed (C-07).
- §4a R-05 "cadence carry-forward reaches 0 of 248 rows": the key is symmetric; the mechanism is title divergence and whitespace, now normalized, with a second-chance match (Rev 53). Re-scope rather than close as stated.
- Rev 44's log entry says the field-level merge "is true now"; it was true only inside the seconds between the client's version check and the fold (S-2).
- Rev 45's log says the unescaped interpolations were "escaped now"; the function they relied on did not escape quotes (E-03).
- Rev 30's comment says removing somebody from the directory removes their sign-in; the function that would have done it had no caller (A-03), and the dialog that issues a sign-in to an existing person had never worked (Rev 55).
- §0b said the QA lane needed "two people signed in at once" for the concurrent cases. One signed-in session plus a direct gateway operation reproduces them exactly, because the consolidator does not know who posted.

---

## 11. Files in this folder

- `repro-sync-path.mjs`: five reproductions against `oms.html`; all pass at Rev 54 and later, each failed at the revision it names.
- `GATE6-PILOT-SCRIPT.md`: the five-user pilot protocol, parts A to D, with exit criteria.
- `REPORT.md`: this document.

---

## 12. Day two, 7 September 2026: Hossam's decisions and the remaining lanes

Hossam's instructions on the morning of 7 Sept, and what happened with each.

| Instruction | Outcome |
|---|---|
| Delete `OMS_USERS_JSON` from Vercel if there is no risk | Verified first that the gateway had written six account operations to `auth/users.json` on `main` in the previous hour, so the file is authoritative and the seed is unreached. Deleted from Production and Preview; redeployed; `/api/me` answers 200 on the new deployment. A missing auth file now fails loudly instead of reverting the roster to the seed (DEC-030). |
| Key Dates: ask for a date range when the year cannot be established | Rev 57: two calendar pickers appear in place of the refusal; dates are read into the period; out-of-period rows are dropped and counted; periods over two years refused. Live on a year-less copy of the real sample: picker shown, 89 rows for Jan 2026 to Mar 2027, 30 rows and 59 counted outside for Jan to Jun 2026. Rev 58 fixed the year scan the live test exposed: it had read six rows and taken `/2027` out of a date lead as the sheet's year, so the picker never appeared on the first try. |
| Admin password resets end live sessions | Confirmed as DEC-029; already shipped in OMS-063. |
| Why were four items left alone | Answered in §13 below; three of the four are now fixed in Rev 57. |
| Correct `REV17.md` | Both sentences corrected in Rev 57 with the date and the decisions that replaced the promise. |
| Update and validate the canonical backlog | `CAO_OMS_Canonical_Backlog_CURRENT_20260907.xlsx` written from the 20260906 file: FAB-11 to FAB-38 added, seven earlier closed FAB rows given the Verified Against they lacked, thirteen QA Checklist rows re-marked with a Verified Against column and ten new cases added, DEC-027 to DEC-030 logged, a Session Log sheet for the day, Source Register and Release Crosswalk rows, README note. Validation pass: no duplicate ids, every status in the dropdown list, every closed FAB row carries Verified Against, and the source workbook held no data validations or formulas, so none were lost. |
| Delete the superseded drafts | All three discarded once Hossam brought the Outlook tab to the front: the Rev 8 handoff, the Rev 9 handoff and the Rev 8 backlog drafts (Drafts 45 to 42). The Dean briefing draft, which had no recipient, now addresses Rachel Woodside and is saved, not sent. The scorecard note and the six working-session drafts were left as they were. |
| Test the viewer role | Run live on 7 Sept once Hossam signed in as the throwaway viewer: `/api/me` viewer; state 200; user list, role change and operation all 403 (`read_only`); Admin and Import screens say Access denied; no editor control visible on Tasks, Dashboard or SOPs after filter re-renders; a dialog save was refused with the Read only banner and toast and nothing reached the gateway. One low finding, FAB-39: the refusal still arms the local pending copy, so the viewer is asked "Leave site?" for work that can never be saved. Background: no viewer account existed before this. `auth/users.json` holds one admin and five editors; Jane Westgate and Clare Il'Giovine are directory people without sign-ins (OMS-056 deliberately left them so). A throwaway viewer account can be created from the console for the test; the sign-in itself has to be typed by Hossam. |
| Finish the gates | Gate 5 Test 3 (outage), Test 4 (recovery) and Test 5 (integrity) run live and passed; Tests 1 and 2 were covered by the concurrent-edit cases. Gate 6 is the five-person pilot and cannot be run by one reviewer; its script is `GATE6-PILOT-SCRIPT.md` in this folder and the recording sheet is the `Gate 6 Pilot` tab of the backlog workbook. |
| Import the real workbooks after the new importer | Events: preview on Rev 58 showed 181 rows, all 181 matching an existing Ari event so every id is kept, 180 selected after one in-workbook duplicate, one unreadable date reported; replacement confirmed: 123 update operations posted and all consolidated within about a minute under the OPS-039 workflow, Connected at canonical revision 97, 180 Ari events with every id kept, the three Standing events and the seven third-source events untouched. Key Dates: preview showed 89 rows, 88 selected, 69 matching existing Maggie events and 20 new (titles the earlier parser had never produced); replacement confirmed, result in §12.2. |

### 12.1 Security probes run against the deployed gateway (safe, single requests)

| Probe | Result |
|---|---|
| `/api/state` with no token, and with a garbage token | 401 both |
| Nested credential-shaped key two levels down | 400 `credential_field_refused`, path named |
| `__proto__` as a field name | 400 `unsafe_key_refused` |
| A single value over the string cap | 400 `payload_too_large` |
| Unknown collection | 400 `Invalid entityType` |
| Cross-origin fetch from github.com to state and login | Blocked by CORS |
| Login with an unknown id vs a known id and wrong password | Same body (`invalid_credentials`); timing indistinguishable after the first cold request |
| Role action for an unknown account, as admin | 404 `Account not found` |

Not run, deliberately: anything resembling brute force against sign-in (no rate limiting exists; hammering the Dean's Office gateway to prove that is not a test worth running), and anything that would need a second real person's credentials.


### 12.2 Import results on the deployed Rev 58

| Source | Before | Preview | After | Canonical |
|---|---|---|---|---|
| Ari (Events workbook) | 180 | 181 rows, all matching, 180 selected, 1 unreadable date | 180, every id kept, 123 field updates | revision 97 |
| Maggie (Key Dates workbook) | 68 | 89 rows, 88 selected, 69 matching, 20 new | 88: 68 ids kept, 20 created, 4 field updates | revision 98 |

Total events 255 to 275; the three Standing events and the seven third-source events untouched; no task carried a source-event link at the time, so nothing could be orphaned. The consolidator absorbed the 123-commit burst without a failed run.

### 12.3 Architecture improvements implemented on 7 September (authorized: "implement architecture improvements if you can ensure system stability and reliability")

Three coordinated changes, landed in dependency order and each verified live before the next. Every step is backward compatible: an older client keeps working against the new gateway, a single-operation inbox file is still consolidated exactly as before, and a client on the new artifact falls back to the old behavior against a gateway that lacks the new endpoints.

| Change | Where | What it fixes | Verified |
|---|---|---|---|
| Batch inbox files (OPS-040) | `CAO-OMS-Data` PR #17, main `8a8281d` | One file may carry several operations under a small envelope (`schemaVersion`, `batchId`, `actor`, `createdAt`, `operations`). Every member is validated before any is applied; a malformed member refuses the whole file. Single files unchanged. New `scripts/test_consolidate.py` (34 checks) runs in the canonical gate. | Gate green; live batch of 2 creates and batch of 2 deletes both applied, per-member and batch stamps present. |
| Snapshot retention applied automatically (FAB-10) | same PR | `prune_snapshots.py --apply` runs in the consolidator commit that adds a snapshot pair. | First run pruned 203 files to 177. |
| Runner Python | same PR | The consolidator no longer installs Python; the runner's own `python3` is used. | Run completed; ~10 s save-to-confirm. |
| Batch endpoint (OMS-064) | `CAO-OMS-Gateway` PR #21, main `e156ecc` | `POST /api/operation` accepts `{operations:[...]}`: one PUT, one commit, one run per save instead of one per record. Cap 100 members, 10x the single-record byte cap; 403/401 semantics unchanged. | `test-batch-and-revision.mjs` 27/0; live commit `OMS batch: 2 operation(s) on tasks`. |
| Revision endpoint (D-12) | same PR | `GET /api/revision` serves `stateRevision`, `status`, `updatedAt`, `lastOperationId` from the manifest. `manifest.status` had never reached a client. | Live: `{revision:101,status:"ready"}`. |
| Bounded fail-open (D-10) | same PR | The stale account list is trusted for 15 minutes after `auth/users.json` becomes unreadable; beyond that reads still fail open but writes and account changes are refused with 503 `auth_unavailable`. `/api/me` serializes only the public account shape. | `test-auth-fallback-bound.mjs` 12/0 with a controlled clock; revocation suite still 55/0. |
| Client Rev 60 (v1.43.0) | `CAO-OMS` `cb61e5b`, sha `477ae25d…` | `OMS_POST_BATCH` sends the whole save when there is more than one operation and remembers a 400 on the envelope as "old gateway"; `OMS_PEEK_REVISION` runs before every state fetch in the wait, the reconciler and the idle watch; `OMS_CONN_HINT` puts a non-ready canonical status into the Connected banner; `.mft` is sticky (OMS-060). | Smoke 919/0 (19 new cases), text claims 106/0, negative gates green, `verify_live` MATCHES; live save Connected at revision 102, deletes at 103, no conflict records. |

What was measured on the live save: a two-record create was one gateway request, one inbox commit and one consolidator run, confirmed in about ten seconds; the client read the state twice (pre-flight version check and confirmation) where Rev 59 would have read it on every poll.

Not done, and why: dispatching the consolidator from the gateway was dropped because the push trigger on the inbox branch already starts a run within seconds; there is nothing to dispatch. Rate limiting and CSP (FAB-08, FAB-09) remain open as before.

### 12.4 Review of the two Opus 5 changes: client Rev 61 and gateway OMS-065 (7 Sept, Fable 5.1)

Requested in the handoff as a review, not a rewrite. Diffs read: `v1.43.0..v1.44.0` in the client and `e156ecc..1b96c9d` (PR #22) in the gateway. Both were re-run locally first: the smoke suite and the release gate passed on the committed Rev 61 artifact, whose SHA-256 matched the handoff and the served file, and the gateway suite passed on the second attempt after one intermittent failure that turned out to be a real finding.

**Gateway OMS-065.** The design is sound: the cost travels with the record, a record without a `kdf` verifies at the legacy parameters, the upgrade happens at the one moment the plaintext exists, the rewrite re-checks the password against fresh file content so a concurrent password change cannot be reverted, and `passwordSetAt` is left alone so the upgrade cannot revoke the session it is about to issue. The timing wrinkle the comment admits (a legacy record refuses a wrong password faster than a migrated one, until everyone has signed in once) is real, bounded, and self-closing. Two defects, neither in the runtime path:

- `scripts/make-users.mjs` derived at the new cost but wrote no `kdf`, so every account it minted was verified at the legacy cost and failed the script's own check. Reproduced: the script exited with every roster entry failing. Loud, which is what the check is for, but the script was unusable from the moment PR #22 merged. Fixed in gateway OMS-066: the record carries `kdf`, the parameters are asserted equal to `currentKdf()` after the import, and a new entry without one fails.
- `scripts/test-session-revocation.mjs` demoted an account by delete-and-recreate. A recreated account has a fresh `passwordSetAt`, and since OMS-063 a token minted before it is refused, so the test passed only when both writes landed in the same wall-clock second as the token's `iat`. OMS-065 made a create slower and `npm test` started failing intermittently, which is how it was noticed. Fixed in OMS-066 by demoting with the role action, which leaves `passwordSetAt` alone by design. The suite passed three consecutive runs afterwards.

Live `auth/users.json` at data `07644a7`: all six records still carry no `kdf`, which is expected, since nobody has signed in since the merge. Nothing to do; the first sign-in of each account upgrades it.

**Client Rev 61.** The design of all five features is right, and the `tasksAtRisk` / `tasksDueSoon` split with its pinning assertions is exactly the correct shape. Four findings, fixed in Rev 62 (v1.45.0, `c3bfaf7fad10e3ddd47293d65ff005314cd3021953f5de1b94e2f4fd0c6e82ac`):

- **Mine and the counter it opens disagreed.** `omsMineOnly` resolved owners through the directory; `omsShowTasks` under Mine set the Tasks owner filter to the signed-in display name, and `omsTaskRows` compares owner strings. Live canonical at revision 103 holds `Hossam Elsaie` and `Hossam`, `Maggie Scirica` and `Maggie`, as owner strings, so the counter said one number and the list showed a smaller one. The Owner filter now offers one directory-resolved value, `Mine (owned by you)`, the counters send it there, and a smoke assertion holds the two equal on both spellings.
- **The Mine tooltip said the cards below narrow too.** Nothing below the counters is scoped; the intake cards are not tasks. Tooltip and guide corrected; a `forbids_code` binding keeps the old sentence out.
- **Copy said "Nothing is sent".** The copy is pushed into state and queued for sync before its dialog opens, so Cancel leaves a saved `(copy)` record. Behavior is defensible; the text was not. The control, the toast and the guide now say it is saved at once and that Cancel does not remove it, and a binding ties the sentence to the order of the two lines in `omsDuplicate`.
- **The five-counter row ignored the breakpoints.** An inline `grid-template-columns` beat the 900 and 600 px media rules that collapse every other grid, so a phone got five columns. It is now a `.g5` class in the same media rules.

Also noted, not changed: `omsDuplicate` carries branches for SOPs and events that no control reaches (the guide sentence is now scoped to the Tasks screen); the `taskSel` comment claimed the selection is dropped on a refresh, which it is not and should not be, so the comment was corrected rather than the code; one task in live canonical carries the owner string `N2s`, which resolves to nobody and is data hygiene for the office rather than a defect.

**Not verified in this pass:** the Rev 62 change was not exercised in a signed-in browser session; the assertions run against the artifact and the pinned owner-string shapes, and the served SHA was confirmed by `verify_live.sh`. The 375 and 768 px checks in section 14 remain unrun.

### 12.5 Rev 62 driven live, the 375/768 px checks, and Revs 63 and 64 (7 Sept, evening, Fable 5.1)

**Rev 62 in a signed-in session** (Chrome, admin account, canonical revision 103 to 105). With Mine on, the In Progress counter read 2 and the list it opened held 2, with the Owner select showing `Mine (owned by you)`; At risk read 1 and opened 1; the unfiltered Mine list held 6, including the task whose owner string is the short form `Hossam`, which is the case Rev 61 got wrong. The corrected tooltip text was read back from the DOM. Copy was exercised for real: a copy of one task was created, its toast read as the new text, the record reached canonical (revision 103 to 104, `_version` 1), and it was then deleted through the ordinary path (revision 104 to 105, eighteen tasks again). Observed in passing: `delItem` calls the legacy `save()`, which marks every collection dirty; the diff still emits only the one change, so nothing is wrong, but the dirty set is a coarse signal on that path.

**Rev 63: export any grid.** Built to the recommendations in the handoff's section 14. One file per screen; one sheet of the rows the screen shows, read from the same function the screen reads (`omsTaskRows`, and two new ones, `omsCalItems` and `omsSopRows`, extracted from `rCal` and `rSOPs` so screen and file cannot drift); a second sheet, About this export, naming the screen, the filter and sort, who exported it, when, and the canonical revision. Buttons on Tasks, Calendars, SOPs, Cadence and the Admin directory. Verified live on Rev 63 with `XLSX.write` capturing the workbook rather than downloading it: Tasks 18 rows, Calendar 278, SOPs 32, Cadence 7, Directory 8, every About sheet carrying revision 105 and the signed-in name. This answers OMS-026. **Also in Rev 63, on Hossam's instruction:** the Key Dates period picker no longer refuses a period longer than two years; a `forbids_code` binding keeps the refusal out. The Rev 57 revision-log entry still describes the limit, because `OMS_REV_LOG` is append-only; the Rev 63 entry records its removal.

**The 375 and 768 px checks** could not be run in the signed-in Chrome tab, whose window ignores resizing, and the in-app browser has no session and must not be given one by hand. They were run instead in a local harness (`scratchpad/layout-harness/server.mjs`, not committed) that serves the shipped `oms.html` with one constant changed, the gateway URL, and answers the four gateway reads with a fake admin session and the real canonical state; writes are refused. At **768 px** everything passed. At **375 px** two things failed: the header did not wrap and ran about 245 px past the viewport, so the page scrolled sideways and People, Notifications and Sign Out were off the edge; and every form field was 12 to 13 px, which makes mobile Safari zoom on focus. **Rev 64** adds a single rule below 600 px: the header wraps and fields are 16 px. Re-checked in the harness: header 375 of 375, no document overflow, every header button visible, one input size, dialog inside the viewport. Nothing changes at desktop widths.

**Not verified:** Rev 63 and Rev 64 were verified against the served artifact and, for the export, by capturing the workbook in the live session; no file was actually downloaded through the browser. The keyboard-only and screen-reader checks in section 14 remain unrun.

### 12.6 Rev 65: one search box, and task templates (7 Sept, evening, Fable 5.1)

Built to the recommendations in the handoff's section 14, on Hossam's instruction.

**One search box.** A header box searches tasks, events, SOPs and people at once. It supplements the per-screen boxes, which filter a table in place, and does not replace them. Ranking is stated in the guide and enforced by one function: a title starting with the query, then a word starting with it, then a title containing it, then a match in a secondary field (owner, notes, location, category, email). Groups come back in a fixed order, at most five per group; retired events and inactive people are excluded. Enter opens the highlighted result (the first by default), the arrow keys move it, Escape clears, a click outside closes the panel. Opening a result goes through `omsLeaveForm`, so an unsaved dialog is not silently discarded; the A-20 assertion counting those exits went from three to four. Verified in the layout harness against real data: "cab" returned Tasks, Events and SOPs in that order, with `Cabinet scorecards` above `Prep cabinet deck`, ArrowDown moved the highlight, Enter landed on the Tasks screen with the Edit Task dialog open, the box cleared and the panel hidden.

**Task templates (OMS-009, OMS-010).** Shape: `{id:'tpl-<slug>', name, category, lines:[{title, offsetDays, owner, priority}]}` in `taskTemplates`, which the consolidator's allow-list and the operation schema had carried since the data side was built; it now joins `OMS_COLLECTIONS` so the client emits operations for it. A template binds to an event category and is edited under Task templates inside the Categories dialog, with its own Save template button, separately from category renames. It is applied at one moment only: a new event added by hand, whose Add Event dialog offers a ticked box naming the count and the lines, redrawn when the category changes. The `saveModal` event branch calls `omsApplyTemplates` only in the new-event branch, editing never applies one, and a smoke assertion walks every function whose name contains "import" to prove none references the template functions, so a re-import cannot multiply tasks. Created tasks are ordinary linked tasks: owner resolved through the directory, due date from the event plus the offset, Not Started, the event's category, no dependency, no notification draft. Verified in the harness: a template with two lines saved from the dialog, an event in that category created two linked tasks dated seven days before and two days after, the offer was absent on Edit Event and on a category with no template. Live canonical holds no templates yet; the office writes the first one.

**Not verified:** no template has been written to canonical, so the collection's first real sync has not been observed. Everything above ran against the harness and the smoke suite; the served artifact was confirmed by `verify_live.sh`.

### 12.7 Closing out: Rev 66 (FAB-08 CSP), data OPS-041 (DEC-019 retry), keyboard probes (7 Sept, late evening, Fable 5.1)

**FAB-08, Rev 66.** Both pages carry a `Content-Security-Policy` meta tag, since GitHub Pages cannot set headers. `default-src 'none'`; `script-src 'self' 'unsafe-inline' https://cdn.sheetjs.com`; `style-src 'self' 'unsafe-inline'`; `img-src 'self' data:` for the one search icon; `connect-src 'self' https://cao-oms-gateway.vercel.app`; `form-action 'self'`; `base-uri 'self'`; `object-src 'none'`. `frame-ancestors` is not there because a meta policy cannot carry it. The honest limit is stated in the guide and pinned by a binding: the application is inline script, so `'unsafe-inline'` must stay and the policy does not stop an injected script from running; it stops it sending anything anywhere but the gateway. Verified in the layout harness with the gateway host rewritten in both the constant and the policy: no console violations, state loaded, SheetJS present, the data-URI icon drew, the export serialized, search worked. Then verified live: the served artifact matches, the sign-in page carries its policy, and the signed-in session reads Connected under the policy.

**DEC-019, data OPS-041.** A second workflow, `consolidate-retry.yml`, listens with `workflow_run` for the consolidator concluding in failure and dispatches it once, after a 45-second pause. Bounded: a run started by `workflow_dispatch` is never retried, so a repeating failure gets one retry and then waits for the cron or a person. The cron is unchanged and remains the backstop. Pull request opened and merged through the GitHub tab; the merge state is recorded in the handoff.

**Keyboard-only probes** (harness, real data): Escape closes an open dialog; the filter chips are focusable buttons and Enter on one sets the filter; the Dashboard counters are real buttons. This is a probe of the mechanisms Rev 54 built, not the full walk-through in section 14, which still calls for a person with the mouse unplugged. The screen reader check remains deliberately deferred.

**Also prepared:** a plain-text draft reply to Rachel Woodside on OMS-026, on the Desktop as `OMS-026_reply_to_Rachel_DRAFT.txt`, written from what Rev 63 shipped; Hossam checks it against her actual question before anything is sent.

**Left open, on purpose:** FAB-22 and Gate 6 (people), OMS-030 (Maggie's workbook), the two Outlook drafts (need the Outlook tab in front and an attachment), the twelve Ready-for-QA rows (need their named tests run), the Vercel Hobby plan question (procurement), the `N2s` owner string on one task (office data), and the full keyboard and screen-reader passes.

### 12.8 Post-mortem: the search box that took one letter (FAB-43, Rev 67)

Reported by Hossam on 7 Sept 2026: "The search box is broken again, we fixed this before. It loses focus after one keystroke." He is right on both counts, and the second half is the important one.

**What was wrong.** Typing into the Tasks search box put the first character in and then dropped focus to the page body, so the rest of the word went nowhere. Reproduced live before anything was changed: clicked the box, typed `cabinet`, and the field held `c` with `document.activeElement` on `BODY`. The SOPs box did the same with `agenda`, leaving `a`.

**Mechanism.** The handler is `oninput="taskQ=this.value;...;rTasks()"`. `rTasks()` replaces `#tasks` with `innerHTML=`, and the search box is emitted from inside that same template. So the element receiving the keystroke was destroyed by its own keystroke. The browser has nothing to keep focus on and drops it to `<body>`. The character already typed reappears because the template re-emits `value="${esc(taskQ)}"`, which is exactly why this reads as "it only takes one letter" rather than "it does nothing".

**Why it came back: three failures, not one.**

1. *Wrong scope.* Rev 12 shipped "preserve search focus" and it was correct - for the Calendars box, via `calSearchInput`. `git log -S` puts it in commit `54f46f4`. The Tasks box (`git log -S "taskQ=this.value"` → Rev 22) and the SOPs box, which predates it, had the identical defect and were never touched. The fix sat in the same file as two live instances of the bug it fixed, for fifty-odd revisions.
2. *Nothing bound it.* `grep -ril "activeElement|setSelectionRange|requestAnimationFrame" test/ scripts/` returned exactly one hit, and that hit is the smoke sandbox stubbing `requestAnimationFrame` to a no-op. No assertion, no text claim, no gate check mentioned focus, `cal-search` or `calSearchInput`. So when Rev 65 added a fourth search box, and when Revs 61 and 63 edited the Tasks handler, nothing in the project could report that three of four boxes had no focus preservation at all. Check 12 could not help: it binds *text* to *code*, and no guide sentence had ever promised that typing works.
3. *Fragile mechanism.* Rev 12 restored focus inside a `requestAnimationFrame` callback, which defers the repair to a later task. That loses any keystroke arriving inside the gap, and it does not run at all while the tab is hidden or throttled. It is also stubbed to a no-op in both smoke sandboxes, so even a well-written assertion could not have exercised it.

**A trap worth recording, because it nearly produced a false finding.** The first live sweep showed the *Calendars* box failing too, which would have meant the Rev 12 fix was broken outright. It was not: the probe was. `document.visibilityState` in that tab was `hidden`, and a hidden tab fires no frame callbacks, so the rAF repair could never run there. Measured directly: a `requestAnimationFrame` registered in that tab had not fired after 600 ms while a `setTimeout` had. This is the third time in two days that the environment, not the system, produced the finding - see the `--file`-ignoring probe and the `grep -c \r` case in CLAUDE.md. The conclusion actually supported by the evidence is narrower and is what the release note says: Tasks and SOPs were broken unconditionally, in every environment; Calendars was broken whenever a frame callback did not run before the next keystroke, which includes any hidden or throttled tab.

**The fix.** One shared helper, `omsRerenderKeepingCaret(inputId, render)`, which reads the focused element and its selection range, runs the render, then restores focus and the caret **synchronously**. Synchronous is the whole point: JavaScript is single threaded, so the next keystroke cannot be delivered until the handler returns, and focus is already back. There is no gap to lose a character in and no dependence on frames, visibility or throttling. It also carries the caret across, where the Rev 12 code reset it to end-of-string, so a word can now be corrected in the middle.

**Scope of the family: eight controls, not three.** The sweep found the same cause in five more places, in the milder form where only focus is lost rather than characters: the Tasks Owner and Category filters, the SOPs Category filter, the Weekly Brief week picker, and the bulk-status picker that Rev 61 itself added. Each dropped a keyboard user back to the top of the document after every choice. All eight now route through the helper.

**Verified live, after release, in a hidden tab** - deliberately the environment where the old mechanism was dead. On the served Rev 67 artifact: `cabinet` into Tasks gives `cabinet`, focus retained, caret at 7, list filtered to 3 rows; `agenda` into SOPs gives `agenda`; `cabinet` into Calendars gives `cabinet`. Then Home followed by `ZZ` gives `ZZcabinet` with the caret at 2, which the Rev 12 mechanism could not have produced.

**Why it cannot recur: gate check 15.** `scripts/no_focus_losing_inputs.py` enumerates every `input`, `textarea` and `select` carrying `oninput`, `onkeyup`, `onkeypress`, `onkeydown` or `onchange`; works out which renderer *emits* that control by brace-matching function bodies and testing whether the control's markup lies inside one; and, if the handler re-triggers that same renderer, requires the render to go through the helper with that control's own id. It rejects a frame-deferred restore outright. The release gate fails on any finding, and `test/no_focus_losing_inputs_negative.py` runs first with sixteen fixtures.

**The negative control earned its place inside the hour.** The first draft of the checker required a renderer to be *called* with parentheses. The fix hands the renderer over as a reference - `omsRerenderKeepingCaret('task-search', rTasks)` - so the draft skipped every control the fix had just repaired and pronounced the artifact clean without examining any of them. It passed for the wrong reason, which is the exact failure shape this project has hit twice before. Fixture 10 is that case. A second self-inflicted false positive followed: the checker read a *code comment* containing the word `requestAnimationFrame` as a frame-deferred refocus, so the analysis now runs on comment-stripped source, and the comment in `calSearchInput` no longer names the token.

**What the guard does NOT cover, stated plainly.** `onclick` is out of scope: including it would flag every button that legitimately redraws and moves focus on purpose, so a checkbox or button that redraws its own container can still lose focus. Renderer detection matches `innerHTML=`, `outerHTML=`, `replaceChildren`, `insertAdjacentHTML` and `removeChild`; a renderer that destroys children by some other route would not be recognised. Indirection is followed one level, so a handler calling a wrapper that calls another wrapper that renders would be missed. And the check is static: it proves the helper is wired to the right id, not that the browser honoured it - which is why the smoke suite also *executes* the helper against the element mock and asserts focus and the caret come back, and why the live keystroke test above was run against the served artifact.

**Residual, not fixed, and deliberate:** each keystroke still re-renders the whole tab, which is wasted work on the calendar's 278 items. It is a performance question, not a correctness one, and debouncing it is a separate change with its own risk.

### 12.9 Rev 68: the calendar filters and the category dialog (Hossam's changes, 7 Sept 2026)

Three instructions, and one of them turned over a rock.

**The Out of office chip is gone, and so is the filter behind it.** Rev 35 hid the `EB OOO` category by default, on the argument that a multi-week absence is fifteen one-per-day rows crowding out the meetings people open the calendar to find. Hossam removed it: the Dean being away is what the calendar is for, and a category hidden by default is one people forget exists. Out-of-office entries are now ordinary events, searchable, filterable by category, and exported with everything else. Verified live: fifteen exist, all in 2026, and all fifteen now appear. **The Dashboard's Events Next 30 Days counter still excludes them**, which is a different question and was deliberately left alone; fifteen days of absence are not fifteen meetings. The text-claims binding is tied to the calendar's own filter expression rather than the two words, precisely so it does not fire on the Dashboard's.

**"Standing only" is now "Recurring", keeping its circular arrow.** The instruction named one chip, but renaming only the chip would have rebuilt the exact split Rev 53 closed: R-13 unified three words, Cadence, Recurring and Standing, onto one. So the whole user-facing vocabulary moved together, across the chip, the One-off tooltip, the event form checkbox and label, the calendar legend, the grid and list markers, the import preview column and its badge and count chip, the export column header, and every affected sentence in the User Guide. There is still exactly one word for this bit. It is also now the same word as the stored field, which has been `recurring` since Rev 17, so the label and the data finally agree. The internal filter token is deliberately unchanged, so calendar views saved before this still apply.

**The Categories dialog can add and delete.** Add takes effect at once and refuses a duplicate whatever its case. Delete is narrower than it looks, and honestly so: `eventCategories()` rebuilds the list from the categories records actually carry, so removing a name still in use would achieve nothing and it would reappear on the next render. Delete is therefore offered only for a category nothing uses; one in use is refused with its counts and pointed at rename-to-merge, which is the operation that really moves records. Built-ins can never be deleted. Renames still apply on Save, and the dialog now says which of the three operations are immediate and which wait for Save. A rename typed but not yet saved survives an add or a delete. Verified live on Rev 68: add, case-insensitive duplicate refusal, built-in refusal, and delete of an unused category all behave, and the local store came back unchanged.

**A limitation worth a decision.** There is no categories collection in canonical. Custom categories live in browser `localStorage`, so a category you add is yours alone until a record uses it, at which point it becomes everyone's. That is exactly how the Event form's "+ Add a new category" has always behaved, so Rev 68 is consistent rather than novel, and the dialog now says so in plain words. Making categories properly shared means a new synced collection, which is a data-repository and gateway change across three repositories. Not done, flagged.

**What this turned over: gate check 15 was reporting on the wrong functions.** Widening the check to cover choice controls made it flag `esc()` as a renderer, which is absurd on its face and so was worth chasing. `esc()` contains `.replace(/'/g,'&#39;')`, and the apostrophe inside that regex opened a phantom string in the checker's tokenizer, swallowing everything to the next apostrophe. Brace matching then desynchronised, and `esc()` measured 63,173 characters instead of about 150, with three unrelated functions all appearing to end at the same offset. A second, independent fault sat underneath it: the artifact's renderers are built from **nested** template literals, and the inner backtick was read as the end of the outer one. Both corrupt the containment test that the whole check rests on, and **both were present in Rev 67** while the check reported a clean artifact. It was not lying so much as not looking where it said it was looking. The tokenizer is now a proper state machine with a frame stack for template literals, interpolation-aware brace counting, and a regex-versus-division heuristic. Verified: no quote characters survive blanking, and every function's span now ends on its own closing brace. Two negative-control fixtures pin both traps, because neither was visible from the outside.

**Rev 67's conclusion survives the correction**, which was worth checking rather than assuming: re-run against the fixed tokenizer, the artifact still reports zero findings, and the eight controls it identifies as redrawn-by-their-own-handler are the eight that route through the helper.

### 12.10 Rev 69, the tester script, the register, and three emails (7 Sept 2026, night)

**Rev 69 finished Rev 68's rename.** Rev 68 claimed one word for one bit and left three strings a person can actually read still saying the old one: the Cadence line written onto an export's About sheet, the two toggle buttons in the import preview, and the User Guide sentence about an annual gala. Found by the audit below, which read the artifact rather than the release note. Two assertions now name those surfaces, scoped outside `OMS_REV_LOG` - the log is append-only history that legitimately quotes the strings a release removes, so an unscoped check fails on its own changelog the moment it ships, which is exactly what happened on the first attempt.

**The tester QA script was validated step by step against the shipped artifact and rewritten.** Twelve of twenty-one steps were sound. The rest were not, and one would have wasted the whole pilot:

- **Step 2 told testers "You do not have to sign in twice."** They do, deliberately: `index.html` clears the session after a password change and returns them to the form, precisely so the new password is proved before anyone depends on it. All five would have reported correct behaviour as a fault, and the grey EXAMPLE row had already primed them to distrust that exact moment.
- **Step 6** put the colour legend "down the side"; `calLegend` renders a horizontal strip above the months.
- **Step 8** asked for a multi-day event. Canonical revision 108 holds none: seven events carry an `endDate` key and all seven hold the empty string. The step was untestable and is gone.
- **Step 12** promised the confirmation "well under a minute" in the top right; the toast is bottom right and the round trip is twenty to thirty seconds.
- **Step 14** said Outlook "opens"; it is a button that opens a new browser tab, which a pop-up blocker can stop.
- **Step 18** claimed a two-minute idle refresh; `OMS_WATCH_MS` is sixty seconds, and the refresh is deliberately refused while the tab is hidden or a dialog is open, so two of the three ways a tester would run it produce a false failure.
- **Step 17** said "most testers" will see the Import tab. All five will: they are editors, and the tab is shown to any editor.

The script now runs to twenty-four steps in seven parts, adds the things it predated (the header search, Export, the Recurring chip, out-of-office entries now being visible) and adds one step of its own for the Rev 67 focus fix, because that defect reached the field and nothing else in the script would catch a regression. Sheet 1's contradictory time estimates are reconciled at half an hour, the sign-in section now says the User ID is the formal address (Margaret, not Maggie), and sheet 4 gained six administrator steps including the one that matters most: **the canonical revision is not in the header**, which shows the client build. Take it from the manifest or from an export's About sheet.

**The register was audited row by row and updated.** It now holds 161 rows with no duplicate ids, and the Canonical Dashboard is derived from the sheet rather than typed - it had read 124 issues and 77 closed against a sheet holding 156 and 128. Closed on evidence: FAB-08 (CSP, Rev 66), FAB-09 (scrypt at the OWASP figure plus the verified Vercel rate-limit rule), OMS-020 (tested properly at last: 16 categories, 16 distinct legend codes, no duplicates, no blanks), and REV-F06, whose rebase-abort cannot occur now that OPS-039 removed the rebase and OPS-041 added the event-driven retry. Corrected: OMS-009 read Deferred against code that shipped in Rev 65; OMS-025's evidence still inventoried the Out of office chip that Rev 68 deleted; OMS-026 records that Rev 63 answered it in XLSX, not the CSV its Next Action assumed; OMS-030's assessment no longer says "decision still open" while its own Next Action says the opposite. Ten rows that contradicted themselves - Closed beside "Outstanding", Closed beside "Confirmed open", Closed beside a QA status meaning "not yet tested" - now say one thing each, with the correction dated and explained. No Status was changed on a closed row without evidence; where the honest answer was "closed on code evidence and the named test was never run", that is what the cell now says.

**Five new rows and two decisions.** FAB-43 the search-focus defect, FAB-44 the Rev 68 calendar and category changes, FAB-45 the gate-checker tokenizer fault, FAB-46 the header search awaiting a live pass, FAB-47 the localStorage category limitation. DEC-031 records an id collision I created: **the Rev 67 release note calls the search-focus defect FAB-40, and the workbook already used FAB-40 for batch operations.** `OMS_REV_LOG` is append-only, so the note keeps its wording, the workbook keeps its FAB-40, and the defect is FAB-43 here. This is DEC-026 repeating, and the remedy is the same: check the workbook before minting an id. DEC-032 asks whether categories should become shared canonical data.

**Three emails prepared in Outlook, none sent.** A new one to Rachel answering the export question and asking what the spreadsheet is actually for. The Maggie and Ari agenda revised, with a new opening section on what changed this week, Ari's ask corrected to "Recurring" with the real figures (3 of 275), and Maggie's ask naming her Key Dates Calendar specifically so it cannot be confused with Ari's Events Calendar. The team invitation reattached with the rewritten checklist and retimed to half an hour. Two malformed duplicate invitations remain in Drafts from an earlier deeplink attempt; they carry plus signs instead of spaces in the subject and should be deleted.

### 12.11 Rev 70: categories become shared canonical data (FAB-47, DEC-032)

Hossam's decision on the limitation Rev 68 exposed. A category lived in whichever browser typed it: `eventCategories()` built its list from the built-in set, every category string a record actually carried, and a per-browser list in `localStorage`. So a name one person invented stayed invisible to everyone else until a record happened to use it, and Delete could only ever remove an unused one, because the list was rebuilt from the records themselves.

**Landed in the required order, data then gateway then client, each inert on its own.**

- **Data, OPS-042, PR #19.** `categories` added to the consolidator's `ALLOWED`, to `validate_canonical`'s `ALLOWED`, and to the `entityType` enum in the operation schema. No apply-path change was needed; the consolidator handles collections generically.
- **Gateway, OMS-067, PR #24.** One line of allow-list. The branch is misnamed `oms-066`; OMS-066 was the make-users fix, and the work is OMS-067.
- **Client, Rev 70, v1.53.0.** `categories` joins `OMS_COLLECTIONS`, which is the line that matters: a collection missing from it emits no operations in either direction while the interface reports success, which is exactly the `gw` and `rob` defect this project already had once.

**The tests are the point, not the allow-list entries.** `taskTemplates` sat in all the same places for weeks with nothing writing one, which is how a collection can be "supported" and untested at the same time. So the consolidator test now drives a category through create, rename and delete; the gateway's operation-guards test validates all three actions, refuses a near-miss name (`categorys`), and pushes one through `submitOperation` to confirm it reaches the inbox with a readable commit message; and the smoke suite covers add, rename, delete, the legacy promotion path and the viewer refusal.

**Record shape, and why a rename is two things.** A record is `{id, name}`. Records reference a category by NAME, so the id exists purely so the record can be synced, updated and deleted like any other, and a rename is an UPDATE rather than a delete and a create. The id therefore stops matching the name after a rename, which is deliberate and is the same rule person ids follow. A rename is consequently an update to the category record AND a rewrite of every event, task and SOP carrying the old string, sent as one save, which is what Rev 60's batching is for.

**One real defect fixed on the way.** `renameCategory` ended with `if(k){...save()}`, where `k` counts records changed. Renaming a category that nothing uses gives `k === 0`, so the function returned early and the rename was silently dropped. That did not matter while the name lived only in `localStorage` and the dialog rebuilt itself from that list, and it matters now. The save is gated on `k || catTouched`, and a smoke assertion pins the zero-record case.

**Migration, stated rather than hidden.** The per-browser list is still READ, so a name somebody added before this shipped does not vanish from their screen; it is no longer written, so that list can only shrink. The dialog now shows where every category lives in its own column - built-in, shared, in use, or *this computer only* - and a local one carries a **Share** button that promotes it to the shared collection and clears the local copy. Only the person whose browser holds it can see it to promote it, which is precisely why the label exists rather than the difference being smoothed over.

**Verified end to end on the live artifact**, not in a harness: adding a category from the dialog produced gateway commit `191d133 OMS create: categories/cat-shared-probe-delete-me`, a consolidator run, and canonical revision 109 holding the record with `_version` 1 and the signed-in author. Deleting it returned canonical to 110 with the collection empty. Both directions work through all three repositories.

### 12.12 Rev 71: the browser stops holding categories at all

Hossam, reading Rev 70: *categories must be canonical, not live in your browser.* He was right that Rev 70 stopped half way. It made new categories canonical but kept READING the old per-browser list, so a name added before it shipped did not vanish from the screen of whoever typed it. Kind to that one person, and wrong overall: it left two homes for one thing, which is the exact split the change existed to close. A category could still be real on one machine and nowhere else, and the dialog needed a *this computer only* label and a Share button to explain a distinction that should not have existed.

**Nothing reads or writes browser storage for categories now.** `eventCategories()` draws on two sources only: the canonical `categories` collection, and the names records actually carry. `omsCustomCats`, `omsRememberCat` and `omsForgetCat` are gone. A category typed into the Category box on an event, task or SOP form creates a canonical record through `omsEnsureCategory`, where it used to be remembered locally, so the vocabulary is the same for everybody however it was created. The Share button and the third state went with the store they described, leaving two: a record of its own, or carried by the records using it.

**The old list is drained once, at boot, rather than dropped.** Deleting the store outright would have silently lost a name somebody had typed, so `omsMigrateLocalCategories` runs after the role is resolved, promotes any name that is not built-in, not already a record and not already carried by a record, and deletes the key. It is deliberately guarded, because a boot-time write is a write on a read and this project has been bitten by one before - Rev 50, where the boot migration left every collection dirty and the idle refresh never ran again. With nothing to move it deletes a redundant key and writes nothing at all. A read-only account never writes, but the key still goes, because reading it is precisely what this change removes.

**Both paths verified live, not in a harness.**

| Path | Result |
|---|---|
| Ordinary boot, key held only duplicates of built-ins | key deleted, canonical unchanged at 110, nothing dirty |
| Boot with a genuine local-only name | gateway commit `c8c1a3a`, consolidator run, canonical 111 holding the record |
| A built-in sitting beside it in the same list | discarded, not duplicated |
| Deleting the probe | canonical 112, collection empty |

**One assertion moved rather than being deleted.** A-13 has proved since Rev 54 that a refused event form leaves no new category behind while a saved one keeps it. Its intent is untouched; it now looks for the category where a category actually lives.

**Two of my own assertions failed on my own prose**, again, and the lesson is the same one as Rev 69: a check that greps the whole artifact for a token will match the code comment explaining the token's removal, and the release note quoting it. Both are now scoped to definitions and to markup rather than to mentions.

**Emails: blocked, then unblocked.** The Outlook web session expired mid-session and re-authenticating needs Hossam's password, which I do not type, so the change was written up for him to paste rather than quietly skipped. He restored the session the same evening and the paragraph was added directly: item 6 of the agenda to Maggie and Ari, draft saved 9:11 PM. The other two drafts needed no change and were checked and found intact - Rachel's is about the calendar export, and the tester checklist deliberately never asks a tester to touch categories. Nothing has been sent. Rachel's draft was confirmed indirectly, by the Drafts count and by Outlook's own save confirmations when it was written, because the message list does not render while its tab is hidden.

## 13. Why four items were left alone on day one, and what changed

- **The scheduled consolidator drain.** It is GitHub's scheduler, not this system's code; DEC-019 already records that it does not fire reliably and asks what to do about it. OPS-039 made it a backstop rather than the recovery path: any later push now drains the inbox, and a manual dispatch works in seconds. Still open as a question of whether to rely on the schedule at all; the honest options are to accept it as-is, or to have the gateway dispatch the workflow after each accepted operation, which needs the GitHub App to hold the Actions permission and is a gateway PR.
- **Intake sections had Delete but no Edit.** Left because the fix agent was told the edit dialogs were out of its scope and I wanted the delete to ship rather than wait. Built in Rev 57.
- **`buildSeed` and the seed arrays.** Left because deleting them changes what an empty canonical shows, and that is a decision about the bootstrap, not a defect. Decided and removed in Rev 57: canonical is the only source of records.
- **`seedPeople` listed a departed colleague.** Left because it runs only when canonical has no people at all, and correcting a roster needs the right roster. Decided in Rev 57: the bootstrap roster is the one administrator.

## 14. Screen reader, keyboard-only, and mobile tests: what they would be

Described so you can decide whether to run or waive them.

- **Keyboard-only.** Unplug the mouse. Tab through the header, the tab bar and each screen; every filter chip and calendar pill must take focus and act on Enter or Space (Rev 54 made them focusable buttons); open a dialog and confirm focus moves into it, Escape closes it, and focus returns to the control that opened it; complete an add-task flow end to end without the mouse. Pass if nothing is unreachable and nothing traps focus.
- **Screen reader.** With Windows Narrator or NVDA: every form field announces its label (Rev 54 associated them); the dialog announces as a dialog with its title; status badges are read as words, not colors; the sync state changes are announced or at least readable on demand. Pass if a person who cannot see the screen can add a task and tell whether it saved.
- **Mobile and responsive.** At 375 px and 768 px widths: the tab bar scrolls horizontally rather than wrapping off-screen (it is styled to), the calendar grid collapses to fewer columns (the print and 900/600 px breakpoints exist), dialogs fit the viewport and their footer stays reachable, and text inputs are not zoomed by the browser on focus. The app has never been designed for phones; the realistic expectation is "readable and operable on a tablet", not "phone-first".

None of these has been run. Nothing in the review depends on them.

