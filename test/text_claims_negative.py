#!/usr/bin/env python3
"""Negative-test the text-claims gate. Every injected drift must be caught.

The failure this project has already had is a check that passes because it is
testing nothing - release gate check 4 was vacuous on Windows for its entire
life. So this one gets fed real drift before it is trusted.
"""
import io, json, os, shutil, subprocess, sys, tempfile, pathlib
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

SRC = pathlib.Path(r"C:\dev\CAO-OMS")
PY = sys.executable
passed = failed = 0

def check(name, ok, detail=""):
    global passed, failed
    if ok: passed += 1; print("PASS  " + name)
    else:  failed += 1; print("FAIL  " + name + (" - " + detail if detail else ""))

def run(tmp):
    r = subprocess.run([PY, "scripts/text_claims.py"], cwd=tmp,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout or "") + (r.stderr or "")

def sandbox():
    tmp = tempfile.mkdtemp()
    (pathlib.Path(tmp) / "scripts").mkdir()
    (pathlib.Path(tmp) / "test").mkdir()
    shutil.copy(SRC / "scripts/text_claims.py", pathlib.Path(tmp) / "scripts/text_claims.py")
    shutil.copy(SRC / "test/text-claims.json", pathlib.Path(tmp) / "test/text-claims.json")
    shutil.copy(SRC / "oms.html", pathlib.Path(tmp) / "oms.html")
    return pathlib.Path(tmp)

def edit_html(tmp, old, new, expect=1):
    p = tmp / "oms.html"
    s = p.read_text(encoding="utf-8")
    assert s.count(old) >= expect, "fixture anchor missing: %r (%d)" % (old[:60], s.count(old))
    p.write_text(s.replace(old, new), encoding="utf-8")

def set_manifest(tmp, data):
    (tmp / "test/text-claims.json").write_text(json.dumps(data, indent=2), encoding="utf-8")

# ---------------------------------------------------------------- control
t = sandbox()
rc, out = run(t)
check("the unmodified artifact passes", rc == 0, out.strip().splitlines()[-1] if out else "")

# ---------------------------------------------------------------- text asserts what code does not
t = sandbox()
edit_html(t, "Double-click a cell to edit its activity text and status.",
             "Single-click a cell to cycle status.")
rc, out = run(t)
check("reintroducing the removed single-click instruction is caught",
      rc == 1 and "cadence-single-click-removed" in out, out.strip()[:160])

# Rev 32 retired the fixture that used to live here: it promised an initial
# password the form could not set, and the form can set one now. Replaced with
# a promise that is still unbacked - the temp-password control deleted in Rev 29.
t = sandbox()
edit_html(t, "They must change it before they can use OMS.",
             "User must set a new password on next login.")
rc, out = run(t)
check("re-promising the deleted temp-password control is caught",
      rc == 1 and "temp-password-must-change" in out, out.strip()[:160])

# ---------------------------------------------------------------- text true only while code is absent
t = sandbox()
edit_html(t, "Issues a sign-in account at the same time,",
             "This does NOT create a sign-in account.")
rc, out = run(t)
check("a claim contradicted by the form it describes is caught",
      rc == 1 and "add-user-not-signin-only" in out, out.strip()[:160])

# ---------------------------------------------------------------- code exists, text does not describe it
t = sandbox()
s = (t / "oms.html").read_text(encoding="utf-8")
# strip every mention of the word from descriptive text, leaving the field in place
cut = s.find("const OMS_REV_LOG")
head, tail = s[:cut], s[cut:]
head = head.replace("waiting on", "REMOVED-FROM-TEXT")
(t / "oms.html").write_text(head + tail, encoding="utf-8")
rc, out = run(t)
check("a field with no description left is caught",
      rc == 1 and "task-dependency-is-described" in out, out.strip()[:160])

t = sandbox()
s = (t / "oms.html").read_text(encoding="utf-8")
cut = s.find("const OMS_REV_LOG")
head, tail = s[:cut], s[cut:]
head = head.replace("every event AND task", "every event")
(t / "oms.html").write_text(head + tail, encoding="utf-8")
rc, out = run(t)
check("understating a rename's blast radius is caught",
      rc == 1 and "category-rename-moves-tasks" in out, out.strip()[:160])

# ---------------------------------------------------------------- stale bindings
t = sandbox()
set_manifest(t, [{"id": "guards-nothing", "code": "function thisWasDeletedLongAgo(",
                  "requires_text": "anything", "why": "x"}])
rc, out = run(t)
check("a binding whose code is gone is reported STALE",
      rc == 1 and "STALE" in out, out.strip()[:160])

# ---------------------------------------------------------------- manifest integrity
t = sandbox()
set_manifest(t, [])
rc, out = run(t)
check("an empty manifest fails rather than passing vacuously", rc == 1, out.strip()[:120])

t = sandbox()
(t / "test/text-claims.json").write_text("{not json", encoding="utf-8")
rc, out = run(t)
check("an unparseable manifest fails", rc == 1, out.strip()[:120])

t = sandbox()
os.remove(t / "test/text-claims.json")
rc, out = run(t)
check("a missing manifest fails rather than skipping", rc == 1, out.strip()[:120])

t = sandbox()
set_manifest(t, [{"id": "nonsense", "why": "neither direction given"}])
rc, out = run(t)
check("a malformed binding fails", rc == 1 and "malformed" in out, out.strip()[:120])

# ---------------------------------------------------------------- history is not policed
t = sandbox()
s = (t / "oms.html").read_text(encoding="utf-8")
cut = s.find("const OMS_REV_LOG")
s = s[:cut] + s[cut:].replace("OMS_REV_LOG=[", "OMS_REV_LOG=[\n  {rev:99,date:'2026-01-01',summary:'Single-click a cell to cycle status was removed.'},", 1)
(t / "oms.html").write_text(s, encoding="utf-8")
rc, out = run(t)
check("the revision log may describe removed behaviour without failing",
      rc == 0, "history is preserved verbatim and must not be policed: " + out.strip()[:110])

print()
print("=" * 56)
print("TEXT-CLAIMS GATE: %d passed, %d failed" % (passed, failed))
print("=" * 56)
sys.exit(1 if failed else 0)
