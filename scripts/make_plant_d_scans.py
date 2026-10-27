"""Scanned OSHA 301 forms for the paper log's SYNTHETIC amputation cases, for the Nemotron VL reader. Only the invented
plants (Site-SYN...) get a form, and every field on it comes from scripts/gen_synthetic.py (a seed, no file): date,
times, job, what happened, injury, object. The employee name is a placeholder and is blacked out before the scan look.
Answers go to sample/seed1003/scans/truth_plant_d.json. compose_records.finish_seed() calls render().
Usage: python -I scripts/make_plant_d_scans.py"""
import sys, json, datetime, pathlib
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from l1_6_make_scans import make  # noqa: E402

HANDS = ['Inkfree.ttf', 'LHANDW.TTF']


def hhmm(t):
    h, m = (t or '0:00').split(':')
    return f'{int(h):02d}:{int(m):02d}'


def twelve(t):
    h, m = map(int, hhmm(t).split(':'))
    return f"{(h % 12) or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def render(forms, out):
    out = pathlib.Path(out)
    for p in out.glob('301_*.jpg'):
        p.unlink()
    truth = {}
    for i, f in enumerate(forms):
        d = datetime.date.fromisoformat(f['date'])
        make(dict(file=f['file'], hand=HANDS[i % 2], seed=f['seed'], establishment=f'{f["site"]} (plant group D)', name='J. Doe', sex='M', redact=['name', 'sex'],
                  case_no=f['case_no'], date_written=d.strftime('%m/%d/%y' if i % 2 else '%m/%d/%Y'), began=twelve(f['began']) if i % 2 else hhmm(f['began']),
                  event=twelve(f['event']) if i % 2 else hhmm(f['event']), job=f['job'], er=f['er'], inpatient=f['inpatient'],
                  before=f['before'], happened=f['happened'], injury=f['injury'], obj=f['obj']), out)
        truth[f['file']] = dict(site=f['site'], case_no=f['case_no'], injury_date=f['date'], time_of_event=hhmm(f['event']), job_title=f['job'],
                                er_visit=f['er'].lower(), inpatient_overnight=f['inpatient'].lower(), side=f['side'], body_part=f['part'].replace('fingertip', 'finger'))
    json.dump(truth, open(out / 'truth_plant_d.json', 'w', encoding='utf-8'), indent=1)
    return truth


if __name__ == '__main__':
    import gen_synthetic
    print('made', list(render(gen_synthetic.generate()['seed1003']['forms'], HERE.parent / 'sample' / 'seed1003' / 'scans')))
