"""Rewrite published injury narratives so that no sentence of the public files is in the repo, while keeping what the
agents match on: the side and body part, the mechanism (what the employee was doing, what caught or struck them) and
the outcome (amputation, laceration, fracture ...). Deterministic templates, no model, no lookup: the same text always
gives the same rewrite. Marked SYNTHETIC lines are left alone (they are not published).

  python -I scripts/paraphrase.py <folder> [<folder> ...]     rewrite every free-text cell of every CSV in place
  import paraphrase; paraphrase.rewrite(text)                 one text

A column is free text when most of its values have four or more words and most values differ (a category column repeats a few values). Transcribed paper-log
lines keep their typed header ("Case 11 on 05/21/2024. Job: Maintenance Tech.") and the rest is rewritten."""
import sys, csv, re, hashlib, pathlib
csv.field_size_limit(10 ** 9)

SIDE = [('both', r'\b(both|bilateral)\b'), ('right', r'\b(right|rt)\b'), ('left', r'\b(left|lt)\b')]
ALONE = {'clearing a jam on': 'clearing a jam', 'cleaning': 'cleaning', 'adjusting': 'doing maintenance', 'cutting with': 'cutting', 'loading': 'lifting or moving material',
         'operating': 'operating equipment', 'walking near': 'walking'}
PARTS = [('thumb', r'thumb'), ('index finger', r'index|pointer|1st finger|first finger'), ('middle finger', r'middle|2nd finger|second finger|long finger'),
         ('ring finger', r'ring finger|ring\b|3rd finger|third finger|4th finger'), ('little finger', r'pinky|pinkie|little finger|5th finger|small finger'),
         ('fingertip', r'finger ?tip|tip of (the )?(his |her |their )?\w* ?finger|distal'), ('fingers', r'fingers'), ('finger', r'finger'),
         ('hand', r'\bhand'), ('wrist', r'wrist'), ('forearm', r'forearm'), ('arm', r'\barm\b'), ('elbow', r'elbow'), ('shoulder', r'shoulder'),
         ('toe', r'\btoe'), ('foot', r'\bfoot|\bfeet'), ('ankle', r'ankle'), ('knee', r'knee'), ('leg', r'\bleg'), ('hip', r'\bhip'),
         ('eye', r'\beye'), ('head', r'\bhead|skull'), ('face', r'\bface'), ('lower back', r'lumbar|lower back'), ('back', r'\bback\b'), ('neck', r'\bneck'), ('ear', r'\bear\b'), ('abdomen', r'abdom|hernia'), ('ribs', r'\brib'), ('chest', r'chest'), ('lungs', r'inhal|lung|respirat')]
OUTCOME = [('partial amputation', r'partial(ly)? amput|tip.{0,20}amput|amput.{0,30}tip'), ('amputation', r'amput|severed|cut off'), ('avulsion', r'avuls|degloving'),
           ('crush injury', r'crush'), ('fracture', r'fractur|broke|broken'), ('laceration', r'lacerat|\bcut\b|\bcuts\b|sutures|stitches'),
           ('burn', r'\bburn'), ('puncture', r'punctur'), ('dislocation', r'dislocat'), ('sprain or strain', r'sprain|strain'), ('contusion', r'contusion|bruis'),
           ('chemical exposure', r'chemical|inhal'), ('heat illness', r'heat (stress|exhaust|stroke)'), ('injury', r'.')]
OBJECT = [('band saw', r'band ?saw'), ('saw', r'\bsaw'), ('slicer', r'slicer'), ('knife', r'knife'), ('blade', r'blade'), ('conveyor', r'conveyor'),
          ('roller', r'roller'), ('belt and pulley', r'pulley|belt'), ('chain', r'\bchain'), ('press', r'\bpress\b'), ('grinder', r'grind'), ('mixer', r'mixer'),
          ('auger', r'auger'), ('sealer', r'sealer'), ('cutter', r'cutter'), ('rack', r'\brack'), ('pallet', r'pallet'), ('forklift', r'forklift|fork lift|pallet jack|power jack'),
          ('door', r'\bdoor'), ('ladder', r'ladder'), ('stairs', r'stair'), ('truck', r'truck|trailer'), ('pump', r'\bpump'), ('valve', r'valve'), ('hammer', r'hammer'),
          ('machine', r'machin|equipment|line\b|unit\b')]
ACTION = [('clearing a jam on', r'jam|clear'), ('cleaning', r'clean|sanit|wip(e|ing)'), ('adjusting', r'adjust|align|troubleshoot|repair|maint'),
          ('cutting with', r'cutting|cut(s)? (the|a)'), ('loading', r'load|stack|lift'), ('operating', r'operat|running|using'), ('walking near', r'walk|slip|trip|fell|fall')]
