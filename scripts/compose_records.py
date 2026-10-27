"""Make every record in a repo sample a composite that cannot be filtered back to one real employer, while keeping
every relation the agents match on (the same gaps in days, the same addresses, the same State Plan coverage):

  dates   every incident, OSHA report, DOL inspection and reply-letter date moves by the same number of days, so
          "same week" stays "same week" and "12 days later" stays "12 days later"
  states  every state is swapped for another one of the same kind (federal OSHA for federal OSHA, State Plan for State
          Plan), the same way in every table (sites, OSHA reports, DOL inspections)
  The shift and the state swap are different for each company and live only in data/private/compose_PRIVATE.json
  (not in the repo). A shift can still be guessed from the published files, so it is not what protects anyone:
  cases   every real case that would end in a "no matching report" or "not in this company's log" conclusion is
          DROPPED (keys in the private file); nothing of it is rewritten. The SYNTHETIC records in the invented plants
          are generated from a seed alone by scripts/gen_synthetic.py, which reads no file.
  fields  on a real plant's log line the case number is a code, the job title a job family, the injury wording
          restated, the days away invented; 300A employees, hours and days are invented and case counts equal the log.
scripts/scan_identity.py attacks the result the way someone holding the public files would. Usage:
python -I scripts/compose_records.py seed1003|unseen_tables|unseen_public (the builders call them) | synthetic (re-apply
the generated records and the field recoding to the committed samples)"""
import sys, csv, json, re, random, datetime, pathlib
csv.field_size_limit(10 ** 9)
ROOT = pathlib.Path(__file__).resolve().parents[1]
SHIFT = 0  # set by configure() from the private file
sys.path.insert(0, str(ROOT / 'scripts'))
from osha_states import STATE_PLAN_PRIVATE, FEDERAL, NAME  # noqa: E402  (one list for every script)
# states are swapped within each kind; Puerto Rico (a territory) is not part of the swap
STATE_PLAN = [s for s in STATE_PLAN_PRIVATE if s != 'PR']
BYNAME = {v: k for k, v in NAME.items()}


def real(k):
    """a real plant's code, from the private file: which real plants' lines were replaced by synthetic ones is not in the repo"""
    return json.loads((ROOT / 'data' / 'private' / 'compose_PRIVATE.json').read_text(encoding='utf-8'))['real_keys'][k]


def derange(xs, seed):
    rnd = random.Random(seed)
    while True:
        ys = xs[:]
        rnd.shuffle(ys)
        if all(a != b for a, b in zip(xs, ys)):
            return dict(zip(xs, ys))


PERM: dict = {}


def configure(company):
    """the company's own shift and state swap, from data/private/compose_PRIVATE.json (never in the repo)"""
    global SHIFT, PERM
    cfg = json.loads((ROOT / 'data' / 'private' / 'compose_PRIVATE.json').read_text(encoding='utf-8'))[company]
    SHIFT = int(cfg['shift'])
    PERM = {**derange(FEDERAL, cfg['federal']), **derange(STATE_PLAN, cfg['state_plan'])}


def st_abbr(v):
    return PERM.get(v.strip().upper(), v) if v else v


def st_name(v):
    a = BYNAME.get((v or '').strip().upper())
    return NAME[PERM[a]] if a in PERM else v


FMT = {'iso': '%Y-%m-%d', 'mdy': '%m/%d/%Y', 'dmy': '%d/%m/%Y', 'mdy2': '%m/%d/%y', 'ymd': '%Y%m%d', 'dby': '%d-%b-%Y'}


def shift(v, fmt):
    if not v:
        return v
    if fmt == 'us':  # OSHA's M/D/YYYY without zero padding
        try:
            d = datetime.datetime.strptime(v.strip(), '%m/%d/%Y').date() + datetime.timedelta(days=SHIFT)
            return f'{d.month}/{d.day}/{d.year}'
        except ValueError:
            return v
    try:
        d = datetime.datetime.strptime(v.strip(), FMT.get(fmt, fmt)) + datetime.timedelta(days=SHIFT)
        return d.strftime(FMT.get(fmt, fmt))
    except ValueError:
        return v


def shift_text(t):
    """dates written inside a transcribed line: "Case 11 on 05/21/2024." """
    return re.sub(r'\b(\d{2}/\d{2}/\d{4})\b', lambda m: shift(m.group(1), 'mdy'), t or '')


def rewrite(p, drop=lambda r: False, add=()):
    """drop rows, append rows (a fully invented record replaces a published one: nothing of the published row survives)"""
    with open(p, encoding='utf-8', newline='') as f:
        rd = csv.DictReader(f)
        rows = list(rd)
        cols = list(rd.fieldnames or [])
    rows = [r for r in rows if not drop(r)] + [{c: a.get(c, '') for c in cols} for a in add]
    with open(p, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)


