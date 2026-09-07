#!/usr/bin/env python3
"""Gate check 15: no text input may destroy itself while somebody is typing.

THE DEFECT THIS EXISTS TO STOP.

A control whose own `oninput` handler triggers the renderer that DREW that
control is destroyed on the first keystroke. `innerHTML=` throws the element
away and builds a new one, the browser has nothing to keep focus on, focus
falls to <body>, and every character after the first is typed into nothing.
The user sees a search box that accepts exactly one letter.

WHY A CHECK AND NOT JUST A FIX. Rev 12 shipped "preserve search focus" for the
calendar box and it was correct. It was also a POINT FIX: the Tasks box and the
SOPs box had the identical defect, were never touched, and nothing anywhere
could notice, because no assertion, no text claim and no gate check mentioned
focus. The fix sat beside two live instances of the bug it fixed for fifty-odd
revisions, and a fourth box was added in Rev 65 with nothing to check it
against. This check is not the repair - Rev 67 was - it is what makes the next
one impossible.

WHY THE MECHANISM IS CONSTRAINED TOO. Rev 12 restored focus inside a
`requestAnimationFrame` callback. That is deferred to a later task, which fails
three separate ways: it loses any keystroke arriving inside the gap, it never
runs while the tab is hidden or throttled (verified 7 Sept 2026 - a hidden tab
fires no frame callbacks, so the box stays dead indefinitely), and
`test/smoke.mjs` stubs `requestAnimationFrame` to a no-op in both sandboxes, so
the suite could not have exercised it even if somebody had written the
assertion. A SYNCHRONOUS restore, inside the same event handler, has none of
those problems: JavaScript is single threaded, so the next keystroke cannot be
delivered until the handler returns and focus is already back.

HOW CONTAINMENT IS DECIDED. The question "is this control inside the thing that
gets replaced" is answered from the artifact text, not guessed: a control is
at risk when its markup is EMITTED FROM INSIDE a renderer's own source - the
renderer literally builds that `<input>` - and the control's handler then
triggers that same renderer. That is precisely the shape of every screen here:
`rTasks()` writes the Tasks toolbar, search box included, into `#tasks`. A
control that no renderer emits (the header search, which lives in the static
body and paints a sibling panel) is not at risk and is not asked to prove
anything.

    python3 scripts/no_focus_losing_inputs.py [--file PATH]

--file is honoured, not ignored. `scripts/text_claims.py` once accepted a path
and silently checked the repository's own artifact instead, so a negative
control run against a deliberately broken copy reported it clean. The negative
suite for this check drives it entirely through --file, so the same mistake
here would show up as fixtures that refuse to fail.
"""
import argparse
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT = os.path.join(REPO, "oms.html")

HELPER = "omsRerenderKeepingCaret"

# Typed-into controls lose CHARACTERS, which is the severe form. Everything
# else redrawn by its own handler loses only FOCUS - the keyboard user is
# returned to the top of the document after every choice - which is milder but
# is the same defect and the same one-line fix, so both are in scope.
TYPING_TYPES = {"", "text", "search", "email", "url", "tel", "password", "number"}
HANDLER_ATTRS = ("oninput", "onkeyup", "onkeypress", "onkeydown", "onchange")


