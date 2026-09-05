# CAO-OMS — working rules

Dean's Office Operations Management System, Wake Forest University School of Medicine / Advocate Health. Dean-facing. Treat every change as production.

## What this repo is

`oms.html` is the entire application: one file, ~166 KB, three inline `<script>` blocks, no build step, no dependencies beyond a CDN SheetJS tag. `index.html` is the sign-in page. GitHub Pages serves both from `main`, so **a push to `main` is a deploy**.

Two sibling repos, both private:

- `CAO-OMS-Gateway` — Vercel functions. `api/operation.js` is a thin wrapper; the logic is in `lib/core.js` (~105 lines), which authenticates as a GitHub App and writes to the data repo. It has no array primitives — it validates and persists, it does not merge.
- `CAO-OMS-Data` — canonical state: `state/oms-state.json`, `state/manifest.json`, `operations/processed/`, `snapshots/`, and `RECOVERY.md`. A consolidator workflow folds operations into the state file.

## Release rules

**Client releases go direct to `main`.** No PR, no branch. The local gate must pass first; CI re-runs it on push; a revert is one commit.

**Anything touching the gateway or `CAO-OMS-Data` goes by PR.** Those have no rollback baseline.

Before pushing `oms.html`:

```bash
node test/smoke.mjs oms.html      # behaviour — 36 assertions
./scripts/release_gate.sh HEAD~1  # form — 11 checks + 31 preflight assertions
```

`./scripts/release.sh <minor> "<summary>"` does the whole release: bumps the badge, writes the revision-log entry, runs smoke, runs the gate, commits, pushes, watches CI. It refuses to push if either check fails. `./scripts/rollback.sh <commit-ish>` restores an older artifact. `./scripts/verify_live.sh <sha256>` polls the deployed site until it serves what you expect.

Every non-cosmetic change **must** bump the version badge, append an `OMS_REV_LOG` entry, and touch the embedded User Guide. The gate enforces all three; that is deliberate.

## Things that will bite you

**`OMS_MAP` drops records with no `id`.** Both sides of the sync diff use it, so a collection whose records lack ids emits **zero operations in every direction** — no create, no update, no delete — while the UI reports success. This is not hypothetical: `gw` (CAO Visibility) and `rob` (the Cadence grid) had never synced, in either direction, until they were migrated on 5 Sept 2026. Rev 15 added a guard that reports Unsynced and names any collection still holding id-less records. **Do not remove it.**

**A save producing no operations used to report "Connected."** That is the shape of the bug above. If you touch `OMS_SYNC_ONCE`, keep the `OMS_UNSYNCABLE()` check on both exit paths.

**The gateway appends on `create`.** Proven by probe: a create for an entity the store already holds produces a duplicate, not an upsert. Unreachable while every record has an id — do not make it reachable.

**Never migrate canonical data through the client.** The `gw`/`rob` id migration was a direct, snapshotted commit to `state/oms-state.json`. Going through the operation path would have produced 16 CAO Visibility rows and 14 workstreams. Snapshot first, using the repo's own `snapshots/manifest-before-<UTC>.json` convention.

**One overlay, one `#mbody`.** `openModal()` replaces `innerHTML`, so a second modal destroys the first. Anything needing a form mid-edit must be **inline** — that is why the new-person form lives inside the task dialog.

**Sync confirmation takes 20–30 seconds.** Wait for `syncState` to read **Connected** *and* for `OMS_REVISION` to increment before reloading. A reload during "Sync pending" discards the change you are testing. A fixed sleep is not good enough; poll.

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

Rev 13 shipped outside its approved scope and was never QA'd. Rev 14 fixed a Cadence grid defect that corrupted status on every documented edit. Rev 15 hardened the release gate, migrated `gw`/`rob` to id-bearing records, and added the silent-save guard. Rev 16 added owner resolution. The gate that exists now was written because the previous one accepted the bare word `Tasks` as proof the User Guide had been updated.
