#!/usr/bin/env python3
"""Mutation control for the Rev 74 export-date-range guards in test/smoke.mjs.

Rev 74 (OMS-026) gave the Export button on Tasks, Calendars, SOPs and Cadence a
date range, and the interface now makes four claims that only a check can keep
true. Three of them are claims about what OMS does NOT do, which is the kind
worth exactly as much as a check that would notice it starting to:

  - with no range chosen, nothing is filtered at all, undated rows included
  - the Admin directory has no range, because a person record has no date
  - the range is held in memory only; a reload does not crop tomorrow's export
  - a range that matches nothing refuses rather than writing a header-only file

The smoke suite carries those checks. This proves they bind, by breaking the
artifact seven ways and requiring each break to be caught. A check that cannot
fail is the failure this project already had in gate check 4, and again in Rev
67 where the focus guard passed for the wrong reason.

Run:  python3 test/export_range_negative.py
Exit 0 if every mutant was caught, 1 if any survived, 2 if a fixture no longer
matches the artifact - which means the anchors moved and this file needs
repointing, not that the guards are gone.
"""
import io
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (name, exact anchor in oms.html, replacement, substring of the assertion that
#  must fail). Each mutant is a plausible future edit, not a nonsense one: every
#  one of them is something a reader could talk themselves into as a tidy-up.
MUTANTS = [
    ("drop the no-range guard from omsRangeSplit",
     "  if(!omsExportRangeActive())return {rows:rows,outside:0,undated:0};\n",
     "",
     "with no range chosen the export is unchanged"),
    ("match the calendar on the start date alone",
     "omsRangeSplit(omsCalItems().filter(e=>e&&e.date),e=>e.date||'',"
     "e=>{const en=calEventEnd(e);return en?isoDate(en):String(e.date||'')})",
     "omsRangeSplit(omsCalItems().filter(e=>e&&e.date),e=>e.date||'')",
     "a multi-day event overlapping the range is exported"),
    ("wire the Directory to the range dialog",
     'onclick="omsExportPeople()"',
     "onclick=\"omsExportRangeDialog('Directory')\"",
     "the Directory, which has no date, still exports at once"),
    ("stop openModal restoring the shared footer",
     "const _mft=document.getElementById('mft');if(_mft)_mft.style.display='';",
     "",
     "the next dialog gets the footer back"),
    ("drop the empty-range refusal",
     "  if(cut&&omsExportRangeActive()&&!rows.length){",
     "  if(false){",
     "refuses instead of writing a header-only file"),
    ("start persisting the range",
     "function omsExportRangeActive(){return !!(_expRange.start||_expRange.end)}",
     "function omsExportRangeActive(){localStorage.setItem('cao_oms_xr',"
     "JSON.stringify(_expRange));return !!(_expRange.start||_expRange.end)}",
     "the range is held in memory only"),
    ("stop the Cadence range picking month columns",
     "  const mi=omsExportRangeMonths();",
     "  const mi=MNA.map((m,i)=>i);",
     "the Cadence range writes only the month columns it spans"),
]


def node_binary():
    for c in (os.path.join("C:" + os.sep, "Program Files", "nodejs", "node.exe"), "node"):
        if c == "node" or os.path.exists(c):
            return c
    return "node"


def main():
    raw = io.open(os.path.join(ROOT, "oms.html"), encoding="utf-8", newline="").read()
    node = node_binary()
    bad = 0

    for name, old, new, expect in MUTANTS:
        if raw.count(old) != 1:
            print("FIXTURE BROKEN: %r appears %d times in oms.html, expected 1"
                  % (old[:60], raw.count(old)))
            return 2
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "test"), exist_ok=True)
        io.open(os.path.join(d, "oms.html"), "w", encoding="utf-8", newline="").write(
            raw.replace(old, new, 1))
        # index.html as well as the suite: smoke.mjs reads it from the
        # artifact's own directory, and without it every run dies on ENOENT,
        # which reads as a broken control rather than a missing file.
        for rel in ("index.html", "test/smoke.mjs"):
            io.open(os.path.join(d, rel), "w", encoding="utf-8", newline="").write(
                io.open(os.path.join(ROOT, rel), encoding="utf-8", newline="").read())
        try:
            r = subprocess.run([node, "test/smoke.mjs", "oms.html"], cwd=d,
                               capture_output=True)
        except OSError as e:
            print("CANNOT RUN NODE (%s) - this control needs it" % e)
            return 2
        fails = [l for l in r.stdout.decode("utf-8", "replace").splitlines()
                 if l.startswith("FAIL")]
        caught = any(expect in l for l in fails)
        bad += 0 if caught else 1
        print("%-4s %-46s -> %d failure(s)%s"
              % ("PASS" if caught else "FAIL", name, len(fails),
                 "" if caught else "   EXPECTED one mentioning: " + expect))
        for l in fails[:3]:
            print("        " + l[:120])

    print("\nOMS-026 MUTATION CONTROL: %d mutant(s), %d not caught" % (len(MUTANTS), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
