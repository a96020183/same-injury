"""Small World Model test sample (real public data):
  - First row per site from the ITA 2024 and 2025 case files (establishment_id, name, company, EIN, address, zip).
  - Renumbered sites: same EIN + zip + street number, different establishment_id in 2025 (same definition as v7 l1_idshift.py). Take 3.
  - Unchanged sites: take 2.
  - SIR reports from 2024-2025 in these 5 sites' zips (employer string + address), at most 2 per site.
Output: data/private/sites_real_PRIVATE.json (real names, not committed); scripts/pseudonymize_fixtures.py produces the committed fixture from it.
Usage: python -I wm_fixture.py ITA2024.csv ITA2025.csv SIR.csv"""
import csv, sys, re, json, random, pathlib, collections
csv.field_size_limit(10 ** 9)
I24, I25, SIR = sys.argv[1:4]
OUT = pathlib.Path(__file__).resolve().parents[1] / 'data' / 'private' / 'sites_real_PRIVATE.json'


def sites(path, year):
    S = {}
    for r0 in csv.DictReader(open(path, encoding='utf-8', errors='replace', newline='')):
        r = {k.lower(): v for k, v in r0.items()}
        e = r['establishment_id']
        if e in S:
            continue
        m = re.match(r'\s*(\d+)', r.get('street_address') or '')
        S[e] = dict(year=year, establishment_id=e, name=r['establishment_name'].strip(), company=(r.get('company_name') or '').strip(),
                    ein=re.sub(r'\D', '', r.get('ein') or ''), street=(r.get('street_address') or '').strip(),
                    zip=re.sub(r'\D', '', r.get('zip_code') or '')[:5], state=r['state'].strip().upper(), streetno=m.group(1) if m else '')
    return S


a, b = sites(I24, 2024), sites(I25, 2025)
key = lambda s: (s['ein'], s['zip'], s['streetno'])
ka = collections.defaultdict(list)
for s in a.values():
    if all(key(s)):
        ka[key(s)].append(s)
changed, same = [], []
for s in b.values():
    if not all(key(s)) or len(ka.get(key(s), [])) != 1:
        continue
    old = ka[key(s)][0]
    (same if old['establishment_id'] == s['establishment_id'] else changed).append((old, s))
rnd = random.Random(1003)
rnd.shuffle(changed)
rnd.shuffle(same)
pick = changed[:3] + same[:2]
zips = {o['zip'] for o, _ in pick}
sir = collections.defaultdict(list)
for r in csv.DictReader(open(SIR, encoding='utf-8', errors='replace', newline='')):
    z = re.sub(r'\D', '', r['Zip'] or '')[:5]
    if z in zips and r['EventDate'].split('/')[-1] in ('2024', '2025') and len(sir[z]) < 2:
        sir[z].append(dict(sir_id=r['ID'], upa=r['UPA'], event_date=r['EventDate'], employer=r['Employer'], address=r['Address1'], zip=z,
                           amputation=r['Amputation'].startswith('1')))
OUT.parent.mkdir(parents=True, exist_ok=True)
json.dump(dict(source='OSHA ITA case detail 2024 & 2025, OSHA SIR Jan2015–Nov2025 (public files)',
               counts=dict(changed_total=len(changed), same_total=len(same)),
               pairs=[dict(y2024=o, y2025=n, id_changed=o['establishment_id'] != n['establishment_id']) for o, n in pick],
               sir=[x for z in sorted(sir) for x in sir[z]]), open(OUT, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('changed', len(changed), 'same', len(same), 'sir', sum(len(v) for v in sir.values()))
