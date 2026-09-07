# Gate 6: five-user pilot script

**Purpose.** Gate 6 is the only gate one reviewer cannot close. It proves that five real people, on their own machines, with their own accounts, can sign in, do their ordinary work, and see each other's work arrive, without a defect that stops them. Everything below runs against production (`https://cao-initiatives.github.io/CAO-OMS/oms.html`) at Rev 58 or later.

**Exit criteria (all five must hold).** Every pilot user signed in on the first attempt after setting a password. Every user saved at least one record and saw it confirmed. No data was corrupted or lost, checked against canonical afterward. No blocking defect. Feedback captured from each person.

**Roles.** Hossam runs the pilot as administrator. Maggie Scirica, Ari Ball, Rachel Woodside and one more editor (Victoria Ozokwelu or Katie Darling) are the pilot editors. If a viewer is wanted, use the throwaway account `qa.fable.viewer@example.invalid` and delete it afterward.

**Before anyone starts (Hossam, ten minutes).**

1. Confirm the served artifact: `./scripts/verify_live.sh <sha>` against the current release note, and the Admin Console shows every pilot account with no `change required` flag left after step 1 below.
2. Note the canonical revision in the header. Write it down; it is the baseline for the integrity check at the end.
3. Create one task per pilot user, titled `PILOT <name> - please edit me`, owner set to that person, due next week. These are the records each person edits; the notifications it generates are real drafts to real people, which is also a test.

---

## Part A: each pilot user, alone (about fifteen minutes)

Do these in order. Note the time and anything unexpected next to each step. A step that does not behave as written is a finding, not a failure of yours.

| # | Step | Expected | Record |
|---|---|---|---|
| A1 | Open the sign-in page and sign in with your id and the initial password you were given. | You are asked to set a new password before anything else. Set one. Sign-in completes. | Time to sign in; any error text verbatim |
| A2 | Look at the header. | Your name and role are shown. The badge reads **Connected** within a few seconds. | Role shown |
| A3 | Open **Dashboard**, **Weekly Brief**, **Calendars**, **Tasks**. | Each screen renders. The Calendars grid shows this month with events. | Any blank screen or error |
| A4 | On **Tasks**, open the task named `PILOT <your name> - please edit me`. | The dialog opens prefilled. Status, owner, due date and notes are there. | |
| A5 | Change the status to **In Progress** and add one line to Notes with the **Add note** control. Save. | The badge reads **Saving**, then **Sync pending**, then **Connected** with a "Save successful" toast, in well under a minute. | Time from Save to Connected |
| A6 | Reload the page. | The task still shows your change. | |
| A7 | Open **Notifications** in the header. | A draft addressed to you exists for the pilot task. Open it; Outlook shows a draft with the subject in the standard form and your name in it. Do not send it. | Subject line verbatim |
| A8 | Open **Calendars**, click any event, change nothing, close it with **Escape**. | The dialog closes; nothing saved; badge stays Connected. | |
| A9 | Open **Import** (editors) or confirm it is absent (viewer). | Editors see two upload cards. Do **not** upload anything. Viewer sees no Import tab. | |
| A10 | Try to open **Admin** (editors and viewer). | The tab is not shown; if reached by URL trick, it says Access denied. | |
| A11 | Leave the page open and untouched for two minutes while somebody else does A5. | Their change appears on your Tasks screen without you saving or reloading, with a toast "Updated with changes from shared OMS". | Did it arrive, and roughly when |
| A12 | Sign out. | You land on the sign-in page. Signing in again works with your new password. | |

## Part B: two people together (Hossam pairs with one editor, five minutes)

| # | Step | Expected |
|---|---|---|
| B1 | Both open the same task. Person 1 changes the **notes**, saves. Person 2 changes the **due date**, saves, without reloading. | Both changes survive; nobody sees a conflict. |
| B2 | Both open the same task. Both change the **title** to different text. Person 1 saves, then Person 2. | Person 2 sees a conflict message naming the task and the field `title`; their title is set aside, Person 1's stands; any other field Person 2 changed is still saved. |
| B3 | Hossam disables Person 2's sign-in from the Admin Console while Person 2 is signed in. Person 2 tries to save anything within two minutes. | The save is refused; the banner says the account can read but not change, or asks them to sign in again. Hossam re-enables the account. |

## Part C: integrity check (Hossam, five minutes, after everyone is done)

1. Canonical revision has moved on from the baseline by at least one per save made.
2. In `CAO-OMS-Data`: `conflicts/unresolved/` holds only its README; `python scripts/validate_canonical.py` passes; the Actions history shows no failed consolidator run during the pilot window.
3. Every `PILOT` task carries its editor's status change and note; no other task changed. Delete the `PILOT` tasks afterward through the Tasks screen, and delete the throwaway viewer account if it was used.

## Part D: feedback (each person, three minutes, verbatim)

1. Did anything break or behave unexpectedly? Where?
2. Was any screen or word confusing?
3. Did any data look wrong?
4. Did sign-in succeed on the first try after you set your password?
5. Would you use this weekly? What would make you?

## Recording

Use the `Gate 6 Pilot` sheet of the canonical backlog workbook: one row per person per step, with time, pass/fail, and the note. A step everybody passes is one line; a step anybody fails is a finding to register with the next free FAB or OMS id and the pilot date as its source.
