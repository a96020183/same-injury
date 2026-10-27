"""Why it matters: how many 2024 OSHA amputation reports have no amputation within 7 days in the log of the plant they
can be tied to (OSHA Severe Injury Reports x ITA 2024 case detail). Prints the counts README.md quotes (2,425 amputation
reports; 504 tied to a plant that files its log with OSHA; 145 of those with no log amputation within 7 days) and dumps
the hard-case list outside the repo. Written for this build (2026-10-22, from the team's own study notes of that day).
Only statistics: the step that groups companies and picks the demo and exam companies is not in this repository.
OSHA's Amputation and Hospitalized fields are counts (1.00, 2.00 ...): any value >= 1 counts.
Usage: python -I scripts/hardcases.py SIR.csv ITA2024_case.csv OUT.json   (OUT.json and OUT_hard.json: keep outside the repo)"""

import csv, sys, io, re, collections, datetime, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
csv.field_size_limit(10**9)
SIR, I24, OUT = sys.argv[1:4]
FED = {'AL','AR','CO','DE','DC','FL','GA','ID','KS','LA','ME','MA','MS','MO','MT','NE','NH','NJ','NY','ND','OH','OK','PA','RI','SD','TX','WV','WI','CT','IL'}
STNAME = {'AL':'ALABAMA','AR':'ARKANSAS','CO':'COLORADO','DE':'DELAWARE','DC':'DISTRICT OF COLUMBIA','FL':'FLORIDA','GA':'GEORGIA','ID':'IDAHO','KS':'KANSAS','LA':'LOUISIANA','ME':'MAINE','MA':'MASSACHUSETTS','MS':'MISSISSIPPI','MO':'MISSOURI','MT':'MONTANA','NE':'NEBRASKA','NH':'NEW HAMPSHIRE','NJ':'NEW JERSEY','NY':'NEW YORK','ND':'NORTH DAKOTA','OH':'OHIO','OK':'OKLAHOMA','PA':'PENNSYLVANIA','RI':'RHODE ISLAND','SD':'SOUTH DAKOTA','TX':'TEXAS','WV':'WEST VIRGINIA','WI':'WISCONSIN','CT':'CONNECTICUT','IL':'ILLINOIS'}
STOP = {"inc","llc","co","corp","corporation","company","the","of","and","ltd","lp","l","p","dba","us","usa","group","services","service","holdings","america","american","international","industries","enterprises","plant","facility"}
def toks(s): return {t for t in re.findall(r"[a-z0-9]+", (s or "").lower()) if t not in STOP and len(t) > 1}
def dt(s):
    for f in ("%m/%d/%Y", "%d%b%Y", "%Y-%m-%d"):
        try: return datetime.datetime.strptime((s or '').strip(), f).date()
        except Exception: pass
def _n(v):
    try: return float((v or '0').strip() or 0)
    except ValueError: return 0.0
def z5(z): return re.sub(r"\D", "", z or "")[:5]
def ov(a, b): return len(a & b) / max(1, min(len(a), len(b)))

sir = collections.defaultdict(list); sir_state = collections.defaultdict(list); sirs = []
for r in csv.DictReader(open(SIR, encoding='utf-8', errors='replace', newline='')):
    d = dt(r['EventDate'])
    if not d or d.year not in (2024, 2025): continue
    x = dict(id=r['ID'], d=d, tok=toks(r['Employer']), zip=z5(r['Zip']), state=r['State'].strip().upper(), addr=r['Address1'] or '',
             amp=_n(r['Amputation']) >= 1, part=(r['Part of Body'] or '').strip()[:2], ev=(r['Event'] or '').strip()[:2],
             src=(r['Source'] or '').strip()[:2], insp=(r['Inspection'] or '').strip(), hosp=_n(r['Hospitalized']) >= 1, emp=r['Employer'], city=r['City'], upa=r['UPA'], nar=(r['Final Narrative'] or '')[:600])
    sirs.append(x); sir[x['zip']].append(x); sir_state[x['state']].append(x)

AMP = re.compile(r'amputat', re.I)
NEG = re.compile(r'\b(no|not|near|almost|avoid\w*|prevent\w*|without)\b[^.]{0,25}amputat', re.I)
AMPX = re.compile(r'amput|severed|fingertip|tip of (his|her|the)', re.I)
MV = re.compile(r'\b(motor vehicle|vehicle accident|car accident|auto accident|mva|traffic|highway|interstate|rear[- ]ended|collision|semi[- ]truck|tractor[- ]trailer)\b', re.I)
DELAY = re.compile(r'\b(days? later|weeks? later|later (had|required|underwent)|subsequent(ly)?|infect\w*|revision)\b', re.I)

est = {}; cases = collections.defaultdict(list)
for r0 in csv.DictReader(open(I24, encoding='utf-8', errors='replace', newline='')):
    r = {k.lower(): v for k, v in r0.items()}
    e = r['establishment_id']
    if e not in est:
        est[e] = dict(naics=(r.get('naics_code') or '')[:4], name=r['establishment_name'].strip(), co=(r['company_name'] or '').strip(), ein=re.sub(r'\D', '', r.get('ein') or ''),
                      zip=z5(r['zip_code']), state=r['state'].strip().upper(), addr=r['street_address'].strip().lower(),
                      tok=toks(r['establishment_name']) | toks(r['company_name']))
    t = ' '.join(r.get(k) or '' for k in ('new_nar_what_happened','new_incident_description','new_nar_injury_illness','new_nar_object_substance','new_nar_before_incident'))
    cases[e].append(dict(d=dt(r['date_of_incident']), t=t, part=r.get('part_code_pred', ''), ev=r.get('event_code_pred', ''), src=r.get('source_code_pred', '')))
