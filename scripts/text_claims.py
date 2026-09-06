#!/usr/bin/env python3
"""Release gate check 12: descriptive text must be backed by the code.

Standing instruction, 6 Sept 2026. Nothing in the gate tied a tooltip, a User
Guide line or an on-screen instruction to the behaviour it describes, so text
drifted away from code silently and stayed wrong until somebody happened to
read it. In one day that produced:

  - a tooltip still instructing "Single-click a cell to cycle status", the exact
    action removed in Rev 14 because it WAS the OMS-003 defect
  - a control promising "user must set a new password on next login" that
    changed no credential at all
  - task tooltips listing the fields on a form, two revisions after two more
    fields were added
  - a guide contradicting itself on the same page
  - a note in a script saying a forced password change could not be enforced,
    an hour after it was made enforceable

The guide hash check proves the guide CHANGED. It cannot prove it became true.
This does, for claims that are declared.

    test/text-claims.json holds the bindings. Two directions:

      {"text": "...", "requires_code": "..."}
        If the text appears, the code MUST. A claim the code does not support
        is a lie in the interface.

      {"code": "...", "requires_text": "..."}
        If the code appears, the text MUST. A capability nobody described is a
        feature users will not find, and a field no tooltip lists is a tooltip
        that has gone stale.

      {"text": "...", "forbids_code": "..."}
        If the text appears, the code must NOT. For a claim that is only true
        while something is absent - "issued separately, through the gateway"
        stopped being true the moment the client could issue one itself.

Text is searched OUTSIDE the revision log, which is history and is deliberately
never rewritten. Code is searched ANYWHERE - including comments and the log.

That last point is a trap, and it has already sprung once: the binding for the
deleted temp-password control named the bare identifier `adminGenTempPw`, which
the Rev 29 comment recording its deletion also contains. The guard was satisfied
by the note explaining that nothing implements it. Binding values on the code
side must therefore be CODE-SHAPED - `function foo(`, `id="bar"`, an actual call
- never a bare name that prose about the code would also contain. The negative
suite is what caught it; keep feeding it real drift.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / "oms.html"
MANIFEST = ROOT / "test/text-claims.json"

failures = []
stale = []
checked = 0


def main():
    global checked
    if not ARTIFACT.exists():
        print("FAIL  oms.html not found"); return 1
    if not MANIFEST.exists():
        print("FAIL  test/text-claims.json not found - check 12 cannot run"); return 1

    html = ARTIFACT.read_text(encoding="utf-8")
    try:
        claims = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except Exception as exc:
        print("FAIL  test/text-claims.json does not parse: %s" % exc); return 1
    if not isinstance(claims, list) or not claims:
        print("FAIL  test/text-claims.json must be a non-empty list"); return 1

    # History is preserved verbatim, so a phrase retired from the interface may
    # legitimately survive in the revision log describing its own removal.
    cut = html.find("const OMS_REV_LOG")
    end = html.find("];", cut) if cut > -1 else -1
    prose = (html[:cut] + html[end:]) if cut > -1 and end > -1 else html

    for c in claims:
        cid = c.get("id", "(unnamed)")
        why = c.get("why", "")
        checked += 1

        if "text" in c and "forbids_code" in c:
            if c["text"] in prose and c["forbids_code"] in html:
                failures.append((cid,
                    'the interface says %r, which is only true while %r is absent - and it is present'
                    % (c["text"][:55], c["forbids_code"][:45]), why))
            continue

        if "text" in c:
            present = c["text"] in prose
            needed = c["requires_code"]
            if present and needed not in html:
                failures.append((cid,
                    'the interface says %r but %r is not in the code' % (c["text"][:60], needed[:60]), why))
            continue

        if "code" in c:
            if c["code"] not in html:
                stale.append((cid, 'the code it guards (%r) is gone' % c["code"][:60]))
                continue
            needed = c["requires_text"]
            if needed not in prose:
                failures.append((cid,
                    'the code has %r but nothing describes it (%r missing)' % (c["code"][:50], needed[:50]), why))
            continue

        failures.append((cid, "malformed binding: needs text+requires_code, text+forbids_code, or code+requires_text", ""))

    for cid, msg, why in failures:
        print("FAIL  %s - %s" % (cid, msg))
        if why:
            print("      %s" % why)
    # A binding whose code has been deleted guards nothing, and a manifest full
    # of dead rules is how this whole mechanism would quietly stop working.
    for cid, msg in stale:
        print("FAIL  %s is STALE - %s. Remove it or repoint it." % (cid, msg))

    total = len(failures) + len(stale)
    print("TEXT CLAIMS: %d checked, %d failed" % (checked, total))
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
