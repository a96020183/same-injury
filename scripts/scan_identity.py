"""Fail if anything that could point to a real employer survives, in the files git would commit AND in every blob of the
git history. Checked: published employer names (scripts/scan_names.py), the real towns, street addresses, ZIP codes and
OSHA/DOL record numbers that scripts/deidentify.py replaced (read from the private map, never printed: hits are reported
as counts per kind and file, unless --show). Images are listed separately (they cannot be text-scanned).
Usage: python -I scripts/scan_identity.py SIR.csv [--show]"""
import sys, re, json, csv, pathlib, subprocess
csv.field_size_limit(10 ** 9)
sys.stdout.reconfigure(encoding='utf-8')
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from scan_names import patterns  # noqa: E402

SHOW = '--show' in sys.argv
name_pats, PLACES, norm_place = patterns(sys.argv[1])
# plus every company in the generator's pool (the exam and the unseen demo company come from there)
from scan_names import GENERIC  # noqa: E402
for c in json.loads((ROOT / 'data/composite/pool_PRIVATE.json').read_text(encoding='utf-8'))['pool']:
    for e in c['establishments']:
        for n in (e.get('name'), e.get('company')):
            words = [w for w in re.findall(r"[A-Za-z][A-Za-z']+", n or '') if w.lower() not in GENERIC]
            if len(words) >= 2:
                name_pats.append(re.compile(r'' + r'\W+'.join(map(re.escape, words[:2])) + r'', re.I))
M = json.loads((ROOT / 'data/private/deid_map_PRIVATE.json').read_text(encoding='utf-8'))
fake_towns = {v.upper() for v in M['city'].values()}
# a real town counts as found when it appears as a proper noun next to address context (state code, ZIP, "IL", comma)
towns = sorted({c for c in M['city'] if c.upper() not in fake_towns and len(c) > 3}, key=len, reverse=True)
town_re = re.compile(r'\b(' + '|'.join(re.escape(t) + '|' + re.escape(t.title()) for t in towns) + r')\b,?\s+(?:[A-Z]{2}\b|\d{5})') if towns else None
streets = [s for s in M.get('street_src', []) if len(s) > 6]
street_re = re.compile(r'\b(' + '|'.join(re.escape(s) for s in sorted(streets, key=len, reverse=True)) + r')\b', re.I) if streets else None
ids = sorted({k.split('|', 1)[1] for k in M['id']})
id_re = re.compile(r'(?<![\w.-])(' + '|'.join(map(re.escape, ids)) + r')(?![\w])') if ids else None
zips = sorted(M['zip'])
# a 5-digit number counts as a ZIP only next to a state (case numbers often have five digits)
STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split()
STATE_RE = re.compile(r'(' + '|'.join(STATES) + r')|ALABAMA|ALASKA|ARIZONA|ARKANSAS|CALIFORNIA|COLORADO|CONNECTICUT|DELAWARE|FLORIDA|GEORGIA|IDAHO|ILLINOIS|INDIANA|IOWA|KANSAS|KENTUCKY|LOUISIANA|MAINE|MARYLAND|MASSACHUSETTS|MICHIGAN|MINNESOTA|MISSISSIPPI|MISSOURI|MONTANA|NEBRASKA|NEVADA|NEW |NORTH |OHIO|OKLAHOMA|OREGON|PENNSYLVANIA|RHODE|SOUTH |TENNESSEE|TEXAS|UTAH|VERMONT|VIRGINIA|WASHINGTON|WEST VIRGINIA|WISCONSIN|WYOMING', re.I)
zip_re = re.compile(r'(?<![\w.:#/-])(' + '|'.join(zips) + r')(?:-\d{4})?(?![\w.])') if zips else None


