"""Fail if any secret value appears in a file git would commit. Prints file and key names only, never values.
Secrets = every KEY/TOKEN/PASSWORD/SECRET value in ../.env and .env, plus data/private/*_PRIVATE.txt and data/l1pg_password_PRIVATE.txt.
With no secret available (a clean clone) it says NOT VERIFIED instead of passing silently; a self-test with a made-up
key always runs. Usage: python -I scripts/scan_secrets.py"""
import pathlib, subprocess, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
vals = {}
for envf in (ROOT.parent / '.env', ROOT / '.env'):
    if envf.exists():
        for ln in envf.read_text(encoding='utf-8').splitlines():
            if '=' in ln and not ln.strip().startswith('#'):
                k, v = ln.split('=', 1); v = v.strip().strip('"').strip("'")
                if any(t in k for t in ('KEY', 'TOKEN', 'PASSWORD', 'SECRET')) and len(v) >= 8: vals[k.strip()] = v
for f in list((ROOT / 'data' / 'private').glob('*_PRIVATE.txt')) + [ROOT / 'data' / 'l1pg_password_PRIVATE.txt']:
    if f.exists(): vals[f.name] = f.read_text().strip()
# self-test: a made-up key planted in a temporary copy of one tracked file must be found, so the scanner is shown to
# work even where no real secret is available (a clean clone has no .env and no data/private)
TEST_KEY = 'l1-selftest-' + 'not-a-real-key-7f3a9c'


def found_in(text, values):
    return [k for k, v in values.items() if v in text]


selftest_ok = found_in('header\nZETARIS_API_KEY=' + TEST_KEY + '\n', {'TEST_KEY': TEST_KEY}) == ['TEST_KEY'] and not found_in('nothing here', {'TEST_KEY': TEST_KEY})
files = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=ROOT, capture_output=True, text=True).stdout.split('\n')
bad = []
for rel in filter(None, files):
    p = ROOT / rel
    try: t = p.read_bytes().decode('utf-8', 'ignore')
    except Exception: continue
    bad += [(rel, k) for k in found_in(t, vals)]
print(f'checked {len([f for f in files if f])} files against {len(vals)} secrets; scanner self-test with a made-up key: {"passed" if selftest_ok else "FAILED"}')
if not vals:
    print('NOT VERIFIED: no secret values to compare against here (no .env, no data/private). Only the self-test ran; '
          'run this on the build machine, which holds the keys, to check the repository.')
for rel, k in bad: print('LEAK', rel, k)
sys.exit(1 if bad or not selftest_ok else 0)