VERB = {'amputation': 'caught', 'partial amputation': 'caught', 'avulsion': 'caught', 'crush injury': 'crushed', 'fracture': 'struck', 'laceration': 'cut',
        'burn': 'burned', 'puncture': 'punctured', 'contusion': 'struck', 'dislocation': 'injured', 'sprain or strain': 'strained', 'chemical exposure': 'exposed',
        'heat illness': 'affected', 'injury': 'injured'}
NEG = re.compile(r'\b(no|not|without|non)[- ](\w+ ){0,2}amput', re.I)


def _first(table, t):
    return next((name for name, rx in table if re.search(rx, t, re.I)), None)


def _parts(t):
    found = [name for name, rx in PARTS if re.search(rx, t, re.I)]
    if 'fingertip' in found:
        fing = [p for p in found if p.endswith('finger') and p != 'finger' and p != 'fingertip']
        found = [f'tip of the {fing[0]}'] if fing else ['fingertip']
    found = [p for p in found if not (p in ('finger', 'fingers') and any(q.endswith('finger') and q not in ('finger', 'fingers') for q in found))]
    return found[:2]


def rewrite(text):
    """one narrative -> a template sentence with the same side, body part, mechanism and outcome"""
    t = (text or '').strip()
    if not t or 'SYNTHETIC' in t or 'COMPOSITE' in t or re.search(r'(REF|SIR|DOL|INSP)-\w+', t):
        return text
    head = ''
    m = re.match(r'(Case \S+ on [0-9/]+\.( Job: [^.]*\.)?)\s*', t)
    if m:
        head, t = m.group(1) + ' ', t[m.end():]
    side = _first(SIDE, t)
    parts = _parts(t)
    outcome = _first(OUTCOME, t)
    if outcome in ('amputation', 'partial amputation') and NEG.search(t):
        outcome = _first([o for o in OUTCOME if not o[0].endswith('amputation')], t)
    obj = _first(OBJECT, t)
    act = _first(ACTION, t)
    sd = side + ' ' if side and side != 'both' else ''
    where = ' and '.join((p.replace('tip of the ', 'tip of the ' + sd) if p.startswith('tip of the ') else sd + p) for p in parts) if parts else 'body'
    if side == 'both' and parts:
        where = 'both ' + ' and '.join(p + ('s' if not p.endswith('s') else '') for p in parts)
    # structured, not prose: a field-style line keeps the facts and shares no run of words with a published sentence
    bits = [f"Body part: {where}."]
    if obj or act:
        bits.append(f"Contact: {obj or 'equipment'}{' (' + VERB.get(outcome, 'injured') + ')' if outcome != 'injury' else ''}.")
    if act:
        bits.append(f"Task: {ALONE[act]}.")
    bits.append(f"Outcome: {outcome}, {where}." if outcome != 'injury' else "Outcome: injury, type not stated.")
    if NEG.search(t):
        bits.append("Not an amputation.")
    return head + " ".join(bits)


def is_free_text(values):
    """a column of free text: mostly multi-word values, mostly distinct (a category column repeats a few values)"""
    vals = [v for v in values if v]
    if not vals:
        return False
    words = sum(len(v.split()) >= 4 for v in vals) / len(vals)
    distinct = len(set(vals)) / len(vals)
    return words > 0.5 and distinct > 0.5


def process(folder):
    n = 0
    for p in sorted(pathlib.Path(folder).rglob('*.csv')):
        with open(p, encoding='utf-8', newline='') as f:
            rows = list(csv.DictReader(f))
        if not rows:
            continue
        # OSHA's classification columns (NatureTitle, EventTitle, ...) are category names, not text: left as published
        cols = [c for c in rows[0] if is_free_text([r[c] for r in rows]) and not c.endswith('Title')]
        for r in rows:
            for c in [c for c in rows[0] if not c.endswith('Title')]:
                # every free-text column, and any other cell long enough to be a searchable phrase (six words or more)
                words = len(re.findall(r"[A-Za-z0-9']+", r[c] or ''))
                new = rewrite(r[c]) if (c in cols and words >= 4) or words >= 6 else r[c]
                n += new != r[c]
                r[c] = new
        with open(p, 'w', encoding='utf-8', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
    print('rewritten', n, 'narratives in', folder)
    return n


if __name__ == '__main__':
    for f in sys.argv[1:]:
        process(f)