# published narratives: any run of 8 words that also appears in a public narrative (2024 OSHA reports, the pool's ITA cases)
# counts as a hit, so a narrative cannot be searched back to the public files
_W = lambda t: re.findall(r"[a-z0-9']+", (t or '').lower())
SHINGLE = 8
PUBLIC = set()
for r in csv.DictReader(open(sys.argv[1], encoding='utf-8', errors='replace', newline='')):
    if (r.get('EventDate') or '').strip().endswith(('2024', '2025')):
        w = _W(r.get('Final Narrative'))
        PUBLIC.update(hash(tuple(w[i:i + SHINGLE])) for i in range(len(w) - SHINGLE + 1))
for c in json.loads((ROOT / 'data/composite/pool_PRIVATE.json').read_text(encoding='utf-8'))['pool']:
    for e in c['establishments']:
        for k in e['cases']:
            for f in ('new_nar_before_incident', 'new_nar_what_happened', 'new_nar_injury_illness', 'new_nar_object_substance'):
                w = _W(k.get(f))
                PUBLIC.update(hash(tuple(w[i:i + SHINGLE])) for i in range(len(w) - SHINGLE + 1))


def narrative_hits(t):
    w = _W(t)
    return sorted({' '.join(w[i:i + SHINGLE]) for i in range(len(w) - SHINGLE + 1) if hash(tuple(w[i:i + SHINGLE])) in PUBLIC})[:20]


def scan_text(t):
    out = {}
    nh = narrative_hits(t)
    if nh:
        out['public-narrative'] = nh
    names = sorted({m.group(0) for p in name_pats for m in [p.search(t)] if m and norm_place(m.group(0)) not in PLACES})
    for kind, found in (('name', names),
                        ('town', sorted({m.group(1) for m in town_re.finditer(t)}) if town_re else []),
                        ('street', sorted({m.group(1) for m in street_re.finditer(t)}) if street_re else []),
                        ('record-id', sorted({m.group(1) for m in id_re.finditer(t)}) if id_re else []),
                        ('zip', sorted({m.group(1) for m in zip_re.finditer(t) if STATE_RE.search(t[max(0, m.start() - 40):m.start()])}) if zip_re else [])):
        if found:
            out[kind] = found
    return out


def report(label, hits):
    print(f'{label}: files with hits {len(hits)}')
    for rel, kinds in sorted(hits.items()):
        print('   ', rel, {k: (v[:8] if SHOW else len(v)) for k, v in kinds.items()})


git = lambda *a, **k: subprocess.run(['git', *a], cwd=ROOT, capture_output=True, **k)
# 1) working tree: every file git would commit
files = [f for f in git('ls-files', '--cached', '--others', '--exclude-standard', text=True).stdout.split('\n') if f]
hits, images = {}, []
for rel in files:
    if rel.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp')):
        images.append(rel)
        continue
    p = ROOT / rel
    if p.exists():
        h = scan_text(p.read_text(encoding='utf-8', errors='ignore'))
        if h:
            hits[rel] = h
report(f'working tree ({len(files)} files; {len(towns)} towns, {len(streets)} streets, {len(ids)} record ids, {len(zips)} zips, {len(name_pats)} names)', hits)
print('images (check by eye):', len(images))
# 2) history: every blob reachable from any ref, plus the reflog
objs = git('rev-list', '--all', '--reflog', '--objects', text=True).stdout.split('\n')
paths = {}
for line in objs:
    if ' ' in line:
        sha, path = line.split(' ', 1)
        paths.setdefault(sha, path)