def blank_out(src, strings=True, comments=True):
    """Blank string literals and comments so brace matching is not fooled.

    The artifact is minified in places and full of template literals holding
    `${...}`, so a naive scan for a function's closing brace walks off the end
    of it. Characters become spaces rather than disappearing, so every offset
    in the result still lines up with the original text.
    """
    out = []
    i, n = 0, len(src)
    quote = None
    comment = None
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if comment == "line":
            out.append(c if c == "\n" else " ")
            if c == "\n":
                comment = None
            i += 1
            continue
        if comment == "block":
            if c == "*" and nxt == "/":
                comment = None
                out.append("  ")
                i += 2
                continue
            out.append("\n" if c == "\n" else " ")
            i += 1
            continue
        if quote:
            if c == "\\":
                out.append(src[i:i + 2] if not strings else "  ")
                i += 2
                continue
            if c == quote:
                quote = None
                out.append(c if not strings else " ")
                i += 1
                continue
            out.append(c if not strings else ("\n" if c == "\n" else " "))
            i += 1
            continue
        if c == "/" and nxt == "/":
            if not comments:
                out.append(c)
                i += 1
                continue
            comment = "line"
            out.append("  ")
            i += 2
            continue
        if c == "/" and nxt == "*":
            if not comments:
                out.append(c)
                i += 1
                continue
            comment = "block"
            out.append("  ")
            i += 2
            continue
        if c in "'\"`":
            quote = c
            out.append(c if not strings else " ")
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def function_span(html, blank, name):
    """(start, end) of a top-level `function name(...)`, brace matched."""
    start = html.find("function %s(" % name)
    if start < 0:
        return None
    i = blank.find("{", start)
    if i < 0:
        return None
    depth, j = 0, i
    while j < len(blank):
        ch = blank[j]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return (start, j + 1)
        j += 1
    return None


def defined_functions(html):
    return set(re.findall(r"function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(", html))


def mentions(text, symbol):
    """Does `text` name `symbol` - called, or passed as a reference?

    A reference matters as much as a call: the fix itself hands the renderer
    over as `omsRerenderKeepingCaret('task-search', rTasks)`, where `rTasks`
    is never followed by a paren. An earlier draft of this checker required
    the paren, so it skipped every control the fix had repaired and reported
    the artifact clean without examining it. The negative suite caught that.
    """
    return re.search(r"(?<![A-Za-z0-9_$.])%s(?![A-Za-z0-9_$])" % re.escape(symbol),
                     text) is not None


def open_tag_for(html, attr_pos):
    lt = html.rfind("<", 0, attr_pos)
    if lt < 0:
        return None, None
    gt = html.find(">", attr_pos)
    if gt < 0:
        return None, None
    return lt, html[lt:gt + 1]


def control_kind(tag):
    """None if this is not a form control; "typing" if characters can be lost.

    A typed-into control loses CHARACTERS, which is the severe form of the
    defect. A select or a date picker loses only FOCUS, which drops a keyboard
    user back to the top of the document after every choice. Milder, same
    cause, same one-line fix, so both are in scope. Buttons, checkboxes and
    radios hold no cursor and are not.
    """
    head = tag[1:].strip().split(None, 1)[0].lower().rstrip(">")
    if head == "textarea":
        return "typing"
    if head == "select":
        return "choice"
    if head != "input":
        return None
    m = re.search(r'\btype\s*=\s*"([^"]*)"', tag)
    t = (m.group(1).strip().lower() if m else "")
    if t in ("checkbox", "radio", "button", "submit", "reset", "hidden", "file"):
        return None
    return "typing" if t in TYPING_TYPES else "choice"


