#!/usr/bin/env python3
"""Release gate check 12: descriptive text must be backed by the code.

Standing instruction, 6 Sept 2026. Nothing in the gate tied a tooltip, a User
Guide line or an on-screen instruction to the behavior it describes, so text
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

      {"code": "...", "requires_text": "...", "reachable_from": ["fn", ...]}
        As above, and the symbol must additionally APPEAR INSIDE each named
        function. Existence is not reachability: Rev 34 shipped an Add note
        control on the SOP dialog only, while the guide described it in general
        terms, and this check passed. Add reachable_from to any claim whose text
        is unscoped - "notes", "tasks", "any record" - and name the forms the
        sentence is promising it on.

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



# --------------------------------------------------------------- reachability
# Check 12 asks whether a symbol EXISTS. That is not the same question as
# whether a user can get to the behavior, and the difference is not academic:
# at Rev 34 the User Guide said, unscoped, "Notes are added to, not typed over.
# Use Add note...", the control existed at exactly one offset in the artifact -
# inside the SOP dialog - and this check reported 27 claims, 0 failures. Rev 35
# added the second call site by hand and wrote a one-off assertion for it.
#
# Orphaning proves the general case. Take any of the bindings that name a
# function definition, leave the definition exactly where it is and rename every
# reference to it, and check 12 misses it every time - 13 of 13 when this was
# measured, and the whole local gate, 458 smoke assertions included, missed 10
# of those 13. `reachable_from` is the declarable version of the assertion Rev
# 35 wrote by hand.
def _function_source(html, name):
    """The source of a top-level `function name(...)`, brace-matched.

    String- and comment-aware enough for this artifact, which is minified in
    places and holds template literals containing braces. Returns None when the
    function is not defined at all - the caller reports that as STALE, the same
    as any other binding whose code has gone.
    """
    start = html.find("function %s(" % name)
    if start < 0:
        return None
    i = html.find("{", start)
    if i < 0:
        return None
    depth, j, instr = 0, i, None
    while j < len(html):
        ch = html[j]
        if instr:
            if ch == "\\":
                j += 2
                continue
            if ch == instr:
                instr = None
        elif ch in "'\"`":
            instr = ch
        elif ch == "/" and html[j + 1:j + 2] == "*":
            k = html.find("*/", j)
            j = (k + 2) if k > -1 else len(html)
            continue
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return html[start:j + 1]
        j += 1
    return html[start:]


def _references(source, symbol):
    """Does `source` actually reference `symbol`?

    Substring matching is wrong here and the negative suite caught it: the
    string "omsSortTasks" is present inside "ORPHANED_omsSortTasks", inside
    "omsSortTasksLegacy", and inside any other identifier that merely contains
    it. A rename is the commonest way for a call site to stop being a call
    site, so a check that cannot see a rename cannot see the thing it exists
    for.

    So an identifier-shaped symbol is matched on identifier boundaries. A
    symbol that is not identifier-shaped - id="f_note_add", an attribute, a
    fragment of a call - has no such boundaries and is matched verbatim.
    """
    if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", symbol):
        return re.search(r"(?<![A-Za-z0-9_$])" + re.escape(symbol) + r"(?![A-Za-z0-9_$])",
                         source) is not None
    return symbol in source


def _symbol_for(binding):
    """What must appear inside each `reachable_from` function.

    Defaults to the identifier in a `function foo(` binding, which is the shape
    that matters: a definition can sit in the artifact with nothing calling it.
    Anything else - an id="..." for instance - is searched verbatim.
    """
    explicit = binding.get("symbol")
    if explicit:
        return explicit
    code = binding.get("code", "")
    m = re.match(r"^function (\w+)\($", code)
    return m.group(1) if m else code


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
            # Existence satisfied. Now: can anybody GET to it?
            for host in c.get("reachable_from", []):
                src = _function_source(html, host)
                if src is None:
                    stale.append((cid, 'reachable_from names %r, which is not a function in the artifact' % host))
                    continue
                symbol = _symbol_for(c)
                if not _references(src, symbol):
                    failures.append((cid,
                        'the code exists but %r does not reach it - %r is not in %s()'
                        % (host, symbol[:40], host), why))
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
