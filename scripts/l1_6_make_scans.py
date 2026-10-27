"""L1-6 synthetic scanned form generator (the "paper" records for plant group D).
Content: 2 SYNTHETIC amputation cases (case no., date, times, job title, body part and narrative all invented; no published
record behind them); person and site names are fake, and the name and sex fields are blacked out before the scan look is
applied (JPEG comment L1-REDACTED marks it). The form says "SYNTHETIC TEST FORM" in its footer.
Layout: follows OSHA Form 301 (Injury and Illness Incident Report) field order; printed text in Arial, filled-in text in handwriting fonts (Ink Free, Lucida Handwriting).
Scan look: grayscale, 0.6-1.1 degree skew, noise, slight blur, JPEG quality 55, 150 dpi.
Answers (20 fields) go to data/vl/truth.json, known at generation time. Usage: python -I l1_6_make_scans.py"""
import json, random, pathlib
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'sample' / 'seed1003' / 'scans'
F = 'C:/Windows/Fonts/'
PRINT = ImageFont.truetype(F + 'arial.ttf', 22)
PRINT_B = ImageFont.truetype(F + 'arialbd.ttf', 30)
SMALL = ImageFont.truetype(F + 'arial.ttf', 17)
MARK = b'L1-REDACTED:'  # JPEG comment; app/agents/reader.ts sends a form to the vision lane only if it carries this

FORMS = [
    dict(file='scan_D1.jpg', hand='Inkfree.ttf', seed=11, establishment='Plant D-07 (masked)', name='J. Doe', sex='F', redact=['name', 'sex'],
         case_no='SYN-D1', date_written='08/14/24', began='6:30 AM', event='10:05 AM', job='Line Technician', er='Yes', inpatient='No',
         before='Clearing a jam on the infeed conveyor',
         happened="Body part: right index finger. Contact: conveyor (caught). Task: clearing a jam.",
         injury='Outcome: partial amputation, right index finger.',
         obj='Conveyor',
         truth=dict(case_no='SYN-D1', injury_date='2024-08-14', time_began_work='06:30', time_of_event='10:05', job_title='Line Technician',
                    er_visit='yes', inpatient_overnight='no', side='right', body_part='index finger')),
    dict(file='scan_D2.jpg', hand='LHANDW.TTF', seed=12, establishment='Plant D-03 (masked)', name='R. Roe', sex='M', redact=['name', 'sex'],
         case_no='SYN-D2', date_written='05/21/2024', began='15:00', event='18:40', job='Press Operator', er='No', inpatient='Yes',
         before='Changing a die on the press',
         happened="Body part: left little finger. Contact: press (crushed). Task: changing a die.",
         injury='Amputation of the left little finger', obj='Press',
         truth=dict(case_no='SYN-D2', injury_date='2024-05-21', time_began_work='15:00', time_of_event='18:40', job_title='Press Operator',
                    er_visit='no', inpatient_overnight='yes', side='left', body_part='little finger')),
]


def wrap(draw, text, font, width):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=font) > width:
            lines.append(cur)
            cur = w
        else:
            cur = t
    return lines + [cur]