def main():
    ap = argparse.ArgumentParser(description="gate check 15: focus-preserving typing controls")
    ap.add_argument("--file", default=DEFAULT,
                    help="artifact to check (default: the repository's oms.html)")
    args = ap.parse_args()

    if not os.path.isfile(args.file):
        print("FOCUS: no such file: %s" % args.file)
        return 2
    html = open(args.file, encoding="utf-8", newline="").read()
    blank = blank_out(html)                      # brace matching
    nocomment = blank_out(html, strings=False)   # analysis: strings kept, comments gone

    names = defined_functions(html)
    spans = {}
    for name in sorted(names):
        sp = function_span(html, blank, name)
        if sp:
            spans[name] = sp

    # Renderers: functions that replace a container wholesale.
    renderers = {}
    for name, (a, b) in spans.items():
        body = html[a:b]
        if re.search(r"getElementById\(\s*['\"][A-Za-z0-9_-]+['\"]\s*\)\s*\.innerHTML\s*=", body) \
           or re.search(r"\.outerHTML\s*=", body):
            renderers[name] = (a, b)

    helper_defined = ("function %s(" % HELPER) in html
    findings = []
    checked = 0
    at_risk = 0

    for attr in HANDLER_ATTRS:
        for m in re.finditer(r'\b%s\s*=\s*"([^"]*)"' % attr, html):
            pos, tag = open_tag_for(html, m.start())
            if not tag:
                continue
            kind = control_kind(tag)
            if not kind:
                continue
            checked += 1
            handler = m.group(1)
            where = tag[:160]

            # Which renderers EMIT this control? Containment, decided from text.
            emitters = sorted(n for n, (a, b) in renderers.items() if a <= pos < b)
            if not emitters:
                continue  # nothing redraws this control; it cannot be destroyed
            at_risk += 1

            # One level of indirection: the handler may name a wrapper whose
            # body does the rendering (calSearchInput). Inline non-renderers.
            expanded = handler
            for ident in sorted(set(re.findall(r"[A-Za-z_$][A-Za-z0-9_$]*", handler))):
                if ident in spans and ident not in renderers:
                    a, b = spans[ident]
                    # Comment-free, or a code comment that merely NAMES
                    # requestAnimationFrame reads as a frame-deferred refocus.
                    # Rev 67's own "was a requestAnimationFrame refocus" note
                    # tripped exactly that while this check was being written.
                    expanded += "\n" + nocomment[a:b]

            triggered = [n for n in emitters if mentions(expanded, n)] \
                or ([n for n in emitters if mentions(expanded, "renderAll")] and emitters)
            if not triggered:
                continue  # typing here does not re-run the renderer that drew it

            if not mentions(expanded, HELPER):
                findings.append((
                    where,
                    ("typing here re-runs %s, the renderer that draws this very control, and "
                     "nothing restores focus - the element is destroyed on the first keystroke "
                     "and the rest of the word goes to the page body"
                     if kind == "typing" else
                     "using this control re-runs %s, the renderer that draws it, and nothing "
                     "restores focus - the element is replaced and the keyboard user is dropped "
                     "back to the top of the document after every choice")
                    % ", ".join(triggered),
                    "route the render through %s('<this control's id>', %s)"
                    % (HELPER, triggered[0])))
                continue

            if "requestAnimationFrame" in expanded:
                findings.append((
                    where,
                    "focus is restored inside a requestAnimationFrame callback, which is "
                    "deferred to a later task: it loses keystrokes arriving in the gap, never "
                    "runs while the tab is hidden or throttled, and is stubbed to a no-op by "
                    "test/smoke.mjs so no assertion can exercise it",
                    "restore focus synchronously through %s instead" % HELPER))
                continue

            ids = re.findall(r"%s\(\s*['\"]([^'\"]+)['\"]" % re.escape(HELPER), expanded)
            tid = re.search(r'\bid\s*=\s*"([^"]*)"', tag)
            tid = tid.group(1) if tid else ""
            if not ids:
                findings.append((where,
                                 "%s is called without a literal element id, so this check "
                                 "cannot prove it refocuses THIS control" % HELPER,
                                 "pass the control's own id as the first argument"))
            elif not tid:
                findings.append((where,
                                 "%s names id %r but this control carries no id attribute, so "
                                 "there is nothing to restore focus to" % (HELPER, ids[0]),
                                 'give the control id="%s"' % ids[0]))
            elif tid not in ids:
                findings.append((where,
                                 "%s is given id %r but this control carries id %r, so focus "
                                 "would be restored to a different element"
                                 % (HELPER, ids[0], tid),
                                 "pass this control's own id"))

    if at_risk and not helper_defined:
        findings.append(("(artifact)",
                         "function %s is not defined in the artifact" % HELPER,
                         "keep the shared synchronous focus-preserving helper"))

    for where, why, remedy in findings:
        print("FOCUS-LOSS  %s" % where)
        print("            %s" % why)
        print("            fix: %s" % remedy)

    print("FOCUS: %d control(s) checked, %d redrawn by their own handler, %d with findings"
          % (checked, at_risk, len(findings)))
    if checked == 0:
        print("FOCUS: nothing was checked, which means the scan is broken, not that the file is clean")
        return 1
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
