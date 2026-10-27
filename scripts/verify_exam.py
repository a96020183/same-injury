"""One command for judges: check the sealed-exam hashes and re-score both agent runs from the files in this repo.

  python -I scripts/verify_exam.py

1. Hashes. Recomputes SHA-256 of the generator and the scorer (they must equal the values recorded before the exam was
   opened), of the private sealed zip and company pool if this machine has them (the repo does not: they hold real
   names), and of every published exam file and prediction listed in docs/sealed_exam/SHA256SUMS.txt.
2. Scores. Scores run 1, run 2, the rule baseline and the keyword baseline with score() from the hashed scorer, each run
   on its own (20 injury-log tables, 80 field pairs), with a Wilson 95% interval per run. Nothing is pooled.
Exit code 0 only if every hash matches and the scores equal docs/sealed_exam/scores_by_run.json."""
import sys, json, math, hashlib, pathlib
sys.stdout.reconfigure(encoding='utf-8')
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from score_discovery import score, keyword_baseline, KEYS  # noqa: E402

EX = ROOT / 'docs' / 'sealed_exam'
SEEDS = [2000, 2001, 2002, 2003, 2004]
bad = 0

print('1. hashes (SHA-256)')
for line in (EX / 'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines():
    if not line or line.startswith('#'):
        continue
    h, rel = line.split('  ', 1)
    p = ROOT / rel
    if not p.exists():
        print(f'   private, not in repo   {rel}')
        continue
    ok = hashlib.sha256(p.read_bytes()).hexdigest() == h
    bad += not ok
    if not ok or not rel.startswith('docs/'):
        print(f'   {"OK      " if ok else "MISMATCH"}   {h}  {rel}')
n_pub = sum(1 for l in (EX / 'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines() if l.startswith(tuple('0123456789abcdef')) and '  docs/' in l)
print(f'   published exam files and predictions: {n_pub} checked, {bad} mismatches')


def wilson(k, n, z=1.96):
    if n == 0:
        return [0.0, 0.0]
    p, d = k / n, 1 + z * z / n
    c, h = (p + z * z / (2 * n)) / d, z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0.0, c - h), 2), round(min(1.0, c + h), 2)]


def run_scores(method):
    t = dict(t_tp=0, t_pred=0, t_gold=0, f_tp=0, f_pred=0, f_gold=0)
    for s in SEEDS:
        ans = json.load(open(EX / 'package' / str(s) / 'answers.json', encoding='utf-8'))
        pred = keyword_baseline(EX / 'package' / str(s) / 'tables') if method == 'keyword' else \
            json.load(open(EX / 'predictions' / method / str(s) / 'prediction.json', encoding='utf-8'))
        score(ans, pred)  # the hashed scorer; the counts below are the same sets it builds
        gi = {x for x, c in ans['tables'].items() if c == 'incident'}
        pi = {x for x, c in pred.get('tables', {}).items() if c == 'incident'}
        gp = {(x, k, ans['field_map'][x][k]) for x in gi for k in KEYS}
        pp = {(x, k, v) for x, m in pred.get('field_map', {}).items() for k, v in m.items() if k in KEYS and v}
        for k, v in dict(t_tp=len(gi & pi), t_pred=len(pi), t_gold=len(gi), f_tp=len(gp & pp), f_pred=len(pp), f_gold=len(gp)).items():
            t[k] += v
    return dict(counts=t, table_recall=[t['t_tp'], t['t_gold'], wilson(t['t_tp'], t['t_gold'])],
                table_precision=[t['t_tp'], t['t_pred'], wilson(t['t_tp'], t['t_pred'])],
                field_recall=[t['f_tp'], t['f_gold'], wilson(t['f_tp'], t['f_gold'])],
                field_precision=[t['f_tp'], t['f_pred'], wilson(t['f_tp'], t['f_pred'])])


print('\n2. scores, each run on its own (5 companies, 20 injury-log tables, 80 field pairs per run)')
res = {m: run_scores(m) for m in ('run1', 'run2', 'rules', 'keyword')}
label = dict(run1='Agent run 1', run2='Agent run 2', rules='Rule baseline', keyword='Keyword baseline')
print(f'   {"":18}{"tables found":>26}{"table precision":>18}{"fields right":>26}{"field precision":>18}')
for m, r in res.items():
    f = lambda x: f'{x[0]}/{x[1]} ({x[2][0]:.2f}-{x[2][1]:.2f})'
    print(f'   {label[m]:18}{f(r["table_recall"]):>26}{r["table_precision"][0]:>9}/{r["table_precision"][1]:<8}{f(r["field_recall"]):>26}{r["field_precision"][0]:>9}/{r["field_precision"][1]:<8}')
ref = EX / 'scores_by_run.json'
if '--write' in sys.argv:
    ref.write_text(json.dumps(res, indent=1), encoding='utf-8')
    print('   wrote', ref.relative_to(ROOT))
else:
    same = json.loads(ref.read_text(encoding='utf-8')) == json.loads(json.dumps(res))
    bad += not same
    print('   equal to docs/sealed_exam/scores_by_run.json:', same)
print('\nverdict:', 'all hashes match, scores reproduced' if not bad else f'{bad} problem(s)')
sys.exit(1 if bad else 0)
