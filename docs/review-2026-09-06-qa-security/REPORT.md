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
| Delete the superseded drafts | The Rev 8 handoff draft is discarded (Drafts 45 to 44). The Rev 9 handoff and the Rev 8 backlog drafts, and the recipient for the Dean briefing draft, are blocked on a browser limitation: Outlook does not render its message list, or the Discard dialog, while its tab is hidden, and the tool cannot bring the Chrome window to the front. Needs the Outlook tab visible; two minutes of work once it is. |
| Test the viewer role | No viewer account exists. `auth/users.json` holds one admin and five editors; Jane Westgate and Clare Il'Giovine are directory people without sign-ins (OMS-056 deliberately left them so). A throwaway viewer account can be created from the console for the test; the sign-in itself has to be typed by Hossam. |
| Finish the gates | Gate 5 Test 3 (outage), Test 4 (recovery) and Test 5 (integrity) run live and passed; Tests 1 and 2 were covered by the concurrent-edit cases. Gate 6 is the five-person pilot and cannot be run by one reviewer. |
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

