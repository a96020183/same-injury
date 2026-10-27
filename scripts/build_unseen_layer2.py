"""Second layer for the unseen company (seed 3001): the public files its plants' records are matched against.

  OSHA Severe Injury Reports, 2024, every report in the ZIP codes or towns of the company's plants
  DOL inspections opened from those reports' referral numbers (src/dol.py, cached), and OSHA's State Plan list
Then everything goes through scripts/deidentify.py with the same salted map as the company's tables, so a plant and
an OSHA report at the same real address get the same invented address. Employer names become codes: the four source
companies "Employer A-D", everyone else "Firm <hex>"; names inside narratives are replaced by "the employer".
Writes sample/unseen3001/public/ and the emulator catalog sample/unseen3001/full/ (sources named as on live Zetaris).
Build machine only (company pool and public SIR file). Usage: python -I scripts/build_unseen_layer2.py SIR.csv"""
import sys, csv, json, re, random, hashlib, pathlib, datetime, shutil
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(ROOT / 'src'))
import gen_composite as G  # noqa: E402
import deidentify  # noqa: E402
csv.field_size_limit(10 ** 9)

SEED, TAG = 3001, 'unseen3001'
SIR = sys.argv[1]
OUT = ROOT / 'sample' / TAG
PUB = OUT / 'public'
GENERIC = {'inc', 'llc', 'co', 'corp', 'corporation', 'company', 'the', 'of', 'and', 'ltd', 'lp', 'dba', 'usa', 'us', 'group', 'services', 'service',
           'holdings', 'enterprises', 'industries', 'international', 'america', 'american', 'national', 'foods', 'food', 'plant', 'facility'}
STNAME = {'AL': 'ALABAMA', 'AK': 'ALASKA', 'AZ': 'ARIZONA', 'AR': 'ARKANSAS', 'CA': 'CALIFORNIA', 'CO': 'COLORADO', 'CT': 'CONNECTICUT', 'DE': 'DELAWARE',
          'DC': 'DISTRICT OF COLUMBIA', 'FL': 'FLORIDA', 'GA': 'GEORGIA', 'HI': 'HAWAII', 'ID': 'IDAHO', 'IL': 'ILLINOIS', 'IN': 'INDIANA', 'IA': 'IOWA',
          'KS': 'KANSAS', 'KY': 'KENTUCKY', 'LA': 'LOUISIANA', 'ME': 'MAINE', 'MD': 'MARYLAND', 'MA': 'MASSACHUSETTS', 'MI': 'MICHIGAN', 'MN': 'MINNESOTA',
          'MS': 'MISSISSIPPI', 'MO': 'MISSOURI', 'MT': 'MONTANA', 'NE': 'NEBRASKA', 'NV': 'NEVADA', 'NH': 'NEW HAMPSHIRE', 'NJ': 'NEW JERSEY', 'NM': 'NEW MEXICO',
          'NY': 'NEW YORK', 'NC': 'NORTH CAROLINA', 'ND': 'NORTH DAKOTA', 'OH': 'OHIO', 'OK': 'OKLAHOMA', 'OR': 'OREGON', 'PA': 'PENNSYLVANIA', 'RI': 'RHODE ISLAND',
          'SC': 'SOUTH CAROLINA', 'SD': 'SOUTH DAKOTA', 'TN': 'TENNESSEE', 'TX': 'TEXAS', 'UT': 'UTAH', 'VT': 'VERMONT', 'VA': 'VIRGINIA', 'WA': 'WASHINGTON',
          'WV': 'WEST VIRGINIA', 'WI': 'WISCONSIN', 'WY': 'WYOMING'}

# the company, exactly as gen_composite drew it
all_idx = list(range(len(G.POOL)))
used = set()
for s in G.DEV:
    used.update(random.Random(s).sample(all_idx, 4))
_, ans = G.build(SEED, [i for i in all_idx if i not in used])
picks = ans['_pool_index_PRIVATE']
ests = [e for pi in picks for e in G.POOL[pi]['establishments']]
zips = {re.sub(r'\D', '', e['zip'])[:5] for e in ests}
towns = {(e['city'].strip().upper(), STNAME.get(e['state'], e['state'])) for e in ests}
import employer_codes as EC  # noqa: E402
# each source company's distinctive words: its filed company name (else the first site's name), minus generic words and
# minus every town of its sites (QA round 6: a hospital sharing a town word was coded as the company)
co_words = [EC.company_words(G.POOL[pi]['establishments'][0]['company'] or G.POOL[pi]['establishments'][0]['name'],
                             [e['city'] for e in G.POOL[pi]['establishments']]) for pi in picks]

rows = []
for r in csv.DictReader(open(SIR, encoding='utf-8', errors='replace', newline='')):
    try:
        if datetime.datetime.strptime(r['EventDate'].strip(), '%m/%d/%Y').year != 2024:
            continue
    except ValueError:
        continue
    z = re.sub(r'\D', '', r['Zip'] or '')[:5]
    if z in zips or ((r['City'] or '').strip().upper(), (r['State'] or '').strip().upper()) in towns:
        rows.append(r)
names = sorted({r['Employer'] for r in rows if r['Employer']})
words = sorted({w for n in names for w in re.findall(r'[A-Za-z][A-Za-z&\'-]{3,}', n) if w.lower() not in GENERIC} |
               {w for e in ests for w in re.findall(r'[A-Za-z][A-Za-z&\'-]{3,}', f"{e['name']} {e['company']}") if w.lower() not in GENERIC}, key=len, reverse=True)


def employer(n):
    return EC.employer_code(n, co_words)


