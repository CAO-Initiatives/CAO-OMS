#!/usr/bin/env python3
"""Negative control for gate check 7 (scripts/guide_changed.py).

A gate that only ever passes is the failure this project already had once, in
check 4, and check 7 itself was wrong in both directions until Rev 72: it
grepped the diff for `guide-wrap|guide-hero|guide-sec`, so a sentence added to
a guide section matched nothing while any edit touching one of two very long
markup lines counted. This feeds the replacement real cases and requires the
right answer to each.

The two builders both have to be covered. guideFor() renders the editor and
viewer guide; rGuide() renders the admin guide from its own _gh template, and
an earlier cut of the check ended the region before rGuide and could not see
an admin-guide edit at all.

Run:  python3 test/guide_changed_negative.py
Exit 0 all cases behaved, non-zero otherwise.
"""
import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECK = os.path.join(ROOT, "scripts", "guide_changed.py")

# Markers, each unique in oms.html, one inside each builder and one well
# outside the guide. If a marker stops being unique the fixture says so rather
# than quietly testing nothing.
IN_GUIDE_FOR = ("Tooltips explain most buttons.", "Tooltips now explain most buttons.")
IN_R_GUIDE = ("This guide explains each screen", "This guide now explains each screen")
# Immediately AFTER the guide. The first cut of the region ran ~3,400 chars
# past rGuide's closing brace and swallowed this dialog, so an edit here
# counted as a guide edit. It is the case the control most needs.
JUST_AFTER = ("function openEvModal(", "function openEvModal( /* probe */")
OUTSIDE = ("function tasksDueSoon(days){", "function tasksDueSoon(days){ /* probe */")


def main():
    # The working tree, not HEAD. The gate is about the artifact being released,
    # and release.sh commits before CI re-runs the gate, so a HEAD-based fixture
    # would only break after the push.
    raw = io.open(os.path.join(ROOT, "oms.html"), encoding="utf-8", newline="").read()
    tmp = tempfile.mkdtemp()

    def write(name, text):
        p = os.path.join(tmp, name)
        io.open(p, "w", encoding="utf-8", newline="").write(text)
        return p

    def edit(name, pair):
        old, new = pair
        n = raw.count(old)
        if n != 1:
            print("FIXTURE BROKEN: %r appears %d times in oms.html, expected 1" % (old, n))
            sys.exit(2)
        return write(name, raw.replace(old, new, 1))

    # Existence is not location - the same lesson check 12 learned in Rev 41.
    # Without this the fixture can 'cover' guideFor with a string that lives in
    # rGuide, and a region that lost the editor guide entirely would still pass.
    gs, gf, rg = (raw.find("function guideSec("), raw.find("function guideFor("),
                  raw.find("function rGuide("))
    for label, marker, lo, hi in (
            ("IN_GUIDE_FOR", IN_GUIDE_FOR[0], gf, rg),
            ("IN_R_GUIDE", IN_R_GUIDE[0], rg, len(raw)),
            ("JUST_AFTER", JUST_AFTER[0], rg, len(raw)),
            ("OUTSIDE", OUTSIDE[0], 0, gs)):
        at = raw.find(marker)
        if not (lo <= at < hi):
            print("FIXTURE BROKEN: %s marker %r sits at %d, outside [%d, %d)"
                  % (label, marker, at, lo, hi))
            sys.exit(2)

    base = write("base.html", raw)
    cases = [
        ("identical artifacts", base, base, 1),
        ("CRLF only, no real edit", base, write("crlf.html", raw.replace("\n", "\r\n")), 1),
        ("edit inside guideFor (editor guide)", base, edit("a.html", IN_GUIDE_FOR), 0),
        ("edit inside rGuide (admin guide)", base, edit("b.html", IN_R_GUIDE), 0),
        ("edit just AFTER the guide (openEvModal)", base, edit("e.html", JUST_AFTER), 1),
        ("edit outside the guide entirely", base, edit("c.html", OUTSIDE), 1),
        ("baseline missing", os.path.join(tmp, "nope.html"), base, 1),
        ("guide renamed away", base, write("d.html", raw.replace("function guideSec(", "function gSec(")), 1),
    ]

    bad = 0
    for name, a, b, want in cases:
        r = subprocess.run([sys.executable, CHECK, a, b], capture_output=True)
        out = r.stdout.decode().strip().splitlines()
        last = out[-1] if out else "(no output)"
        ok = r.returncode == want
        bad += 0 if ok else 1
        print("%-4s %-38s exit %d (want %d)  %s"
              % ("PASS" if ok else "FAIL", name, r.returncode, want, last))

    print("\nGUIDE CHECK CONTROL: %d case(s), %d failed" % (len(cases), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
