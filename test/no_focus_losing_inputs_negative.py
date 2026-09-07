#!/usr/bin/env python3
"""Negative control for gate check 15.

A guard that only ever passes is the failure this project has already had twice,
in check 4 and again in check 12. So this feeds the checker artifacts that are
deliberately broken in each way the real defect has actually appeared, and
asserts that it FAILS on every one - and passes the shapes that are genuinely
fine, so it is not simply refusing everything.

    python3 test/no_focus_losing_inputs_negative.py

It earned its place immediately: the first draft of the checker required a
renderer to be CALLED with parentheses in the handler. The Rev 67 fix hands the
renderer over as a reference - omsRerenderKeepingCaret('task-search', rTasks) -
so the draft skipped every control the fix had just repaired and pronounced the
artifact clean without examining any of them. Fixture 10 below is that exact
case, and it is why the rule now matches a reference as well as a call.

Each fixture is a minimal artifact built the way the real screens are built -
the renderer EMITS the control inside its own template literal - so a change to
oms.html can never quietly turn a fixture clean.
"""
import os
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECKER = os.path.join(REPO, "scripts", "no_focus_losing_inputs.py")
REAL = os.path.join(REPO, "oms.html")

PASS, FAIL = [], []

HELPER = """
function omsRerenderKeepingCaret(inputId,render){
  var before=document.getElementById(inputId);
  var had=!!before&&document.activeElement===before;
  var s=null,e=null;
  if(had){try{s=before.selectionStart;e=before.selectionEnd}catch(_){}}
  render();
  if(!had)return;
  var after=document.getElementById(inputId);
  if(!after)return;
  try{after.focus();if(s!=null)after.setSelectionRange(s,e)}catch(_){}
}
"""


def artifact(markup, extra="", helper=True):
    """A renderer that EMITS the control, which is how every real screen works."""
    return ("<!doctype html><html><body><div id=\"thing\"></div><script>\n"
            "function rThing(){ document.getElementById('thing').innerHTML = `"
            + markup + "`; }\n" + (HELPER if helper else "") + extra
            + "\n</script></body></html>")


def run(path):
    r = subprocess.run([sys.executable, CHECKER, "--file", path],
                       capture_output=True, text=True)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def check(name, should_fail, body):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "fixture.html")
        with open(p, "w", encoding="utf-8", newline="") as f:
            f.write(body)
        code, out = run(p)
    ok = (code != 0) == should_fail
    (PASS if ok else FAIL).append(name)
    print(("PASS  " if ok else "FAIL  ") + name +
          ("" if ok else "  --  exit %d, output:\n%s" % (code, out)))


print("# The real artifact must pass")
code, out = run(REAL)
ok = code == 0
(PASS if ok else FAIL).append("the shipped oms.html is clean")
print(("PASS  " if ok else "FAIL  ") + "the shipped oms.html is clean" +
      ("" if ok else "  --  exit %d:\n%s" % (code, out)))

print("\n# Broken artifacts that must be caught")

# 1. The defect itself: type, re-render, nothing restores focus. Exactly what
#    the Tasks and SOPs boxes did from Rev 22 until Rev 67.
check("a search box whose oninput re-runs the renderer that drew it is caught", True,
      artifact('<input class="srch" id="s" oninput="q=this.value;rThing()">'))

# 2. The same thing one function deep - the shape calSearchInput has, minus the
#    repair. A checker that does not follow one level of indirection misses it.
check("...and is still caught when the render is one function deep", True,
      artifact('<input class="srch" id="s" oninput="wrap(this)">',
               "function wrap(i){ q=i.value; rThing(); }"))

# 3. Rev 12's actual mechanism: a frame-deferred restore. Correct-looking, dead
#    in a hidden tab, and stubbed to a no-op by the smoke harness.
check("a requestAnimationFrame refocus is rejected as a deferred restore", True,
      artifact('<input class="srch" id="s" oninput="wrap(this)">',
               "function wrap(i){ q=i.value; rThing(); "
               "requestAnimationFrame(function(){var e=document.getElementById('s');"
               "if(e){e.focus()}}); }"))

# 4. The helper aimed at a different element than the one being typed into.
check("the helper pointed at the wrong element id is caught", True,
      artifact('<input class="srch" id="typed-in" '
               "oninput=\"q=this.value;omsRerenderKeepingCaret('some-other-box',rThing)\">"))

# 5. The helper used on a control with no id, so there is nothing to find again.
check("the helper used on a control with no id is caught", True,
      artifact('<input class="srch" '
               "oninput=\"q=this.value;omsRerenderKeepingCaret('s',rThing)\">"))

# 6. A textarea, not just an input.
check("a textarea with the same defect is caught", True,
      artifact('<textarea id="t" oninput="q=this.value;rThing()"></textarea>'))

# 7. onkeyup instead of oninput - the same defect wearing a different attribute.
check("the same defect on onkeyup is caught", True,
      artifact('<input class="srch" id="s" onkeyup="q=this.value;rThing()">'))

