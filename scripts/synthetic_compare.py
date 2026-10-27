"""Is every SYNTHETIC record new? (QA round 9) Each generated row is compared with every reference row on six fields:
house number + state, case number, job title, page, date, and any 5-word run of narrative. A synthetic row passes if
it shares fewer than 2 of them with every reference row; an invented plant passes if no real plant has its house
number + state or its ZIP.

  sample   (always; no private data): the real rows of the same sample (OSHA reports, DOL inspections, log lines, plants),
           in the sample's own shifted and swapped form. Writes docs/synthetic_check.json with --write.
  public   (scripts/scan_identity.py, on the build machine): the public OSHA file and the ITA cases of the company pool,
           with the true and the guessed date shifts and the true state swap undone, the strongest attacker.
Usage: python -I scripts/synthetic_compare.py [--sample DIR] [--write]"""
import sys, csv, json, re, datetime, pathlib, collections
csv.field_size_limit(10 ** 9)
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from osha_states import NAME  # noqa: E402
ABBR = {v: k for k, v in NAME.items()}
SYN = re.compile(r'^(Site|SIR|DOL|LTR)-SYN')
FIELDS = ('house_state', 'case', 'job', 'page', 'date', 'narrative')


def grams(text, n=5):
    w = re.findall(r'[a-z]+', (text or '').lower())
    return {' '.join(w[i:i + n]) for i in range(len(w) - n + 1)}


def house(street):
    m = re.match(r'\s*(\d+)', street or '')
    return m.group(1) if m else ''


def day(v):
    v = (v or '').strip()
    for f in ('%Y-%m-%d', '%m/%d/%Y', '%d/%m/%Y', '%m/%d/%y', '%Y%m%d', '%d-%b-%Y', '%d%b%Y'):
        try:
            return datetime.datetime.strptime(v, f).date()
        except ValueError:
            pass
    return None


def read(p):
    with open(p, encoding='utf-8', newline='') as f:
        return list(csv.DictReader(f))


def row(id_, hs=None, case='', job='', page='', date=None, text='', kind=''):
    return dict(id=id_, kind=kind, house_state=hs, case=str(case or '').strip(), job=(job or '').strip().lower(), page=str(page or '').strip(), date=date, grams=grams(text))


