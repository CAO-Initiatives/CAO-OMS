#!/usr/bin/env bash
# OMS release gate. Run from the repository root.
#   ./scripts/release_gate.sh [BASE_REF]
# BASE_REF defaults to HEAD~1. Diff-dependent checks are skipped when the base
# ref does not exist (first commit, shallow clone).
set -uo pipefail

OMS=oms.html
IDX=index.html
BASE="${1:-HEAD~1}"
FAILED=0

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILED=1; }
skip() { echo "SKIP  $1"; }

echo "=================================================="
echo "OMS RELEASE GATE"
echo "=================================================="

# ---------- 1. artifacts exist ----------
if [ -f "$OMS" ] && [ -f "$IDX" ]; then
  pass "1 artifacts present ($OMS, $IDX)"
else
  fail "1 artifacts missing"
  echo "Cannot continue without both artifacts."
  exit 2
fi

# ---------- 2. script tags balanced ----------
OPEN=$(grep -o "<script" "$OMS" | wc -l)
CLOSE=$(grep -o "</script>" "$OMS" | wc -l)
if [ "$OPEN" -eq "$CLOSE" ]; then
  pass "2 script tags balanced ($OPEN/$CLOSE)"
else
  fail "2 script tags unbalanced ($OPEN open, $CLOSE close)"
fi

# ---------- 3. capability markers ----------
# Twelve markers, each verified present in the Rev 14 production artifact.
# A missing marker means a capability was deleted, not refactored.
MARKERS="OMS_GATEWAY OMS_REV_LOG OMS_MAP saveModal rAdmin sessionStorage \
createNotificationForTask eventTaskStats briefWeek buildCalGrid findPerson seedPeople"
MISSING=""
for m in $MARKERS; do
  grep -q "$m" "$OMS" || MISSING="$MISSING $m"
done
if [ -z "$MISSING" ]; then
  pass "3 all 12 capability markers present"
else
  fail "3 capability markers MISSING:$MISSING"
fi

# ---------- 4. inline JavaScript parses ----------
# PYTHONIOENCODING is not optional. The artifact contains non-ASCII characters
# (there is a U+2194). Without it, Python's stdout defaults to the system
# codepage on Windows, the extraction dies mid-print, NOTHING is flushed, and
# `node --check` then cheerfully parses a ZERO-BYTE file and reports success.
# This check silently proved nothing on Windows until 5 Sept 2026. The size
# guard is the real fix: a failed extraction must never look like a clean parse.
rm -f /tmp/_inline.js
PYTHONIOENCODING=utf-8 python3 - "$OMS" <<'PY' > /tmp/_inline.js
import re, sys
s = open(sys.argv[1], encoding='utf-8').read()
blocks = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', s, re.S)
sys.stderr.write("inline blocks: %d\n" % len(blocks))
print('\n;\n'.join(blocks))
PY
INLINE_BYTES=$(wc -c < /tmp/_inline.js 2>/dev/null | tr -d ' ' || echo 0)
if [ "${INLINE_BYTES:-0}" -lt 1000 ]; then
  fail "4 inline JavaScript could not be extracted (${INLINE_BYTES:-0} bytes) - this check proves nothing"
elif node --check /tmp/_inline.js 2>/tmp/_nodeerr; then
  pass "4 inline JavaScript parses (node --check, $INLINE_BYTES bytes)"
else
  fail "4 inline JavaScript is a syntax error: $(head -3 /tmp/_nodeerr | tr '\n' ' ')"
fi