byzip = collections.defaultdict(list)
for e, i in est.items(): byzip[i['zip']].append(e)

def empmatch(s, i):
    j = ov(s['tok'], i['tok'])
    m = re.match(r'\d+', s['addr'])
    if m and i['addr'].startswith(m.group(0) + ' '): j += 0.5
    return j >= 0.6

loose = collections.Counter(); strict = collections.Counter()
logamp_rows = []
for e, cl in cases.items():
    i = est[e]
    if i['state'] not in FED: continue
    for k in cl:
        d = k['d']
        if not d or d.year != 2024: continue
        if not AMP.search(k['t']) or NEG.search(k['t']): continue
        loose['log_amp'] += 1; strict['log_amp'] += 1
        zs = sir.get(i['zip'], [])
        # loose (V6)
        if any(abs((s['d'] - d).days) <= 7 for s in zs): lv = 'A'
        elif any(abs((s['d'] - d).days) <= 30 for s in zs): lv = 'B'
        elif any(abs((s['d'] - d).days) <= 7 and ov(s['tok'], i['tok']) >= 0.6 for s in sir_state.get(STNAME.get(i['state'], ''), [])): lv = 'C'
        elif MV.search(k['t']) and not re.search(r'forklift|pallet jack', k['t'], re.I): lv = 'D'
        elif DELAY.search(k['t']): lv = 'E'
        else: lv = 'F'
        loose[lv] += 1
        # strict: SIR must be an amputation report and the employer must match
        if any(s['amp'] and abs((s['d'] - d).days) <= 7 and empmatch(s, i) for s in zs): sv = 'A'
        elif any(s['amp'] and abs((s['d'] - d).days) <= 30 and empmatch(s, i) for s in zs): sv = 'B'
        elif any(s['amp'] and abs((s['d'] - d).days) <= 7 and ov(s['tok'], i['tok']) >= 0.6 for s in sir_state.get(STNAME.get(i['state'], ''), [])): sv = 'C'
        elif MV.search(k['t']) and not re.search(r'forklift|pallet jack', k['t'], re.I): sv = 'D'
        elif DELAY.search(k['t']): sv = 'E'
        else: sv = 'F'
        strict[sv] += 1
        # loose matched by an SIR that is NOT an amputation or NOT this employer
        if lv in 'AB' and sv not in 'AB': strict['loose_AB_but_strict_' + sv] += 1


# ---------- V8 additions ----------
AVUL = re.compile(r'avuls', re.I)
def best_ests(s):
    sc = []
    for e in byzip.get(s['zip'], []):
        i = est[e]; j = ov(s['tok'], i['tok'])
        m = re.match(r'\d+', s['addr'])
        if m and i['addr'].startswith(m.group(0)): j += 0.5
        sc.append((j, e))
    if not sc: return [], 0
    b = max(x[0] for x in sc)
    return [e for j, e in sc if j == b], b
print('amputation reports 2024', sum(1 for s in sirs if s['d'].year == 2024 and s['amp']))
fwd = collections.Counter(); hard = []
for s in sirs:
    if s['d'].year != 2024 or not s['amp']: continue
    es, b = best_ests(s)
    if not es or b < 0.6: continue
    fwd['est_found'] += 1
    hit = any(k['d'] and abs((k['d'] - s['d']).days) <= 7 and AMPX.search(k['t']) for e in es for k in cases[e])
    if hit: fwd['found_ties_any'] += 1
    else:
        fwd['unmatched'] += 1; hard.append(s)
        if s['insp']: fwd['unmatched_with_inspection_no'] += 1
        if s['hosp']: fwd['unmatched_also_hospitalized'] += 1
# reverse strict-F list by establishment (for DOL lookup on day one)
revF = []
for e, cl in cases.items():
    i = est[e]
    if i['state'] not in FED: continue
    for k in cl:
        d = k['d']
        if not d or d.year != 2024 or not AMP.search(k['t']) or NEG.search(k['t']): continue
        zs = sir.get(i['zip'], [])
        if any(s['amp'] and abs((s['d'] - d).days) <= 30 and empmatch(s, i) for s in zs): continue
        if any(s['amp'] and abs((s['d'] - d).days) <= 7 and ov(s['tok'], i['tok']) >= 0.6 for s in sir_state.get(STNAME.get(i['state'], ''), [])): continue
        if MV.search(k['t']) and not re.search(r'forklift|pallet jack', k['t'], re.I): continue
        if DELAY.search(k['t']): continue
        revF.append((e, d, bool(AVUL.search(k['t']))))
fwd['reverse_strict_F'] = len(revF); fwd['reverse_strict_F_avulsion_word'] = sum(x[2] for x in revF)
fwd['reverse_strict_F_establishments'] = len({x[0] for x in revF})
print('forward/hard', dict(fwd))

json.dump(dict(forward_v8=dict(fwd)), open(OUT, 'w'), indent=1, default=str)

# ---------- day-one dump ----------
HARD = OUT.replace('.json', '_hard.json')
json.dump(dict(
  forward_hard=[dict(sir_id=s['id'], upa=s['upa'], event_date=str(s['d']), employer=s['emp'], address=s['addr'], city=s['city'], state=s['state'], zip=s['zip'],
                     inspection=s['insp'], narrative=s['nar']) for s in hard],
  reverse_F=[dict(establishment_id=e, est_name=est[e]['name'], company=est[e]['co'], address=est[e]['addr'], state=est[e]['state'], zip=est[e]['zip'],
                  ein=est[e]['ein'], event_date=str(d), avulsion=a) for e, d, a in revF]),
  open(HARD, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('dumped', HARD, len(hard), len(revF))
