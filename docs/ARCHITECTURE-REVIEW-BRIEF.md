# CAO-OMS architecture fidelity review — brief for a fresh session

**Written 6 September 2026** by the session that built Revs 32–35, for a session
that did not.

---

## Why this is a handoff and not a continuation

This is a **fidelity** review: *does the code do what the documents claim it
does?* The session that wrote the code is the worst available instrument for
that, because it knows what the code was *meant* to do, and intent is exactly
what the review must not inherit. That is not a theoretical worry. In one day
the authoring session:

- shipped a control on one form while writing guide text describing it as
  present on all forms;
- built a gate check specifically to catch text drifting from code, and that
  check still could not see the above, because it ties text to *existence* and
  not to *reachability*;
- created a queue branch as an orphan to prevent a dangerous merge, and did not
  notice that this removed the workflow which made the queue drain at all.

In each case the author knew what they meant. That is what stopped them seeing
what they had done.

**So: do not trust this document's interpretations. Trust its pointers.**
Everything below is either (a) a path, a command or a commit SHA — verifiable in
seconds, and you should verify it, or (b) an *event*, described as what happened
rather than what it means. Section 6 deliberately contains no conclusions.

---

## 0. Surfaces used in this review

| Surface | What it is | What it can reach |
|---|---|---|
| **Code** | A new Claude Code session, working directory `C:\dev\CAO-OMS` | The filesystem, git, the terminal, and a browser with the user's live logins |
| **Chat** | A claude.ai conversation with no repository access | Only what is pasted into it |

Every step below names the surface it **starts on** and the surface it **ends
on**. Where a step ends on Chat, that is deliberate and the reason is given —
Chat is used precisely because it *cannot* open the files, which makes it a
better judge of whether an argument stands on the evidence presented.

The user's rule of thumb: *if it touches a file, a repo, or a live system → Code.
If it is thinking, drafting or discussing → either.*

---

## 1. Ground truth (verify, do not assume)

Three repositories. Only the first is public.

| Repo | Path | Role |
|---|---|---|
| `CAO-OMS` | `C:\dev\CAO-OMS` | The client. `oms.html` is the whole application. GitHub Pages serves `main`, so **a push to `main` is a deploy** |
| `CAO-OMS-Gateway` | `C:\Users\hossa\Documents\GitHub\CAO-OMS-Gateway` | Vercel functions. `api/*.js` are thin; logic is `lib/core.js` |
| `CAO-OMS-Data` | `C:\Users\hossa\Documents\GitHub\CAO-OMS-Data` | Canonical state, operation log, snapshots, `RECOVERY.md` |

State at handoff — **re-derive all of it, do not take these on faith:**

- Client `main`: `57c366e`, Rev 35, badge v1.24.0
- Gateway `main`: `6bb4769`
- Data `main`: `dd0ccb5`
- Data branches: `inbox`, plus several merged-and-stale `ops-*`/`oms-*`, plus one
  open: `ops-029-scrub-plaintext-password`
- The `inbox` branch is **not in use**; its README records why

Commands. `scripts/*.sh` are bash and **do not run in PowerShell** — use Git
Bash. Node may need `export PATH="$PATH:/c/Program Files/nodejs"`.

```bash
node test/smoke.mjs oms.html          # behavior
./scripts/release_gate.sh HEAD        # form: numbered checks + preflight
python scripts/text_claims.py         # check 12: text must match code
python test/text_claims_negative.py   # check 12 must still catch real drift
python test/no_counts_negative.py     # check 13 must still catch real drift
python scripts/validate_canonical.py  # in CAO-OMS-Data
```

Two traps that will cost you an hour each if you meet them cold:

- **Heredocs collapse backslashes.** Any script containing regex escapes must be
  written to a file with the Write tool, never piped through a heredoc. This bit
  the authoring session at least five times across two sessions.
- **MSYS mangles git ref paths.** `git show origin/main:path/to/file` becomes a
  Windows path. Prefix with `MSYS_NO_PATHCONV=1`, or use `git ls-tree`.

`CLAUDE.md` deliberately contains **no counts** — no assertion totals, no check
totals, no file sizes. Gate check 13 fails the build if one is written back in.
Run the command and read the number it prints.

---

## 2. Rules for this review

1. **Never report state from memory or from a summary.** Read it live: `curl`
   the served artifact and hash it; `git log`; the Actions run; the state file.
2. **A finding is not a finding until it has a reproduction.** A file and line
   number, a command whose output shows it, or a mutation that breaks a test.
3. **Test your instruments before trusting them.** The authoring session ran one
   probe three times before it measured the right thing — first against an
   uncommitted branch, then against a stale merge base. A probe that fails in a
   way you cannot explain is a broken probe until proven otherwise.
4. **Prefer a negative control.** "The old shape fails and the new shape passes"
   is worth more than "the new shape passes."
5. **Do not fix what you find**, unless it is actively harming production. This
   is a review. Findings first; the user decides what gets built.
6. **en-US only.** No en-GB spellings anywhere, including in your own report.

---

