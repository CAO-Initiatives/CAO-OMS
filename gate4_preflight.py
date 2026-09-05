#!/usr/bin/env python3
"""OMS preflight assertions.

Run from the repository root or by absolute path; paths resolve relative to
this file. Exits 0 when every assertion passes, 1 when any fails, 2 when an
artifact is missing.

Change history:
  v2 (2026-09-05) — removed the hardcoded 'v1.4.0' assertion, which appeared
  exactly once in the artifact (the badge) and would therefore have failed on
  every future release the moment the badge was bumped. The version is now
  DERIVED from the badge and checked for shape and uniqueness instead.
"""
from pathlib import Path
import re, sys, hashlib, json

ROOT = Path(__file__).resolve().parent
INDEX = ROOT / 'index.html'
OMS = ROOT / 'oms.html'
DATA = ROOT / 'data'

results = []


def check(name, ok):
    print(('PASS' if ok else 'FAIL') + ': ' + name)
    results.append(bool(ok))
    return ok


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


if not (check('index.html exists', INDEX.exists()) and check('oms.html exists', OMS.exists())):
    sys.exit(2)

i = INDEX.read_text(encoding='utf-8')
o = OMS.read_text(encoding='utf-8')

# --- version, derived rather than hardcoded ---
badge = re.search(r'vbadge">(v\d+\.\d+\.\d+)', o)
version = badge.group(1) if badge else None
check('version badge present and well formed', version is not None)
if version:
    check('version string appears exactly once (no stale duplicate)', o.count(version) == 1)
else:
    check('version string appears exactly once (no stale duplicate)', False)

# --- revision log ---
revs = [int(m) for m in re.findall(r'\{rev:(\d+),', o)]
check('OMS_REV_LOG has entries', len(revs) > 0)
check('OMS_REV_LOG strictly decreasing from the top',
      all(revs[k] > revs[k + 1] for k in range(len(revs) - 1)))

tests = [
    ('OMS login page identified', 'CAO OMS Sign In' in i),
    ('OMS application identified', 'CAO Operations Management System (OMS)' in o),
    ('Gateway URL present', 'https://cao-oms-gateway.vercel.app' in i
        and 'https://cao-oms-gateway.vercel.app' in o),
    ('Login endpoint present', '/api/login' in i),
    ('State endpoint present', '/api/state' in o),
    ('Operation endpoint present', '/api/operation' in o),
    ('Shared password removed', 'SITE_PASSWORD' not in i and 'CAO-OMS-2026!' not in i),
    ('Legacy access flag removed', 'cao_oms_gate_access' not in i),
    ('Session storage used', 'sessionStorage' in i and 'sessionStorage' in o),
    ('Sign Out present', bool(re.search(r'Sign Out', o, re.I))),
    ('Sync states present', all(x.lower() in o.lower()
        for x in ['Connected', 'Sync pending', 'Synced', 'Unsynced'])),
    ('User Guide present', 'User Guide' in o),
    ('User Guide updated', 'Authentication required' in o and 'shared canonical' in o),
    ('No private key in index', 'BEGIN PRIVATE KEY' not in i and 'BEGIN RSA PRIVATE KEY' not in i),
    ('No private key in OMS', 'BEGIN PRIVATE KEY' not in o and 'BEGIN RSA PRIVATE KEY' not in o),
    ('Dashboard retained', 'Dashboard' in o),
    ('Weekly Brief retained', 'Weekly Brief' in o),
    ('CAO Visibility retained', 'CAO Visibility' in o),
    ('Calendars retained', 'Calendars' in o),
    ('Cadence retained', 'Cadence (RoB)' in o),
    ('SOPs retained', 'SOPs' in o),
    ('Deliverables retained', 'Deliverables' in o),
    ('People retained', 'People' in o),
    ('Notifications retained', 'Notifications' in o),
]
for n, v in tests:
    check(n, v)

# --- committed data files must be parseable ---
if DATA.is_dir():
    bad = []
    for j in sorted(DATA.glob('*.json')):
        try:
            json.loads(j.read_text(encoding='utf-8'))
        except Exception as e:
            bad.append('%s (%s)' % (j.name, type(e).__name__))
    check('data/*.json all parse' + (' — bad: ' + ', '.join(bad) if bad else ''), not bad)

print('\nversion    ', version)
print('top rev    ', revs[0] if revs else None)
print('SHA256 index.html', sha(INDEX))
print('SHA256 oms.html  ', sha(OMS))

failed = sum(1 for r in results if not r)
print('\nSUMMARY: %d passed, %d failed' % (len(results) - failed, failed))
sys.exit(1 if failed else 0)
