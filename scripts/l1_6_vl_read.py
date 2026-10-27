"""L1-6: Super VL (via Nightshift) reads the synthetic scanned forms; passes only if >= 18 of 20 fields are correct.
One call per image, asking for JSON; reasoning text is stripped before parsing. Scoring rules (fixed in advance):
  case_no, job_title: exact match after trimming whitespace, case-insensitive
  injury_date: same YYYY-MM-DD; time_*: same HH:MM (24-hour)
  sex: M/F; er_visit, inpatient_overnight: yes/no; side: left/right
  body_part: the expected finger name (middle / ring) appears in the answer
Receipts (requested model, served model, tokens) go to out/l1_6_vl.json and runs/calls.jsonl.
Usage: python -I l1_6_vl_read.py [model]"""
import sys, json, re, pathlib
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'src'))
import nightshift

MODEL = sys.argv[1] if len(sys.argv) > 1 else 'nvidia/nemotron-3.5-super-vl-120b-a12b'
RETRIES = int(sys.argv[2]) if len(sys.argv) > 2 else 8
VL = HERE.parent / 'data' / 'vl'
truth = json.load(open(VL / 'truth.json', encoding='utf-8'))
PROMPT = """This is a scanned, hand-filled OSHA Form 301 incident report. Read it and return ONLY one JSON object, no prose, with exactly these keys:
{"case_no": string as written in item 10,
 "injury_date": "YYYY-MM-DD" (item 11),
 "time_began_work": "HH:MM" 24-hour (item 12),
 "time_of_event": "HH:MM" 24-hour (item 13),
 "job_title": string (item 2),
 "sex": "M" or "F" (item 5, the checked box),
 "er_visit": "yes" or "no" (item 8, the checked box),
 "inpatient_overnight": "yes" or "no" (item 9, the checked box),
 "side": "left" or "right" (which side of the body was injured, from item 16),
 "body_part": the primary body part injured, from item 16}
If a value is unreadable, use null."""


def parse(text):
    m = re.search(r'\{.*\}', text, re.S)
    return json.loads(m.group(0)) if m else {}


def ok(k, want, got):
    if got is None:
        return False
    g = str(got).strip().lower()
    w = str(want).strip().lower()
    if k == 'body_part':
        return w.split()[0] in g
    if k.startswith('time_'):
        g = re.sub(r'^(\d):', r'0\1:', g)
        w = re.sub(r'^(\d):', r'0\1:', w)
    return re.sub(r'\s+', ' ', g) == re.sub(r'\s+', ' ', w)


res, total, right, receipts = {}, 0, 0, []
OUTF = HERE.parent / 'out' / ('l1_6_vl.json' if len(sys.argv) == 1 else 'l1_6_vl_' + re.sub(r'\W', '_', MODEL) + '.json')


def save(partial=False):
    summary = dict(fields=total, correct=right, gate=('PARTIAL' if partial else ('PASS' if right >= 18 else 'FAIL')), threshold='>=18 of 20',
                   requested=MODEL, served=sorted({x['served'] for x in receipts if x.get('served')}))
    json.dump(dict(summary=summary, receipts=receipts, fields=res), open(OUTF, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    return summary


for fn, t in truth.items():
    msgs = [{'role': 'user', 'content': [{'type': 'text', 'text': PROMPT}, nightshift.image_part(VL / fn)]}]
    try:
        r = nightshift.chat(msgs, MODEL, max_tokens=3000, tag='l1-6-vl:' + fn, retries=RETRIES)
    except RuntimeError as e:  # service kept failing: count every field on this image as unread (wrong), record as is
        receipts.append(dict(file=fn, requested=MODEL, served=None, error=str(e)[:200]))
        res[fn] = {k: dict(want=v, got=None, ok=False) for k, v in t.items()}
        total += len(t)
        print(fn, 'FAILED after retries', flush=True)
        continue
    receipts.append(dict(file=fn, requested=MODEL, served=r['served'], usage=r['usage'], headers=r['headers']))
    try:
        got = parse(r['text'])
    except Exception as e:
        got = {'_parse_error': str(e), '_text': r['text'][:500]}
    per = {k: dict(want=v, got=got.get(k), ok=ok(k, v, got.get(k))) for k, v in t.items()}
    res[fn] = per
    total += len(per)
    right += sum(p['ok'] for p in per.values())
    print(fn, 'served by', r['served'], sum(p['ok'] for p in per.values()), '/', len(per), flush=True)
    save(partial=True)

print(json.dumps(save()))
