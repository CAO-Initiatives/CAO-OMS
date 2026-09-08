#!/usr/bin/env python3
"""Mutation control for the DEC-033 guards in test/smoke.mjs.

Rev 73 changed the SOP Owner field and the User Guide to say that OMS does not
email SOP owners at all. That is a claim about what the software does NOT do,
and a claim like that is worth only as much as a check that would notice it
starting to. The smoke suite carries those checks; this proves they bind, by
breaking the artifact four ways and requiring each break to be caught.

A check that cannot fail is the failure this project already had once, in gate
check 4, and again in Rev 67 where the focus guard passed for the wrong reason.

Run:  python3 test/sop_no_notification_negative.py
Exit 0 every mutant was caught, 1 if any survived, 2 if a fixture no longer
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
#  must fail). Each mutant is a plausible future edit, not a nonsense one.
MUTANTS = [
    ("wire a notification into the SOP save branch",
     "closeModal();save();rSOPs(); }",
     "createNotificationForTask(o,null); closeModal();save();rSOPs(); }",
     "does not reach createNotificationForTask"),
    ("read a SOP's stored address",
     "ownerId:sopPerson?sopPerson.id:'',ownerEmail:sopPerson?(sopPerson.email||''):''};",
     "ownerId:sopPerson?sopPerson.id:'',ownerEmail:sopPerson?(sopPerson.email||''):''};const _x=sopRec.ownerEmail;",
     "no notification is ever addressed from a SOP record"),
    ("drop the ambiguity guard",
     "if(sopOwner&&ownerAmbiguity(sopOwner)){alert(ownerAmbiguity(sopOwner));return}",
     "",
     "an ambiguous SOP owner is refused"),
    ("put the reminder promise back on the form",
     "OMS does not email SOP owners.",
     "no reminder can reach them.",
     "no longer promises a reminder"),
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

    print("\nDEC-033 MUTATION CONTROL: %d mutant(s), %d not caught" % (len(MUTANTS), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