## 3. The review, step by step

### Step 1 — Recover ground truth
**Start on: Code.** **End on: Code.**

Verify every fact in section 1 yourself. Hash the live artifact and compare it to
the top `OMS_REV_LOG` entry. Confirm the three repos are where this says. Read
`CLAUDE.md`, `RECOVERY.md` in the data repo, and the gateway's `lib/core.js` in
full — `lib/core.js` is short enough to read entirely, and you should.

Produce nothing but a working note. If any fact in section 1 is wrong, that is
itself a finding: this brief was written by someone who believed it.

---

### Step 2 — Extract the claims
**Start on: Code.** **End on: Code.**

Build a list of **every architectural promise the project makes about itself**,
each with a source. Sources are: `CLAUDE.md`, `RECOVERY.md`, the embedded User
Guide inside `oms.html`, `test/text-claims.json`, tooltips, and the revision log.

A promise is anything of the form "X always happens", "Y can never happen", "Z is
enforced". Examples of the *shape* (not an exhaustive list, and not necessarily
true — that is Step 3's job): records without ids emit no operations; the gateway
appends on create; one overlay and one `#mbody`; canonical is never written
through the client; read-only is enforced at the gateway rather than hidden.

Output: a table of claim → source → how it could be falsified.

---

### Step 3 — Test each claim against the code
**Start on: Code.** **End on: Code.**

For each claim, find the code that implements it and decide whether it does.
Where a claim is testable, write the test and run it. Where a claim is about
absence ("never happens"), try to make it happen.

Pay attention to claims that are **true today for a reason nobody wrote down** —
those are the ones that break silently later.

Output: claim → holds / drifted / unfalsifiable, with a reproduction for every
"drifted".

---

### Step 4 — Examine the seams
**Start on: Code.** **End on: Code.**

The interesting failures in this system have all been at boundaries, not inside
components. Look hard at:

- **Client ↔ gateway:** what the client sends versus what the gateway validates.
  Include what is sent that nobody asked for.
- **Gateway ↔ data repo:** the write path, the read path, and whether they can
  ever point at different places.
- **Data repo ↔ itself:** the consolidator, the canonical gate, and the
  documented direct-commit exemption in `RECOVERY.md`. Who can write
  `state/oms-state.json`, and what happens when two of them do?
- **Documents ↔ code:** gate checks 12 and 13 exist for this. Ask what class of
  drift they *cannot* catch — one such class is already known and named in
  section 6.

---

### Step 5 — Adversarially challenge your own findings
**Start on: Code.** **End on: Code.**

For every finding, argue the opposite as well as you can:

- What would have to be true for this finding to be wrong?
- Is it a real defect, or a design choice whose reason I have not found? Search
  the git log and the revision log before calling anything a mistake — several
  things in this codebase that look wrong are load-bearing, and the comments say
  so.
- Is the reproduction actually reproducing the thing I claim, or something
  adjacent? (See rule 3.)
- If I recommend a change, what does it break? What is the failure mode of my
  fix, and is it *quieter* than the one it replaces? Quieter is worse.

Kill any finding that does not survive. Say in the report how many you killed —
a review with no discarded findings did not challenge itself.

---

### Step 6 — Write the report
**Start on: Code.** **End on: Code, then hand off to Chat.**

Write it to `docs/ARCHITECTURE-REVIEW-<date>.md`. Structure:

1. What was verified, and how
2. Findings, ordered by consequence, each with: what is claimed, what is true,
   reproduction, blast radius, and confidence
3. Findings considered and discarded, with why
4. Recommendations, each marked *do now* / *do before go-live* / *do later* /
   *deliberately not doing*
5. What this review did **not** cover

Then **copy the finished report out** for Step 7.

---

### Step 7 — Independent read of the argument
**Start on: Chat.** **End on: Chat.**

Paste the report into a **fresh chat with no repository access**, and ask:

> For each finding, does the conclusion follow from the evidence presented? Where
> is the reasoning doing work the evidence does not support? Ignore whether the
> claims about the code are true — you cannot check that. Judge only the
> argument.

This step is on Chat **because** Chat cannot open the files. A reviewer with
repository access re-reads the code and re-convinces itself; a reviewer without
it can only test whether the written argument stands up. Findings that survive
here are ones a Dean's-office reader can also follow.

Carry the objections back to Step 5 and re-run it for anything that wobbles.

---

### Step 8 — Executive summary
**Start on: Chat.** **End on: Chat.**

Draft a one-page summary for a non-technical reader: what is sound, what is at
risk, what it would cost to fix, what happens if nothing is done. No file paths,
no function names. Chat is the right surface — this is writing, not
investigation, and the absence of the code keeps the summary honest about what a
reader without it can understand.

---

### Step 9 — Decide with the user
**Start on: Chat or Code, wherever the user is.** **End on: Code.**

Walk the recommendations. The user decides scope; do not assume. Anything agreed
becomes work in a Code session, under the normal release rules.

---

### Step 10 — Fable 5.1 steelman and security/QA pass
**Start on: Code.** **End on: Code.**