def rw(p, fn):
    with open(p, encoding='utf-8', newline='') as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return
    cols = list(rows[0])
    for r in rows:
        fn(r)
    with open(p, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)


def public(folder_sir, folder_dol, letters=None):
    def sir(r):
        r['EventDate'] = shift(r['EventDate'], 'us')
        r['State'] = st_name(r['State'])
    rw(folder_sir, sir)
    if folder_dol:
        def ins(r):
            r['open_date'] = shift(r['open_date'], 'iso')
            r['site_state'] = st_abbr(r['site_state'])
        rw(folder_dol, ins)
    if letters and letters.exists():
        def let(r):
            r['sent_on'] = shift(r['sent_on'], 'iso')
        rw(letters, let)


def sites(p):
    def f(r):
        r['state'] = st_abbr(r['state'])
    rw(p, f)



def seed1003():
    """the demo company: shift the dates, swap the states, drop the real cases that would end negative, then the
    generated SYNTHETIC records and the QA 8 recoding (finish_seed)"""
    configure('seed1003')
    S = ROOT / 'sample' / 'seed1003'
    for g in ('group_a_postgres', 'group_b_mysql', 'group_c_csv', 'group_d_scan'):
        sites(S / g / 'sites.csv')
    rw(S / 'group_a_postgres' / 'injury_log.csv', lambda r: r.update(date_of_injury=shift(r['date_of_injury'], 'iso')))
    rw(S / 'group_b_mysql' / 'inc_rpt.csv', lambda r: r.update(inc_dt=shift(r['inc_dt'], 'dmy')))
    rw(S / 'group_c_csv' / 'EHS_Export_2024.csv', lambda r: r.update({'Incident Date': shift(r['Incident Date'], 'mdy2')}))
    rw(S / 'group_d_scan' / 'scanned_log_transcribed.csv', lambda r: r.update(transcribed_text=shift_text(r['transcribed_text'])))
    public(S / 'shared' / 'osha_sir_2024.csv', S / 'dol' / 'inspection.csv', S / 'shared' / 'reply_letters.csv')
    drop_real('seed1003')
    finish_seed()
    print('seed1003: dates shifted, states swapped')


def unseen_tables():
    configure('unseen3001')
    U = ROOT / 'sample' / 'unseen3001'
    ans = json.load(open(U / 'answers.json', encoding='utf-8'))
    for key, role in ans['tables'].items():
        f = U / 'tables' / (key.replace('/', '__').replace(':', '-') + '.csv')
        if role == 'site_master':
            sites(f)
        if role != 'incident':
            continue
        m = ans['field_map'][key]
        if m.get('date') == m.get('narrative'):  # transcribed paper log: date and case inside the text
            rw(f, lambda r, col=m['narrative']: r.update({col: shift_text(r[col])}))
        else:
            rw(f, lambda r, m=m, fmt=m.get('_date_format', '%Y-%m-%d'): r.update({m['date']: shift(r[m['date']], fmt)}))
    print('unseen3001 tables: dates shifted, states swapped')


def unseen_public():
    configure('unseen3001')
    U = ROOT / 'sample' / 'unseen3001'
    public(U / 'public' / 'osha_sir_2024.csv', U / 'public' / 'inspection.csv')
    drop_real('unseen3001')
    finish_unseen()
    print('unseen3001 public files: dates shifted, states swapped')


# ---------------------------------------------------------------------------------------------------------------- QA 9
# The real cases that would end in a negative conclusion are DROPPED, never rewritten (keys in the private file). Every
# SYNTHETIC record comes from scripts/gen_synthetic.py, which reads nothing but a seed.
def drop_real(company):
    """remove the real log lines, OSHA reports and DOL inspections listed in the private file (used on a fresh build;
    a no-op on the committed samples, where they are already gone)"""
    keys = json.loads((ROOT / 'data' / 'private' / 'compose_PRIVATE.json').read_text(encoding='utf-8'))['drop'][company]
    logs = {(real(k), c) for k, c in keys['logs']}
    reps, ins = set(keys['reports']), set(keys['inspections'])
    for f in (ROOT / 'sample' / company).rglob('*.csv'):
        if 'full' in f.parts:
            continue
        with open(f, encoding='utf-8', newline='') as h:
            head = next(csv.reader(h), [])
        if 'ID' in head:
            rewrite(f, drop=lambda r: r['ID'] in reps)
        elif 'activity_nr' in head and 'estab_name' in head:
            rewrite(f, drop=lambda r: r['activity_nr'] in ins)
        elif 'activity_nr' in head:
            rewrite(f, drop=lambda r: r['activity_nr'] in ins)
        elif 'transcribed_text' in head:
            rewrite(f, drop=lambda r: (r['site'], (re.match(r'Case (\S+) on', r['transcribed_text']) or [None, ''])[1]) in logs)
        else:
            sc = next((c for c in head if c in ('establishment', 'plant_id', 'Site Name', 'plant', 'f9')), None)
            cc = next((c for c in head if c in ('case_number', 'rec_id', 'Case #', 'log_line', 'f8')), None)
            if sc and cc:
                rewrite(f, drop=lambda r, sc=sc, cc=cc: (r[sc], r[cc]) in logs)


