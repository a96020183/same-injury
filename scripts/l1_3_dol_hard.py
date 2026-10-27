"""L1-3: look up DOL inspection records for each forward hard case (DOL API v4, OSHA dataset).

Join method (tested 2026-10-23):
  SIR's Inspection field is the 7-digit OIS number from the OSHA website, not the DOL API activity_nr (9 digits since 2024, e.g. 347603870).
  Querying it as activity_nr returns only 5 of 60, all other 1980s employers (number collisions); unusable.
  Correct join: SIR's UPA (severe injury report referral number)
           -> OSHA/related_activity: rel_type='R' and rel_act_nr = UPA -> activity_nr
           -> OSHA/inspection: activity_nr -> establishment name, address, zip, open date.
  Collision guard: counts as found only if open date is within -7..+365 days of the event and (zip matches or name similarity >= 0.5).
  Also pulls accident_injury (rel_insp_nr) to check for an OSHA-170 accident summary.

Sample: 145 forward unmatched cases recomputed by hardcases.py; the gate uses the 60 with an SIR inspection number; all 145 reported separately.
Output: out/l1_3_dol_hard.json (snapshot; no keys). Usage: python -I l1_3_dol_hard.py"""
import sys, json, pathlib, re, difflib, datetime
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'src'))
import dol

OUT = HERE.parent / 'out'
hard = json.load(open(OUT / 'l1_base_hard.json', encoding='utf-8'))['forward_hard']


def fetch_in(endpoint, field, values, chunk=100, extra=None):
    rows = []
    values = sorted(set(values))
    for i in range(0, len(values), chunk):
        f = {'field': field, 'operator': 'in', 'value': values[i:i + chunk]}
        if extra:
            f = {'and': [f] + extra}
        st, d = dol.get('OSHA', endpoint, filt=f, limit=10000)
        if st != 200:
            raise SystemExit(f'{endpoint} HTTP {st}: {d}')
        rows += d.get('data', [])
    return rows


def norm(s):
    s = re.sub(r'[^a-z0-9 ]', ' ', (s or '').lower())
    return ' '.join(t for t in s.split() if t not in {'inc', 'llc', 'co', 'corp', 'corporation', 'company', 'the', 'ltd', 'lp', 'dba'})


def d10(s):
    return datetime.date.fromisoformat(s[:10]) if s else None


# --- old join (kept to record why it fails)
with60 = [h for h in hard if h['inspection']]
naive = fetch_in('inspection', 'activity_nr', [int(h['inspection']) for h in with60])
naive_hits = [dict(activity_nr=r['activity_nr'], estab_name=r['estab_name'], open_date=r['open_date']) for r in naive]

# --- UPA join (all 145)
upas = [int(h['upa']) for h in hard if h['upa'].isdigit()]
rel = fetch_in('related_activity', 'rel_act_nr', upas, extra=[{'field': 'rel_type', 'operator': 'eq', 'value': 'R'}])
acts = sorted({int(r['activity_nr']) for r in rel})
insp = {int(r['activity_nr']): r for r in fetch_in('inspection', 'activity_nr', acts)}
inj = fetch_in('accident_injury', 'rel_insp_nr', acts) if acts else []

rows = []
for h in hard:
    ev = d10(h['event_date'])
    cands = []
    for r in rel:
        if h['upa'].isdigit() and int(r['rel_act_nr']) == int(h['upa']):
            i = insp.get(int(r['activity_nr']))
            if not i:
                cands.append(dict(activity_nr=int(r['activity_nr']), inspection_row=False))
                continue
            od = d10(i['open_date'])
            sim = round(difflib.SequenceMatcher(None, norm(h['employer']), norm(i['estab_name'])).ratio(), 2)
            zs = (i['site_zip'] or '')[:5] == h['zip']
            ok_date = bool(od and -7 <= (od - ev).days <= 365)
            cands.append(dict(activity_nr=int(r['activity_nr']), inspection_row=True, estab_name=i['estab_name'], site_address=i['site_address'],
                              site_zip=(i['site_zip'] or '')[:5], open_date=i['open_date'][:10] if i['open_date'] else None,
                              insp_type=i.get('insp_type'), zip_same=zs, name_sim=sim, days_after_event=(od - ev).days if od else None,
                              verified=ok_date and (zs or sim >= 0.5),
                              accident_rows=sum(int(x['rel_insp_nr']) == int(r['activity_nr']) for x in inj)))
    rows.append(dict(sir_id=h['sir_id'], upa=h['upa'], sir_inspection_field=h['inspection'], event_date=h['event_date'],
                     sir_employer=h['employer'], sir_zip=h['zip'], has_sir_inspection_no=bool(h['inspection']),
                     linked=bool(cands), found=any(c.get('verified') for c in cands), candidates=cands))


def summ(rs):
    return dict(cases=len(rs), linked_by_upa=sum(r['linked'] for r in rs), found_verified=sum(r['found'] for r in rs),
                zip_same=sum(any(c.get('zip_same') for c in r['candidates']) for r in rs),
                with_accident_summary=sum(any(c.get('accident_rows') for c in r['candidates']) for r in rs))


s60 = summ([r for r in rows if r['has_sir_inspection_no']])
s60['gate'] = 'PASS' if s60['found_verified'] >= 40 else 'FAIL'
s60['threshold'] = '>=40 of 60'
s145 = summ(rows)
s145_noinsp = summ([r for r in rows if not r['has_sir_inspection_no']])
print('naive Inspection=activity_nr hits:', len(naive_hits))
print('gate 60:', json.dumps(s60))
print('all 145:', json.dumps(s145))
print('85 without SIR inspection no:', json.dumps(s145_noinsp))
json.dump(dict(method=__doc__, gate60=s60, all145=s145, no_insp_no_85=s145_noinsp,
               naive_activity_nr_hits=naive_hits, rows=rows,
               raw=dict(related_activity=rel, inspection=list(insp.values()), accident_injury=inj)),
          open(OUT / 'l1_3_dol_hard.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=str)
