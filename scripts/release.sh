#!/usr/bin/env bash
# OMS one-command release. Run from the repository root.
#
#   ./scripts/release.sh <version> "<rev log summary>"
#
# <version> is the FULL semantic version, with or without the leading v:
#   MAJOR  milestone or audience change   1.x pilot -> 2.0.0 Dean's Office go-live
#   MINOR  planned release with user-visible change
#   PATCH  hotfix between planned releases, no new capability
#
# The OMS_REV_LOG rev is a separate, immutable audit counter. It only ever
# increments by one and never restarts, whatever the badge does.
#
# Example:
#   ./scripts/release.sh 1.7.0 "Rev 17 (client). Retired task status and the
#   ownerId backfill. User Guide updated."
#   ./scripts/release.sh 2.0.0 "Rev 18. Dean's Office production go-live."
#
# Assumes oms.html has ALREADY been edited. This script owns the release
# mechanics only: version badge, revision-log entry, verification, commit,
# push, and watching the CI run. It never edits application logic.
#
# Nothing is pushed unless the local gate AND the smoke test both pass.
set -euo pipefail

VERSION="${1:-}"
SUMMARY="${2:-}"
OMS=oms.html

die() { echo "ERROR: $*" >&2; exit 1; }

[ -n "$VERSION" ] || die "usage: ./scripts/release.sh <version> \"<summary>\"  e.g. 1.7.0 or 2.0.0"
NEWVER="v${VERSION#v}"
echo "$NEWVER" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$' || die "version must look like 1.7.0 or 2.0.0 (got '$VERSION')"
[ -n "$SUMMARY" ] || die "a revision-log summary is required (the gate rejects releases without one)"
[ -f "$OMS" ] || die "$OMS not found — run from the repository root"
[ -f scripts/release_gate.sh ] || die "scripts/release_gate.sh not found"
[ -f test/smoke.mjs ] || die "test/smoke.mjs not found"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || echo "NOTE: on branch '$BRANCH', not main."

git diff --quiet -- "$OMS" && die "$OMS has no uncommitted changes — nothing to release"

OLDVER=$(grep -oE 'vbadge">v[0-9]+\.[0-9]+\.[0-9]+' "$OMS" | head -1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+')
OLDREV=$(grep -oE "\{rev:[0-9]+," "$OMS" | grep -oE "[0-9]+" | head -1)
NEWREV=$((OLDREV + 1))

# Monotonic check up front, so a bad version fails before anything is edited.
python3 - "$OLDVER" "$NEWVER" <<'PY' || die "version must increase: $OLDVER -> $NEWVER"
import sys
t=lambda v: tuple(int(x) for x in v.lstrip('v').split('.'))
sys.exit(0 if t(sys.argv[2]) > t(sys.argv[1]) else 1)
PY
TODAY=$(date -u +%Y-%m-%d)

echo "=============================================="
echo "OMS RELEASE"
echo "  version   $OLDVER -> $NEWVER"
echo "  rev log   $OLDREV -> $NEWREV   ($TODAY)"
echo "=============================================="

# Refuse to overwrite an already-bumped file, so a re-run is safe.
if [ "$OLDVER" = "$NEWVER" ]; then
  echo "Badge already reads $NEWVER — skipping bump."
else
  BADGE_HITS=$(grep -c "vbadge\">$OLDVER" "$OMS" || true)
  [ "$BADGE_HITS" -eq 1 ] || die "expected exactly one badge occurrence, found $BADGE_HITS"
  sed -i "s|vbadge\">$OLDVER|vbadge\">$NEWVER|" "$OMS"
  echo "badge bumped."
fi

if grep -q "{rev:$NEWREV," "$OMS"; then
  echo "Revision log already has rev $NEWREV — skipping entry."
else
  python3 - "$OMS" "$NEWREV" "$TODAY" "$SUMMARY" <<'PY'
import sys
path, rev, today, summary = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = open(path, encoding='utf-8').read()
anchor = "OMS_REV_LOG=[\n"
if anchor not in s:
    raise SystemExit("ERROR: could not find the OMS_REV_LOG anchor")
entry = "  {rev:%s,date:'%s',summary:'%s'},\n" % (rev, today, summary.replace("\\", "\\\\").replace("'", "\\'"))
open(path, 'w', encoding='utf-8').write(s.replace(anchor, anchor + entry, 1))
print("revision log entry added.")
PY
fi

echo
echo "---------- smoke test (behaviour) ----------"
node test/smoke.mjs "$OMS" || die "smoke test failed — NOT pushing"

echo
echo "---------- release gate (form) ----------"
# Stage and commit first: the gate reads the commit message and diffs HEAD~1.
git add -A
git commit -q -m "Release Rev $NEWREV ($NEWVER): ${SUMMARY:0:90}"
chmod +x scripts/release_gate.sh
if ! ./scripts/release_gate.sh HEAD~1; then
  echo
  echo "GATE FAILED. The commit is local and NOT pushed."
  echo "Fix the artifact, then: git commit --amend -a  &&  ./scripts/release_gate.sh HEAD~1"
  exit 2
fi

SHA=$(sha256sum "$OMS" | cut -d' ' -f1)
BYTES=$(stat -c%s "$OMS")

echo
echo "---------- push ----------"
git push origin "$BRANCH"

git tag -a "$NEWVER" -m "Rev $NEWREV ($NEWVER): ${SUMMARY:0:90}"
git push origin "$NEWVER"

echo
echo "=============================================="
echo "RELEASED  $NEWVER   rev $NEWREV   (tagged)"
echo "  bytes    $BYTES"
echo "  sha256   $SHA"
echo "  commit   $(git rev-parse --short HEAD)"
echo "=============================================="
echo "Rollback baseline (previous production artifact):"
git show "HEAD~1:$OMS" | sha256sum | sed 's/-$/(HEAD~1)/'
PREVTAG=$(git tag --sort=-v:refname | sed -n 2p)
[ -n "$PREVTAG" ] && echo "  or by tag:  ./scripts/rollback.sh $PREVTAG"
echo
echo "Watching CI. Ctrl-C is safe; the release is already pushed."
if command -v gh >/dev/null 2>&1; then
  gh run watch --exit-status 2>/dev/null || echo "NOTE: could not attach to the run; check Actions."
else
  echo "gh not installed — check: https://github.com/CAO-Initiatives/CAO-OMS/actions"
fi

echo
echo "Verify the deploy actually serves it (Pages takes ~1 minute):"
echo "  ./scripts/verify_live.sh $SHA"