def sample_rows(folder):
    """(synthetic rows, real reference rows, plants) of one sample folder, in its own form"""
    folder = pathlib.Path(folder)
    syn, ref, plants = [], [], []
    site_tables = [p for p in folder.rglob('*.csv') if 'full' not in p.parts and 'code' in (read(p)[0] if read(p) else {}) and 'street' in (read(p)[0] if read(p) else {})]
    where = {}
    for p in site_tables:
        for r in read(p):
            where[r['code']] = (house(r['street']), (r['state'] or '').upper())
            plants.append(dict(code=r['code'], house_state=where[r['code']], zip=r['zip'], syn=bool(SYN.match(r['code']))))
    for p in sorted(folder.rglob('*.csv')):
        if 'full' in p.parts:
            continue
        rows = read(p)
        if not rows:
            continue
        cols = set(rows[0])
        for r in rows:
            if 'Final Narrative' in cols:  # OSHA reports
                x = row(r['ID'], (house(r['Address1']), ABBR.get((r['State'] or '').upper(), (r['State'] or '').upper())), date=day(r['EventDate']), text=r['Final Narrative'], kind='report')
                (syn if SYN.match(r['ID']) else ref).append(x)
            elif 'estab_name' in cols:  # DOL inspections
                x = row(r['activity_nr'], (house(r['site_address']), (r['site_state'] or '').upper()), date=day(r['open_date']), kind='inspection')
                (syn if SYN.match(r['activity_nr']) else ref).append(x)
            elif 'transcribed_text' in cols:  # paper log
                t = r['transcribed_text']
                m = re.match(r'Case (\S+) on ([0-9/]+)\.\s*(?:Job: ([^.]*)\.)?', t)
                x = row(f"{p.name}:{r['site']}:{m.group(1) if m else ''}", where.get(r['site']), m.group(1) if m else '', m.group(3) if m else '', r.get('page'),
                        day(m.group(2)) if m else None, t, 'log')
                (syn if SYN.match(r['site']) else ref).append(x)
            elif 'sent_on' in cols:  # reply letters
                x = row(r['doc_id'], where.get(r['site']), date=day(r['sent_on']), text=r['body'], kind='letter')
                (syn if SYN.match(r['doc_id']) else ref).append(x)
            else:  # typed logs: the column names differ per system
                sc = next((c for c in ('establishment', 'plant_id', 'Site Name', 'plant', 'f9', 'site') if c in cols), None)
                cc = next((c for c in ('case_number', 'rec_id', 'Case #', 'log_line', 'f8', 'case_no') if c in cols), None)
                if not sc or not cc:
                    continue
                jc = next((c for c in ('job_title', 'occupation', 'Job Title', 'position', 'f7') if c in cols), None)
                dc = next((c for c in ('date_of_injury', 'inc_dt', 'Incident Date', 'evt_date', 'f6', 'injury_date') if c in cols), None)
                tc = [c for c in ('what_happened', 'descr', 'Description of Incident', 'narr', 'f5', 'nature_of_injury', 'inj_type', 'Injury Type', 'f1', 'description', 'injury') if c in cols]
                d = day(r[dc]) if dc else None
                if dc == 'inc_dt':  # plant group B writes day first
                    try:
                        d = datetime.datetime.strptime(r[dc], '%d/%m/%Y').date()
                    except ValueError:
                        pass
                x = row(f"{p.name}:{r[sc]}:{r[cc]}", where.get(r[sc]), r[cc], r.get(jc, '') if jc else '', '', d, ' '.join(r[c] for c in tc), 'log')
                (syn if SYN.match(r[sc]) else ref).append(x)
    return syn, ref, plants


class Index:
    def __init__(self, refs):
        self.refs = refs
        self.by = {f: collections.defaultdict(set) for f in FIELDS}
        for i, r in enumerate(refs):
            for f in ('house_state', 'case', 'job', 'page', 'date'):
                if r[f]:
                    self.by[f][r[f]].add(i)
            for g in r['grams']:
                self.by['narrative'][g].add(i)

    def shared(self, s, shifts=(0,), states=(lambda hs: hs,)):
        """the reference row sharing the most fields with s, and which fields"""
        hit = collections.defaultdict(set)
        for f in ('case', 'job', 'page'):
            if s[f]:
                for i in self.by[f].get(s[f], ()):
                    hit[i].add(f)
        if s['house_state'] and s['house_state'][0]:
            for st in states:
                for i in self.by['house_state'].get(st(s['house_state']), ()):
                    hit[i].add('house_state')
        if s['date']:
            for sh in shifts:
                for i in self.by['date'].get(s['date'] - datetime.timedelta(days=sh), ()):
                    hit[i].add('date')
        for g in s['grams']:
            for i in self.by['narrative'].get(g, ()):
                hit[i].add('narrative')
        if not hit:
            return 0, None, []
        i = max(hit, key=lambda k: len(hit[k]))
        return len(hit[i]), self.refs[i]['id'], sorted(hit[i])


def check(syn, refs, plants_real=(), shifts=(0,), states=(lambda hs: hs,)):
    idx = Index(refs)
    worst, fails = 0, []
    for s in syn:
        n, rid, fields = idx.shared(s, shifts, states)
        worst = max(worst, n)
        if n >= 2:
            fails.append(dict(row=s['id'], reference=rid, fields=fields))
    real_hs = {p['house_state'] for p in plants_real if not p['syn']}
    real_zip = {p['zip'] for p in plants_real if not p['syn']}
    plant_fail = [p['code'] for p in plants_real if p['syn'] and (p['house_state'] in real_hs or p['zip'] in real_zip)]
    return dict(rows=len(syn), max_shared=worst, rows_sharing_2_or_more=len(fails), fails=fails, invented_plants=sum(p['syn'] for p in plants_real),
                invented_plants_at_a_real_address_or_zip=plant_fail)


