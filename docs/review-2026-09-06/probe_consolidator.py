#!/usr/bin/env python3
"""Step 3 probes against the REAL consolidator, in a throwaway repo.

Claims under test, each with its source:

  C1  CLAUDE.md: "The gateway appends on create. Proven by probe: a create for
      an entity the store already holds produces a duplicate, not an upsert.
      Unreachable while every record has an id."
  C2  RECOVERY.md step 3: "Keep state.revision and manifest.stateRevision in
      step, or the consolidator refuses to run on its next invocation."
  C3  RECOVERY.md: "A record with no id cannot be addressed by a delete."
  C4  RECOVERY.md / OPS-029 commit: "consolidate.py merges changes with
      dict.update(), so an update can set tempPassword to null but never
      remove it."
  C5  consolidate.py comment: replays are dropped before they can manufacture
      a conflict record or bump the revision.
  C6  consolidate.py: "One revision increment per processed batch, including
      conflicts/invalid operations."
"""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DATA = pathlib.Path(r"C:\Users\hossa\Documents\GitHub\CAO-OMS-Data")
fails = []


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (("  — " + detail) if detail else ""))
    if not cond:
        fails.append(name)


def fresh(state_collections, revision=10):
    root = pathlib.Path(tempfile.mkdtemp(prefix="cons-"))
    (root / "scripts").mkdir()
    (root / "state").mkdir()
    (root / "operations/inbox").mkdir(parents=True)
    (root / "operations/processed").mkdir(parents=True)
    shutil.copy(DATA / "scripts/consolidate.py", root / "scripts/consolidate.py")
    state = {"schemaVersion": 2, "revision": revision,
             "updatedAt": "2026-09-06T00:00:00Z"}
    state.update(state_collections)
    (root / "state/oms-state.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
    (root / "state/manifest.json").write_text(json.dumps(
        {"schemaVersion": 1, "stateRevision": revision, "statePath": "state/oms-state.json",
         "updatedAt": "2026-09-06T00:00:00Z", "lastOperationId": None, "status": "ready"},
        indent=2), encoding="utf-8")
    return root


def op(root, name, **kw):
    o = {"operationId": kw.pop("operationId", name), "schemaVersion": 1,
         "actor": {"githubLogin": "oms-probe", "displayName": "Probe"},
         "createdAt": "2026-09-06T00:00:00Z"}
    o.update(kw)
    (root / "operations/inbox" / (name + ".json")).write_text(json.dumps(o, indent=2), encoding="utf-8")


def run(root):
    r = subprocess.run([sys.executable, "scripts/consolidate.py"], cwd=root,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r


def state_of(root):
    return json.loads((root / "state/oms-state.json").read_text(encoding="utf-8"))


# ------------------------------------------------------------------ C1
print("\n### C1  a create for an id the store already holds\n")

root = fresh({"tasks": [{"id": "t1", "title": "Already here", "_version": 1}]})
op(root, "create-dupe", entityType="tasks", entityId="t1", action="create",
   baseVersion=0, changes={"title": "Second copy"})
r = run(root)
s = state_of(root)
print("   stdout:", r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr.strip()[:200])
check("C1a: rows stay at 1 — no duplicate when the id is already present",
      len(s["tasks"]) == 1, "%d rows" % len(s["tasks"]))
check("C1b: the create is recorded as a conflict, not applied",
      (root / "conflicts/unresolved").exists() and
      any((root / "conflicts/unresolved").glob("*.json")))
if (root / "conflicts/unresolved").exists():
    c = json.loads(next((root / "conflicts/unresolved").glob("*.json")).read_text(encoding="utf-8"))
    print("      reason recorded:", c.get("reason"))

# and the id-LESS case, which is what the gw probe actually hit
root = fresh({"gw": [{"date": "2026-01-01", "note": "no id"}]})
op(root, "create-idless", entityType="gw", entityId="gw-2026-01-01", action="create",
   baseVersion=0, changes={"date": "2026-01-01", "note": "no id"})
run(root)
s = state_of(root)
check("C1c: with an ID-LESS row present, the same create DOES append a duplicate row",
      len(s["gw"]) == 2, "%d rows — this is the gw 8→9 probe" % len(s["gw"]))

# ------------------------------------------------------------------ C2
print("\n### C2  revision and manifest out of step\n")

root = fresh({"tasks": [{"id": "t1", "title": "x", "_version": 1}]}, revision=10)
m = json.loads((root / "state/manifest.json").read_text(encoding="utf-8"))
m["stateRevision"] = 9
(root / "state/manifest.json").write_text(json.dumps(m, indent=2), encoding="utf-8")
op(root, "op-mismatch", entityType="tasks", entityId="t1", action="update",
   baseVersion=1, changes={"title": "y"})
r = run(root)
check("C2a: the consolidator refuses to run when revision != stateRevision",
      r.returncode != 0, "exit %d" % r.returncode)
print("      error:", (r.stderr.strip().splitlines() or [""])[-1][:120])

# ...but only when there is something to do?
root = fresh({"tasks": [{"id": "t1", "_version": 1}]}, revision=10)
m = json.loads((root / "state/manifest.json").read_text(encoding="utf-8"))
m["stateRevision"] = 9
(root / "state/manifest.json").write_text(json.dumps(m, indent=2), encoding="utf-8")
r = run(root)   # empty inbox
check("C2b: it refuses even with an empty inbox (validate_state runs first)",
      r.returncode != 0, "exit %d" % r.returncode)

# ------------------------------------------------------------------ C3
print("\n### C3  a record with no id cannot be addressed by a delete\n")

root = fresh({"gw": [{"date": "2026-01-01"}]})
op(root, "del-idless", entityType="gw", entityId="gw-2026-01-01", action="delete", baseVersion=0)
run(root)
s = state_of(root)
check("C3: the id-less row survives the delete", len(s["gw"]) == 1, "%d rows" % len(s["gw"]))

# ------------------------------------------------------------------ C4
print("\n### C4  an update cannot remove a key\n")

root = fresh({"people": [{"id": "p1", "name": "R", "tempPassword": "CAO-OMS-2026!", "_version": 1}]})
op(root, "null-it", entityType="people", entityId="p1", action="update",
   baseVersion=1, changes={"tempPassword": None})
run(root)
s = state_of(root)
row = s["people"][0]
check("C4a: setting a key to null leaves the key present",
      "tempPassword" in row, "keys: %s" % sorted(row))
check("C4b: ...with the value null rather than the secret",
      row.get("tempPassword") is None, repr(row.get("tempPassword")))

# ------------------------------------------------------------------ C5
print("\n### C5  a replayed operation is dropped before it can do harm\n")

root = fresh({"tasks": [{"id": "t1", "title": "x", "_version": 1}]})
op(root, "replay-me", entityType="tasks", entityId="t1", action="update",
   baseVersion=1, changes={"title": "y"})
run(root)
rev_after_first = state_of(root)["revision"]
# present the SAME filename again
op(root, "replay-me", entityType="tasks", entityId="t1", action="update",
   baseVersion=1, changes={"title": "z"})
r = run(root)
s = state_of(root)
check("C5a: the replay does not change the record",
      s["tasks"][0]["title"] == "y", s["tasks"][0]["title"])
check("C5b: the replay does not bump the revision",
      s["revision"] == rev_after_first, "%d then %d" % (rev_after_first, s["revision"]))
check("C5c: the replay writes no conflict record",
      not list((root / "conflicts/unresolved").glob("*.json"))
      if (root / "conflicts/unresolved").exists() else True)

# ------------------------------------------------------------------ C6
print("\n### C6  one revision increment per batch, conflicts included\n")

root = fresh({"tasks": [{"id": "t1", "title": "x", "_version": 1}]}, revision=10)
for i in range(3):
    op(root, "batch-%d" % i, entityType="tasks", entityId="t1", action="update",
       baseVersion=1, changes={"title": "v%d" % i})
run(root)
check("C6a: three operations in one batch advance the revision by exactly 1",
      state_of(root)["revision"] == 11, "revision=%d" % state_of(root)["revision"])

root = fresh({"tasks": [{"id": "t1", "_version": 1}]}, revision=10)
op(root, "only-invalid", entityType="tasks", entityId="t1", action="update",
   baseVersion=1)   # no changes -> invalid
run(root)
check("C6b: a batch of nothing but invalid operations still advances the revision",
      state_of(root)["revision"] == 11, "revision=%d" % state_of(root)["revision"])

print("\n" + "=" * 66)
print("CONSOLIDATOR PROBES: %d failed" % len(fails))
for f in fails:
    print("   FAILED:", f)
print("=" * 66)
