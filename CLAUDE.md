# CAO-OMS — working rules

Dean's Office Operations Management System, Wake Forest University School of Medicine / Advocate Health. Dean-facing. Treat every change as production.

## What this repo is

`oms.html` is the entire application: one file, three inline `<script>` blocks, no build step, no dependencies beyond a CDN SheetJS tag. `index.html` is the sign-in page. GitHub Pages serves both from `main`, so **a push to `main` is a deploy**.

Two sibling repos, both private:

- `CAO-OMS-Gateway` — Vercel functions. `api/operation.js` is a thin wrapper; the logic is in `lib/core.js`, which authenticates as a GitHub App and writes to the data repo. It has no array primitives — it validates and persists, it does not merge.
- `CAO-OMS-Data` — canonical state: `state/oms-state.json`, `state/manifest.json`, `operations/processed/`, `snapshots/`, and `RECOVERY.md`. A consolidator workflow folds operations into the state file.

## Release rules

**Client releases go direct to `main`.** No PR, no branch. The local gate must pass first; CI re-runs it on push; a revert is one commit.

**Anything touching the gateway or `CAO-OMS-Data` goes by PR.** Those have no rollback baseline.

Before pushing `oms.html`:

```bash
node test/smoke.mjs oms.html      # behavior
./scripts/release_gate.sh HEAD~1  # form
```

`./scripts/release.sh <minor> "<summary>"` does the whole release: bumps the badge, writes the revision-log entry, runs smoke, runs the gate, commits, pushes, watches CI. It refuses to push if either check fails. `./scripts/rollback.sh <commit-ish>` restores an older artifact. `./scripts/verify_live.sh <sha256>` polls the deployed site until it serves what you expect.

**No counts are written in this file, deliberately.** How many assertions the suite holds, how many checks the gate runs, how large the artifact is: every one of those was written down once and was wrong within days, because a number in prose is a fact with no owner and nothing fails when it drifts. This file said 268 assertions and 11 checks on the day the suite passed 401 and 12. Run the command and read the total it prints. **Gate check 13 fails if a count is written back into this file**; if you want to say the suite is thorough, say that, and let the command say how thorough.

Every non-cosmetic change **must** bump the version badge, append an `OMS_REV_LOG` entry, and touch the embedded User Guide. The gate enforces all three; that is deliberate.

**Descriptive text must be tied to the code it describes.** Standing instruction. The guide hash check proves the guide *changed*, not that it became *true*, and nothing else tied a tooltip or a guide line to the behavior behind it — so text drifted silently and stayed wrong until somebody read it. In one day that produced a tooltip still instructing the exact action that caused the OMS-003 defect, a control promising a forced password change it could not deliver, and task tooltips listing a field set two revisions out of date.

Gate check 12 (`scripts/text_claims.py`, manifest `test/text-claims.json`) enforces it in both directions:

- `{"text": …, "requires_code": …}` — if the interface says it, the code must do it.
- `{"code": …, "requires_text": …}` — if the code does it, something must describe it.

**When you add a control, a field, or a status, add a binding for it.** When you remove one, the binding becomes stale and the gate says so. Text is checked outside `OMS_REV_LOG`, which is history and is never rewritten. `test/text_claims_negative.py` feeds the checker real drift and must keep passing; a gate that only ever passes is the failure this project already had once, in check 4.

## Things that will bite you

**`OMS_MAP` drops records with no `id`.** Both sides of the sync diff use it, so a collection whose records lack ids emits **zero operations in every direction** — no create, no update, no delete — while the UI reports success. This is not hypothetical: `gw` (CAO Visibility) and `rob` (the Cadence grid) had never synced, in either direction, until they were migrated on 5 Sept 2026. Rev 15 added a guard that reports Unsynced and names any collection still holding id-less records. **Do not remove it.**

**A save producing no operations used to report "Connected."** That is the shape of the bug above. If you touch `OMS_SYNC_ONCE`, keep the `OMS_UNSYNCABLE()` check on both exit paths.

**The gateway appends on `create`.** Proven by probe: a create for an entity the store already holds produces a duplicate, not an upsert. Unreachable while every record has an id — do not make it reachable.

**Never migrate canonical data through the client.** The `gw`/`rob` id migration was a direct, snapshotted commit to `state/oms-state.json`. Going through the operation path would have produced 16 CAO Visibility rows and 14 workstreams. Snapshot first, using the repo's own `snapshots/manifest-before-<UTC>.json` convention.

**One overlay, one `#mbody`.** `openModal()` replaces `innerHTML`, so a second modal destroys the first. Anything needing a form mid-edit must be **inline** — that is why the new-person form lives inside the task dialog.

**Sync confirmation takes 20–30 seconds.** Wait for `syncState` to read **Connected** *and* for `OMS_REVISION` to increment before reloading. A reload during "Sync pending" discards the change you are testing. A fixed sleep is not good enough; poll.

## Running the tooling on Windows

`scripts/release_gate.sh`, `scripts/release.sh`, `scripts/rollback.sh` and `scripts/verify_live.sh` are bash. **They do not run in PowerShell.** Use **Git Bash** (ships with Git for Windows): right-click in the repo folder, *Open Git Bash here*. `test/smoke.mjs` is Node and runs in any shell.

Line endings matter here in a way they usually do not: the gate checksums `oms.html`, and `release.sh` computes SHA-256 of the working-tree file. If `core.autocrlf` rewrites LF to CRLF on checkout, every checksum mismatches and `.sh` files fail in Git Bash with `bad interpreter`. Confirm `git config --get core.autocrlf` is `false` for this repo, and that `oms.html` hashes to the value in the current release note.

## Verifying anything

Never report state from memory or from a register row. Read it live:

- Display artifact: `curl` the raw file, `sha256sum`, check the badge and top rev.
- Canonical state: read `ST`/`OMS_REVISION` in a signed-in browser session — the app requires OMS credentials, held in `sessionStorage`, which die with the tab.
- Repo: `git log`, the Actions run, the served file. Not a summary of them.

## Conventions

Person ids are `slug(name)` with a `-2`, `-3` suffix on collision. Owner strings must match a directory person; `findPerson` binds only when exactly one person matches, and `ownerAmbiguity` blocks a save that matches two. Display names and email names diverge at Advocate — Maggie/Margaret, Ari/Ariana — so the resolution ladder checks both.

`gw` ids are `gw-<YYYY-MM-DD>`; `rob` ids are `rob-<slug of workstream>`.

Names to spell correctly: Terry Hales, Terri Yates, Clare Il'Giovine, Dean Boulware, Maggie Scirica, Ari Ball, Rachel Woodside, Erich Huang.

## History worth knowing

Rev 13 shipped outside its approved scope and was never QA'd. Rev 14 fixed a Cadence grid defect that corrupted status on every documented edit. Rev 15 hardened the release gate, migrated `gw`/`rob` to id-bearing records, and added the silent-save guard. Rev 16 added owner resolution. Rev 17 added Retired status, free-text categories, saved views and multi-day event spanning; Rev 18 made categories user-editable and fixed a live legend-code collision; Rev 19 fixed the Weekly Brief default week and the notification subject standard; Rev 20 removed en-GB spellings and added a guard; Rev 21 was the sync-path release, quarantined deliberately; Rev 22 unified the vocabulary on "task"; Rev 23 gave tasks a category, sortable columns, a grouped checklist export and a working intake form.

The gate that exists now was written because the previous one accepted the bare word `Tasks` as proof the User Guide had been updated.
