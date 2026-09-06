#!/usr/bin/env python3
"""Negative control for gate check 14.

A gate that only ever passes is the failure this project already had once, in
check 4, and again in the Rev 35 smoke assertion that certified the very
condition disabling the reconciler. So feed check 14 the real defect and
confirm it fails, and feed it legitimate content and confirm it does not.

The real defect is reproduced exactly: a literal NUL inside a JavaScript string
used as a separator, which is what Rev 37 shipped into oms.html and what the
whole gate, the 505-assertion smoke suite included, passed without noticing.

Run:  python3 test/no_control_bytes_negative.py
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/no_control_bytes.py"

passed = failed = 0


def case(name, mutate, expect_fail):
    """Build a throwaway tree, apply `mutate` to it, run check 14 there."""
    global passed, failed
    work = pathlib.Path(tempfile.mkdtemp(prefix="ctlbytes-"))
    (work / "scripts").mkdir()
    (work / "test").mkdir()
    shutil.copy(CHECK, work / "scripts/no_control_bytes.py")
    for f in ("oms.html", "index.html"):
        if (ROOT / f).exists():
            shutil.copy(ROOT / f, work / f)
    if (ROOT / "test/text-claims.json").exists():
        shutil.copy(ROOT / "test/text-claims.json", work / "test/text-claims.json")

    mutate(work)
    r = subprocess.run([sys.executable, "scripts/no_control_bytes.py"], cwd=work,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    caught = r.returncode != 0
    good = caught == expect_fail
    print(("PASS  " if good else "FAIL  ") + name +
          ("" if good else "  — expected %s, got exit %d" %
           ("a failure" if expect_fail else "a pass", r.returncode)))
    if good:
        passed += 1
    else:
        failed += 1
        for line in (r.stdout or "").strip().splitlines()[-4:]:
            print("        " + line)


def poke(rel, old, new):
    """Byte-level substitution inside a file in the throwaway tree."""
    def go(work):
        p = work / rel
        b = p.read_bytes()
        assert old in b, "anchor %r not present in %s" % (old[:30], rel)
        p.write_bytes(b.replace(old, new, 1))
    return go


print("# Gate check 14 must catch a real control byte, and only a real one\n")

case("the unmodified artifacts pass", lambda w: None, expect_fail=False)

# THE ACTUAL DEFECT: Rev 37 wrote a literal NUL where the two-character escape was intended.
case("a literal NUL inside a JavaScript string is caught",
     poke("oms.html", b".join('\\u0000')", b".join('\x00')"), expect_fail=True)

case("a NUL anywhere else in the artifact is caught",
     poke("oms.html", b"<title>", b"<ti\x00tle>"), expect_fail=True)

case("a NUL in index.html is caught",
     poke("index.html", b"<title>", b"<ti\x00tle>"), expect_fail=True)

case("a NUL in the check-12 manifest is caught",
     poke("test/text-claims.json", b'"id"', b'"i\x00d"'), expect_fail=True)

# CRLF is the same policy from the other end, and is how the artifact hash
# stops matching the release note on a fresh Windows clone.
case("a single CRLF is caught",
     poke("oms.html", b"<title>", b"\r\n<title>"), expect_fail=True)

case("a whole file converted to CRLF is caught",
     lambda w: (w / "oms.html").write_bytes((w / "oms.html").read_bytes().replace(b"\n", b"\r\n")),
     expect_fail=True)

# Other C0 characters that have no business in a shipped artifact.
case("a vertical tab is caught",
     poke("oms.html", b"<title>", b"\x0b<title>"), expect_fail=True)
case("a form feed is caught",
     poke("oms.html", b"<title>", b"\x0c<title>"), expect_fail=True)
case("an escape character is caught",
     poke("oms.html", b"<title>", b"\x1b[31m<title>"), expect_fail=True)
case("a DEL is caught",
     poke("oms.html", b"<title>", b"\x7f<title>"), expect_fail=True)

# ...and the things that must NOT trip it.
case("tabs are left alone",
     poke("oms.html", b"<title>", b"\t<title>"), expect_fail=False)
case("newlines are left alone",
     poke("oms.html", b"<title>", b"\n\n<title>"), expect_fail=False)
case("the two-character escape \\u0000 in source is left alone",
     poke("oms.html", b"<title>", b"<title>/*\\u0000*/"), expect_fail=False)
case("multi-byte UTF-8 is left alone",
     poke("oms.html", b"<title>", "<title>— • ’ é 中".encode("utf-8")), expect_fail=False)
case("a missing file is skipped rather than failing",
     lambda w: (w / "index.html").unlink(), expect_fail=False)

print("\n" + "=" * 56)
print("CONTROL-BYTE GUARD: %d passed, %d failed" % (passed, failed))
print("=" * 56)
sys.exit(1 if failed else 0)