def _mdY(d):
    return datetime.date.fromisoformat(d).strftime('%m/%d/%Y')


SYN_ID = ('Site-SYN', 'SIR-SYN', 'DOL-SYN', 'LTR-SYN')


def _syn(v):
    return str(v or '').startswith(SYN_ID)


def _write(path, cols, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows([{c: r.get(c, '') for c in cols} for r in rows])


SYN_SITE_COLS = ['code', 'plant_name', 'legal_name', 'street', 'city', 'state', 'zip', 'ein']
SYN_LOG_COLS = ['case_no', 'site', 'injury_date', 'body_part', 'description', 'injury', 'outcome', 'days_away', 'job_title']
# QA round 10: every invented plant sits in one synthetic test system of its own (its own source and tables, named after
# nothing real), never in a real employer's plant system
SYN_SOURCE = {'seed1003': 'synthetic_csv', 'unseen3001': 'synthetic-csv__'}


def _syn_logs(gen):
    return [{'case_no': ln['case'], 'site': ln['site'], 'injury_date': ln['date'], 'body_part': ln['body'], 'description': ln['text'], 'injury': ln['injury'],
             'outcome': ln['outcome'], 'days_away': ln['days'], 'job_title': ln['job']} for ln in gen['logs']]


def add_synthetic(company):
    """remove every SYNTHETIC row and invented plant from wherever they are, then write the generated ones into the
    synthetic test system (idempotent)"""
    import gen_synthetic
    gen = gen_synthetic.generate()[company]
    root = ROOT / 'sample' / company
    # no invented plant or synthetic line stays in a real plant system
    for f in sorted(root.rglob('*.csv')):
        if 'full' in f.parts or 'synthetic' in f.name or 'synthetic' in f.parts[-2]:
            continue
        with open(f, encoding='utf-8', newline='') as h:
            head = next(csv.reader(h), [])
        sc = next((c for c in ('code', 'site', 'establishment', 'plant_id', 'Site Name', 'plant', 'f9') if c in head), None)
        if sc and 'Establishment' not in head and 'doc_id' not in head:
            rewrite(f, drop=lambda r, sc=sc: _syn(r[sc]))
    sites = [{'code': p['code'], 'plant_name': p['plant_name'], 'legal_name': p['legal_name'], 'street': p['street'], 'city': p['city'], 'state': p['state'],
              'zip': p['zip'], 'ein': ''} for p in gen['plants']]
    if company == 'seed1003':
        _write(root / 'synthetic_csv' / 'sites.csv', SYN_SITE_COLS, sites)
        _write(root / 'synthetic_csv' / 'injury_log.csv', SYN_LOG_COLS, _syn_logs(gen))
        sir, ins, rel, s300 = root / 'shared' / 'osha_sir_2024.csv', root / 'dol' / 'inspection.csv', root / 'dol' / 'related_activity.csv', root / 'shared' / 'annual_summary_300A.csv'
        rewrite(root / 'shared' / 'reply_letters.csv', drop=lambda r: True, add=gen['letters'])
    else:
        # the unseen company's plant tables carry no names; its synthetic site table neither
        _write(root / 'tables' / 'synthetic-csv__sites.csv', ['code', 'street', 'city', 'state', 'zip', 'ein'], sites)
        _write(root / 'tables' / 'synthetic-csv__injury_log.csv', SYN_LOG_COLS, _syn_logs(gen))
        sir, ins, rel, s300 = root / 'public' / 'osha_sir_2024.csv', root / 'public' / 'inspection.csv', root / 'public' / 'related_activity.csv', root / 'tables' / 'minio-csv__yr_totals.csv'
    rewrite(sir, drop=lambda r: _syn(r['ID']), add=gen['reports'])
    rewrite(ins, drop=lambda r: _syn(r['activity_nr']), add=[{k: v for k, v in i.items() if k != 'upa'} for i in gen['inspections']])
    rewrite(rel, drop=lambda r: _syn(r['activity_nr']), add=[{'activity_nr': i['activity_nr'], 'rel_type': 'R', 'rel_act_nr': i['upa']} for i in gen['inspections']])
    rewrite(s300, drop=lambda r: _syn(r['Establishment']), add=[{'Establishment': p['code'], 'Annual Average Employees': str(p['employees']),
            'Total Hours Worked': str(p['hours']), 'Total Deaths': '0', 'Total Dafw Cases': '0', 'Total Djtr Cases': '0', 'Total Other Cases': '0',
            'Total Dafw Days': '0', 'Total Djtr Days': '0', 'Total Injuries': '0'} for p in gen['plants']])
    return gen


def invent_300a(path, site_col='Establishment'):
    """employees, hours and day totals: invented per site (seeded by the private salt), never the published values"""
    salt = json.loads((ROOT / 'data' / 'private' / 'compose_PRIVATE.json').read_text(encoding='utf-8')).get('salt300a', 'l1-300a')

    def f(r):
        if _syn(r[site_col]):  # an invented plant keeps its generated employees and hours
            r['Total Dafw Days'] = r['Total Djtr Days'] = '0'
            return
        rng = random.Random(f"{salt}|{r[site_col]}")
        emp = rng.randrange(60, 1400)
        r['Annual Average Employees'] = str(emp)
        r['Total Hours Worked'] = str(int(emp * rng.uniform(1650, 2350)))
        r['Total Dafw Days'] = str(int(r.get('Total Dafw Cases') or 0) * rng.randrange(4, 60))
        r['Total Djtr Days'] = str(int(r.get('Total Djtr Cases') or 0) * rng.randrange(4, 60))
    rw(path, f)



# ---------------------------------------------------------------------------------------------------------------- QA 8
# A real plant carries nothing that reads as a finding about it, and none of the case-level fields the public ITA case
# detail publishes. On every real plant's log line:
#   case number   -> a new code (LN-001, LN-002, ... in date order per plant); the published number is gone
#   job title     -> a job family (Production, Maintenance, Sanitation, Warehouse and shipping, Supervision, Office and lab)
#   injury text   -> restated in this repo's own words (body part, side, outcome) when it was the published wording
#   days away     -> invented (only "none" or "some" survives)
# Synthetic documents (log lines, OSHA reports, DOL inspections, referrals, reply letters, 301 forms) exist only in the
# invented Site-SYN plants and are generated from a seed (scripts/gen_synthetic.py). Every real plant's 300A case count equals its log; a count mismatch exists only in an
# invented plant. sample/<company>/plants.json lists every plant with real: true/false for the output gate (app/gate.ts).
CODE_RX = re.compile(r'^LN-\d{3}$')
FAMILY = [(r'temp\b|temporary|^tw\b', None), (r'maint|mechanic|mech\b|technician|tech\b|engineer|controls|refrigeration|electric', 'Maintenance'),
          (r'sanit|hygiene|wash|clean|janitor|trash', 'Sanitation'), (r'forklift|warehouse|wearhouse|shipping|receiv|material handler|picker|driver|pit\b|lto|bmh', 'Warehouse and shipping'),
          (r'supv|supervisor|lead|manager|foreman|planner|training|onboarding|continuous improvement|ci lead', 'Supervision'),
          (r'lab|microbio|fsq|admin|office|analytical', 'Office and lab')]


def job_family(title):
    t = (title or '').strip().lower()
    if not t or t.startswith('body part') or t in ('na', 'unknown'):
        return 'Not stated'
    temp = bool(re.search(FAMILY[0][0], t))
    fam = next((f for rx, f in FAMILY[1:] if re.search(rx, t)), 'Production')
    return fam + (' (temporary)' if temp else '')


NATURE = [(r'amputat', 'amputation'), (r'fractur|factured|broken|cracked', 'fracture'), (r'lacera|\bcut\b', 'laceration'), (r'dislocat', 'dislocation'),
          (r'contusion|smashed|bruis', 'contusion'), (r'sprain|strain|straing|over extended|hyperflexion', 'sprain or strain'), (r'burn', 'burn'),
          (r'\btear\b', 'tear'), (r'hearing|threshold shift', 'hearing loss'), (r'chemical', 'chemical exposure'), (r'shock', 'electric shock'),
          (r'tendon|bursitis|carpal|repetitive', 'repetitive-motion disorder'), (r'hernia', 'hernia'), (r'abrasion', 'abrasion'), (r'stress', 'stress'),
          (r'pain|discomfort|apin', 'pain')]
BODY = [(r'fingertip', 'fingertip'), (r'thumb', 'thumb'), (r'pinkie|5th finger|little finger', 'little finger'), (r'index|pointer', 'index finger'),
        (r'middle finger', 'middle finger'), (r'ring finger', 'ring finger'), (r'finger', 'finger'), (r'palm|hand', 'hand'), (r'wrist', 'wrist'), (r'forearm', 'forearm'),
        (r'elbow', 'elbow'), (r'bicep', 'upper arm'), (r'\barm\b', 'arm'), (r'shoulder|rotator', 'shoulder'), (r'neck', 'neck'), (r'eye', 'eye'), (r'\bear\b', 'ear'),
        (r'tooth|lip', 'mouth'), (r'back|lumbar', 'lower back'), (r'abdom|groin', 'abdomen'), (r'hip', 'hip'), (r'thigh', 'thigh'), (r'knee', 'knee'),
        (r'shin|lower leg|calf', 'lower leg'), (r'ankle', 'ankle'), (r'foot', 'foot'), (r'head', 'head'), (r'\bleg\b', 'leg')]


def restate(text):
    """an injury description in this repo's words: 'Body part: left index finger. Outcome: amputation, left index finger.'"""
    t = (text or '').lower()
    nature = next((n for rx, n in NATURE if re.search(rx, t)), 'injury, type not stated')
    body = next((b for rx, b in BODY if re.search(rx, t)), '')
    if body.endswith('fingertip') and re.search(r'index', t):
        body = 'index fingertip'
    side = 'both' if 'bilateral' in t else 'left' if re.search(r'\bleft\b|\(?\bl\b', t) else 'right' if 'right' in t else ''
    where = '' if not body else f'both {body}s' if side == 'both' else f'{side} {body}'.strip()
    return f'Body part: {where}. Outcome: {nature}, {where}.' if where else f'Outcome: {nature}.'


def _date(v, fmt):
    for f in ([FMT.get(fmt, fmt)] if fmt else []) + ['%m/%d/%Y']:
        try:
            return datetime.datetime.strptime((v or '').strip(), f).date()
        except ValueError:
            pass
    return datetime.date(1900, 1, 1)


def _salt():
    return json.loads((ROOT / 'data' / 'private' / 'compose_PRIVATE.json').read_text(encoding='utf-8')).get('salt300a', 'l1-300a')


def recode_log(path, site, case=None, job=None, injury=None, days=None, date=None, fmt=None, text=None, synthetic=lambda code: code.startswith('Site-SYN')):
    """real plants only: case number -> code, job title -> family, published injury wording -> restated, days away invented"""
    with open(path, encoding='utf-8', newline='') as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return 0
    cols, salt, n = list(rows[0]), _salt(), 0
    order = {}
    for i, r in enumerate(rows):
        if synthetic(r[site]):
            continue
        d = _date(re.search(r'on (\d{2}/\d{2}/\d{4})\.', r[text]).group(1), 'mdy') if text and re.search(r'on (\d{2}/\d{2}/\d{4})\.', r[text]) else _date(r.get(date or '', ''), fmt)
        order.setdefault(r[site], []).append((d, i))
    for code, lst in order.items():
        for k, (_, i) in enumerate(sorted(lst)):
            r = rows[i]
            new = f'LN-{k + 1:03d}'
            if text:
                m = re.match(r'Case (\S+) on', r[text])
                if m and not CODE_RX.match(m.group(1)):
                    r[text] = f'Case {new} on' + r[text][m.end():]
                    r[text] = re.sub(r'Job: ([^.]*)\.', lambda j: f'Job: {job_family(j.group(1))}.', r[text], count=1)
                    n += 1
                continue
            if case and CODE_RX.match(r[case] or ''):
                continue
            rng = random.Random(f'{salt}|days|{code}|{r.get(case, "") if case else i}')
            if case:
                r[case] = new
            if job:
                r[job] = job_family(r[job])
            if injury and not (r[injury] or '').startswith('Body part:'):
                r[injury] = restate(r[injury])
            if days and (r[days] or '0').strip() not in ('', '0'):
                r[days] = str(rng.randrange(2, 75))
            n += 1
    with open(path, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    return n


def log_counts(specs):
    """case count per plant over every incident table (what the Verifier's 300A check counts)"""
    out = {}
    for path, site in specs:
        for r in csv.DictReader(open(path, encoding='utf-8', newline='')):
            out[r[site]] = out.get(r[site], 0) + 1
    return out


def align_300a(path, counts, classes, extra=None, site_col='Establishment'):
    """every plant's 300A case count = its log count (classes: {site: {'2': n, '3': n}} from the log's classification);
    extra: {invented plant: cases the 300A has beyond its log} (the only count mismatch in the sample)"""
    extra = extra or {}

    def f(r):
        s = r[site_col]
        total = counts.get(s, 0) + extra.get(s, 0)
        c = classes.get(s, {})
        dafw = min(c.get('2', 0), total)
        djtr = min(c.get('3', 0), total - dafw)
        r.update({'Total Deaths': '0', 'Total Dafw Cases': str(dafw), 'Total Djtr Cases': str(djtr), 'Total Other Cases': str(total - dafw - djtr)})
        r['Total Injuries'] = str(total)
    rw(path, f)


def classes_of(specs):
    out = {}
    for path, site, col in specs:
        for r in csv.DictReader(open(path, encoding='utf-8', newline='')):
            if col:
                k = (r[col] or '').strip()
                out.setdefault(r[site], {}).setdefault(k, 0)
                out[r[site]][k] += 1
    return out


def write_plants(folder, site_tables, synthetic):
    plants = []
    for p, col in site_tables:
        for r in csv.DictReader(open(p, encoding='utf-8', newline='')):
            plants.append({'site': r[col], 'real': r[col] not in synthetic})
    plants.sort(key=lambda x: x['site'])
    json.dump({'note': 'Every plant in this sample. real: false = an invented plant (Site-SYN...): invented name, address, town, ZIP and 300A row; '
               'the only place synthetic records live. The output gate (app/gate.ts) shows a real plant only as found, written differently or State Plan.',
               'plants': plants}, open(folder / 'plants.json', 'w', encoding='utf-8'), indent=1)
    return plants


def manifest(folder):
    import hashlib
    m = json.load(open(folder / 'MANIFEST.json', encoding='utf-8'))
    m['note'] = ('Public OSHA and DOL records of four companies, re-sharded into four plant systems, then de-identified and composed (scripts/deidentify.py, '
                 'scripts/compose_records.py): names, addresses, towns, ZIPs and record numbers replaced by codes; dates shifted and states swapped per company; '
                 'on real plants the log case numbers are codes, job titles are job families, injury wording is restated and days away are invented; '
                 '300A employees, hours and days are invented. Synthetic records (marked SYNTHETIC) exist only in the invented Site-SYN plants.')
    files = {}
    for p in sorted(folder.rglob('*.csv')):
        rel = p.relative_to(folder).as_posix()
        rows = sum(1 for _ in csv.DictReader(open(p, encoding='utf-8', newline='')))
        files[rel] = {'rows': rows, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
    m['files'] = files
    json.dump(m, open(folder / 'MANIFEST.json', 'w', encoding='utf-8'), indent=1)


def _recode_seed(S):
    n = recode_log(S / 'group_a_postgres' / 'injury_log.csv', 'establishment', 'case_number', 'job_title', 'nature_of_injury', 'days_away', 'date_of_injury', 'iso')
    n += recode_log(S / 'group_b_mysql' / 'inc_rpt.csv', 'plant_id', 'rec_id', 'occupation', 'inj_type', 'dafw', 'inc_dt', 'dmy')
    n += recode_log(S / 'group_c_csv' / 'EHS_Export_2024.csv', 'Site Name', 'Case #', 'Job Title', 'Injury Type', 'Days Away From Work', 'Incident Date', 'mdy2')
    n += recode_log(S / 'group_d_scan' / 'scanned_log_transcribed.csv', 'site', text='transcribed_text')
    return n


def finish_seed():
    """the demo company after its dates and states: real log fields recoded, generated SYNTHETIC records, 300A, plants,
    301 forms (only for the synthetic cases), the opening pair on the home page, manifest"""
    configure('seed1003')
    S = ROOT / 'sample' / 'seed1003'
    n = _recode_seed(S)
    gen = add_synthetic('seed1003')
    logs = [(S / 'group_a_postgres' / 'injury_log.csv', 'establishment', 'outcome'), (S / 'group_b_mysql' / 'inc_rpt.csv', 'plant_id', 'classif'),
            (S / 'group_c_csv' / 'EHS_Export_2024.csv', 'Site Name', 'Case Classification'), (S / 'group_d_scan' / 'scanned_log_transcribed.csv', 'site', None),
            (S / 'synthetic_csv' / 'injury_log.csv', 'site', 'outcome')]
    align_300a(S / 'shared' / 'annual_summary_300A.csv', log_counts([(p, s) for p, s, _ in logs]), classes_of(logs), gen['extra_300a'])
    invent_300a(S / 'shared' / 'annual_summary_300A.csv')
    plants = write_plants(S, [(S / g / 'sites.csv', 'code') for g in ('group_a_postgres', 'group_b_mysql', 'group_c_csv', 'group_d_scan', 'synthetic_csv')], {p['code'] for p in gen['plants']})
    import make_plant_d_scans
    make_plant_d_scans.render(gen['forms'], S / 'scans')
    intro(S / 'intro.json', gen)
    manifest(S)
    print(f'seed1003: {n} real log lines recoded; {len(gen["logs"])} synthetic log lines, {len(gen["reports"])} synthetic reports in {len(gen["plants"])} invented plants; '
          f'{sum(p["real"] for p in plants)} real plants')


def intro(path, gen):
    """the home page's opening pair: the generated P2 case and its OSHA report (nothing typed by hand)"""
    d = json.load(open(path, encoding='utf-8'))
    ln = next(x for x in gen['logs'] if x['site'] == 'Site-SYN2')
    rep = next(x for x in gen['reports'] if x['ID'] == 'SIR-SYN002')
    form = next(f for f in gen['forms'] if f['case_no'] == ln['case'])
    log_mark = ln['text'].split('Result: ')[-1].rstrip('.')
    rep_mark = rep['Final Narrative'].split('Result: ')[-1].rstrip('.')
    d['headline'] = 'One injury. Three records.\nNo shared key from the log to OSHA.'
    d['records'][0].update(id=f"{ln['site']} · case {ln['case']}", date=_mdY(ln['date']), text='SYNTHETIC test record. ' + ln['text'].split('not a published record. ', 1)[1],
                           mark=log_mark, scan=form['file'])
    d['records'][1].update(id=rep['ID'], subIds=[f"referral {rep['UPA']}", 'employer masked by Zetaris policy'], date=f"{rep['EventDate']} · hospitalized",
                           text='SYNTHETIC test record. ' + rep['Final Narrative'].split('not a published record. ', 1)[1], mark=rep_mark)
    d['featured'] = {'site': ln['site'], 'case': ln['case']}
    json.dump(d, open(path, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    with open(path, 'a', encoding='utf-8') as f:
        f.write('\n')


def finish_unseen():
    configure('unseen3001')
    rekey_unseen()
    U = ROOT / 'sample' / 'unseen3001'
    T = U / 'tables'
    n = recode_log(T / 'plant_group_B-mysql__recordables.csv', 'plant_id', 'log_line', 'job_title', 'nature_of_injury', 'days_away', 'evt_date', '%Y%m%d')
    n += recode_log(T / 'plant_group_C-postgres__EHS_Export_2024.csv', 'plant', 'log_line', 'position', 'nature_of_injury', 'away_ct', 'evt_date', '%d-%b-%Y')
    n += recode_log(T / 'plant_group_D-csv__inc_rpt.csv', 'f9', 'f8', 'f7', 'f1', 'f4', 'f6', '%Y%m%d')
    n += recode_log(T / 'plant_group_A-scan__scanned_log_transcribed.csv', 'site', text='transcribed_text')
    gen = add_synthetic('unseen3001')
    logs = [(T / 'plant_group_B-mysql__recordables.csv', 'plant_id', 'result_cd'), (T / 'plant_group_C-postgres__EHS_Export_2024.csv', 'plant', 'outcome'),
            (T / 'plant_group_D-csv__inc_rpt.csv', 'f9', 'f2'), (T / 'plant_group_A-scan__scanned_log_transcribed.csv', 'site', None),
            (T / 'synthetic-csv__injury_log.csv', 'site', 'outcome')]
    align_300a(T / 'minio-csv__yr_totals.csv', log_counts([(p, s) for p, s, _ in logs]), classes_of(logs), gen['extra_300a'])
    invent_300a(T / 'minio-csv__yr_totals.csv')
    sites = [(T / f, 'code') for f in ('plant_group_A-scan__loc_master.csv', 'plant_group_B-mysql__plants.csv', 'plant_group_C-postgres__sites.csv', 'plant_group_D-csv__facility_dim.csv',
                                       'synthetic-csv__sites.csv')]
    plants = write_plants(U, sites, {p['code'] for p in gen['plants']})
    # the layer-2 catalog (sample/unseen3001/full) holds the same files under the live source names
    pairs = {'unseen3001_files': 'plant_group_D-csv__', 'unseen3001_my': 'plant_group_B-mysql__', 'unseen3001_paper': 'plant_group_A-scan__', 'unseen3001_pg': 'plant_group_C-postgres__'}
    import shutil
    for d, pre in pairs.items():
        for f in (U / 'full' / d).glob('*.csv'):
            shutil.copyfile(T / (pre + f.name), f)
    shutil.copyfile(T / 'minio-csv__yr_totals.csv', U / 'full' / 'unseen3001_hq' / 'yr_totals.csv')
    for f in (U / 'full' / 'unseen3001_public').glob('*.csv'):
        shutil.copyfile(U / 'public' / f.name, f)
    shutil.copyfile(U / 'plants.json', U / 'full' / 'plants.json')
    # the synthetic test system, as its own source in the layer-2 catalog
    (U / 'full' / 'unseen3001_extra').mkdir(exist_ok=True)
    for t in ('sites', 'injury_log'):
        shutil.copyfile(T / f'synthetic-csv__{t}.csv', U / 'full' / 'unseen3001_extra' / f'{t}.csv')
    cat = json.load(open(U / 'full' / 'catalog.json', encoding='utf-8'))
    cat['lightning'] = [x for x in cat['lightning'] if x['name'] != 'unseen3001_extra'] + [{'name': 'unseen3001_extra', 'description': 'separate plant system',
                         'tables': {'sites': 'unseen3001_extra/sites.csv', 'injury_log': 'unseen3001_extra/injury_log.csv'}}]
    json.dump(cat, open(U / 'full' / 'catalog.json', 'w', encoding='utf-8'), indent=1)
    print(f'unseen3001: {n} real log lines recoded; {len(gen["logs"])} synthetic log lines, {len(gen["reports"])} synthetic reports in {len(gen["plants"])} invented plants; '
          f'{sum(p["real"] for p in plants)} real plants')


# ---------------------------------------------------------------------------------------------------------------- QA 11
# The two samples were de-identified with one shared map, so a real report, town or ZIP got the same code in both
# (QA round 11: one OSHA report sat in both, under two employer codes, which lines the two companies up and leaks each one's
# private shift and state swap). The unseen company's record codes, towns and ZIPs are re-keyed with a company salt
# into ranges the demo company does not use. Done once; the map stays in the private file.
def rekey_unseen():
    priv = ROOT / 'data' / 'private' / 'compose_PRIVATE.json'
    cfg = json.loads(priv.read_text(encoding='utf-8'))
    if cfg.get('rekey_unseen3001'):
        return 0
    import hashlib
    U = ROOT / 'sample' / 'unseen3001'
    S = ROOT / 'sample' / 'seed1003'
    files = [f for f in U.rglob('*.csv') if 'full' not in f.parts]
    seed_towns, seed_zips = set(), set()
    for f in S.rglob('*.csv'):
        for r in csv.DictReader(open(f, encoding='utf-8', newline='')):
            for k in ('city', 'City', 'site_city'):
                if r.get(k):
                    seed_towns.add(r[k].strip().upper())
            for k in ('zip', 'Zip', 'site_zip'):
                if r.get(k):
                    seed_zips.add(r[k].strip()[:5])
    towns, zips, ids = set(), set(), set()
    for f in files:
        for r in csv.DictReader(open(f, encoding='utf-8', newline='')):
            if any(_syn(v) for v in r.values()):
                continue
            for k in ('city', 'City', 'site_city'):
                if r.get(k):
                    towns.add(r[k].strip().upper())
            for k in ('zip', 'Zip', 'site_zip'):
                if r.get(k):
                    zips.add(r[k].strip()[:5])
            for v in r.values():
                for m in re.finditer(r'\b(SIR|DOL|REF|INSP)-\d{4,}\b', v or ''):
                    ids.add(m.group(0))
    salt = cfg.get('salt300a', 'l1') + '|unseen3001'
    h = lambda s: int(hashlib.sha256(f'{salt}|{s}'.encode()).hexdigest(), 16)
    idmap, used = {}, set()
    for i in sorted(ids):
        p, n = i.split('-', 1)
        k = 0
        while True:
            new = f'{p}-{str(h(i + str(k)) % 9 * 10 ** (len(n) - 1) + h(i + str(k)) % 10 ** (len(n) - 1)).zfill(len(n))}'
            if new not in used and new != i:
                break
            k += 1
        used.add(new); idmap[i] = new
    zipmap = {}
    free = [f'{z:05d}' for z in range(600, 1000) if f'{z:05d}' not in seed_zips]
    for i, z in enumerate(sorted(zips)):
        zipmap[z] = free[h(z) % len(free)] if False else free[i]
    A = ['Bram', 'Cald', 'Dorn', 'Esk', 'Fallo', 'Grent', 'Hask', 'Ilm', 'Jorv', 'Kest', 'Lund', 'Mirr', 'Nesh', 'Orv', 'Pell', 'Quen', 'Rusk', 'Stav', 'Tull', 'Ulv', 'Vask', 'Wend', 'Yarr', 'Zell']
    B = ['ford', 'by', 'holm', 'stead', 'wick', 'thorpe', 'mere', 'dale', 'gate', 'moor', 'ham', 'wold']
    townmap, taken = {}, set(seed_towns)
    for t in sorted(towns):
        k = 0
        while True:
            name = (A[h(t + str(k)) % len(A)] + B[h(t + 'b' + str(k)) % len(B)]).upper()
            if name not in taken:
                break
            k += 1
        taken.add(name); townmap[t] = name
    trx = re.compile(r'\b(' + '|'.join(re.escape(t) for t in sorted(townmap, key=len, reverse=True)) + r')\b', re.I) if townmap else None
    zrx = re.compile(r'\b(' + '|'.join(sorted(zipmap)) + r')\b') if zipmap else None
    irx = re.compile(r'\b(SIR|DOL|REF|INSP)-\d{4,}\b')

    def town(m):
        new = townmap[m.group(0).upper()]
        return new if m.group(0).isupper() else new.title()
    n = 0
    for f in files:
        def fix(r):
            nonlocal n
            if any(_syn(v) for v in r.values()):
                return
            for k, v in list(r.items()):
                if not v:
                    continue
                w = irx.sub(lambda m: idmap.get(m.group(0), m.group(0)), v)
                w = zrx.sub(lambda m: zipmap[m.group(0)], w) if zrx else w
                w = trx.sub(town, w) if trx else w
                if w != v:
                    r[k] = w
                    n += 1
        rw(f, fix)
    cfg['rekey_unseen3001'] = {'ids': idmap, 'zips': zipmap, 'towns': townmap}
    priv.write_text(json.dumps(cfg, indent=1), encoding='utf-8')
    print(f'unseen3001: {len(idmap)} record codes, {len(zipmap)} ZIPs, {len(townmap)} towns re-keyed ({n} cells)')
    return n


if __name__ == '__main__':
    {'seed1003': seed1003, 'unseen_tables': unseen_tables, 'unseen_public': unseen_public, 'synthetic': lambda: (finish_seed(), finish_unseen())}[sys.argv[1]]()
