#!/usr/bin/env python3
"""Release gate check 13: CLAUDE.md must not hand-write counts.

Standing instruction, 6 Sept 2026, after CLAUDE.md claimed 268 assertions and
11 gate checks on a day the suite passed 401 and ran 12. It had been wrong
twice in two days, both times within hours of a release.

Re-syncing the numbers was the obvious fix and the wrong one. A count written
in prose is a fact with no owner: no test covers it, no reader can tell a stale
number from a current one, and it drifts silently every time the thing it
describes grows. Check 12 exists because descriptive text drifted from code in
oms.html; this is the same failure in the file that states the rule.

So the numbers are deleted rather than corrected, and this check keeps them out.
The command prints the truth on demand; prose does not get to remember it.

WHAT THIS DOES NOT FLAG
-----------------------
History. "58 of 85 concluded runs were failing" and "gw went from 8 rows to 9"
are statements about events that already happened - they cannot go stale, and
losing them would cost real institutional memory. Only counts that describe the
CURRENT size or shape of the tooling are flagged, which is why the patterns
below are narrow and name their unit.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
TARGET = ROOT / "CLAUDE.md"

# Each pattern names a unit whose live value is printed by a command. Anything
# vaguer is left alone: a guard with false positives gets disabled, and a
# disabled guard is worth less than no guard.
PATTERNS = [
    (r"\b\d+\s+assertions?\b",              "node test/smoke.mjs oms.html"),
    (r"\b\d+\s+checks?\b(?!\s+the)",        "./scripts/release_gate.sh HEAD"),
    (r"\b\d+\s+preflight\b",                "./scripts/release_gate.sh HEAD"),
    (r"~\s*\d+\s*[KM]B\b",                  "wc -c oms.html"),
    (r"~\s*\d+\s+lines\b",                  "wc -l on the file itself"),
    (r"\b\d+\s+bindings?\b",                "python3 scripts/text_claims.py"),
]


def main():
    if not TARGET.exists():
        print("FAIL  CLAUDE.md not found - check 13 cannot run")
        return 1

    text = TARGET.read_text(encoding="utf-8")
    lines = text.splitlines()

    # The check's own explanation of the failure quotes the numbers that caused
    # it. Skip the paragraph that says so, or the guard fails on the sentence
    # justifying the guard - the same self-reference that made the en-GB word
    # list check for the correct spelling.
    findings = []
    for i, line in enumerate(lines, 1):
        if "deliberately" in line and "No counts are written in this file" in line:
            continue
        for pat, how in PATTERNS:
            for m in re.finditer(pat, line):
                findings.append((i, m.group(0).strip(), how))

    for ln, hit, how in findings:
        print("FAIL  CLAUDE.md:%d writes a count: %r" % (ln, hit))
        print("      Delete it. Anyone who needs the number runs: %s" % how)

    if findings:
        print("      A count in prose is a fact with no owner. This file has been")
        print("      wrong twice in two days by keeping one.")

    print("HANDWRITTEN COUNTS: %d found" % len(findings))
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
