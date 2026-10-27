"""Build the public, de-identified copy of the sealed discovery exam (build machine only; needs the private sealed zip).

  1. checks the four sealed inputs against sealed/SHA256SUMS_inputs.txt (exam zip, generator, scorer, company pool)
  2. extracts the zip to a temp folder, de-identifies every table with scripts/deidentify.py (addresses, towns, ZIPs, EINs;
     town names inside text) and drops the private pool index from each answers.json; table names, column names,
     date formats and every value the scorer looks at are unchanged
  3. copies both agent runs' and the rule baseline's predictions (table roles, field map, model call log; no traces)
  4. writes docs/sealed_exam/SHA256SUMS.txt: the full SHA-256 of the four sealed inputs and of every published file

Then `python -I scripts/verify_exam.py` (no private files needed) re-checks the hashes and re-scores everything.
Usage: python -I scripts/package_exam.py"""
import sys, json, shutil, hashlib, zipfile, tempfile, pathlib
sys.stdout.reconfigure(encoding='utf-8')
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import deidentify  # noqa: E402
import paraphrase  # noqa: E402

SEEDS = [2000, 2001, 2002, 2003, 2004]
OUT = ROOT / 'docs' / 'sealed_exam' / 'package'
RUNS = ROOT / 'runs' / 'sealed_exam'
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()

sealed = {}
for line in (ROOT / 'sealed' / 'SHA256SUMS_inputs.txt').read_text().splitlines():
    h, name = line.split(' *', 1)
    p = (ROOT / 'sealed' / name) if (ROOT / 'sealed' / name).exists() else (ROOT / 'scripts' / name)
    ok = sha(p) == h
    print('sealed input', pathlib.Path(name).name, 'OK' if ok else 'MISMATCH')
    if not ok:
        raise SystemExit(1)
    sealed[pathlib.Path(name).name] = h

shutil.rmtree(OUT, ignore_errors=True)
with tempfile.TemporaryDirectory() as tmp:
    with zipfile.ZipFile(ROOT / 'sealed' / 'discovery_exam_2000-2004.zip') as z:
        z.extractall(tmp)
    for s in SEEDS:
        d = pathlib.Path(tmp) / str(s)
        deidentify.process(d / 'tables', all_text=True)
        paraphrase.process(d / 'tables')  # narratives rewritten: no published sentence in the repo
        ans = json.load(open(d / 'answers.json', encoding='utf-8'))
        ans.pop('_pool_index_PRIVATE', None)
        (OUT / str(s) / 'tables').mkdir(parents=True)
        for f in sorted((d / 'tables').glob('*.csv')):
            shutil.copy(f, OUT / str(s) / 'tables' / f.name)
        json.dump(ans, open(OUT / str(s) / 'answers.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)

for run, src in (('run1', RUNS / 'run1_overlapping' / 'agent'), ('run2', RUNS / 'agent'), ('rules', RUNS / 'rules')):
    for s in SEEDS:
        dst = OUT.parent / 'predictions' / run / str(s)
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copy(src / str(s) / 'prediction.json', dst / 'prediction.json')

lines = [f'# sealed inputs, hashed 2026-10-23 before the exam was opened (the zip and the pool hold real names: kept private)']
lines += [f'{h}  sealed/{n}' if n.endswith('.zip') else f'{h}  {"data/composite/" if "pool" in n else "scripts/"}{n}' for n, h in sealed.items()]
lines += ['# published copy (this folder), made from the zip above by scripts/package_exam.py']
for p in sorted(list(OUT.rglob('*')) + list((OUT.parent / 'predictions').rglob('*'))):
    if p.is_file():
        lines.append(f'{sha(p)}  {p.relative_to(ROOT).as_posix()}')
(OUT.parent / 'SHA256SUMS.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('wrote', OUT.relative_to(ROOT), 'and SHA256SUMS.txt,', len(lines) - 6, 'published files hashed')
