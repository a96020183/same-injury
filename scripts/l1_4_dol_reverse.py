"""L1-4: for the 224 reverse cases (215 sites) the strict rule could not match, check DOL for same-period inspections of that site.

Method:
  1. Query OSHA/inspection in batches by the 215 sites' zips: site_zip in [...] and open_date > 2023-12-31.
  2. Match sites locally: same zip and (name similarity >= 0.6 or same street number).
  3. For each log amputation: site has an inspection opened -7..+120 days from the event -> "same-period inspection".
     Then check related_activity: if that inspection has rel_type='R' (referral; severe injury reports go this way) -> "same-period referral inspection".
  4. Report both counts; no judgment on whether it was reported, only how many are found.
Output: out/l1_4_dol_reverse.json. Usage: python -I l1_4_dol_reverse.py"""
import sys, json, pathlib, re, difflib, datetime, collections
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'src'))
import dol

OUT = HERE.parent / 'out'
rev = json.load(open(OUT / 'l1_base_hard.json', encoding='utf-8'))['reverse_F']
STOP = {'inc', 'llc', 'co', 'corp', 'corporation', 'company', 'the', 'ltd', 'lp', 'dba', 'of', 'and'}


def norm(s):
    return ' '.join(t for t in re.sub(r'[^a-z0-9 ]', ' ', (s or '').lower()).split() if t not in STOP)


def d10(s):
    return datetime.date.fromisoformat(s[:10]) if s else None


zips = sorted({r['zip'] for r in rev if r['zip']})
F = ['activity_nr', 'estab_name', 'site_address', 'site_zip', 'open_date', 'insp_type']
insp = []
for i in range(0, len(zips), 15):
    part = zips[i:i + 15]
    off = 0
    while True:
        st, d = dol.get('OSHA', 'inspection', fields=F, limit=5000, offset=off,
                        filt={'and': [{'field': 'site_zip', 'operator': 'in', 'value': part},
                                      {'field': 'open_date', 'operator': 'gt', 'value': '2023-12-31'}]})
        if st != 200:
            raise SystemExit(f'inspection HTTP {st}: {d}')
        rows = d.get('data', [])
        insp += rows
        if len(rows) < 5000:
            break
        off += 5000
    print('zips', i + len(part), '/', len(zips), 'rows', len(insp), flush=True)

byzip = collections.defaultdict(list)
for r in insp:
    byzip[(r['site_zip'] or '')[:5]].append(r)


def same_site(case, r):
    sim = difflib.SequenceMatcher(None, norm(case['est_name'] + ' ' + case['company']), norm(r['estab_name'])).ratio()
    sim2 = difflib.SequenceMatcher(None, norm(case['est_name']), norm(r['estab_name'])).ratio()
    m1 = re.match(r'\s*(\d+)', case['address'] or '')
    m2 = re.match(r'\s*(\d+)', r['site_address'] or '')
    num = bool(m1 and m2 and m1.group(1) == m2.group(1))
    return max(sim, sim2) >= 0.6 or num, round(max(sim, sim2), 2), num


site_insp = {}
for c in rev:
    hits = []
    for r in byzip.get(c['zip'], []):
        ok, sim, num = same_site(c, r)
        if ok:
            hits.append(dict(activity_nr=int(r['activity_nr']), estab_name=r['estab_name'], open_date=(r['open_date'] or '')[:10],
                             insp_type=r['insp_type'], name_sim=sim, street_no_same=num))
    site_insp[c['establishment_id']] = hits

near = sorted({h['activity_nr'] for c in rev for h in site_insp[c['establishment_id']]
               if h['open_date'] and -7 <= (d10(h['open_date']) - d10(c['event_date'])).days <= 120})
rel = []
for i in range(0, len(near), 100):
    st, d = dol.get('OSHA', 'related_activity', limit=10000, filt={'field': 'activity_nr', 'operator': 'in', 'value': near[i:i + 100]})
    if st != 200:
        raise SystemExit(f'related_activity HTTP {st}: {d}')
    rel += d.get('data', [])
ref_acts = {int(r['activity_nr']) for r in rel if r['rel_type'] == 'R'}

rows = []
for c in rev:
    ev = d10(c['event_date'])
    hs = site_insp[c['establishment_id']]
    same_period = [h for h in hs if h['open_date'] and -7 <= (d10(h['open_date']) - ev).days <= 120]
    rows.append(dict(c, site_has_any_insp_since_2024=bool(hs), same_period=same_period,
                     same_period_referral=[h for h in same_period if h['activity_nr'] in ref_acts]))

summary = dict(cases=len(rows), sites=len({r['establishment_id'] for r in rows}),
               sites_with_any_insp_since_2024=len({r['establishment_id'] for r in rows if r['site_has_any_insp_since_2024']}),
               cases_same_period_insp=sum(bool(r['same_period']) for r in rows),
               cases_same_period_referral_insp=sum(bool(r['same_period_referral']) for r in rows),
               inspection_rows_pulled=len(insp))
print(json.dumps(summary))
json.dump(dict(method=__doc__, summary=summary, rows=rows), open(OUT / 'l1_4_dol_reverse.json', 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1, default=str)
