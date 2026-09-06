#!/usr/bin/env python3
"""fn.py <file> <name> [...] -- print each named top-level function in full,
brace-balanced, string- and comment-aware enough for this codebase."""
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
path = sys.argv[1]
h = open(path, encoding="utf-8").read()


def extract(start):
    i = h.find("{", start)
    depth = 0
    instr = None
    j = i
    while j < len(h):
        ch = h[j]
        if instr:
            if ch == "\\":
                j += 2
                continue
            if ch == instr:
                instr = None
            elif instr == "`" and ch == "$" and h[j + 1:j + 2] == "{":
                # template substitution: track braces normally
                pass
        else:
            if ch in "'\"`":
                instr = ch
            elif ch == "/" and h[j + 1:j + 2] == "*":
                k = h.find("*/", j)
                j = (k + 2) if k > -1 else len(h)
                continue
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return h[start:j + 1]
        j += 1
    return h[start:start + 4000]


for name in sys.argv[2:]:
    for lead in ("function %s(" % name, "const %s=" % name, "let %s=" % name,
                 "async function %s(" % name):
        p = h.find(lead)
        if p > -1:
            print("=" * 78)
            print("### %s   (offset %d)" % (name, p))
            print("=" * 78)
            print(extract(p))
            print()
            break
    else:
        print("### %s -- NOT FOUND" % name)
