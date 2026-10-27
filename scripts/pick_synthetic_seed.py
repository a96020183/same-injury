"""Which seed scripts/gen_synthetic.py uses. The generator reads nothing; this script (build machine only: it needs the
public OSHA file and the private company pool) only rejects seeds. Starting from 20261027 it takes the first seed whose
generated rows pass the attacks scripts/scan_identity.py runs on them:
  - the conclusion attack: no synthetic row's date (at the guessed date shifts, +-7 days), state (and its guessed swap),
    side and body part leave exactly one real employer in the public OSHA file (a coincidence that would make an
    invented negative case read as a finding about that employer). The pool's ITA cases are a small subset of the
    national file, where a 15-day window in one state often holds exactly one pool establishment for any record at all
    (over 800 seeds no seed had none): --with-ita adds them, and scripts/scan_identity.py reports them, without failing; and
  - the six-field comparison (scripts/synthetic_compare.py): no row shares 2 or more fields with one public record.
So the seed steers the invented records away from real ones; nothing of a real record goes into them.
Usage: python -I scripts/pick_synthetic_seed.py SIR.csv [start] [count]"""
import sys, csv, json, re, datetime, pathlib, collections
csv.field_size_limit(10 ** 9)
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import gen_synthetic  # noqa: E402
import synthetic_compare as SC  # noqa: E402
import compose_records as CR  # noqa: E402
from osha_states import NAME  # noqa: E402
ABBR = {v: k for k, v in NAME.items()}
PARTS = ['thumb', 'index', 'middle', 'ring', 'little', 'pinky', 'finger', 'hand', 'wrist', 'arm', 'foot', 'toe', 'leg', 'eye', 'head', 'back']
SIDES = ['right', 'left']


def _d(s):
    for f in ('%m/%d/%Y', '%Y-%m-%d', '%d%b%Y'):
        try:
            return datetime.datetime.strptime((s or '').strip(), f).date()
        except ValueError:
            pass
    return None


SIR = sys.argv[1]
pub_rows = [r for r in csv.DictReader(open(SIR, encoding='utf-8', errors='replace', newline='')) if (r.get('EventDate') or '').strip()[-4:] in ('2023', '2024', '2025')]
sir_pub = [(_d(r['EventDate']), (r['State'] or '').strip().upper(), (r['Employer'] or '').strip().upper(), f"{r.get('Part of Body Title', '')} {r.get('Final Narrative', '')}".lower()) for r in pub_rows]
pool = json.loads((ROOT / 'data/composite/pool_PRIVATE.json').read_text(encoding='utf-8'))['pool']
ita_pub = [(_d(k['date_of_incident']), e['state'], e['establishment_id'], ' '.join(k.get(f) or '' for f in ('new_nar_what_happened', 'new_nar_injury_illness')).lower())
           for c in pool for e in c['establishments'] for k in e['cases']]
by_day = collections.defaultdict(list)
for r in pub_rows:
    by_day[(_d(r['EventDate']), (r.get('Part of Body Title') or '').strip(), (r.get('Amputation') or '').strip()[:1])].append((r['State'] or '').strip().upper())
sir_by_state = collections.defaultdict(list)
for t in sir_pub:
    sir_by_state[t[1]].append(t)
ita_by_state = collections.defaultdict(list)
for t in ita_pub:
    ita_by_state[t[1]].append(t)


def guess(sir_file):
    """the same shift and state-swap guess as scripts/scan_identity.py"""
    rows = [r for r in csv.DictReader(open(sir_file, encoding='utf-8', newline='')) if not re.search('SYNTHETIC|COMPOSITE', r.get('Final Narrative') or '')]
    scores = {sh: sum(1 for r in rows if _d(r['EventDate']) and by_day.get((_d(r['EventDate']) - datetime.timedelta(days=sh), (r.get('Part of Body Title') or '').strip(),
                                                                                (r.get('Amputation') or '').strip()[:1]))) for sh in range(-60, 61)}
    best = sorted(scores, key=lambda k: -scores[k])[:3]
    votes = collections.defaultdict(collections.Counter)
    for r in rows:
        d = _d(r['EventDate'])
        for st in by_day.get((d - datetime.timedelta(days=best[0]), (r.get('Part of Body Title') or '').strip(), (r.get('Amputation') or '').strip()[:1]), []) if d else []:
            votes[(r['State'] or '').strip().upper()][st] += 1
    return best, {k: [s for s, _ in v.most_common(2)] for k, v in votes.items()}


