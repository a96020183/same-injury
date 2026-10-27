"""Put OSHA's classification columns back in the sample OSHA files (build machine only; needs the private ID map).

The narrative rewrite (scripts/paraphrase.py) used to treat long category values ("Caught in running equipment or
machinery during regular operation") as free text and turned them into sentences that contradicted the narrative.
These columns are OIICS category names, the same for thousands of reports, so they are restored as published:
NatureTitle, Part of Body Title, EventTitle, SourceTitle, and FederalState as OSHA writes it (1 or 0). SYNTHETIC
reports get categories that follow their own invented narrative. paraphrase.py now leaves *Title columns alone.
Usage: python -I scripts/restore_categories.py SIR.csv  (rewrites the sample OSHA files in place)"""
import csv, json, re, sys, pathlib
csv.field_size_limit(10 ** 9)
ROOT = pathlib.Path(__file__).resolve().parents[1]
COLS = ['NatureTitle', 'Part of Body Title', 'EventTitle', 'SourceTitle', 'FederalState']
FILES = [ROOT / 'sample/seed1003/shared/osha_sir_2024.csv', ROOT / 'sample/unseen3001/public/osha_sir_2024.csv']
# categories for the invented reports, from their own text
SOURCE = [('band saw', 'Saws, band'), ('slicer', 'Slicers'), ('conveyor', 'Conveyors belt, slot, chain'), ('press', 'Presses, unspecified'), ('saw', 'Saws, unspecified')]
EVENT = [('(caught)', 'Caught in running equipment or machinery during regular operation'), ('(crushed)', 'Compressed or pinched by shifting objects or equipment'),
         ('(cut)', 'Struck by discharged or flying object')]


def synthetic(r):
    t = (r.get('Final Narrative') or '').lower()
    r['EventTitle'] = next((v for k, v in EVENT if k in t), 'Caught in running equipment or machinery during regular operation')
    r['SourceTitle'] = next((v for k, v in SOURCE if k in t), 'Machinery, unspecified')
    if not r.get('NatureTitle') or 'Body part' in r['NatureTitle']:
        r['NatureTitle'] = 'Amputations'
    if 'Body part' in (r.get('Part of Body Title') or ''):
        r['Part of Body Title'] = 'Finger(s), fingernail(s)'
    r['FederalState'] = '1'


def main(sir_csv):
    code_to_orig = {v: k.split('|', 1)[1] for k, v in json.loads((ROOT / 'data/private/deid_map_PRIVATE.json').read_text(encoding='utf-8'))['id'].items() if k.startswith('SIR|')}
    pub = {r['ID']: r for r in csv.DictReader(open(sir_csv, encoding='utf-8', errors='replace', newline=''))}
    for p in FILES:
        rows = list(csv.DictReader(open(p, encoding='utf-8', newline='')))
        n = 0
        for r in rows:
            if re.search('SYNTHETIC', r.get('Final Narrative') or ''):
                synthetic(r); n += 1; continue
            o = pub.get(code_to_orig.get(r['ID'], ''))
            if not o:
                raise SystemExit(f'{p.name}: no published row for {r["ID"]}')
            for c in COLS:
                r[c] = (o.get(c) or '').strip()
            n += 1
        with open(p, 'w', encoding='utf-8', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader(); w.writerows(rows)
        print(p.relative_to(ROOT), n, 'rows: categories as published (synthetic rows from their own text)')


if __name__ == '__main__':
    main(sys.argv[1])