# ---------- 5. version badge present and well formed ----------
VER=$(grep -oE 'vbadge">v[0-9]+\.[0-9]+\.[0-9]+' "$OMS" | head -1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+')
if [ -n "$VER" ]; then
  pass "5 version badge present ($VER)"
else
  fail "5 version badge missing or malformed"
fi

# ---------- 6. rev log strictly decreasing from the top ----------
REVS=$(grep -oE "\{rev:[0-9]+," "$OMS" | grep -oE "[0-9]+")
TOPREV=$(echo "$REVS" | head -1)
if [ -z "$TOPREV" ]; then
  fail "6 OMS_REV_LOG has no parseable entries"
else
  ORDER_OK=$(echo "$REVS" | awk 'NR==1{p=$1;next}{if($1>=p){print "BAD";exit}p=$1}')
  if [ "$ORDER_OK" = "BAD" ]; then
    fail "6 OMS_REV_LOG is not strictly decreasing from the top"
  else
    pass "6 OMS_REV_LOG ordered, top entry rev $TOPREV"
  fi
fi

# ---------- diff-dependent checks ----------
if git rev-parse --verify --quiet "$BASE" >/dev/null && git cat-file -e "$BASE:$OMS" 2>/dev/null; then
  git show "$BASE:$OMS" > /tmp/_base_oms.html
  ADDED=$(git diff "$BASE" -- "$OMS" | grep -c "^+" || true)
  echo "      (added lines in $OMS vs $BASE: $ADDED)"

  # Rev 50 (R-01). This threshold was 5: any change adding five lines or fewer
  # was classed cosmetic and skipped checks 7 and 8. Rev 47 - a real release
  # that removed two false promises from the interface - added four lines and
  # went through with the guide, badge and rev-log checks all skipped. There
  # is no cosmetic change to a Dean-facing production artifact; the rule in
  # CLAUDE.md is that every change bumps the badge, appends the log and
  # touches the guide, and the gate now enforces the rule as written.
  if [ "$ADDED" -gt 0 ]; then
    # ---------- 7. User Guide touched ----------
    # Guide-specific selectors ONLY. The old gate accepted the bare words
    # Admin, Import, Tasks and Navigation:, which any unrelated edit satisfies.
    GUIDE=$(git diff "$BASE" -- "$OMS" | grep -cE "^\+.*(guide-wrap|guide-hero|guide-sec)" || true)
    if [ "$GUIDE" -gt 0 ]; then
      pass "7 User Guide updated ($GUIDE guide lines added)"
    else
      fail "7 non-cosmetic change ($ADDED added lines) but the embedded User Guide was NOT updated"
    fi

    # ---------- 8. version and rev log both advanced ----------
    BASEVER=$(grep -oE 'vbadge">v[0-9]+\.[0-9]+\.[0-9]+' /tmp/_base_oms.html | head -1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+')
    BASEREV=$(grep -oE "\{rev:[0-9]+," /tmp/_base_oms.html | grep -oE "[0-9]+" | head -1)
    # Strictly greater, not merely different: an accidental downgrade
    # (v1.5.0 -> v1.4.0) must fail, and inequality alone would let it pass.
    VCMP=$(python3 - "$BASEVER" "$VER" <<'PY'
import sys
def t(v):
    return tuple(int(x) for x in v.lstrip('v').split('.')) if v else ()
b, h = t(sys.argv[1]), t(sys.argv[2])
print('UP' if (b and h and h > b) else ('SAME' if b == h else 'DOWN'))
PY
)
    if [ "$VCMP" = "UP" ]; then
      pass "8a version badge bumped ($BASEVER -> $VER)"
    elif [ "$VCMP" = "SAME" ]; then
      fail "8a version badge not bumped (still $VER after $ADDED added lines)"
    else
      fail "8a version badge went BACKWARDS ($BASEVER -> $VER)"
    fi
    if [ -n "$BASEREV" ] && [ -n "$TOPREV" ] && [ "$TOPREV" -le "$BASEREV" ]; then
      fail "8b OMS_REV_LOG not appended (top rev $BASEREV -> $TOPREV)"
    else
      pass "8b OMS_REV_LOG appended (rev $BASEREV -> $TOPREV)"
    fi
  else
    skip "7 User Guide check ($OMS unchanged since $BASE)"
    skip "8 version and rev-log bump ($OMS unchanged since $BASE)"
  fi
else
  skip "7 and 8 (base ref $BASE unavailable)"
fi

# ---------- 9. commit message ----------
MSG=$(git log -1 --pretty=%B 2>/dev/null || echo "")
if [ "${#MSG}" -ge 10 ]; then
  pass "9 commit message length ${#MSG}"
else
  fail "9 commit message too short (${#MSG} chars)"
fi

# ---------- 10. every data/*.json parses ----------
if [ -d data ]; then
  BADJSON=""
  for j in data/*.json; do
    [ -e "$j" ] || continue
    python3 -c "import json,sys; json.load(open(sys.argv[1],encoding='utf-8'))" "$j" 2>/dev/null \
      || BADJSON="$BADJSON $j"
  done
  if [ -z "$BADJSON" ]; then
    pass "10 all data/*.json parse"
  else
    fail "10 invalid JSON:$BADJSON"
  fi
else
  skip "10 no data/ directory"
fi

# ---------- 11. preflight ----------
if [ -f gate4_preflight.py ]; then
  if python3 gate4_preflight.py; then
    pass "11 gate4_preflight.py clean"
  else
    fail "11 gate4_preflight.py reported failures (see above)"
  fi
else
  fail "11 gate4_preflight.py missing from the repository"
fi

# ---------- 12. descriptive text is backed by the code ----------
# Standing instruction, 6 Sept 2026. The guide hash check proves the guide
# CHANGED; it cannot prove it became true. This ties declared claims in
# tooltips, the User Guide and on-screen instructions to the code behind them,
# in both directions: a claim the code does not support fails, and a capability
# nothing describes fails. See scripts/text_claims.py for what went wrong
# without it.
if [ -f scripts/text_claims.py ]; then
  if python3 scripts/text_claims.py; then
    pass "12 descriptive text matches the code"
  else
    fail "12 descriptive text contradicts the code (see above)"
  fi
else
  fail "12 scripts/text_claims.py missing from the repository"
fi

# ---- 13: CLAUDE.md must not hand-write counts -------------------------------
# Same failure as check 12, one file over. CLAUDE.md claimed 268 assertions and
# 11 gate checks on a day the suite passed 401 and ran 12 - wrong twice in two
# days. A count in prose is a fact with no owner: nothing fails when it drifts.
# The numbers were deleted rather than corrected; this keeps them out. History
# ("58 of 85 runs were failing") is deliberately not flagged.
if [ -f scripts/no_handwritten_counts.py ]; then
  if python3 scripts/no_handwritten_counts.py; then
    pass "13 CLAUDE.md hand-writes no counts"
  else
    fail "13 CLAUDE.md hand-writes a count that will go stale (see above)"
  fi
else
  fail "13 scripts/no_handwritten_counts.py missing from the repository"
fi

# ---------- 14. no stray control bytes in a shipped artifact ----------
# Rev 37 put a literal NUL into oms.html where the two-character escape was
# meant. Harmless at runtime, and the whole gate passed - but git treats a file
# containing a NUL as BINARY, which silently turns off the eol=lf normalization
# that .gitattributes exists to enforce on the one file whose SHA-256 is quoted
# in every release note and used as the rollback baseline. It was caught because
# grep started saying "Binary file oms.html matches" on an unrelated command,
# which is luck rather than a control.
if [ -f scripts/no_control_bytes.py ]; then
  if python3 scripts/no_control_bytes.py; then
    pass "14 artifacts hold no stray control bytes"
  else
    fail "14 a shipped artifact holds a control byte or a carriage return (see above)"
  fi
else
  fail "14 scripts/no_control_bytes.py missing from the repository"
fi

# ---------- 15. no text input may destroy itself while being typed into ----------
# Three search boxes re-rendered their own container on every keystroke, so the
# element being typed into was replaced, focus fell to <body>, and only the first
# letter of a search ever landed. Rev 12 fixed exactly this for the calendar box
# and the fix was never generalized - the Tasks and SOPs boxes carried the same
# defect for fifty-odd revisions, and nothing in the gate, the smoke suite or the
# text claims mentioned focus, so nothing could say so. The negative control runs
# first: a guard that only ever passes is the failure this project has had twice.
if [ -f scripts/no_focus_losing_inputs.py ] && [ -f test/no_focus_losing_inputs_negative.py ]; then
  if python3 test/no_focus_losing_inputs_negative.py >/dev/null 2>&1; then
    if python3 scripts/no_focus_losing_inputs.py; then
      pass "15 no typing control destroys itself as you type"
    else
      fail "15 a text input re-renders its own container with nothing restoring focus (see above)"
    fi
  else
    python3 test/no_focus_losing_inputs_negative.py || true
    fail "15 the focus guard no longer catches real drift - its negative control failed"
  fi
else
  fail "15 scripts/no_focus_losing_inputs.py or its negative control is missing from the repository"
fi

echo "=================================================="
if [ "$FAILED" -eq 0 ]; then
  echo "GATE PASSED"
  echo "=================================================="
  exit 0
else
  echo "GATE FAILED — see FAIL lines above"
  echo "=================================================="
  exit 2
fi
