"""Build the SAMPLE_MODE slice for the demo composite company (seed 1003).

Default output: sample/seed1003/ (committed). Identities are PSEUDONYMIZED: the four companies become Employer A-D
(token by token, so spelling variants survive: "<company> Food Solutions, LLC" -> "Employer C Food Solutions, LLC"),
every other employer and DOL establishment becomes "Employer <4 hex>", EINs become EIN-A..EIN-D. Then scripts/deidentify.py
replaces names with whole-string codes ("Employer A", "Firm 3F2A"), every address, town, ZIP and OSHA/DOL record number.
Dates, injuries and narratives as published at this step; scripts/compose_records.py then shifts, recodes and rewrites them,
drops the real cases that would end negative and adds the generated SYNTHETIC records (scripts/gen_synthetic.py).
--real: writes the same slice with the published names to data/real_seed1003/ (git-ignored) for local live runs.

Inputs (not in the repo; scripts/fetch_public_data.py downloads the public files):
  data/composite/1003/*.csv, data/composite/pool_PRIVATE.json   from scripts/gen_composite.py and the private pool tool (not in the repo)
  data/private/pseudonym_config_PRIVATE.json                      the real-name -> code mapping (never committed)
  OSHA Severe Injury Reports CSV                                  argv[1]
DOL snapshot: OSHA inspection + related_activity rows through src/dol.py (cached; key never written).
Usage: python -I scripts/build_sample.py SIR.csv [--real] [--no-dol]"""
import sys, csv, json, re, random, hashlib, pathlib, datetime, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
csv.field_size_limit(10 ** 9)
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
SEED = 1003
COMP = ROOT / 'data' / 'composite' / str(SEED)
REAL = '--real' in sys.argv
OUT = ROOT / ('data/real_seed1003' if REAL else f'sample/seed{SEED}')
SIR = sys.argv[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from compose_records import real  # noqa: E402  (real plant codes come from the private file)
NO_DOL = '--no-dol' in sys.argv

# Private-sector OSHA State Plan states (osha.gov/stateplans). CT, IL, ME, NJ, NY (and VI) cover public employees only,
# so private employers there are under federal OSHA and report to the federal Severe Injury file.
from osha_states import STATE_PLAN_PRIVATE  # noqa: E402  (one list for every script)
STNAME = {'AL': 'ALABAMA', 'AR': 'ARKANSAS', 'CO': 'COLORADO', 'DE': 'DELAWARE', 'FL': 'FLORIDA', 'GA': 'GEORGIA', 'IL': 'ILLINOIS',
          'IA': 'IOWA', 'IN': 'INDIANA', 'MI': 'MICHIGAN', 'MO': 'MISSOURI', 'NM': 'NEW MEXICO', 'OH': 'OHIO', 'TN': 'TENNESSEE',
          'VT': 'VERMONT', 'TX': 'TEXAS', 'WI': 'WISCONSIN'}

pool = json.load(open(ROOT / 'data' / 'composite' / 'pool_PRIVATE.json', encoding='utf-8'))['pool']
ans = json.load(open(COMP / 'answers_PRIVATE.json', encoding='utf-8'))
picks = ans['_pool_index_PRIVATE']
CFG = json.load(open(ROOT / 'data' / 'private' / 'pseudonym_config_PRIVATE.json', encoding='utf-8'))
PHRASES = [(re.compile(r'\b' + r'\s+'.join(map(re.escape, p.split())) + r'\b', re.I), code) for p, code in CFG['phrases']]
GENERIC = {'inc', 'llc', 'co', 'corp', 'corporation', 'company', 'the', 'of', 'and', 'ltd', 'lp', 'dba', 'usa', 'us', 'group', 'services',
           'service', 'holdings', 'enterprises', 'industries', 'international', 'america', 'american', 'national', 'llp', 'pc'}


def company(s):
    """the four companies' names -> Employer A-D (keeps the rest of the string: suffixes, 'dba', punctuation)"""
    if not s or REAL:
        return s
    for rx, code in PHRASES:
        s = rx.sub(lambda m: code.upper() if m.group(0).isupper() else code, s)
    return s


def norm(s):
    return ' '.join(t for t in re.findall(r'[a-z0-9]+', (s or '').lower()) if t not in GENERIC)


def employer(s):
    """any employer string: one of the four companies -> its code; any other -> 'Employer <hash>' (same name -> same code)"""
    if not s or REAL:
        return s
    c = company(s)
    if c != s:
        return c
    return 'Employer ' + hashlib.sha256(('l1|' + norm(s)).encode()).hexdigest()[:4].upper()


def scrub_text(text, names):
    """free text: the four companies' names -> codes (other proper names are handled by scrub_proper)"""
    if not text or REAL:
        return text
    return company(text)


# ---------------------------------------------------------------- plant groups
mask = lambda e: 'Site-' + hashlib.sha256(f'{SEED}|{e}'.encode()).hexdigest()[:4].upper()
real_by_code = {}
for g, pi in zip('ABCD', picks):
    for e in pool[pi]['establishments']:
        real_by_code[mask(e['establishment_id'])] = dict(e, grp=g)

SYS = {'A': 'group_a_postgres', 'B': 'group_b_mysql', 'C': 'group_c_csv', 'D': 'group_d_scan'}
KIND = {'A': 'postgres', 'B': 'mysql', 'C': 'csv', 'D': 'scan'}


def read_csv(p):
    with open(p, encoding='utf-8', newline='') as f:
        return list(csv.DictReader(f))


def write_csv(p, rows, cols=None):
    p.parent.mkdir(parents=True, exist_ok=True)
    cols = cols or (list(rows[0]) if rows else [])
    with open(p, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)


def date_key(v, fmt):
    try:
        return datetime.datetime.strptime(v, fmt)
    except (ValueError, TypeError):
        return datetime.datetime.max


for g in 'ABCD':
    for f in sorted(COMP.glob(f'plant_group_{g}-{KIND[g]}__*.csv')):
        table = f.stem.split('__', 1)[1]
        rows = read_csv(f)
        if table == 'sites':
            rows = [dict(code=r['code'], plant_name=company(real_by_code[r['code']]['name']), legal_name=company(real_by_code[r['code']]['company']),
                         street=r['street'], city=r['city'], state=r['state'], zip=r['zip'],
                         ein=(r['ein'] if REAL else (CFG['ein_by_group'][g] if r['ein'] else ''))) for r in rows]
        if g == 'B' and table == 'inc_rpt':
            # plant group B's system exports its log sorted by incident date (day-first dates)
            rows.sort(key=lambda r: date_key(r['inc_dt'], '%d/%m/%Y'))
        write_csv(OUT / SYS[g] / f'{table}.csv', rows)
write_csv(OUT / 'shared' / 'annual_summary_300A.csv', read_csv(COMP / 'minio-csv__annual_summary_300A.csv'))

# The real plant-log amputations and OSHA reports that would end in a negative conclusion are dropped later
# (scripts/compose_records.py drop_real(), keys in the private file); nothing of them is rewritten into a synthetic
# record. Every SYNTHETIC record is generated from a seed alone (scripts/gen_synthetic.py, QA round 9).

# ---------------------------------------------------------------- SIR slice (2024)
zips = {e['zip'] for e in real_by_code.values()}
states = {STNAME.get(e['state'], e['state']) for e in real_by_code.values()}
company_rx = [rx for rx, _ in PHRASES]


def d(s):
    try:
        return datetime.datetime.strptime(s.strip(), '%m/%d/%Y').date()
    except ValueError:
        return None


near, named, other = [], [], []
for r in csv.DictReader(open(SIR, encoding='utf-8', errors='replace', newline='')):
    dd = d(r['EventDate'])
    if not dd or dd.year != 2024:
        continue
    z = re.sub(r'\D', '', r['Zip'] or '')[:5]
    if z in zips:
        near.append(r)
    elif any(rx.search(r['Employer'] or '') for rx in company_rx):
        named.append(r)
    elif r['State'].strip().upper() in states:
        other.append(r)
rnd2 = random.Random(SEED + 1)
background = rnd2.sample(other, min(220, len(other)))
SIRCOLS = ['ID', 'UPA', 'EventDate', 'Employer', 'Address1', 'City', 'State', 'Zip', 'Hospitalized', 'Amputation', 'Inspection',
           'Final Narrative', 'NatureTitle', 'Part of Body Title', 'EventTitle', 'SourceTitle', 'FederalState']
src_rows = sorted(near + named + background, key=lambda x: x['ID'])
all_employers = sorted({r['Employer'] for r in src_rows if r['Employer']})
# proper-noun words of every employer in the slice: removed from all narratives where they appear capitalized
_lower_corpus = ' '.join((r.get('Final Narrative') or '') for r in src_rows)
# brand-like words only: a name word that never appears in lower case in the narratives is a proper noun
NAME_WORDS = sorted({w for n in all_employers for w in re.findall(r'[A-Za-z][A-Za-z&\'-]{3,}', n)
                     if w.lower() not in GENERIC and not re.search(r'\b' + re.escape(w.lower()) + r'\b', _lower_corpus)}, key=len, reverse=True)


def scrub_proper(text):
    if not text or REAL:
        return text
    for w in NAME_WORDS:
        text = re.sub(r'\b(' + re.escape(w.capitalize()) + '|' + re.escape(w.upper()) + r')\b', 'the employer', text)
    return text
sir_rows = []
for r in src_rows:
    row = {k: (r.get(k) or '').strip() for k in SIRCOLS}
    row['Employer'] = employer(r['Employer'])
    row['Final Narrative'] = scrub_proper(scrub_text(r.get('Final Narrative'), [r['Employer']]))
    if not REAL and r in background:
        # background rows only fill the table; their street names (some carry a company name) are not needed
        row['Address1'] = (re.match(r'\s*(\d+)', r['Address1'] or '') or [None, ''])[1] + ' (street withheld)'
    sir_rows.append(row)
write_csv(OUT / 'shared' / 'osha_sir_2024.csv', sir_rows, SIRCOLS)
print('SIR slice', len(sir_rows), 'near', len(near), 'same-company', len(named), 'background', len(background))

# ---------------------------------------------------------------- reply letters
# the table starts empty: its one SYNTHETIC letter is generated with the invented plants (scripts/gen_synthetic.py)
write_csv(OUT / 'shared' / 'reply_letters.csv', [], ['doc_id', 'site', 'sent_on', 'subject', 'body', 'synthetic'])
write_csv(OUT / 'reference' / 'state_plans.csv', [dict(state=s, covers_private_sector='true') for s in STATE_PLAN_PRIVATE])

# ---------------------------------------------------------------- DOL snapshot
dol_names = []
if not NO_DOL:
    import dol
    upas = sorted({int(r['UPA']) for r in near + named if (r['UPA'] or '').isdigit()})
    rel = []
    for i in range(0, len(upas), 40):
        st, out = dol.get('OSHA', 'related_activity', filt={'and': [{'field': 'rel_act_nr', 'operator': 'in', 'value': upas[i:i + 40]},
                                                                    {'field': 'rel_type', 'operator': 'eq', 'value': 'R'}]},
                          fields=['activity_nr', 'rel_type', 'rel_act_nr'], limit=200)
        rel += out.get('data', []) if st == 200 else []
    acts = sorted({int(x['activity_nr']) for x in rel})
    ins = []
    for i in range(0, len(acts), 40):
        st, out = dol.get('OSHA', 'inspection', filt={'field': 'activity_nr', 'operator': 'in', 'value': acts[i:i + 40]},
                          fields=['activity_nr', 'estab_name', 'site_address', 'site_city', 'site_state', 'site_zip', 'open_date', 'insp_type'], limit=200)
        ins += out.get('data', []) if st == 200 else []
    dol_names = [x.get('estab_name') for x in ins]
    write_csv(OUT / 'dol' / 'related_activity.csv', [dict(activity_nr=x['activity_nr'], rel_type=x['rel_type'], rel_act_nr=x['rel_act_nr']) for x in rel],
              ['activity_nr', 'rel_type', 'rel_act_nr'])
    write_csv(OUT / 'dol' / 'inspection.csv', [dict(activity_nr=x['activity_nr'], estab_name=employer(x.get('estab_name')), site_address=x.get('site_address'),
                                                    site_city=x.get('site_city'), site_state=x.get('site_state'), site_zip=x.get('site_zip'),
                                                    open_date=(x.get('open_date') or '')[:10], insp_type=x.get('insp_type')) for x in ins],
              ['activity_nr', 'estab_name', 'site_address', 'site_city', 'site_state', 'site_zip', 'open_date', 'insp_type'])
    print('DOL related', len(rel), 'inspections', len(ins), 'from UPAs', len(upas))

# ---------------------------------------------------------------- manifest + leak check
man = {}
for p in sorted(OUT.rglob('*.csv')):
    man[p.relative_to(OUT).as_posix()] = dict(rows=sum(1 for _ in open(p, encoding='utf-8')) - 1, sha256=hashlib.sha256(p.read_bytes()).hexdigest())
note = ('Public OSHA and DOL records of four companies, re-sharded into four plant systems. ' +
        ('Published names (local use only, not committed).' if REAL else
         'Identities pseudonymized: Employer A-D, other employers "Employer <hex>", EIN-A..D. Dates, injuries, addresses and record numbers as published.') +
        ' Reply letters are synthetic.')
json.dump(dict(seed=SEED, note=note, files=man), open(OUT / 'MANIFEST.json', 'w', encoding='utf-8'), indent=1)
if not REAL:
    # second pass: addresses, towns, ZIPs and every OSHA/DOL record number -> consistent codes (mapping stays in data/private)
    # invented town names must not be real places: list every city in the public SIR file and the DOL snapshot (private file)
    places = {(r.get('City') or '').strip().upper() for r in csv.DictReader(open(SIR, encoding='utf-8', errors='replace', newline=''))}
    for f in (ROOT / 'data/dol/cache').glob('*.json'):
        d = json.load(open(f, encoding='utf-8'))
        places |= {(x.get('site_city') or '').strip().upper() for x in (d.get('data', []) if isinstance(d, dict) else d) if isinstance(x, dict)}
    (ROOT / 'data/private/real_places_PRIVATE.txt').write_text(chr(10).join(sorted(p for p in places if p)), encoding='utf-8')
    sys.path.insert(0, str(ROOT / 'scripts'))
    import deidentify  # noqa: E402
    deidentify.process(OUT)
    # no published sentence stays in the repo: every narrative is rewritten (side, body part, mechanism, outcome kept)
    import paraphrase  # noqa: E402
    paraphrase.process(OUT)
    # every distinctive word of every real name in this slice must be gone (city names are addresses, not identities)
    cities = {w.lower() for e in real_by_code.values() for w in re.findall(r'[A-Za-z]+', e['city'])} | \
             {w.lower() for r in src_rows for w in re.findall(r'[A-Za-z]+', r['City'] or '')}
    names = all_employers + [x for x in dol_names if x] + [e['name'] for e in real_by_code.values()] + [e['company'] for e in real_by_code.values()]
    words = {w for n in names for w in re.findall(r'[A-Za-z][A-Za-z&\'-]{3,}', n or '')}
    words = {w for w in words if w.lower() not in GENERIC and w.lower() not in cities}
    blob = '\n'.join(p.read_text(encoding='utf-8') for p in OUT.rglob('*.csv'))
    # a name word is a leak where it appears as a proper noun (Capitalized or UPPER), not as an ordinary lower-case word
    hits = sorted({w for w in words if re.search(r'\b(' + re.escape(w.capitalize()) + '|' + re.escape(w.upper()) + r')\b', blob)})
    print('distinct name words checked', len(words), 'still present', len(hits))
    json.dump(dict(still_present=hits), open(ROOT / 'data' / 'private' / 'leakcheck_PRIVATE.json', 'w', encoding='utf-8'), indent=1)
if not REAL:
    import compose_records  # noqa: E402
    compose_records.seed1003()
print('wrote', OUT, len(man), 'files')
