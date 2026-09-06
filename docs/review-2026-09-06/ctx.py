#!/usr/bin/env python3
"""ctx.py <file> <needle> [before] [after] -- print context around each hit."""
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
path, needle = sys.argv[1], sys.argv[2]
before = int(sys.argv[3]) if len(sys.argv) > 3 else 250
after = int(sys.argv[4]) if len(sys.argv) > 4 else 80

h = open(path, encoding="utf-8").read()
i = 0
n = 0
while True:
    i = h.find(needle, i)
    if i < 0:
        break
    n += 1
    print("=== hit %d at offset %d ===" % (n, i))
    print(h[max(0, i - before): i + after].replace("\n", "\\n"))
    print()
    i += len(needle)
print("total hits:", n)