def sample_check(root=ROOT / 'sample'):
    out = {}
    for company in ('seed1003', 'unseen3001'):
        syn, ref, plants = sample_rows(pathlib.Path(root) / company)
        r = check(syn, ref, plants)
        r.pop('fails') if not r['fails'] else None
        out[company] = r
    return out


if __name__ == '__main__' and '--public' not in sys.argv and '--hardcoded' not in sys.argv:
    root = sys.argv[sys.argv.index('--sample') + 1] if '--sample' in sys.argv else ROOT / 'sample'
    res = dict(fields=list(FIELDS), threshold='a synthetic row fails if it shares 2 or more of these fields with one real row', companies=sample_check(root))
    print(json.dumps(res, indent=1, default=str))
    if '--write' in sys.argv:
        (ROOT / 'docs' / 'synthetic_check.json').write_text(json.dumps(res, indent=1, default=str) + '\n', encoding='utf-8')


def public_refs(sir_csv, pool_json):
    """the public OSHA file (2023-2025) and the ITA cases of every company in the pool (build machine only)"""
    refs = []
    with open(sir_csv, encoding='utf-8', errors='replace', newline='') as f:
        for r in csv.DictReader(f):
            if (r.get('EventDate') or '').strip()[-4:] not in ('2023', '2024', '2025'):
                continue
            refs.append(row('SIR ' + (r.get('ID') or ''), (house(r.get('Address1')), ABBR.get((r.get('State') or '').strip().upper(), (r.get('State') or '').strip().upper())),
                            date=day(r.get('EventDate')), text=r.get('Final Narrative'), kind='public report'))
    for c in json.loads(pathlib.Path(pool_json).read_text(encoding='utf-8'))['pool']:
        for e in c['establishments']:
            for k in e['cases']:
                refs.append(row(f"ITA {e['establishment_id']}:{k.get('case_number')}", (house(e.get('street')), (e.get('state') or '').upper()), k.get('case_number'),
                                k.get('job_description'), '', day(k.get('date_of_incident')),
                                ' '.join(k.get(f) or '' for f in ('new_nar_before_incident', 'new_nar_what_happened', 'new_nar_injury_illness', 'new_nar_object_substance')), 'public ITA case'))
    return refs


def public_plants(pool_json):
    return [dict(code=e['establishment_id'], house_state=(house(e.get('street')), (e.get('state') or '').upper()), zip=(e.get('zip') or '')[:5], syn=False)
            for c in json.loads(pathlib.Path(pool_json).read_text(encoding='utf-8'))['pool'] for e in c['establishments']]


def public_check(sample_root, refs, real_plants, shifts_by_company, unswap_by_company):
    """every SYNTHETIC row of both samples against the public rows, at the true and guessed shifts, with the state swap
    undone; every invented plant against the pool's real establishments"""
    idx = Index(refs)
    out = {}
    for company in ('seed1003', 'unseen3001'):
        syn, _, plants = sample_rows(pathlib.Path(sample_root) / company)
        un = unswap_by_company[company]
        states = (lambda hs: hs, lambda hs, un=un: (hs[0], un.get(hs[1], hs[1])) if hs else hs)
        worst, fails = 0, []
        for s in syn:
            n, rid, fields = idx.shared(s, shifts_by_company[company], states)
            worst = max(worst, n)
            if n >= 2:
                fails.append(dict(row=s['id'], reference=rid.split(':')[0].split(' ')[0], fields=fields))
        hs_real = {p['house_state'] for p in real_plants}
        zip_real = {p['zip'] for p in real_plants}
        pf = [p['code'] for p in plants if p['syn'] and (any(st(p['house_state']) in hs_real for st in states) or p['zip'] in zip_real)]
        out[company] = dict(rows=len(syn), max_shared=worst, rows_sharing_2_or_more=len(fails), fails=fails, invented_plants_at_a_real_address_or_zip=pf)
    return out


