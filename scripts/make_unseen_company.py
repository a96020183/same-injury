"""A company nobody has seen, for the live demo: one new seed through the same generator as the exam
(scripts/gen_composite.py, unchanged), from the pool companies that no development seed used, then de-identified.

  seed     3001 by default. Development used seeds 1000-1012, the exam 2000-2004; 3001 was never generated before
           (the script refuses a seed that already has a folder).
  output   sample/unseen<seed>/tables/*.csv (what the agents get) and sample/unseen<seed>/answers.json (the generator's
           answer key, used only to score the run on screen). Table names, column names and date formats are random.
Build machine only (the pool holds real names). Usage: python -I scripts/make_unseen_company.py [seed]"""
import sys, json, random, pathlib, shutil, tempfile
sys.stdout.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import gen_composite as G  # noqa: E402
import deidentify  # noqa: E402
import paraphrase  # noqa: E402

seed = int(sys.argv[1]) if len(sys.argv) > 1 else 3001
assert seed not in G.DEV + G.EXAM
out = ROOT / 'sample' / f'unseen{seed}'
if (out / 'answers.json').exists():
    raise SystemExit(f'{out} exists: pick a new seed')
all_idx = list(range(len(G.POOL)))
used = set()
for s in G.DEV:
    used.update(random.Random(s).sample(all_idx, 4))
unseen = [i for i in all_idx if i not in used]
tables, ans = G.build(seed, unseen)
with tempfile.TemporaryDirectory() as tmp:
    t = pathlib.Path(tmp) / 'tables'
    t.mkdir()
    for n, rows in tables.items():
        (t / (G.safe(n) + '.csv')).write_text(G.to_csv(rows), encoding='utf-8')
    deidentify.process(t, all_text=True)
    paraphrase.process(t)
    (out / 'tables').mkdir(parents=True)
    for f in sorted(t.glob('*.csv')):
        shutil.copy(f, out / 'tables' / f.name)
ans.pop('_pool_index_PRIVATE', None)
json.dump(ans, open(out / 'answers.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
import compose_records  # noqa: E402
compose_records.unseen_tables()
inc = [k for k, v in ans['tables'].items() if v == 'incident']
print('unseen company', seed, 'tables', len(tables), 'injury logs', len(inc), 'systems', ans['systems'])
