#!/usr/bin/env python3
"""Probe: does check 12's rev-log excision actually excise the rev log?

scripts/text_claims.py builds `prose` as html[:cut] + html[end:] where
    cut = html.find("const OMS_REV_LOG")
    end = html.find("];", cut)

`];` is the FIRST such pair after the array starts. If any rev-log summary
string contains those two characters, the slice ends early and the rest of the
revision log stays in `prose` -- i.e. history is treated as interface text.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2] if False else pathlib.Path(r"C:\dev\CAO-OMS")
html = (ROOT / "oms.html").read_text(encoding="utf-8")

cut = html.find("const OMS_REV_LOG")
end = html.find("];", cut)
print("cut  offset:", cut)
print("end  offset:", end)
print("excised bytes:", end - cut)

print("\n--- 120 chars around the chosen `];` ---")
print(repr(html[end - 100:end + 20]))

# Where does the array ACTUALLY end? Walk brackets from the opening [.
open_br = html.find("[", cut)
depth = 0
i = open_br
in_str = None
true_end = None
while i < len(html):
    ch = html[i]
    if in_str:
        if ch == "\\":
            i += 2
            continue
        if ch == in_str:
            in_str = None
    else:
        if ch in "'\"`":
            in_str = ch
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                true_end = i
                break
    i += 1

print("\ntrue array end offset:", true_end)
print("bytes the array really spans:", (true_end - cut) if true_end else None)
if true_end is not None:
    leaked = (true_end + 1) - end
    print("bytes of REV LOG left inside `prose`:", leaked)
    if leaked > 0:
        seg = html[end:true_end + 1]
        print("\n--- first 300 chars of leaked rev-log text ---")
        print(repr(seg[:300]))
        # how many rev entries leak?
        print("\nrev entries inside the leak:", len(re.findall(r"\{rev:\d+,", seg)))