def public_main(sir_csv, sample_root):
    """the build machine's check (needs the public file and the private pool): python -I scripts/synthetic_compare.py
    --public SIR.csv [--sample DIR]; prints counts only (no record of the public files)"""
    import compose_records as CR
    shifts, unswap = {}, {}
    for name in ('seed1003', 'unseen3001'):
        CR.configure(name)
        shifts[name] = sorted({0, CR.SHIFT})
        unswap[name] = {v: k for k, v in CR.PERM.items()}
    pool = ROOT / 'data/composite/pool_PRIVATE.json'
    r = public_check(sample_root, public_refs(sir_csv, pool), public_plants(pool), shifts, unswap)
    for v in r.values():
        v['fails'] = [dict(row=x['row'], fields=x['fields'], reference=x['reference']) for x in v['fails']]
    return r


if __name__ == '__main__' and '--public' in sys.argv:
    print(json.dumps(public_main(sys.argv[sys.argv.index('--public') + 1], sys.argv[sys.argv.index('--sample') + 1] if '--sample' in sys.argv else ROOT / 'sample'), indent=1))


# ---------------------------------------------------------------------------------------------------------------- QA 11
# Values typed into code, tests, fixtures and docs (not the samples and not the published traces): none may be a real
# record's id, or a real plant's or real report's house number together with its ZIP in the same file. A test fixture
# built from a real case (QA round 11: the dropped unseen-company case sat in test/units.test.ts) fails here.
HARD_SCOPE = ('test/', 'scripts/', 'docs/', 'engine/', 'app/', 'ui/')
HARD_SKIP = ('docs/trace/', 'docs/sealed_exam/', 'docs/screens/', 'docs/review_screens/')
ID_RX = re.compile(r'\b(SIR|DOL|REF|INSP)-\d{4,}\b')


def tracked(root=ROOT):
    import subprocess
    out = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=root, capture_output=True, text=True).stdout.split('\n')
    return [f for f in out if f.startswith(HARD_SCOPE) and not f.startswith(HARD_SKIP) and pathlib.Path(root / f).suffix in ('.ts', '.js', '.mjs', '.py', '.json', '.jsonl', '.md', '.txt', '.sh', '.html', '.csv')]


def real_values(sample_root=ROOT / 'sample'):
    """real ids and (house number, ZIP) pairs of every sample: plants, OSHA reports, DOL inspections"""
    ids, pairs = set(), set()
    for f in pathlib.Path(sample_root).rglob('*.csv'):
        for r in read(f):
            for k in ('ID', 'UPA', 'Inspection', 'activity_nr', 'rel_act_nr'):
                v = (r.get(k) or '').strip()
                if ID_RX.fullmatch(v):
                    ids.add(v)
            for hk, zk in (('street', 'zip'), ('Address1', 'Zip'), ('site_address', 'site_zip')):
                if r.get(hk) and r.get(zk) and not SYN.match(r.get('code') or r.get('ID') or r.get('activity_nr') or ''):
                    h, z = house(r[hk]), (r[zk] or '')[:5]
                    if h and z:
                        pairs.add((h, z))
    return ids, pairs


def hardcoded_check(files=None, ids=None, pairs=None, root=ROOT):
    if ids is None or pairs is None:
        ids, pairs = real_values()
    hits = []
    for f in files if files is not None else tracked(root):
        p = pathlib.Path(f) if pathlib.Path(f).is_absolute() else root / f
        try:
            t = p.read_text(encoding='utf-8')
        except Exception:
            continue
        found_ids = sorted(set(ID_RX.findall(t) and [m.group(0) for m in ID_RX.finditer(t)]) & ids)
        nums = set(re.findall(r'\b\d{3,5}\b', t))
        found_pairs = sorted((h, z) for h, z in pairs if h in nums and z in nums)
        if found_ids or found_pairs:
            hits.append(dict(file=str(f), ids=len(found_ids), address_pairs=len(found_pairs)))
    return hits


if __name__ == '__main__' and '--hardcoded' in sys.argv:
    extra = sys.argv[sys.argv.index('--hardcoded') + 1:]
    print(json.dumps(hardcoded_check(extra or None), indent=1))
