"""Fail if a published employer name appears in any file git would commit (prints counts and file names, never the names).
Names checked: every employer in the demo slice of the OSHA Severe Injury file, every DOL establishment in the cached
snapshot, every establishment and company of the four source companies, and the World Model fixture originals.
Needs the private inputs (data/), so it runs on the build machine only.
Usage: python -I scripts/scan_names.py SIR.csv"""
import sys, csv, json, re, pathlib, subprocess
csv.field_size_limit(10 ** 9)
ROOT = pathlib.Path(__file__).resolve().parents[1]
GENERIC = {'inc', 'llc', 'co', 'corp', 'corporation', 'company', 'the', 'of', 'and', 'ltd', 'lp', 'dba', 'usa', 'us', 'group', 'services', 'service',
           'holdings', 'enterprises', 'industries', 'international', 'america', 'american', 'national'}
def patterns(sir):
    """(name patterns, place phrases that are not names)"""
    names = set()
    pool = json.load(open(ROOT / 'data/composite/pool_PRIVATE.json', encoding='utf-8'))['pool']
    ans = json.load(open(ROOT / 'data/composite/1003/answers_PRIVATE.json', encoding='utf-8'))
    for pi in ans['_pool_index_PRIVATE']:
        for e in pool[pi]['establishments']:
            names |= {e['name'], e['company']}
    zips = {e['zip'] for pi in ans['_pool_index_PRIVATE'] for e in pool[pi]['establishments']}
    for r in csv.DictReader(open(sir, encoding='utf-8', errors='replace', newline='')):
        if r['EventDate'].endswith('2024') and re.sub(r'\D', '', r['Zip'] or '')[:5] in zips:
            names.add(r['Employer'])
    for f in (ROOT / 'data/dol/cache').glob('*.json'):
        d = json.load(open(f, encoding='utf-8'))
        for x in (d.get('data', []) if isinstance(d, dict) else d):
            if not isinstance(x, dict):
                continue
            if x.get('estab_name'):
                names.add(x['estab_name'])
    for f in ('agencies_real_PRIVATE.json', 'sites_real_PRIVATE.json'):
        p = ROOT / 'data/private' / f
        if p.exists():
            names |= set(re.findall(r'"(?:sir_employer|dol_estab_name|name|company)": "([^"]+)"', p.read_text(encoding='utf-8')))
    cities = {w.lower() for pi in ans['_pool_index_PRIVATE'] for e in pool[pi]['establishments'] for w in re.findall(r'[A-Za-z]+', e['city'])}
    # a name is found when its distinctive part (2+ non-generic words, or one rare word of 6+ letters) appears in a file
    pats = []
    for n in names:
        words = [w for w in re.findall(r"[A-Za-z][A-Za-z']+", n or '') if w.lower() not in GENERIC]
        if len(words) >= 2:
            pats.append(re.compile(r'\b' + r'\W+'.join(map(re.escape, words[:2])) + r'\b', re.I))
    cfg = json.load(open(ROOT / 'data/private/pseudonym_config_PRIVATE.json', encoding='utf-8'))
    for p, _ in cfg['phrases']:
        if len(p) > 3:
            pats.append(re.compile(r'\b' + re.escape(p) + r'\b', re.I))
    # place names and plain phrases that also occur inside employer names but identify nobody (city and state names, "<city> plant", "at home")
    norm_place = lambda s: re.sub(r'[^a-z]+', ' ', s.lower()).strip()
    PLACES = {norm_place(r['City']) for r in csv.DictReader(open(sir, encoding='utf-8', errors='replace', newline='')) if r['City']}
    PLACES |= {norm_place(e['city']) for pi in ans['_pool_index_PRIVATE'] for e in pool[pi]['establishments']}
    PLACES |= {norm_place(e['city'] + ' ' + e['state']) for pi in ans['_pool_index_PRIVATE'] for e in pool[pi]['establishments']}
    PLACES |= {norm_place(e['city'] + ' plant') for pi in ans['_pool_index_PRIVATE'] for e in pool[pi]['establishments']}
    PLACES |= {'new york', 'united states', 'all in', 'at home', 'his her', 'metal building', 'new jersey', 'new mexico', 'north carolina', 'south carolina'}
    return pats, PLACES, norm_place


if __name__ == '__main__':
    pats, PLACES, norm_place = patterns(sys.argv[1])
    files = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=ROOT, capture_output=True, text=True).stdout.split('\n')
    bad = {}
    for rel in filter(None, files):
        if rel.endswith(('.png', '.jpg')):
            continue
        t = (ROOT / rel).read_text(encoding='utf-8', errors='ignore')
        found = sorted({m.group(0) for p in pats for m in [p.search(t)] if m and norm_place(m.group(0)) not in PLACES})
        hits = len(found)
        if found and '--show' in sys.argv: print('   ', rel, found[:12])
        if hits:
            bad[rel] = hits
    print(f'checked {len([f for f in files if f])} files against {len(pats)} name patterns; files with hits: {len(bad)}')
    for rel, n in sorted(bad.items()):
        print('  ', rel, n)
    sys.exit(1 if bad else 0)
