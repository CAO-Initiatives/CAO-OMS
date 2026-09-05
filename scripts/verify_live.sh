#!/usr/bin/env bash
# Confirms the deployed site actually serves an expected artifact.
#   ./scripts/verify_live.sh [expected-sha256]
set -uo pipefail
URL="https://cao-initiatives.github.io/CAO-OMS/oms.html"
EXPECT="${1:-}"
for i in $(seq 1 20); do
  BODY=$(curl -sS -L "$URL" 2>/dev/null || true)
  if [ -n "$BODY" ]; then
    SHA=$(printf '%s' "$BODY" | sha256sum | cut -d' ' -f1)
    VER=$(printf '%s' "$BODY" | grep -oE 'vbadge">v[0-9.]+' | head -1 | grep -oE 'v[0-9.]+')
    REV=$(printf '%s' "$BODY" | grep -oE "\{rev:[0-9]+," | grep -oE "[0-9]+" | head -1)
    if [ -z "$EXPECT" ] || [ "$SHA" = "$EXPECT" ]; then
      echo "LIVE  $VER  rev $REV"
      echo "sha256 $SHA"
      [ -n "$EXPECT" ] && echo "MATCHES expected artifact."
      exit 0
    fi
    echo "attempt $i: serving $VER ($SHA) — waiting for the deploy..."
  else
    echo "attempt $i: no response yet"
  fi
  sleep 15
done
echo "TIMEOUT: the deploy did not serve the expected artifact within 5 minutes." >&2
exit 1