hist = {}
blobs = [s for s in paths if not paths[s].lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp'))]
if blobs:
    out = git('cat-file', '--batch', input=('\n'.join(blobs) + '\n').encode()).stdout
    i = 0
    while i < len(out):
        nl = out.index(b'\n', i)
        sha, typ, size = out[i:nl].decode().split(' ')
        size = int(size)
        data = out[nl + 1: nl + 1 + size]
        i = nl + 1 + size + 1
        if typ != 'blob':
            continue
        h = scan_text(data.decode('utf-8', errors='ignore'))
        if h:
            hist[f'{paths[sha]} @{sha[:8]}'] = h
commits = git('rev-list', '--all', '--count', text=True).stdout.strip()
# 3) the conclusions, attacked the way someone holding the public files would. Dates and states in the samples are
# shifted and swapped with private values, so the attack first GUESSES them from the published files: for every shift
# from -60 to +60 days it counts the sample's OSHA reports that have a public report on the shifted day with the same
# body-part category and amputation flag; the best three shifts are kept, and for each sample state the two public
# states its matched reports most often come from. Then every conclusion is filtered back with each (shift, state)
# guess: date +-7 days, state, side and body part, in the public OSHA file and in the ITA case detail of the source
# companies. A conclusion that says no report was found, or that a report is not in the company's log, FAILS the scan
# if any guess leaves exactly one real employer. Other conclusions (a report exists; needs a person) are counted and
# printed: they repeat what OSHA's public file already says.
import datetime, os, collections  # noqa: E402
PARTS = ['thumb', 'index', 'middle', 'ring', 'little', 'pinky', 'finger', 'hand', 'wrist', 'arm', 'foot', 'toe', 'leg', 'eye', 'head', 'back']
SIDES = ['right', 'left']


def _d(s):
    for f in ('%m/%d/%Y', '%Y-%m-%d', '%d%b%Y'):
        try:
            return datetime.datetime.strptime((s or '').strip(), f).date()
        except ValueError:
            pass


pub_rows = [r for r in csv.DictReader(open(sys.argv[1], encoding='utf-8', errors='replace', newline='')) if (r.get('EventDate') or '').strip()[-4:] in ('2023', '2024', '2025')]
sir_pub = [(_d(r['EventDate']), (r['State'] or '').strip().upper(), (r['Employer'] or '').strip().upper(), f"{r.get('Part of Body Title', '')} {r.get('Final Narrative', '')}".lower()) for r in pub_rows]
by_day = collections.defaultdict(list)
for r in pub_rows:
    by_day[(_d(r['EventDate']), (r.get('Part of Body Title') or '').strip(), (r.get('Amputation') or '').strip()[:1])].append((r['State'] or '').strip().upper())
ita_cases_full = [(str(k.get('case_number') or '').strip(), _d(k.get('date_of_incident')), (k.get('job_description') or '').strip(),
                   ' '.join(k.get(f) or '' for f in ('new_nar_what_happened', 'new_nar_injury_illness')).lower())
                  for c in json.loads((ROOT / 'data/composite/pool_PRIVATE.json').read_text(encoding='utf-8'))['pool'] for e in c['establishments'] for k in e['cases']]
ita_pub = [(_d(k['date_of_incident']), e['state'], e['establishment_id'], ' '.join(k.get(f) or '' for f in ('new_nar_what_happened', 'new_nar_injury_illness')).lower())
           for c in json.loads((ROOT / 'data/composite/pool_PRIVATE.json').read_text(encoding='utf-8'))['pool'] for e in c['establishments'] for k in e['cases']]
import compose_records as CR  # noqa: E402
ABBR = {v: k for k, v in CR.NAME.items()}


def guess(sir_file):
    rows = [r for r in csv.DictReader(open(sir_file, encoding='utf-8', newline='')) if not re.search('SYNTHETIC|COMPOSITE', r.get('Final Narrative') or '')]
    scores = {}
    for sh in range(-60, 61):
        scores[sh] = sum(1 for r in rows if _d(r['EventDate']) and by_day.get((_d(r['EventDate']) - datetime.timedelta(days=sh), (r.get('Part of Body Title') or '').strip(), (r.get('Amputation') or '').strip()[:1])))
    best = sorted(scores, key=lambda k: -scores[k])[:3]
    votes = collections.defaultdict(collections.Counter)
    for r in rows:
        d = _d(r['EventDate'])
        for st in by_day.get((d - datetime.timedelta(days=best[0]), (r.get('Part of Body Title') or '').strip(), (r.get('Amputation') or '').strip()[:1]), []) if d else []:
            votes[(r['State'] or '').strip().upper()][st] += 1
    states = {k: [s for s, _ in v.most_common(2)] for k, v in votes.items()}
    return best, scores, states


# negative conclusions: no report / not in the log / an R-lane waiting on identity / OSHA's report says less than the log
SENSITIVE = lambda it: it['column'] in ('not_found', 'not_in_log') or (it['column'] in ('pending', 'review') and it['lane'].startswith('R')) or bool(it.get('osha_less'))
unique, other, ita_chance = [], [], []
SAMPLE_ITEMS = {}
n_sens = n_other = 0
for name, folder, sir_file in (('seed1003', 'sample/seed1003', 'sample/seed1003/shared/osha_sir_2024.csv'),
                               ('unseen3001', 'sample/unseen3001/full', 'sample/unseen3001/public/osha_sir_2024.csv')):
    best, scores, states = guess(ROOT / sir_file)
    env = {**os.environ, 'L1_SAMPLE_DIR': str(ROOT / folder), 'SAMPLE_MODE': 'true', 'L1_MODEL_OFFLINE': 'true', 'L1_RUNS_DIR': str(ROOT / 'runs' / 'scan_runs')}
    if name == 'unseen3001':
        env.update(L1_USL_NAME='unseen3001_records')
    out = subprocess.run(['node', '--no-warnings', '--import', 'tsx', 'scripts/variant_run.ts'], cwd=ROOT, env=env, capture_output=True, text=True, encoding='utf-8')
    line = next((l for l in out.stdout.splitlines() if l.startswith('@@RESULT')), None)
    if not line:
        print('conclusions: could not run', name, out.stderr[-300:]); unique.append(name); continue
    items = json.loads(line[8:])['items']
    SAMPLE_ITEMS[name] = (items, ROOT / sir_file, ROOT / folder)
    n_sens += sum(1 for it in items if SENSITIVE(it)); n_other += sum(1 for it in items if not SENSITIVE(it))
    for it in items:
        d = _d(it.get('date')); st = CR.NAME.get((it.get('state') or '').upper(), '')
        body = (it.get('body') or '').lower()
        part = next((p for p in PARTS if p in body), None)
        side = next((s_ for s_ in SIDES if s_ in body), None)
        if not d or not st or not part:
            continue
        found = []
        for sh in best:
            dd0 = d - datetime.timedelta(days=sh)
            for pst in states.get(st, []) or [st]:
                hs = {e for (dd, s2, e, t) in sir_pub if dd and abs((dd - dd0).days) <= 7 and s2 == pst and part in t and (not side or side in t)}
                hi = {e for (dd, s2, e, t) in ita_pub if dd and abs((dd - dd0).days) <= 7 and s2 == ABBR.get(pst, pst) and part in t and (not side or side in t)}
                found += [f'shift {sh}, {pst}: one {k}' for k, h in (('OSHA employer', hs), ('ITA establishment', hi)) if len(h) == 1]
        if found and it.get('synthetic'):
            # a generated row (scripts/gen_synthetic.py) was never a real record: the complete public OSHA file decides;
            # the pool's ITA cases are a small subset where a 15-day window in a state often holds one establishment by chance
            sir_found = [x for x in found if 'OSHA employer' in x]
            if sir_found:
                (unique if SENSITIVE(it) else other).append(f"{name} {it['lane']} ({it['column']}, generated): {sir_found[0]}")
            else:
                ita_chance.append(f"{name} {it['lane']}")
        elif found:
            (unique if SENSITIVE(it) else other).append(f"{name} {it['lane']} ({it['column']}): {found[0]}")
    print(f'conclusions: {name} {len(items)} attacked; best shift guesses {best} (matches {[scores[b] for b in best]})')
print('"not found" / "not in the log" conclusions that a guessed shift ties to one real employer:', len(unique))
for u in unique[:20]:
    print('   ', u)
print('generated rows that the pool ITA subset alone ties to one establishment (chance in a subset; not failed):', len(ita_chance))
print('other conclusions (a report exists, or a person decides) that a guessed shift ties to one real employer:', len(other))
for u in other[:20]:
    print('   ', u)

# 6) QA rounds 5 and 6: the attacks that do not need the shift.
#  a) employer report sets: an employer code's reports in a sample (with their OSHA categories) against every public
#     employer's 2023-2025 reports: same Part of Body Title and NatureTitle, dates at one common offset (any, within 60
#     days, +-7). An employer code that only one public employer fits is IDENTIFIED (counted). A negative conclusion
#     fails if its OSHA report is published (not SYNTHETIC) or if its report's employer code is identified.
#  b) SYNTHETIC rows are invented, not edited: a SYNTHETIC OSHA row fails if a public report agrees with it on the date
#     (at a guessed shift, or unshifted) and on two or more of Part of Body Title, EventTitle, SourceTitle; a SYNTHETIC
#     log line fails if a published ITA case of the source companies has its date (guessed shift or unshifted), its job
#     title (or a case number of 4+ characters) and its body part.
by_cat = collections.defaultdict(list)
pub_cat = collections.defaultdict(set)
for r in pub_rows:
    d = _d(r['EventDate'])
    if d:
        by_cat[((r.get('Part of Body Title') or '').strip(), (r.get('NatureTitle') or '').strip())].append((d, (r['Employer'] or '').strip().upper()))
        pub_cat[d].add(((r.get('Part of Body Title') or '').strip(), (r.get('EventTitle') or '').strip(), (r.get('SourceTitle') or '').strip()))


def fits(reports):
    """public employers whose reports match this report set at one common date offset"""
    first, rest = reports[0], reports[1:]
    cands = {}
    for d, e in by_cat.get(first[1], []):
        off = (first[0] - d).days
        if abs(off) <= 60:
            cands.setdefault(e, []).append(off)
    out = set()
    for e, offs in cands.items():
        for off in offs:
            if all(any(e2 == e and abs((r[0] - d2).days - off) <= 7 for d2, e2 in by_cat.get(r[1], [])) for r in rest):
                out.add(e)
                break
    return out


set_fail, identified, syn_fail, n_neg, n_syn_rows = [], {}, [], 0, 0
syn_cols = ('Part of Body Title', 'EventTitle', 'SourceTitle')
ita_by_date = collections.defaultdict(list)
for cn, dd, job, txt in ita_cases_full:
    if dd:
        ita_by_date[dd].append((cn, job, txt))
for name, (items, sir_file, folder) in SAMPLE_ITEMS.items():
    rows = list(csv.DictReader(open(sir_file, encoding='utf-8', newline='')))
    best = guess(sir_file)[0]
    emp = collections.defaultdict(list)
    for r in rows:
        if _d(r['EventDate']):
            emp[(r['Employer'] or '').strip()].append((_d(r['EventDate']), ((r.get('Part of Body Title') or '').strip(), (r.get('NatureTitle') or '').strip())))
    ident = {e for e, reps in emp.items() if len(fits(reps)) == 1}
    identified[name] = (len(ident), len(emp))
    rep_by_id = {r['ID']: r for r in rows}
    for it in items:
        if not SENSITIVE(it):
            continue
        n_neg += 1
        r = rep_by_id.get(it.get('report') or '')
        if r is None:
            continue
        if 'SYNTHETIC' not in (r.get('Final Narrative') or ''):
            set_fail.append(f"{name} {it['lane']}: negative conclusion on a published report")
        elif (r['Employer'] or '').strip() in ident:
            set_fail.append(f"{name} {it['lane']}: its report's employer code is identified by the report-set attack")
# b) QA round 9: every SYNTHETIC row is new, not an edited real one (scripts/synthetic_compare.py). Each generated row
#    against every public OSHA report (2023-2025) and every ITA case of the company pool, on house number + state, case
#    number, job title, page, date and any 5-word run of narrative, at the true and the guessed date shifts and with the
#    state swap undone: 2 or more shared fields with one public row fail it. An invented plant fails if a real
#    establishment of the pool has its house number + state or its ZIP.
import synthetic_compare as SC  # noqa: E402
SAMPLE_ROOT = pathlib.Path(os.environ.get('L1_SCAN_SAMPLE', str(ROOT / 'sample')))
pub_refs = SC.public_refs(sys.argv[1], ROOT / 'data/composite/pool_PRIVATE.json')
shifts, unswap = {}, {}
for name, sir_file in (('seed1003', 'sample/seed1003/shared/osha_sir_2024.csv'), ('unseen3001', 'sample/unseen3001/public/osha_sir_2024.csv')):
    CR.configure(name)
    shifts[name] = sorted({0, CR.SHIFT, *guess(ROOT / sir_file)[0]})
    unswap[name] = {v: k for k, v in CR.PERM.items()}
syn_check = SC.public_check(SAMPLE_ROOT, pub_refs, SC.public_plants(ROOT / 'data/composite/pool_PRIVATE.json'), shifts, unswap)
syn_check_sample = SC.sample_check(SAMPLE_ROOT)
for name, r in syn_check.items():
    n_syn_rows += r['rows']
    syn_fail += [f"{name} {x['row']}: shares {', '.join(x['fields'])} with a published {x['reference']} record" for x in r['fails']]
    syn_fail += [f"{name} {c}: an invented plant at a real establishment's house number + state or ZIP" for c in r['invented_plants_at_a_real_address_or_zip']]
for name, r in syn_check_sample.items():
    syn_fail += [f"{name} {x['row']}: shares {', '.join(x['fields'])} with a real row of the sample" for x in r.get('fails', [])]
    syn_fail += [f"{name} {c}: an invented plant at a real plant's house number + state or ZIP (sample)" for c in r['invented_plants_at_a_real_address_or_zip']]
syn_fail = sorted(set(syn_fail))
print(f"report-set attack: employer codes identified: {', '.join(f'{k} {a} of {b}' for k, (a, b) in identified.items())}; negative conclusions that fail it: {len(set_fail)} of {n_neg}")
for u in set_fail:
    print('   ', u)
print(f'SYNTHETIC rows sharing 2 or more fields with a published record, or invented plants at a real address: {len(syn_fail)} (of {n_syn_rows} rows); most fields any row shares: '
      + ', '.join(f"{k} {v['max_shared']}" for k, v in syn_check.items()))
for u in syn_fail:
    print('   ', u)

# 7) QA round 7: the plants themselves. a) a plant's 300A row must not carry the published employee count or hours (they
#    single a plant out in OSHA's public 300A file); b) the real plants a 300A case-count triple (DAFW, DJTR, other)
#    still singles out among the source companies' published 300A rows are counted (they only ever carry neutral,
#    public-to-public conclusions); c) every SYNTHETIC record and every negative conclusion sits in an invented plant
#    (Site-SYN...), never in a real one.
pool_s300 = [(e['state'], e.get('s300') or {}) for c in json.loads((ROOT / 'data/composite/pool_PRIVATE.json').read_text(encoding='utf-8'))['pool'] for e in c['establishments']]
pub_emp_hours = {(str(s.get('annual_average_employees')), str(s.get('total_hours_worked'))) for _, s in pool_s300 if s}
pub_counts = collections.Counter((str(s.get('total_dafw_cases')), str(s.get('total_djtr_cases')), str(s.get('total_other_cases'))) for _, s in pool_s300 if s)
plant_fail, n_plants, n_real, n_ident = [], 0, 0, 0
for name, f300 in (('seed1003', 'sample/seed1003/shared/annual_summary_300A.csv'), ('unseen3001', 'sample/unseen3001/tables/minio-csv__yr_totals.csv')):
    for r in csv.DictReader(open(ROOT / f300, encoding='utf-8', newline='')):
        n_plants += 1
        if (r['Annual Average Employees'], r['Total Hours Worked']) in pub_emp_hours:
            plant_fail.append(f"{name} {r['Establishment']}: published 300A employees and hours")
        if not r['Establishment'].startswith('Site-SYN'):
            n_real += 1
            if pub_counts.get((r['Total Dafw Cases'], r['Total Djtr Cases'], r['Total Other Cases'])) == 1:
                n_ident += 1
syn_in_real = []
for name, (items, sir_file, folder) in SAMPLE_ITEMS.items():
    for it in items:
        if (SENSITIVE(it) or it.get('synthetic')) and not str(it.get('site') or '').startswith('Site-SYN'):
            syn_in_real.append(f"{name} {it['lane']} ({it['column']}) at {it.get('site')}")
    for f in sorted(folder.rglob('*.csv')):
        for line in f.read_text(encoding='utf-8').splitlines()[1:]:
            if 'SYNTHETIC' in line:  # any synthetic document (log line, report, letter, referral), not only log lines
                for site in re.findall(r'Site-[0-9A-Z]{4}', line):
                    if not site.startswith('Site-SYN'):
                        syn_in_real.append(f"{name} {f.name}: a SYNTHETIC record at {site}")
    for f in sorted(folder.rglob('301_*.jpg')):
        if not f.name.startswith('301_Site-SYN'):
            syn_in_real.append(f"{name} {f.name}: a 301 form at a real plant")
syn_in_real = sorted(set(syn_in_real))
print(f'plants: {len(plant_fail)} of {n_plants} carry published 300A employees and hours; {n_ident} of {n_real} real plants are singled out by their 300A case counts among the source companies')
for u in plant_fail[:10]:
    print('   ', u)
print(f'SYNTHETIC records or negative conclusions in a real plant: {len(syn_in_real)}')
for u in syn_in_real[:20]:
    print('   ', u)

# 9) values typed into code, tests, fixtures and docs (QA round 11): no real record id, and no real plant's or report's
#    house number with its ZIP in one file. The reference set adds what is no longer in the samples: the dropped
#    negative cases (ids, addresses) and the unseen company's codes from before it was re-keyed (private file).
import synthetic_compare as SC0  # noqa: E402
_cfg = json.loads((ROOT / 'data' / 'private' / 'compose_PRIVATE.json').read_text(encoding='utf-8'))
_ids, _pairs = SC0.real_values()
_fp = _cfg.get('drop_fingerprints', {})
_ids |= set(_fp.get('ids', [])) | set((_cfg.get('rekey_unseen3001') or {}).get('ids', {}))
_inv = {v: k for k, v in ((_cfg.get('rekey_unseen3001') or {}).get('zips', {})).items()}
_pairs |= {tuple(x) for x in _fp.get('pairs', [])} | {(h, _inv[z]) for h, z in _pairs if z in _inv}
hard_fail = SC0.hardcoded_check(None, _ids, _pairs)
print(f'values typed into code, tests, fixtures and docs that are a real record id or a real address with its ZIP: {len(hard_fail)} file(s)')
for u in hard_fail[:10]:
    print('   ', u)

# 8) the output gate's rule over every file git would commit (app/gate.ts, scripts/gate_scan.ts): a unit that names a
#    real plant next to a non-neutral label (not found, unresolved, for counsel, a person decides, a count that differs
#    from the 300A, ...) or a synthetic record
gate = json.loads(subprocess.run(['node', '--no-warnings', '--import', 'tsx', 'scripts/gate_scan.ts'], cwd=ROOT, capture_output=True, text=True, encoding='utf-8').stdout)
gate_hits = gate['real_plant_units_with_non_neutral_or_synthetic']
print(f"output gate: {gate['units']} units in {gate['files']} files; units naming a real plant with a non-neutral label or a synthetic record: {gate_hits}")
for f, n in list(gate['by_file'].items())[:10]:
    print('   ', f, n)

# 4) the scanned 301 forms: what each image shows is in its answer file (truth*.json; vl_recorded.json is what the model
# read). A form fails if its date and time of the event are those of a published ITA case of the source companies, or
# its date and a distinctive case number (4+ characters; "3" or "23" recur in every log) are (dates compared as written on
# the form: the samples are shifted, the synthetic forms invented).
scan_fail = []
hm = lambda t: (lambda m: f'{int(m.group(1)):02d}:{m.group(2)}' if m else '')(re.match(r'\s*(\d{1,2}):(\d{2})', str(t or '')))
ita_cases = [(str(k.get('case_number') or '').strip(), _d(k.get('date_of_incident')), hm(k.get('time_of_incident')))
             for c in json.loads((ROOT / 'data/composite/pool_PRIVATE.json').read_text(encoding='utf-8'))['pool'] for e in c['establishments'] for k in e['cases']]
by_case_date = {(cn, d) for cn, d, _ in ita_cases if len(cn) >= 4 and d}
by_date_time = {(d, t) for _, d, t in ita_cases if d and t}
forms = 0
for f in sorted((ROOT / 'sample').rglob('scans/*.json')):
    for name, v in json.loads(f.read_text(encoding='utf-8')).items():
        v = v.get('fields', v) if isinstance(v, dict) else {}
        d = _d(str(v.get('injury_date') or '')); cn = str(v.get('case_no') or '').strip(); t = hm(v.get('time_of_event'))
        forms += 1
        if (cn, d) in by_case_date or (d, t) in by_date_time:
            scan_fail.append(f'{f.relative_to(ROOT)} {name}: case {cn}, {d} {t} is a published ITA case')
print(f'scanned forms ({forms} answer entries): {len(scan_fail)} tie to a published ITA case')
for u in scan_fail:
    print('   ', u)

# 5) can the repo re-derive WHICH real companies were drawn? The draw needs the company pool (grouping and order);
# gen_composite.py and make_unseen_company.py only read it from data/composite/pool_PRIVATE.json. A tracked file fails
# if it builds or orders that pool, or carries the company grouping (a writer of pool_PRIVATE, pool_keys, the old
# grouping script by name).
SELECT = re.compile(r"pool_keys|gen_pool_extract|open\([^)]*pool_PRIVATE[^)]*['\"]w['\"]|json\.dump\([^)]*pool")
sel_fail = []
for rel in files:
    if not rel.endswith(('.py', '.ts', '.js', '.mjs', '.sh')) or rel == 'scripts/scan_identity.py':
        continue
    t = (ROOT / rel).read_text(encoding='utf-8', errors='ignore') if (ROOT / rel).exists() else ''
    if SELECT.search(t):
        sel_fail.append(rel)
print(f'company selection rebuildable from tracked scripts: {len(sel_fail)} file(s)')
for u in sel_fail:
    print('   ', u)
report(f'git history ({commits} commits, {len(blobs)} text blobs)', hist)
# counts only (no shift, state or employer): what README.md quotes, via scripts/readme_numbers.ts
(ROOT / 'docs' / 'scan_identity_result.json').write_text(json.dumps(dict(working_tree_hits=len(hits), history_hits=len(hist),
    sensitive_conclusions=n_sens, sensitive_tied=len(unique), generated_tied_by_ita_subset_only=len(ita_chance), other_conclusions=n_other, other_tied=len(other), scanned_form_entries=forms, scanned_forms_tied=len(scan_fail), selection_scripts=len(sel_fail),
    negatives_report_set_failed=len(set_fail), employer_codes_identified={k: f'{a} of {b}' for k, (a, b) in identified.items()}, synthetic_rows=n_syn_rows, synthetic_rows_derived=len(syn_fail), synthetic_max_shared_fields={k: v['max_shared'] for k, v in syn_check.items()},
    plants=n_plants, plants_published_300a=len(plant_fail), real_plants=n_real, real_plants_singled_out_by_counts=n_ident, synthetic_or_negative_in_real_plants=len(syn_in_real),
    gate_units=gate['units'], gate_files=gate['files'], gate_real_plant_non_neutral=gate_hits, hardcoded_real_values=len(hard_fail)), indent=1) + chr(10), encoding='utf-8')
sys.exit(1 if hits or hist or unique or scan_fail or sel_fail or set_fail or syn_fail or plant_fail or syn_in_real or gate_hits or hard_fail else 0)
