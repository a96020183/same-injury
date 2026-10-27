"""Look in the public files for a naturally unsettled pair: an ITA log line and an OSHA severe-injury report at a near address
(same house number and city with another ZIP, or same ZIP with another house number), within 7 days, injury words that fit.
Build machine only (reads the private company pool and the public SIR file; prints to the console, writes nothing).
Usage: python -I scripts/find_ambiguous.py"""
import csv, json, re, datetime, sys
csv.field_size_limit(10 ** 9)
pool = json.load(open('data/composite/pool_PRIVATE.json', encoding='utf-8'))['pool']
ans = json.load(open('data/composite/1003/answers_PRIVATE.json', encoding='utf-8'))
demo = set(ans['_pool_index_PRIVATE'])
def d(s):
    for f in ('%m/%d/%Y', '%d%b%Y', '%Y-%m-%d'):
        try: return datetime.datetime.strptime((s or '').strip(), f).date()
        except Exception: pass
num = lambda s: (re.match(r'\s*(\d+)', s or '') or [None, ''])[1]
z5 = lambda z: re.sub(r'\D', '', z or '')[:5]
sir = []
for r in csv.DictReader(open('data/public/January2015toNovember2025.csv', encoding='utf-8', errors='replace')):
    x = d(r['EventDate'])
    if x and x.year == 2024 and (r['Amputation'].startswith('1') or (r['Hospitalized'] or '0').strip() not in ('', '0', '0.0')):
        sir.append(dict(id=r['ID'], d=x, no=num(r['Address1']), city=(r['City'] or '').strip().upper(), zip=z5(r['Zip']), upa=(r['UPA'] or '').strip(),
                        amp=r['Amputation'].startswith('1'), part=r.get('Part of Body Title', ''), nar=(r['Final Narrative'] or '')[:300]))
by_city = {}
for s in sir: by_city.setdefault(s['city'], []).append(s)
out = []
for pi, co in enumerate(pool):
    for e in co['establishments']:
        city, zp, no = (e['city'] or '').strip().upper(), z5(e['zip']), num(e['street'])
        for s in by_city.get(city, []):
            sameNo, sameZip = s['no'] == no and no, s['zip'] == zp
            if sameNo and sameZip: continue          # clean place match: not ambiguous
            if not (sameNo or sameZip): continue    # nowhere near
            for c in e['cases']:
                cd = d(c['date_of_incident'])
                if not cd or abs((cd - s['d']).days) > 7: continue
                t = ' '.join(c.get(k) or '' for k in ('new_nar_what_happened', 'new_nar_injury_illness'))
                if not re.search(r'amput|finger|hand|crush|fractur|laceration', t, re.I): continue
                out.append(dict(pool=pi, demo=pi in demo, est=e['establishment_id'], case=c['case_number'], days=(cd - s['d']).days, sameNo=bool(sameNo), sameZip=sameZip,
                                upa=bool(s['upa']), sir_amp=s['amp'], sir=s['id'], part=s['part'], log=t[:160], osha=s['nar'][:160]))
out.sort(key=lambda x: (not x['demo'], x['upa'], abs(x['days'])))
print(len(out))
print("pairs", len(out), "in the demo company", sum(o["demo"] for o in out), "without a referral number", sum(not o["upa"] for o in out))
