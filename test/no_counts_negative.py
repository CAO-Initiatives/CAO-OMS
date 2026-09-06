#!/usr/bin/env python3
"""Negative-test gate check 13. Every count must be caught; history must not be.

Same discipline as test/text_claims_negative.py, and for the same reason: this
project has already shipped a gate check that was vacuous on Windows for its
entire life. A guard that only ever passes is worth less than no guard, because
it also buys false confidence.

The second half matters as much as the first. A guard that flags "58 of 85
concluded runs were failing" would be turned off within a week, and a disabled
guard protects nothing.
"""
import io, os, pathlib, shutil, subprocess, sys, tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

SRC = pathlib.Path(__file__).resolve().parents[1]
PY = sys.executable
passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1; print("PASS  " + name)
    else:
        failed += 1; print("FAIL  " + name + (" - " + detail if detail else ""))


def sandbox():
    tmp = pathlib.Path(tempfile.mkdtemp())
    (tmp / "scripts").mkdir()
    shutil.copy(SRC / "scripts/no_handwritten_counts.py", tmp / "scripts/no_handwritten_counts.py")
    shutil.copy(SRC / "CLAUDE.md", tmp / "CLAUDE.md")
    return tmp


def run(tmp):
    r = subprocess.run([PY, "scripts/no_handwritten_counts.py"], cwd=tmp,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def append(tmp, line):
    with open(tmp / "CLAUDE.md", "a", encoding="utf-8") as fh:
        fh.write("\n" + line + "\n")


# ------------------------------------------------------------------ control
t = sandbox()
rc, out = run(t)
check("the current CLAUDE.md passes", rc == 0, out.strip()[:160])

# ------------------------------------------------------------------ counts must be caught
CAUGHT = [
    ("an assertion count",   "The suite now holds 401 assertions."),
    ("a gate check count",   "The gate runs 12 checks before it will push."),
    ("a preflight count",    "Plus 31 preflight assertions on top of that."),
    ("an artifact size",     "`oms.html` is ~291 KB of single-file application."),
    ("a source line count",  "`lib/core.js` is ~136 lines and does not merge."),
    ("a binding count",      "The manifest carries 20 bindings today."),
]
for label, line in CAUGHT:
    t = sandbox(); append(t, line)
    rc, out = run(t)
    check("re-adding %s is caught" % label, rc == 1 and "writes a count" in out, out.strip()[:160])

# ------------------------------------------------------------------ history must NOT be caught
# These are statements about events that already happened. They cannot go stale,
# and flagging them would get this guard switched off.
SPARED = [
    ("a past failure rate",    "58 of 85 concluded runs were failing on a non-fast-forward push."),
    ("a past duplication",     "Verified by probe at the time: gw went from 8 rows to 9."),
    ("a past blast radius",    "Rev 14 fixed a defect that corrupted status across 84 live cells."),
    ("a revision number",      "Rev 32 made Add User issue a sign-in account."),
]
for label, line in SPARED:
    t = sandbox(); append(t, line)
    rc, out = run(t)
    check("%s is left alone" % label, rc == 0, out.strip()[:160])

# ------------------------------------------------------------------ integrity
t = sandbox()
os.remove(t / "CLAUDE.md")
rc, out = run(t)
check("a missing CLAUDE.md fails rather than skipping", rc == 1, out.strip()[:120])

print()
print("=" * 56)
print("HANDWRITTEN-COUNT GUARD: %d passed, %d failed" % (passed, failed))
print("=" * 56)
sys.exit(1 if failed else 0)