def make(f, out=None):
    out = pathlib.Path(out or OUT)
    out.mkdir(parents=True, exist_ok=True)
    rnd = random.Random(f['seed'])
    W, H = 1275, 1650
    im = Image.new('L', (W, H), 250)
    d = ImageDraw.Draw(im)
    HAND = ImageFont.truetype(F + f['hand'], 30 if 'Ink' in f['hand'] else 24)

    def hand(x, y, s):
        d.text((x + rnd.randint(-3, 3), y + rnd.randint(-3, 3)), s, font=HAND, fill=rnd.randint(25, 60))

    def field(y, label, val, x0=60, x1=1215):
        d.text((x0, y), label, font=PRINT, fill=0)
        lx = x0 + d.textlength(label, font=PRINT) + 12
        d.line((lx, y + 34, x1, y + 34), fill=90, width=1)
        hand(lx + 8, y - 4, val)

    def check(x, y, label, on):
        d.rectangle((x, y + 3, x + 20, y + 23), outline=0, width=2)
        d.text((x + 28, y), label, font=PRINT, fill=0)
        if on:
            hand(x - 2, y - 8, 'X')

    d.text((60, 40), 'OSHA\'s Form 301', font=PRINT_B, fill=0)
    d.text((60, 80), 'Injury and Illness Incident Report', font=PRINT_B, fill=0)
    d.text((60, 122), 'Attention: This form contains information relating to employee health and must be used in a manner that protects the', font=SMALL, fill=40)
    d.text((60, 142), 'confidentiality of employees to the extent possible while the information is being used for occupational safety purposes.', font=SMALL, fill=40)
    field(185, 'Establishment:', f['establishment'])
    d.text((60, 245), 'Information about the employee', font=PRINT_B, fill=0)
    field(290, '1) Full name', f['name'])
    # the job title is not an item of Form 301 (item 2 is the employee's street): it is copied from the Log's column C, unnumbered
    field(340, 'Job title (from the Log, column C)', f['job'])
    d.text((60, 395), '5) Sex', font=PRINT, fill=0)
    check(180, 395, 'Male', f['sex'] == 'M')
    check(320, 395, 'Female', f['sex'] == 'F')
    d.text((60, 455), 'Information about the case', font=PRINT_B, fill=0)
    field(500, '10) Case number from the Log', f['case_no'], x1=700)
    field(550, '11) Date of injury or illness', f['date_written'], x1=760)
    field(600, '12) Time employee began work', f['began'], x1=760)
    field(650, '13) Time of event', f['event'], x1=620)
    check(660, 650, 'Check if time cannot be determined', False)
    # privacy: personal fields are blacked out on the paper before the scan exists, so no model ever sees them
    hide = f.get('redact', ['name'])
    def black(box):
        d.rectangle(box, fill=20); d.text((box[0] + 14, box[1] + 12), 'REDACTED', font=SMALL, fill=235)
    if 'name' in hide:
        black((60 + d.textlength('1) Full name', font=PRINT) + 16, 280, 1220, 328))
    if 'sex' in hide:
        black((170, 388, 470, 428))
    d.text((60, 710), '14) What was the employee doing just before the incident occurred?', font=PRINT, fill=0)
    y = 745
    for ln in wrap(d, f['before'], HAND, 1100):
        d.line((60, y + 36, 1215, y + 36), fill=120, width=1); hand(70, y, ln); y += 44
    d.text((60, y + 15), '15) What happened? Tell us how the injury occurred.', font=PRINT, fill=0)
    y += 52
    for ln in wrap(d, f['happened'], HAND, 1100):
        d.line((60, y + 36, 1215, y + 36), fill=120, width=1); hand(70, y, ln); y += 44
    d.text((60, y + 15), '16) What was the injury or illness? Tell us the part of the body that was affected and how it was affected.', font=PRINT, fill=0)
    y += 52
    for ln in wrap(d, f['injury'], HAND, 1100):
        d.line((60, y + 36, 1215, y + 36), fill=120, width=1); hand(70, y, ln); y += 44
    d.text((60, y + 15), '17) What object or substance directly harmed the employee?', font=PRINT, fill=0)
    y += 52
    hand(70, y, f['obj']); d.line((60, y + 36, 1215, y + 36), fill=120, width=1)
    y += 70
    d.text((60, y), 'Information about the physician or other health care professional', font=PRINT_B, fill=0)
    y += 50
    d.text((60, y), '8) Was employee treated in an emergency room?', font=PRINT, fill=0)
    check(620, y, 'Yes', f['er'] == 'Yes'); check(740, y, 'No', f['er'] == 'No')
    y += 50
    d.text((60, y), '9) Was employee hospitalized overnight as an in-patient?', font=PRINT, fill=0)
    check(680, y, 'Yes', f['inpatient'] == 'Yes'); check(800, y, 'No', f['inpatient'] == 'No')

    if str(f.get('case_no', '')).startswith('SYN-') or 'Site-SYN' in f.get('establishment', ''):
        d.text((60, H - 60), 'SYNTHETIC TEST FORM - not a real record', font=SMALL, fill=60)

    # scan look
    im = im.rotate(rnd.uniform(0.6, 1.1) * rnd.choice([-1, 1]), fillcolor=235, resample=Image.BICUBIC)
    px = im.load()
    for _ in range(9000):
        x, yy = rnd.randrange(W), rnd.randrange(H)
        px[x, yy] = rnd.randint(120, 200)
    im = im.filter(ImageFilter.GaussianBlur(0.7))
    im.save(out / f['file'], quality=55, comment=MARK + ','.join(f.get('redact', ['name'])).encode())



if __name__ == '__main__':
    truth = {}
    for f in FORMS:
        make(f)
        truth[f['file']] = f['truth']
    json.dump(truth, open(OUT / 'truth.json', 'w', encoding='utf-8'), indent=1)
    print('made', list(truth), 'fields', sum(len(v) for v in truth.values()))