WITH_ITA = '--with-ita' in sys.argv
GUESS = {'seed1003': guess(ROOT / 'sample/seed1003/shared/osha_sir_2024.csv'), 'unseen3001': guess(ROOT / 'sample/unseen3001/public/osha_sir_2024.csv')}


def ties(company, date, state_name, body):
    best, states = GUESS[company]
    d = _d(date)
    part = next((p for p in PARTS if p in body), None)
    side = next((s for s in SIDES if s in body), None)
    out = []
    for sh in best:
        d0 = d - datetime.timedelta(days=sh)
        for pst in states.get(state_name, []) or [state_name]:
            hs = {e for (dd, s2, e, t) in sir_by_state.get(pst, ()) if dd and abs((dd - d0).days) <= 7 and part in t and (not side or side in t)}
            hi = {e for (dd, s2, e, t) in ita_by_state.get(ABBR.get(pst, pst), ()) if dd and abs((dd - d0).days) <= 7 and part in t and (not side or side in t)}
            out += [f'shift {sh}' for h in ((hs, hi) if WITH_ITA else (hs,)) if len(h) == 1]
    return out


def attack(gen):
    bad = []
    for company, g in gen.items():
        state = {p['code']: p['state_name'] for p in g['plants']}
        for ln in g['logs']:
            if ties(company, ln['date'], state[ln['site']], f"{ln['body']} {ln['text']}".lower()):
                bad.append(f"{company} {ln['site']} {ln['case']}")
        for r in g['reports']:
            if ties(company, r['EventDate'], r['State'], f"{r['Part of Body Title']} {r['Final Narrative']}".lower()):
                bad.append(f"{company} {r['ID']}")
    return bad


refs = SC.public_refs(SIR, ROOT / 'data/composite/pool_PRIVATE.json')
idx = SC.Index(refs)
unswap = {}
for name in ('seed1003', 'unseen3001'):
    CR.configure(name)
    unswap[name] = ({v: k for k, v in CR.PERM.items()}, sorted({0, CR.SHIFT, *GUESS[name][0]}))


def compare(gen):
    bad = []
    for company, g in gen.items():
        un, shifts = unswap[company]
        hs = {p['code']: (str(p['house']), p['state']) for p in g['plants']}
        rows = [SC.row(ln['case'], hs[ln['site']], ln['case'], ln['job'], ln['page'] or '', SC.day(ln['date']), ln['text']) for ln in g['logs']]
        rows += [SC.row(r['ID'], (SC.house(r['Address1']), ABBR.get(r['State'], r['State'])), date=SC.day(r['EventDate']), text=r['Final Narrative']) for r in g['reports']]
        for s in rows:
            n, _, _ = idx.shared(s, shifts, (lambda h: h, lambda h, un=un: (h[0], un.get(h[1], h[1])) if h else h))
            if n >= 2:
                bad.append(f'{company} {s["id"]}')
    return bad


start = int(sys.argv[2]) if len(sys.argv) > 2 else gen_synthetic.SEED
for seed in range(start, start + (int(sys.argv[3]) if len(sys.argv) > 3 else 400)):
    gen = gen_synthetic.generate(seed)
    a, c = attack(gen), compare(gen)
    print(seed, 'conclusion-attack ties', len(a), '· rows sharing 2+ fields', len(c), flush=True)
    if not a and not c:
        print('SEED', seed)
        break
