#!/usr/bin/env python3
"""Probe: does gate check 12 bind CLAIMS to REACHABLE behavior, or only to the
existence of a string somewhere in the artifact?

Method. For every code-side binding in test/text-claims.json that names a
function definition, orphan that function: leave the definition exactly where
it is, and remove every CALL to it. The interface can then no longer reach the
behavior at all, while the guide goes on promising it. Run check 12 against the
mutated artifact and see whether it notices.

A gate that passes on an orphaned function cannot police reachability, only
presence. Rule 4: this is the negative control -- the old shape must fail and
the new shape pass, or neither result means anything.
"""
import json
import pathlib
import re
import subprocess
import sys
import shutil
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = pathlib.Path(r"C:\dev\CAO-OMS")
html = (REPO / "oms.html").read_text(encoding="utf-8")
claims = json.loads((REPO / "test/text-claims.json").read_text(encoding="utf-8"))

FUNC = re.compile(r"^function (\w+)\($")

targets = []
for c in claims:
    tok = c.get("code") or c.get("requires_code") or ""
    m = FUNC.match(tok)
    if m:
        targets.append((c.get("id"), m.group(1), tok))

print("bindings that name a function DEFINITION: %d of %d\n" % (len(targets), len(claims)))

work = pathlib.Path(tempfile.mkdtemp(prefix="reach-"))
(work / "scripts").mkdir()
(work / "test").mkdir()
shutil.copy(REPO / "scripts/text_claims.py", work / "scripts/text_claims.py")
shutil.copy(REPO / "test/text-claims.json", work / "test/text-claims.json")

rows = []
for cid, fn, tok in targets:
    defn = "function %s(" % fn
    # every occurrence of the bare name that is NOT the definition is a
    # reference: a call, an onclick handler, an export. Neutralize them all.
    out = []
    i = 0
    calls = 0
    while True:
        j = html.find(fn, i)
        if j < 0:
            out.append(html[i:])
            break
        if html.startswith(defn, j - len("function ")):
            out.append(html[i:j + len(fn)])
            i = j + len(fn)
            continue
        out.append(html[i:j])
        out.append("ORPHANED_" + fn)   # same length class, different symbol
        i = j + len(fn)
        calls += 1
    mutated = "".join(out)
    (work / "oms.html").write_text(mutated, encoding="utf-8")
    r = subprocess.run([sys.executable, "scripts/text_claims.py"], cwd=work,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    verdict = "CAUGHT" if r.returncode else "passed"
    rows.append((cid, fn, calls, verdict))
    print("%-38s %-26s refs removed: %-3d  check 12: %s" % (cid, fn, calls, verdict))

print()
missed = [r for r in rows if r[3] == "passed" and r[2] > 0]
print("orphaned functions that check 12 did NOT catch: %d of %d"
      % (len(missed), len([r for r in rows if r[2] > 0])))
