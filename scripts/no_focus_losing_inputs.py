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

--file is honored, not ignored. `scripts/text_claims.py` once accepted a path
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


_RE_KEYWORDS = ("return", "typeof", "case", "in", "of", "new", "delete",
                "void", "do", "else", "yield", "await", "throw")


def _regex_keyword(out):
    """True when the text emitted so far ends in a keyword a regex may follow."""
    tail = "".join(out[-12:])
    stripped = tail.rstrip()
    for kw in _RE_KEYWORDS:
        if stripped.endswith(kw):
            before = stripped[:-len(kw)]
            if not before or not (before[-1].isalnum() or before[-1] in "_$."):
                return True
    return False


def blank_out(src, strings=True, comments=True):
    """Blank string literals, template literals, regexes and comments.

    Everything is replaced by spaces rather than removed, so every offset in
    the result still lines up with the original text and a span measured here
    can be applied to the original.

    THIS HAS TO BE A REAL STATE MACHINE, and two rounds of wrong answers proved
    why. The artifact is one minified HTML file whose renderers are built from
    NESTED template literals - `...${canEdit?`<td>...`:''}...` - and it is full
    of regexes like .replace(/'/g,'&#39;'). A naive scanner fails on both:

      * the inner backtick reads as the END of the outer template, so the rest
        of the markup is parsed as code;
      * the apostrophe inside /'/g opens a phantom string that swallows
        everything up to the next apostrophe.

    Either one desynchronises brace counting, and brace counting is how this
    check decides which renderer draws which control. Measured on the real
    artifact before the fix: esc() brace-matched to 63,173 characters instead
    of about 150, and three unrelated functions all "ended" at the same offset.
    The check still reported zero findings, which is the dangerous part - it
    was not looking at what it claimed to be looking at.

    Interpolation braces (`${` and its closing `}`) are blanked too, so they
    never disturb the depth count; real braces inside an interpolation are
    balanced and cancel out on their own.
    """
    out = []
    i, n = 0, len(src)
    prev = ""                      # last significant char, for regex-vs-division
    comment = None                 # "line" | "block" | None
    quote = None                   # "'" | '"' | None  (simple strings)
    stack = [["code", 0]]          # frames: ["code", brace_depth] | ["tmpl", 0]

    def emit(text, blank):
        out.append((" " * len(text)) if blank else text)

    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        top = stack[-1]

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

        if quote is not None:
            if c == "\\":
                emit(src[i:i + 2], strings)
                i += 2
                continue
            if c == quote:
                quote = None
                emit(c, strings)
                prev = c
                i += 1
                continue
            out.append(("\n" if c == "\n" else " ") if strings else c)
            i += 1
            continue

        if top[0] == "tmpl":
            if c == "\\":
                emit(src[i:i + 2], strings)
                i += 2
                continue
            if c == "`":
                stack.pop()
                emit(c, strings)
                prev = "`"
                i += 1
                continue
            if c == "$" and nxt == "{":
                stack.append(["code", 0])
                out.append("  ")          # the interpolation braces never count
                prev = "{"
                i += 2
                continue
            out.append(("\n" if c == "\n" else " ") if strings else c)
            i += 1
            continue

        # ---- code context ----
        if c == "/" and nxt == "/":
            if comments:
                comment = "line"
                out.append("  ")
                i += 2
                continue
        elif c == "/" and nxt == "*":
            if comments:
                comment = "block"
                out.append("  ")
                i += 2
                continue
        elif c == "/" and (prev == "" or prev in "(,=:[!&|?{};+-*%~^<>"
                           or _regex_keyword(out)):
            j, cls, closed = i + 1, False, False
            while j < n:
                d = src[j]
                if d == "\\":
                    j += 2
                    continue
                if d == "[":
                    cls = True
                elif d == "]":
                    cls = False
                elif d == "/" and not cls:
                    closed = True
                    break
                elif d == "\n":
                    break              # a regex literal cannot span a line
                j += 1
            if closed:
                j += 1                                   # closing slash
                while j < n and src[j].isalpha():        # flags
                    j += 1
                out.append(" " * (j - i))
                prev = "/"
                i = j
                continue

        if c in "'\"":
            quote = c
            emit(c, strings)
            prev = c
            i += 1
            continue
        if c == "`":
            stack.append(["tmpl", 0])
            emit(c, strings)
            prev = "`"
            i += 1
            continue
        if c == "{":
            top[1] += 1
            out.append(c)
            prev = c
            i += 1
            continue
        if c == "}":
            if top[1] == 0 and len(stack) > 1:
                stack.pop()               # closes ${...}, back into the template
                out.append(" ")           # blanked: never counted
            else:
                top[1] -= 1
                out.append(c)
            prev = c
            i += 1
            continue

        out.append(c)
        if not c.isspace():
            prev = c
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
        # innerHTML= is how every renderer in this artifact replaces a
        # container, but it is not the only way to destroy a child element, and
        # a guard that knows only today's idiom is a guard with an expiry date.
        if re.search(r"getElementById\(\s*['\"][A-Za-z0-9_-]+['\"]\s*\)\s*\.innerHTML\s*=", body) \
           or re.search(r"\.outerHTML\s*=", body) \
           or re.search(r"\.replaceChildren\s*\(", body) \
           or re.search(r"\.insertAdjacentHTML\s*\(", body) \
           or re.search(r"\.removeChild\s*\(", body):
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
