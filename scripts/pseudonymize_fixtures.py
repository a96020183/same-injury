"""Pseudonymize the World Model test fixtures (public ITA/SIR/DOL rows) for the repo.
Every name token of 3+ letters (except legal suffixes) is replaced by a same-length pseudo-word (salted hash, so it cannot be
reversed with a word list), the same way everywhere, case kept; EINs become EIN-<n> (equal EINs stay equal). Name similarity
between fields is therefore preserved, which is what the tests exercise. Addresses, ZIPs and every record number go through
scripts/deidentify.py (same house number + ZIP -> same invented address; same number -> same code). Originals stay in
data/private/ (git-ignored).
Usage: python -I scripts/pseudonymize_fixtures.py data/private/agencies_real_PRIVATE.json data/private/sites_real_PRIVATE.json"""
import sys, json, re, hashlib, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import deidentify as D  # noqa: E402
KEEP = {'inc', 'llc', 'co', 'corp', 'company', 'the', 'and', 'of', 'dba', 'usa', 'ltd', 'lp'}
NAME_FIELDS = {'sir_employer', 'dol_estab_name', 'name', 'company', 'employer', 'estab_name'}
CONS, VOW = 'bcdfghjklmnprstvz', 'aeiou'
eins = {}
ADDR = {'street', 'address', 'dol_site_address'}
IDS = {'establishment_id': 'EST', 'sir_id': 'SIR', 'upa': 'REF', 'dol_activity_nr': 'DOL'}
_zip_ctx = ['']


def zip_of(o):
    # the address key uses the ZIP of the same record (or of the case's ITA site), so equal addresses stay equal
    z = o.get('zip') or (o.get('ita') or {}).get('zip') or _zip_ctx[0]
    return re.sub(r'\D', '', str(z))[:5]


def fake(tok):
    h = hashlib.sha256(('fx|' + D.SALT + '|' + tok.lower()).encode()).digest()
    w = ''.join((CONS if i % 2 == 0 else VOW)[h[i % len(h)] % (len(CONS) if i % 2 == 0 else len(VOW))] for i in range(len(tok)))
    return w.upper() if tok.isupper() else w.capitalize() if tok[0].isupper() else w


def pname(s):
    return re.sub(r'[A-Za-z]{3,}', lambda m: m.group(0) if m.group(0).lower() in KEEP else fake(m.group(0)), s or '')


def walk(o):
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k in NAME_FIELDS and isinstance(v, str):
                out[k] = pname(v)
            elif k in ADDR and isinstance(v, str):
                out[k] = D.street(v, 'Z' + zip_of(o))
            elif k == 'zip' and isinstance(v, str):
                out[k] = D.zipc(v)
            elif k == 'streetno' and v:
                out[k] = (re.match(r'\d+', D.street(f"{v} X", 'Z' + zip_of(o))) or [''])[0]
            elif k in IDS and v not in (None, ''):
                code = D.rid(IDS[k], str(v))
                out[k] = int(code.split('-')[1]) if isinstance(v, int) else code
            elif k == 'ein' and isinstance(v, str):
                out[k] = (eins.setdefault(v, f'EIN-{len(eins) + 1}') if v else '')
            else:
                out[k] = walk(v)
        return out
    if isinstance(o, list):
        return [walk(x) for x in o]
    return o


for src in sys.argv[1:]:
    d = json.load(open(src, encoding='utf-8'))
    name = pathlib.Path(src).name.replace('_PRIVATE', '').replace('_real', '')
    out = walk(d)
    if 'cases' in out:  # mark the parent-vs-subsidiary case the test needs (SIR names a different company than DOL and ITA)
        for c0, c in zip(d['cases'], out['cases']):
            c['parent_vs_subsidiary'] = not set(re.findall(r'[a-z]{4,}', c0['sir_employer'].lower())) & set(re.findall(r'[a-z]{4,}', c0['dol_estab_name'].lower()))
    out['source'] = (d.get('source', '') + '; names pseudonymized (scripts/pseudonymize_fixtures.py)').strip('; ')
    json.dump(out, open(ROOT / 'engine' / 'world-model' / 'fixtures' / name, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    print('wrote', name)
D.MAP_F.write_text(json.dumps(D.M, indent=1), encoding='utf-8')
