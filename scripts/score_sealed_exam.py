"""Score the sealed discovery exam (seeds 2000-2004) for the agent, the rule baseline and the keyword baseline.

Uses score() and keyword_baseline() from score_discovery.py, which is byte-identical to the version hashed before the exam
was sealed. Adds pooled counts, Wilson 95% intervals and a company-level bootstrap interval.

usage: python -I scripts/score_sealed_exam.py EXAM_ROOT RUN_ROOT OUT.json
  EXAM_ROOT/<seed>/tables/*.csv and EXAM_ROOT/<seed>/answers.json  (answers extracted only after every run finished)
  RUN_ROOT/agent/<seed>/prediction.json, RUN_ROOT/rules/<seed>/prediction.json  (written by app/exam.ts with L1_EXAM_OUT and L1_EXAM_FLAT=1)
"""
import sys, json, math, random, pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from score_discovery import score, keyword_baseline, KEYS  # noqa: E402

SEEDS = [2000, 2001, 2002, 2003, 2004]


def counts(ans, pred):
    gold_inc = {t for t, c in ans['tables'].items() if c == 'incident'}
    pred_inc = {t for t, c in pred.get('tables', {}).items() if c == 'incident'}
    gold_pairs = {(t, k, ans['field_map'][t][k]) for t in gold_inc for k in KEYS}
    pred_pairs = {(t, k, v) for t, m in pred.get('field_map', {}).items() for k, v in m.items() if k in KEYS and v}
    return dict(t_tp=len(gold_inc & pred_inc), t_pred=len(pred_inc), t_gold=len(gold_inc),
                f_tp=len(gold_pairs & pred_pairs), f_pred=len(pred_pairs), f_gold=len(gold_pairs))


def wilson(k, n, z=1.96):
    if n == 0:
        return [0.0, 0.0]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0.0, c - h), 3), round(min(1.0, c + h), 3)]


def pooled(rows):
    s = {k: sum(r[k] for r in rows) for k in rows[0]}
    r = lambda a, b: round(s[a] / s[b], 3) if s[b] else 0.0
    return s, dict(table_precision=r('t_tp', 't_pred'), table_recall=r('t_tp', 't_gold'),
                   field_precision=r('f_tp', 'f_pred'), field_recall=r('f_tp', 'f_gold'))


def bootstrap(rows, n=10000, seed=7):
    rnd = random.Random(seed)
    out = {m: [] for m in ('table_precision', 'table_recall', 'field_precision', 'field_recall')}
    for _ in range(n):
        _, p = pooled([rnd.choice(rows) for _ in rows])
        for m in out:
            out[m].append(p[m])
    return {m: [round(sorted(v)[int(0.025 * n)], 3), round(sorted(v)[int(0.975 * n) - 1], 3)] for m, v in out.items()}


if __name__ == '__main__':
    exam, runs, out = (pathlib.Path(a) for a in sys.argv[1:4])
    res = {}
    for method in ('agent', 'rules', 'keyword'):
        per, rows = {}, []
        for s in SEEDS:
            ans = json.load(open(exam / str(s) / 'answers.json', encoding='utf-8'))
            if method == 'keyword':
                pred = keyword_baseline(exam / str(s) / 'tables')
            else:
                pred = json.load(open(runs / method / str(s) / 'prediction.json', encoding='utf-8'))
            sc = score(ans, pred)
            c = counts(ans, pred)
            # same numbers as the hashed scorer
            assert abs(sc['table_recall'] - round(c['t_tp'] / c['t_gold'], 3)) < 1e-9 and abs(sc['field_recall'] - round(c['f_tp'] / c['f_gold'], 3)) < 1e-9
            per[s] = dict(sc, **c)
            rows.append(c)
        s, p = pooled(rows)
        res[method] = dict(per_company=per, pooled_counts=s, pooled=p,
                           macro={m: round(sum(per[x][m] for x in SEEDS) / len(SEEDS), 3) for m in p},
                           wilson95=dict(table_precision=wilson(s['t_tp'], s['t_pred']), table_recall=wilson(s['t_tp'], s['t_gold']),
                                         field_precision=wilson(s['f_tp'], s['f_pred']), field_recall=wilson(s['f_tp'], s['f_gold'])),
                           bootstrap95_companies=bootstrap(rows))
    json.dump(res, open(out, 'w', encoding='utf-8'), indent=1)
    for m, r in res.items():
        print(m, 'pooled', r['pooled'], 'counts', r['pooled_counts'])
        print('   wilson', r['wilson95'])
        print('   bootstrap', r['bootstrap95_companies'])
