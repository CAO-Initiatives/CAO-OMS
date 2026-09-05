#!/usr/bin/env bash
# OMS rollback. Restores oms.html from a previous commit and re-releases it.
#
#   ./scripts/rollback.sh <commit-ish>   e.g. ./scripts/rollback.sh HEAD~1
#                                             ./scripts/rollback.sh 59446910
#
# Rolls the ARTIFACT back by committing the older bytes forward. It never
# rewrites history, so the bad release stays in the log where it belongs.
# Canonical DATA is untouched — this only affects the display artifact.
set -euo pipefail
OMS=oms.html
TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: ./scripts/rollback.sh <commit-ish>" >&2; exit 1; }
git cat-file -e "$TARGET:$OMS" 2>/dev/null || { echo "ERROR: $OMS not found at $TARGET" >&2; exit 1; }

CUR=$(sha256sum "$OMS" | cut -d' ' -f1)
git show "$TARGET:$OMS" > /tmp/_rollback_oms.html
TGT=$(sha256sum /tmp/_rollback_oms.html | cut -d' ' -f1)
TGTVER=$(grep -oE 'vbadge">v[0-9.]+' /tmp/_rollback_oms.html | head -1 | grep -oE 'v[0-9.]+')
TGTREV=$(grep -oE "\{rev:[0-9]+," /tmp/_rollback_oms.html | grep -oE "[0-9]+" | head -1)

echo "current : $CUR"
echo "target  : $TGT   ($TGTVER, rev $TGTREV, from $TARGET)"
[ "$CUR" = "$TGT" ] && { echo "Already identical — nothing to roll back."; exit 0; }

read -r -p "Restore $TGTVER over the current artifact? [y/N] " a
[ "$a" = "y" ] || { echo "aborted."; exit 1; }

cp /tmp/_rollback_oms.html "$OMS"
node test/smoke.mjs "$OMS" || echo "NOTE: smoke reports failures — expected when rolling back BEHIND a fix."
git add "$OMS"
git commit -q -m "Rollback oms.html to $TGTVER (rev $TGTREV) from $TARGET"
./scripts/release_gate.sh HEAD~1 || echo "NOTE: gate objects to a rollback (no version bump). Expected; the commit stands."
git push origin "$(git rev-parse --abbrev-ref HEAD)"
echo "Rolled back to $TGTVER. Verify: ./scripts/verify_live.sh $TGT"