def scrub(text):
    for w in words:
        text = re.sub(r'\b(' + re.escape(w.capitalize()) + '|' + re.escape(w.upper()) + '|' + re.escape(w) + r')\b', 'the employer', text or '')
    return text


COLS = ['ID', 'UPA', 'EventDate', 'Employer', 'Address1', 'City', 'State', 'Zip', 'Hospitalized', 'Amputation', 'Inspection',
        'Final Narrative', 'NatureTitle', 'Part of Body Title', 'EventTitle', 'SourceTitle', 'FederalState']
shutil.rmtree(PUB, ignore_errors=True)
PUB.mkdir(parents=True)


def write(p, rs, cols):
    with open(p, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rs)


write(PUB / 'osha_sir_2024.csv', [{**{k: (r.get(k) or '').strip() for k in COLS}, 'Employer': employer(r['Employer']), 'Final Narrative': scrub(r.get('Final Narrative'))} for r in rows], COLS)
shutil.copy(ROOT / 'sample/seed1003/reference/state_plans.csv', PUB / 'state_plans.csv')
import dol  # noqa: E402
upas = sorted({int(r['UPA']) for r in rows if (r['UPA'] or '').isdigit()})
rel, ins = [], []
for i in range(0, len(upas), 40):
    st, out = dol.get('OSHA', 'related_activity', filt={'and': [{'field': 'rel_act_nr', 'operator': 'in', 'value': upas[i:i + 40]}, {'field': 'rel_type', 'operator': 'eq', 'value': 'R'}]},
                      fields=['activity_nr', 'rel_type', 'rel_act_nr'], limit=200)
    rel += out.get('data', []) if st == 200 else []
acts = sorted({int(x['activity_nr']) for x in rel})
for i in range(0, len(acts), 40):
    st, out = dol.get('OSHA', 'inspection', filt={'field': 'activity_nr', 'operator': 'in', 'value': acts[i:i + 40]},
                      fields=['activity_nr', 'estab_name', 'site_address', 'site_city', 'site_state', 'site_zip', 'open_date', 'insp_type'], limit=200)
    ins += out.get('data', []) if st == 200 else []
write(PUB / 'related_activity.csv', [dict(activity_nr=x['activity_nr'], rel_type=x['rel_type'], rel_act_nr=x['rel_act_nr']) for x in rel], ['activity_nr', 'rel_type', 'rel_act_nr'])
ICOLS = ['activity_nr', 'estab_name', 'site_address', 'site_city', 'site_state', 'site_zip', 'open_date', 'insp_type']
write(PUB / 'inspection.csv', [dict(activity_nr=x['activity_nr'], estab_name=employer(x.get('estab_name')), site_address=x.get('site_address'), site_city=x.get('site_city'),
                                    site_state=x.get('site_state'), site_zip=x.get('site_zip'), open_date=(x.get('open_date') or '')[:10], insp_type=x.get('insp_type')) for x in ins], ICOLS)
deidentify.process(PUB, all_text=False)
import paraphrase  # noqa: E402
paraphrase.process(PUB)
import compose_records  # noqa: E402
compose_records.unseen_public()
print('SIR rows', len(rows), 'DOL related', len(rel), 'inspections', len(ins))

# emulator catalog with the live source names (scripts/load_company_zetaris.py): <tag>_pg, _paper, _my, _files, _hq, _public
FULL = OUT / 'full'
shutil.rmtree(FULL, ignore_errors=True)
NAME = {'postgres': 'pg', 'scan': 'paper', 'mysql': 'my', 'csv': 'files'}
cat = {'note': 'Emulator view of the unseen company: the same sources the company role sees on live Zetaris.', 'datasources': [], 'lightning': [],
       'policies': {f'{TAG}_public.severe_injury_reports': {'Employer': '[A-Za-z0-9]', 'Address1': '[A-Za-z]'}, f'{TAG}_public.inspection': {'estab_name': '[A-Za-z0-9]', 'site_address': '[A-Za-z]'}}}
groups = {}
for f in sorted((OUT / 'tables').glob('*.csv')):
    sysname, table = f.stem.split('__', 1)
    if sysname.startswith('plant_group_'):
        g, kind = sysname[len('plant_group_'):].split('-', 1)
        src, desc = f'{TAG}_{NAME[kind]}', f'plant group {g} ' + ('exports' if kind == 'csv' else 'system')
    else:
        kind, src, desc = 'csv', f'{TAG}_hq', 'headquarters shared drive'
    (FULL / src).mkdir(parents=True, exist_ok=True)
    shutil.copy(f, FULL / src / (table + '.csv'))
    groups[src] = (kind, desc)
for src, (kind, desc) in sorted(groups.items()):
    if kind == 'csv':
        cat['lightning'].append({'name': src, 'description': desc, 'tables': {p.stem.lower(): f'{src}/{p.name}' for p in sorted((FULL / src).glob('*.csv'))}})
    else:
        cat['datasources'].append({'name': src, 'description': desc, 'folder': src, 'engine': 'postgres' if kind != 'mysql' else 'mysql'})
(FULL / f'{TAG}_public').mkdir()
for p in PUB.glob('*.csv'):
    shutil.copy(p, FULL / f'{TAG}_public' / p.name)
cat['lightning'].append({'name': f'{TAG}_public', 'description': 'OSHA and DOL public files',
                         'tables': {'severe_injury_reports': f'{TAG}_public/osha_sir_2024.csv', 'state_plans': f'{TAG}_public/state_plans.csv',
                                    'inspection': f'{TAG}_public/inspection.csv', 'related_activity': f'{TAG}_public/related_activity.csv'}})
json.dump(cat, open(FULL / 'catalog.json', 'w', encoding='utf-8'), indent=1)
print('wrote', FULL.relative_to(ROOT))
