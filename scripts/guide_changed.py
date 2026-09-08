#!/usr/bin/env python3
"""Gate check 7. Did the embedded User Guide actually change?

The check this replaces grepped the diff for added lines containing
`guide-wrap`, `guide-hero` or `guide-sec`. Those strings appear only in the
STRUCTURAL markup, which lives on two enormous lines, so:

  * adding a sentence to a guide section - the ordinary way the guide is
    edited, since every section's content is an array of strings passed to
    guideSec() - matched nothing and was reported as "the User Guide was NOT
    updated". Rev 72 hit exactly that: a new line in the Notifications
    section, invisible to the check.
  * meanwhile any edit that happened to touch one of those two long lines
    counted, whatever it changed.

So the check both blocked real guide edits and could be satisfied without
making one. It now compares the guide's SOURCE REGION between the baseline
artifact and the working one, which is what "the guide changed" means.

The region runs from `function guideSec(` to the END of `function rGuide(`.
There are TWO builders and both must be inside it: guideFor() builds the
editor and viewer guide, and rGuide() builds the admin one from its own _gh
template. An earlier cut of this check ended the region at the start of
rGuide and so could not see an edit to the admin guide at all.

The end is rGuide's own closing brace, found by brace matching with the same
`blank_out` / `function_span` pair gate check 15 uses, so strings, comments,
regexes and template literals cannot throw the count off. Scanning instead for
the next line-initial `function ` over-ran by about 3,400 characters into
`openEvModal`, because the declarations after rGuide do not start their lines:
editing the event dialog alone then reported "User Guide updated".

If the region cannot be located in either file this exits FAIL, not pass. A
refactor that renames those functions must be noticed, not silently skipped -
that is the failure mode check 4 already had once.

Usage:  guide_changed.py <baseline.html> <candidate.html>
Exit 0  the guide region differs
Exit 1  it is byte-identical, or could not be located
"""
import hashlib
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from no_focus_losing_inputs import blank_out, function_span  # noqa: E402

START = "function guideSec("
LAST = "function rGuide("


def region(path):
    try:
        s = io.open(path, encoding="utf-8", newline="").read()
    except OSError as e:
        return None, "cannot read %s: %s" % (path, e)
    # Normalized BEFORE the markers are located, not after the region is cut.
    # The baseline comes out of git with LF and the candidate is read from the
    # working tree; if the tree ever held CRLF - which check 14 rejects, but
    # which runs later and separately - every line would differ and this check
    # would pass without a word of the guide having changed. Normalizing after
    # the cut is not enough either: the end marker is found at "\nfunction",
    # which in a CRLF file leaves the preceding "\r" inside the region and
    # shifts the boundary by one byte. A check that passes for the wrong
    # reason is the failure this gate was rebuilt to remove.
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    a = s.find(START)
    if a < 0:
        return None, "%s: %r not found - has the guide been renamed?" % (path, START)
    if s.find(LAST, a) < 0:
        return None, "%s: %r not found after the guide - has the admin renderer been renamed?" % (path, LAST)
    span = function_span(s, blank_out(s), "rGuide")
    if span is None:
        return None, "%s: rGuide's braces do not balance - cannot bound the guide" % path
    b = span[1]
    if b <= a:
        return None, "%s: guide region is empty" % path
    return s[a:b], None


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: guide_changed.py <baseline.html> <candidate.html>\n")
        return 1
    base, head, = argv[1], argv[2]
    rb, eb = region(base)
    rh, eh = region(head)
    for err in (eb, eh):
        if err:
            print("GUIDE REGION: %s" % err)
            return 1
    hb = hashlib.sha256(rb.encode("utf-8")).hexdigest()
    hh = hashlib.sha256(rh.encode("utf-8")).hexdigest()
    print("GUIDE REGION: baseline %d chars %s" % (len(rb), hb[:12]))
    print("GUIDE REGION: candidate %d chars %s" % (len(rh), hh[:12]))
    if hb == hh:
        print("GUIDE REGION: unchanged")
        return 1
    print("GUIDE REGION: changed (%+d chars)" % (len(rh) - len(rb)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
