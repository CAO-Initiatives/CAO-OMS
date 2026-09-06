#!/usr/bin/env python3
"""Release gate check 14: no stray control bytes in a shipped artifact.

Written 6 September 2026, after a defect I introduced and caught by accident.

The Rev 37 edit put a literal NUL byte into oms.html where the two-character
escape \\u0000 was intended, as a separator inside a JavaScript string. It was
functionally harmless - a NUL is a legal character in a JS string, the page
worked, every test passed, and the release gate passed.

What it was not harmless for is git. Git decides a file is BINARY by looking for
a NUL byte in the first 8000 bytes, and a binary file gets no end-of-line
normalization at all. So the moment that byte landed, the `* text=auto eol=lf`
policy in .gitattributes silently stopped applying to the one file it exists to
protect - the file whose SHA-256 is quoted in every release note, checked by
verify_live.sh against the deployed artifact, and used as the rollback baseline.
CLAUDE.md devotes a section to exactly this failure and it still happened.

It was caught because `grep` started printing "Binary file oms.html matches" on
an unrelated command. That is not a control; that is luck.

So: no C0 control characters in a shipped artifact except tab and newline, and
no carriage returns, which are the same policy read from the other end. Both are
cheap to check and neither has a legitimate exception here - a genuine control
character in user-facing text belongs as an escape in the source, which is what
the Rev 37 edit was supposed to be.

Run:  python3 scripts/no_control_bytes.py
Exit: 0 clean, 1 one or more findings.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

# The deployed artifacts, plus the files the gate itself reads. A stray control
# byte in the manifest would break check 12 in a way that looks like a claim
# failure rather than an encoding fault.
TARGETS = [
    "oms.html",
    "index.html",
    "test/text-claims.json",
]
TARGETS += sorted(str(p.relative_to(ROOT)).replace("\\", "/") for p in (ROOT / "data").glob("*.json")) \
    if (ROOT / "data").is_dir() else []

ALLOWED = {0x09, 0x0A}          # tab, newline
CR = 0x0D

failures = []
checked = 0


def describe(data, index):
    """A readable window around the offending byte, control bytes escaped."""
    lo, hi = max(0, index - 45), min(len(data), index + 45)
    out = []
    for i in range(lo, hi):
        b = data[i]
        if i == index:
            out.append("<<0x%02X>>" % b)
        elif b in ALLOWED:
            out.append(" ")
        elif b < 0x20 or b == 0x7F:
            out.append("\\x%02x" % b)
        else:
            out.append(chr(b) if b < 0x7F else ".")
    line = data.count(b"\n", 0, index) + 1
    return line, "".join(out)


def main():
    global checked
    for name in TARGETS:
        path = ROOT / name
        if not path.exists():
            continue
        checked += 1
        data = path.read_bytes()

        bad = [i for i, b in enumerate(data) if (b < 0x20 or b == 0x7F) and b not in ALLOWED and b != CR]
        crs = [i for i, b in enumerate(data) if b == CR]

        if not bad and not crs:
            print("PASS  %s clean (%d bytes)" % (name, len(data)))
            continue

        if bad:
            failures.append(name)
            first = bad[0]
            line, window = describe(data, first)
            print("FAIL  %s holds %d control byte(s), first 0x%02X at offset %d (line %d)"
                  % (name, len(bad), data[first], first, line))
            print("      %s" % window)
            if data[first] == 0:
                print("      A NUL makes git treat this file as BINARY, which silently turns off")
                print("      the eol=lf normalization .gitattributes exists to enforce. Write the")
                print("      escape (\\u0000) in the source rather than the byte itself.")
        if crs:
            failures.append(name)
            line, _ = describe(data, crs[0])
            print("FAIL  %s holds %d carriage return(s), first at line %d"
                  % (name, len(crs), line))
            print("      .gitattributes pins LF in the working tree: release.sh hashes this file")
            print("      and scripts/*.sh fail in Git Bash under CRLF.")

    print("\nCONTROL BYTES: %d file(s) checked, %d with findings" % (checked, len(set(failures))))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