# 8. The choice-control form of it: a filter dropdown that redraws its own
#    screen. Five of these were live until Rev 67; one arrived in Rev 61.
check("a filter dropdown that redraws its own screen is caught", True,
      artifact('<select id="f" onchange="cat=this.value;rThing()"><option>a</option></select>'))

# 9. The helper deleted from the artifact while a call site still names it.
check("the helper missing from the artifact is caught", True,
      artifact('<input class="srch" id="s" '
               "oninput=\"q=this.value;omsRerenderKeepingCaret('s',rThing)\">",
               helper=False))

# 10. THE REGRESSION THIS SUITE ALREADY CAUGHT ONCE. The renderer is handed over
#     as a bare reference rather than called, so a rule that looks for "rThing("
#     sees nothing to check and passes the file. It must still be caught.
check("a renderer passed by reference, not called, is still caught", True,
      artifact('<input class="srch" id="s" oninput="q=this.value;setTimeout(rThing,0)">'))

# 11. A renderer that rebuilds its container by a route other than innerHTML.
#     Every renderer in the artifact uses innerHTML today; a guard that knows
#     only today's idiom expires the first time somebody writes modern DOM code.
check("a renderer using replaceChildren instead of innerHTML is still caught", True,
      ("<!doctype html><html><body><div id=\"thing\"></div><script>\n"
       "function rThing(){ const d=document.createElement('div');"
       "d.innerHTML=`<input class=\"srch\" id=\"s\" oninput=\"q=this.value;rThing()\">`;"
       "document.getElementById('thing').replaceChildren(d); }\n"
       + HELPER + "\n</script></body></html>"))

# 12. THE TOKENIZER TRAP, PART ONE: nested template literals. Every renderer in
#     the artifact is built this way. A scanner that treats the inner backtick
#     as the end of the outer template parses the rest of the markup as code,
#     brace matching desynchronises, and the containment test silently reports
#     on the wrong function. Rev 67 shipped with exactly that defect.
check("a defect hidden inside a nested template literal is still caught", True,
      ("<!doctype html><html><body><div id=\"thing\"></div><script>\n"
       "function rThing(){ const on=true; document.getElementById('thing').innerHTML = "
       "`<div>${on?`<span>x</span>`:''}"
       "<input class=\"srch\" id=\"s\" oninput=\"q=this.value;rThing()\">`; }\n"
       + HELPER + "\n</script></body></html>"))

# 13. THE TOKENIZER TRAP, PART TWO: a regex holding a quote. esc() in the real
#     artifact is .replace(/'/g,'&#39;'), and the apostrophe inside the pattern
#     opened a phantom string that swallowed 63,000 characters, so unrelated
#     functions appeared to contain each other.
check("a defect after a regex containing an apostrophe is still caught", True,
      ("<!doctype html><html><body><div id=\"thing\"></div><script>\n"
       "function esc(s){return String(s).replace(/'/g,'&#39;').replace(/\"/g,'&quot;')}\n"
       "function rThing(){ document.getElementById('thing').innerHTML = "
       "`<input class=\"srch\" id=\"s\" oninput=\"q=this.value;rThing()\">`; }\n"
       + HELPER + "\n</script></body></html>"))

print("\n# Sound artifacts that must NOT be caught")

# 11. The correct shape: the helper, with this control's own id.
check("a correctly guarded box passes", False,
      artifact('<input class="srch" id="s" '
               "oninput=\"q=this.value;omsRerenderKeepingCaret('s',rThing)\">"))

# 12. The Rev 65 header search: static markup that paints a sibling panel and
#     never destroys itself. It needs no helper and must not be asked for one.
check("a box that paints a separate panel passes", False,
      ("<!doctype html><html><body><div id=\"panel\"></div>"
       '<input class="srch" id="g" oninput="paint(this.value)">'
       "<script>function paint(v){document.getElementById('panel').innerHTML=v}"
       + HELPER + "</script></body></html>"))

# 13. Emitted by a renderer, but its handler does not re-run that renderer, so
#     nothing destroys it.
check("a control that does not re-run its own renderer passes", False,
      artifact('<input class="srch" id="s" oninput="q=this.value">'))

# 14. A checkbox holds no cursor and is deliberately out of scope; sweeping in
#     every clickable would flag every button that legitimately redraws. A
#     guarded input sits beside it so the scan has something in scope to check:
#     an artifact where NOTHING is in scope trips the "the scan is broken"
#     safety net, which is the correct behaviour for the real file.
check("a checkbox is out of scope and passes", False,
      artifact('<input type="checkbox" id="c" onchange="q=this.checked;rThing()">'
               '<input class="srch" id="s" '
               "oninput=\"q=this.value;omsRerenderKeepingCaret('s',rThing)\">"))

print("\n" + "=" * 60)
print("FOCUS NEGATIVE SUITE: %d passed, %d failed" % (len(PASS), len(FAIL)))
print("=" * 60)
sys.exit(1 if FAIL else 0)
