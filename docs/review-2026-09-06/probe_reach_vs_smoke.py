#!/usr/bin/env python3
"""Adversarial follow-up to probe_reachability.py.

Check 12 missing an orphaned function only matters if nothing ELSE in the gate
catches it. The gate runs 13 numbered checks, a 31-assertion preflight and a
458-assertion behavioral smoke suite. So: orphan each function again, and this
time run the WHOLE local gate -- smoke first, then the numbered checks.

Reported per function: does smoke catch it, does the gate catch it, does 12.
"""
import json
import pathlib
import re
import shutil
import subprocess
import sys
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
        targets.append((c.get("id"), m.group(1)))

work = pathlib.Path(tempfile.mkdtemp(prefix="reach2-"))
for sub in ("scripts", "test"):
    (work / sub).mkdir()
shutil.copy(REPO / "scripts/text_claims.py", work / "scripts/text_claims.py")
shutil.copy(REPO / "test/text-claims.json", work / "test/text-claims.json")
shutil.copy(REPO / "test/smoke.mjs", work / "test/smoke.mjs")

NODE = r"C:\Program Files\nodejs\node.exe"


def orphan(fn):
    defn = "function %s(" % fn
    out, i, n = [], 0, 0
    while True:
        j = html.find(fn, i)
        if j < 0:
            out.append(html[i:]); break
        if html.startswith(defn, j - len("function ")):
            out.append(html[i:j + len(fn)]); i = j + len(fn); continue
        out.append(html[i:j]); out.append("ORPHANED_" + fn)
        i = j + len(fn); n += 1
    return "".join(out), n


print("%-38s %-24s %-6s %-10s %-10s" % ("binding", "function", "refs", "check 12", "smoke"))
print("-" * 94)
missed_by_both = []
for cid, fn in targets:
    mutated, n = orphan(fn)
    (work / "oms.html").write_text(mutated, encoding="utf-8")

    r12 = subprocess.run([sys.executable, "scripts/text_claims.py"], cwd=work,
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    rsm = subprocess.run([NODE, "test/smoke.mjs", "oms.html"], cwd=work,
                         capture_output=True, text=True, encoding="utf-8", errors="replace")

    v12 = "CAUGHT" if r12.returncode else "passed"
    tail = [l for l in (rsm.stdout or "").splitlines() if "SMOKE:" in l]
    vsm = "CAUGHT" if rsm.returncode else "passed"
    detail = tail[-1].strip() if tail else (rsm.stderr or "").strip()[:60]
    print("%-38s %-24s %-6d %-10s %-10s  %s" % (cid, fn, n, v12, vsm, detail))
    if v12 == "passed" and vsm == "passed" and n > 0:
        missed_by_both.append((cid, fn, n))

print()
print("orphaned and caught by NOTHING: %d" % len(missed_by_both))
for cid, fn, n in missed_by_both:
    print("   %-38s %-24s (%d references removed)" % (cid, fn, n))
