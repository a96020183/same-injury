"""World Model test sample two: how three agencies name the same site (real public data).
Takes L1-3 verified hard cases (UPA -> DOL inspection, same zip) and pairs each with the ITA 2024 site in the same zip with the closest name.
Output: data/private/agencies_real_PRIVATE.json (real names, not committed); scripts/pseudonymize_fixtures.py produces the committed fixture from it.
Usage: python -I wm_fixture_agencies.py ITA2024.csv"""
import csv, sys, re, json, difflib, pathlib
csv.field_size_limit(10 ** 9)
ROOT = pathlib.Path(__file__).resolve().parents[1]
d = json.load(open(ROOT / 'out' / 'l1_3_dol_hard.json', encoding='utf-8'))
want = {}
for r in d['rows']:
    c = next((c for c in r['candidates'] if c.get('verified') and c.get('zip_same')), None)
    if c and r['sir_employer'].strip().upper() != (c['estab_name'] or '').strip().upper():
        want.setdefault(r['sir_zip'], []).append(dict(sir_id=r['sir_id'], upa=r['upa'], event_date=r['event_date'], sir_employer=r['sir_employer'],
                                                     dol_activity_nr=c['activity_nr'], dol_estab_name=c['estab_name'], dol_site_address=c['site_address']))
norm = lambda s: re.sub(r'[^a-z0-9 ]', ' ', (s or '').lower())
best = {}
for r0 in csv.DictReader(open(sys.argv[1], encoding='utf-8', errors='replace', newline='')):
    r = {k.lower(): v for k, v in r0.items()}
    z = re.sub(r'\D', '', r.get('zip_code') or '')[:5]
    if z not in want:
        continue
    for w in want[z]:
        s = difflib.SequenceMatcher(None, norm(w['sir_employer']), norm(r['establishment_name'] + ' ' + (r.get('company_name') or ''))).ratio()
        if s > best.get(w['sir_id'], (0,))[0]:
            best[w['sir_id']] = (s, dict(establishment_id=r['establishment_id'], name=r['establishment_name'], company=r.get('company_name'),
                                        ein=re.sub(r'\D', '', r.get('ein') or ''), street=r['street_address'], zip=z))
out = []
for z, ws in want.items():
    for w in ws:
        if w['sir_id'] in best and best[w['sir_id']][0] >= 0.5:
            out.append(dict(w, ita=best[w['sir_id']][1], ita_name_sim=round(best[w['sir_id']][0], 2)))
out.sort(key=lambda x: x['sir_id'])
json.dump(dict(source='SIR (OSHA), DOL API v4 OSHA inspection, ITA 2024 case detail', cases=out),
          open(ROOT / 'data' / 'private' / 'agencies_real_PRIVATE.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
for x in out: print(x['sir_employer'], '|', x['dol_estab_name'], '|', x['ita']['name'], x['ita_name_sim'])