The user's stated end goal. Fable 5.1 is available as a model inside Claude Code,
so this does **not** need a different application — run it as a separate agent
with the model set to `fable`, against the same repositories.

Give it two jobs, in this order:

1. **Steelman**, not critique: take the architecture proposal and make the
   strongest possible case *for* it, then say what would have to be true for that
   case to hold.
2. **Security and QA review** of the three repos, with the credential model as
   the focus: `auth/users.json`, `scryptSync`, the session token, `requireAdmin`,
   the account endpoints, and what a signed-in read-only account can actually
   reach.

Ask it explicitly to challenge the review's findings, not to agree with them.

---

## 4. Standing constraints (from the user, still in force)

- **Dean-facing. Treat every change as production.**
- Client releases go direct to `main` after the gate passes. **Gateway and data
  repo changes go by PR.**
- Line endings: `core.autocrlf` must be `false`; the gate hashes `oms.html`.
- **NO en-GB SPELLINGS.** en-US throughout.
- OMS-related email must carry `OMS` in the subject plus a detailed summary; the
  in-app standard is `omsSubject()` in `oms.html`.
- Descriptive text must be tied to the code it describes — gate check 12. When a
  control, field or status is added, add a binding.
- Do not report state from memory. Read it live.

---

## 5. Open items not covered by this review

- `ops-029-scrub-plaintext-password` — an open PR removing a plaintext password
  from canonical. Re-cut so it no longer bumps the revision, and therefore merges
  cleanly regardless of concurrent saves.
- Six register items were recommended on and four were built (Revs 33–35). The
  category work depends on Ari Ball populating column P of the Dean's Office
  Events workbook; a worksheet and a draft email were prepared for her.
- The Fable 5.1 pass is Step 10, not part of the review proper.

---

## 6. Evidence dossier — events, not conclusions

Each of these happened on 6 September 2026. **They are described here as events.
Verify each one and decide for yourself what it means.** The authoring session's
interpretation is deliberately omitted, and where it is unavoidable it is marked.

**6.1 — The inbox cutover.** A branch named `inbox` was created in `CAO-OMS-Data`
as an orphan (no shared history with `main`) containing only a README. The
Vercel variable `GITHUB_INBOX_BRANCH=inbox` was set on the gateway, and the
gateway redeployed. A user then saved a task at 16:01:48Z. The operation was
written to `operations/inbox/` on the `inbox` branch (commit `3611d9f`). No
consolidator run started. Canonical stayed at revision 73 for eight minutes. The
client displayed **Unsynced**. A manual `workflow_dispatch` of the consolidator
on `main` (run #610) drained the queue and canonical moved to 74. The variable
was then deleted and the gateway redeployed; the `inbox` branch README was
updated (`658c21d`). **Facts to check:** what determines which workflow file a
push evaluates; whether the `branches:` filter in a workflow on one branch has
any effect on pushes to another; whether the consolidator, had it run, would have
worked correctly against that branch.

**6.2 — Unsynced was terminal.** `OMS_WAIT_FOR` in `oms.html` polled for
canonical confirmation for 24 seconds and then threw. The catch set the Unsynced
banner. Nothing re-checked. Rev 35 added a reconciler. **To check:** whether the
reconciler can adopt canonical over unsaved local edits; whether it can race a
new sync; what happens if the session expires while it is running.

**6.3 — A control described but not present.** Rev 34 added an attributed-note
control to the SOP dialog and User Guide text describing the behavior generally.
The task dialog — where notes are actually written — did not receive the control
until Rev 35. Gate check 12 passed throughout. **To check:** what check 12
actually binds, and what class of claim it therefore cannot police. This is the
one place this document states an interpretation, because it directly shapes
Step 4.

**6.4 — A pull request that would have caused data loss.** The OPS-029 branch was
cut when canonical was at revision 73 and set it to 74. Canonical independently
reached 74 through an ordinary save. Merging the branch as it stood would have
replaced `state/oms-state.json` with a version predating that save. It was
re-cut. It went stale a second time within the hour, and was re-cut again — this
time without touching `revision` or `updatedAt` at all. **To check:** whether
anything in the system requires the revision to increase; what else could
collide with a hand edit to canonical; whether git can merge two edits to that
file cleanly and still produce a wrong document.

**6.5 — A near-miss during cleanup.** A glob intended to remove two stale
snapshot files also matched `snapshots/*-20260906T162538Z.json`, which had been
committed to `main` by the consolidator. It was caught in `git status` and
restored before commit.

**6.6 — Role enforcement.** `api/operation.js` rejects non-admin/editor with
HTTP 403. `api/state.js` calls `requireSession` and returns state. **To check:**
what each endpoint enforces, and what it does not.

---

## 7. First message for the fresh session

> Read `docs/ARCHITECTURE-REVIEW-BRIEF.md` in `C:\dev\CAO-OMS`, then start at
> Step 1. Verify its ground-truth section before trusting any of it — it was
> written by the session that built the code, and its author's assumptions are
> the thing this review exists to catch.
