"""Every SYNTHETIC record in the samples, generated from one seed and nothing else (QA round 9).

This file reads no file and no data: no public OSHA or ITA file, no sample row, no private file. Plant names, house
numbers, streets, towns, states, ZIPs, NAICS codes, employee counts, hours, case numbers, pages, job titles, dates,
machines, body parts and narratives all come from random.Random(seed) over the ranges and word lists below. Only the
shape of each story is fixed (what the demo needs to show): for example "the log says amputation, OSHA's phone report
says laceration", "the same ZIP and day, another house number", "no report at all". Which real case a story resembles
plays no part: none was looked at.
test/gate.test.ts checks that this file opens and reads nothing, and that no generated row shares two or more fields
(house number and state, case number, job title, page, date, a 5-word run of narrative) with any published record.
Usage: python -I scripts/gen_synthetic.py [seed]   (prints the generated records as JSON)"""
import random
import datetime
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from osha_states import NAME  # noqa: E402  (a constant list in code, no file)

SEED = 20261027  # the first seed scripts/pick_synthetic_seed.py accepts (it only rejects seeds; this file reads nothing)
# invented plants live at ZIPs no real plant in the samples uses (the samples' codes are 00100-00499)
ZIPS = [f'{z:05d}' for z in range(510, 600) if z != 544]
SYL_A = ['Bar', 'Cor', 'Dal', 'Fen', 'Gal', 'Har', 'Kel', 'Lom', 'Mar', 'Nor', 'Pel', 'Quil', 'Ros', 'Sal', 'Tor', 'Vel', 'Wex', 'Yar', 'Zel']
SYL_B = ['ova', 'ent', 'ick', 'umb', 'ast', 'evo', 'ian', 'orn', 'ade', 'ish']
TOWN_END = ['Falls', 'Crossing', 'Bend', 'Hollow', 'Landing', 'Junction', 'Mills', 'Flats']
STREET_END = ['Rd', 'Ave', 'Ln', 'Ct', 'Way', 'Pkwy', 'Row', 'Dr', 'Trl']
JOB_A = ['Kettle', 'Brine', 'Slicer', 'Tray', 'Wrap', 'Dicer', 'Bagger', 'Grinder', 'Chiller', 'Portion']
JOB_B = ['Deck Hand', 'Line Tender', 'Station Hand', 'Setup Hand', 'Room Attendant', 'Crew Second']
MACHINES = [('slicer', 'Slicers'), ('band saw', 'Band saws'), ('conveyor', 'Conveyors, belt'), ('press', 'Presses'), ('auger', 'Augers'),
            ('grinder', 'Grinders'), ('dicer', 'Dicers'), ('tray sealer', 'Sealing machines')]
TASKS = ['cleaning', 'clearing a jam', 'changing a blade', 'adjusting a guard', 'loading product', 'wiping down']
# body parts are named the way many reports name them (a finger, a fingertip), not one finger: an invented record should not
# point at the few real reports that name the same finger on the same side
FINGERS = ['finger', 'fingertip', 'two fingertips']
# the larger federal-OSHA states, where many reports fall on any week: an invented record does not stand out among them
STATES = ['TX', 'PA', 'OH', 'IL', 'GA', 'FL', 'NY', 'NJ', 'MO', 'WI', 'AL', 'CO']
NAICS = ['311612', '311613', '311615', '311991', '311999', '311421', '311813']


class G:
    def __init__(self, seed):
        self.r = random.Random(seed)
        self.zips = self.r.sample(ZIPS, 12)
        self.names = set()

    def word(self):
        while True:
            w = self.r.choice(SYL_A) + self.r.choice(SYL_B)
            if w not in self.names:
                self.names.add(w)
                return w

    def plant(self, code, group=None, letter=None):
        state = self.r.choice(STATES)
        town = f'{self.word()} {self.r.choice(TOWN_END)}'
        house = self.r.randrange(1100, 9900)
        emp = self.r.randrange(80, 1300)
        self.r.randrange(20, 99), self.r.randrange(100, 999)  # (draws kept so the accepted seed gives the same records)
        n = code.replace('Site-SYN', '')
        # every invented plant sits in one synthetic test system of its own, named after nothing real (QA round 10)
        return dict(code=code, group='synthetic', plant_name=f'Plant S{n} (SYNTHETIC)', legal_name=f'Firm SYN-{n} (SYNTHETIC)',
                    house=house, street=f'{house} {self.word()} {self.r.choice(STREET_END)}', city=town, state=state, state_name=NAME[state],
                    zip=self.zips.pop(), naics=self.r.choice(NAICS), employees=emp, hours=int(emp * self.r.uniform(1700, 2300)))

    def date(self, lo=20, hi=330):
        return datetime.date(2024, 1, 1) + datetime.timedelta(days=self.r.randrange(lo, hi))

    def injury(self, finger=None):
        side = ''  # no side: like many phone reports, and so an invented record matches no single real one
        finger = finger or self.r.choice(FINGERS)
        part = finger
        machine, source = self.r.choice(MACHINES)
        return dict(side=side, part=part, finger=finger, machine=machine, source=source, mech=self.r.choice(['caught', 'cut', 'crushed']),
                    task=self.r.choice(TASKS), category='Finger(s), fingernail(s)')

    def case(self):
        return f'S{self.r.randrange(1000, 9999)}'

    def job(self):
        return f'{self.r.choice(JOB_A)} {self.r.choice(JOB_B)}'

    def time(self):
        h = self.r.randrange(5, 20)
        return f'{h}:{self.r.choice(["00", "15", "30", "45"])}', f'{h + self.r.randrange(1, 4)}:{self.r.randrange(0, 60):02d}'


def log_text(i, result):
    """a log narrative in its own words (not the samples' 'Body part / Contact / Task / Outcome' wording)"""
    return (f'SYNTHETIC DEMO LINE, not a published record. Injured: {i["part"]}. Equipment: {i["machine"]}, {i["mech"]}. '
            f'Activity: {i["task"]}. Result: {i["part"]} {result}.')


def report_text(i, result):
    return (f'SYNTHETIC DEMO REPORT, not a published record. Injured: {i["part"]}. Equipment: {i["machine"]}, {i["mech"]}. '
            f'Activity: {i["task"]}. Result: {i["part"]} {result}.')


def other_firm(g):
    """an OSHA report's employer that is none of the invented plants"""
    g.r.randrange(100, 999)  # (draw kept, see plant())
    g.firms += 1
    return f'Firm SYN-X{g.firms} (SYNTHETIC)'


def us(d):
    return f'{d.month}/{d.day}/{d.year}'


def log_line(g, plant, d, inj, result='amputated', page=None):
    t0, t1 = g.time()
    return dict(site=plant['code'], case=g.case(), page=page, date=d.isoformat(), job=g.job(), body=inj['category'], text=log_text(inj, result),
                injury=f'SYNTHETIC DEMO LINE: {inj["part"]} {result}', outcome='2', days=str(g.r.randrange(5, 60)),
                began=t0, event=t1, side=inj['side'], part=inj['part'], machine=inj['machine'], task=inj['task'])


def report(g, rid, employer, house, street_word, plant, d, inj, amputation, hospitalized, upa='', result='amputated'):
    return {'ID': rid, 'UPA': upa, 'EventDate': us(d), 'Employer': employer, 'Address1': f'{house} {street_word}', 'City': plant['city'].upper(),
            'State': plant['state_name'], 'Zip': plant['zip'], 'Hospitalized': '1.00' if hospitalized else '0.00', 'Amputation': '1.00' if amputation else '0.00',
            'Inspection': '', 'Final Narrative': report_text(inj, result), 'NatureTitle': 'Amputations' if amputation else 'Cuts, lacerations, punctures without injury to internal structures',
            'Part of Body Title': inj['category'], 'EventTitle': 'Caught in running equipment or machinery during regular operation' if inj['mech'] == 'caught' else 'Struck by object or equipment',
            'SourceTitle': inj['source'], 'FederalState': '1'}


def inspection(aid, plant, address, d, upa):
    return dict(activity_nr=aid, estab_name=plant['legal_name'], site_address=address.upper(), site_city=plant['city'].upper(), site_state=plant['state'],
                site_zip=plant['zip'], open_date=d.isoformat(), insp_type='C', upa=upa)


def generate(seed=SEED):
    g = G(seed)
    g.firms = 0
    # ---------------------------------------------------------------- the demo company (seed 1003)
    p1, p2, p3 = g.plant('Site-SYN1', 'group_b_mysql', 'B'), g.plant('Site-SYN2', 'group_d_scan', 'D'), g.plant('Site-SYN3', 'group_d_scan', 'D')
    page2, page3 = g.r.randrange(14, 40), g.r.randrange(14, 40)
    # P1: the same ZIP, the next day, another house number, no referral (L4/R48; scripts/variants.ts changes one fact)
    d1 = g.date()
    i1 = g.injury()
    l1 = log_line(g, p1, d1, i1, 'partly amputated')
    other = p1['house'] + g.r.choice([-1, 1]) * g.r.randrange(12, 60)
    r1 = report(g, 'SIR-SYN001', other_firm(g), other, p1['street'].split(' ', 1)[1], p1, d1 + datetime.timedelta(days=1), dict(i1), True, False)
    # P2: the opening pair: the log says amputation, OSHA's phone report says laceration and hospitalized; OSHA's referral
    # leads to a DOL inspection at the plant's address; a reply letter cites the referral
    d2 = g.date()
    i2 = g.injury()
    l2 = log_line(g, p2, d2, i2, 'amputated', page2)
    i2r = dict(i2, mech='cut')
    r2 = report(g, 'SIR-SYN002', p2['legal_name'], p2['house'], p2['street'].split(' ', 1)[1], p2, d2, i2r, False, True, 'REF-SYN002', 'lacerated')
    ins2 = inspection('DOL-SYN0002', p2, p2['street'], d2 + datetime.timedelta(days=g.r.randrange(8, 16)), 'REF-SYN002')
    letter = dict(doc_id='LTR-SYN001', site=p2['code'], sent_on=(d2 + datetime.timedelta(days=g.r.randrange(4, 9))).isoformat(), subject='Response to OSHA referral REF-SYN002',
                  body=f'SYNTHETIC DEMO LETTER, not a published record. In response to referral REF-SYN002, the plant describes the guard it added to the {i2["machine"]}.', synthetic='true')
    # P2 again and P3: an amputation in the log with no report anywhere (L8, L5)
    d2b = d2 + datetime.timedelta(days=g.r.randrange(60, 150))
    l2b = log_line(g, p2, d2b, g.injury(), 'partly amputated', page2)
    l3 = log_line(g, p3, g.date(), g.injury(), 'partly amputated', page3)
    forms = []
    for k, (ln, plant, inpatient) in enumerate(((l2, p2, True), (l2b, p2, False), (l3, p3, False))):
        forms.append(dict(file=f'301_{plant["code"]}_case{ln["case"]}.jpg', site=plant['code'], case_no=ln['case'], date=ln['date'], began=ln['began'], event=ln['event'],
                          job=ln['job'], er='Yes' if (inpatient or g.r.random() < 0.5) else 'No', inpatient='Yes' if inpatient else 'No', side=ln['side'], part=ln['part'],
                          before=f'{ln["task"].capitalize()} at the {ln["machine"]}', happened=f'SYNTHETIC DEMO FORM. Injured: {ln["part"]}. Equipment: {ln["machine"]}.',
                          injury=f'{ln["part"].capitalize()} {"amputated" if ln is l2 else "partly amputated"}', obj=ln['machine'].capitalize(), seed=200 + k))
    seed1003 = dict(plants=[p1, p2, p3], logs=[l1, l2, l2b, l3], reports=[r1, r2], inspections=[ins2], letters=[letter], forms=forms, extra_300a={})

    # ---------------------------------------------------------------- the unseen company (seed 3001)
    q5, q6 = g.plant('Site-SYN5', 'plant_group_B-mysql', 'B'), g.plant('Site-SYN6', 'plant_group_C-postgres', 'C')
    q7, q8, q9 = (g.plant(c, 'plant_group_D-csv', 'D') for c in ('Site-SYN7', 'Site-SYN8', 'Site-SYN9'))
    u5 = log_line(g, q5, g.date(), g.injury(), 'partly amputated')
    # Q6: the lead pair: the same ZIP and day, another house number; OSHA's referral leads to a DOL inspection at OSHA's
    # address three days later; the employer is masked for the agents, so a person decides
    d6 = g.date()
    i6 = g.injury()
    u6 = log_line(g, q6, d6, i6, 'partly amputated')
    h6 = q6['house'] + g.r.choice([-1, 1]) * g.r.randrange(200, 2000)
    w6 = g.word()
    r6 = report(g, 'SIR-SYN003', other_firm(g), h6, f'{w6} {g.r.choice(STREET_END)}', q6, d6, dict(i6), True, False, 'REF-SYN003', 'partly amputated')
    ins6 = inspection('DOL-SYN0003', dict(q6, legal_name=r6['Employer']), r6['Address1'], d6 + datetime.timedelta(days=3), 'REF-SYN003')
    u7 = log_line(g, q7, g.date(), g.injury(), 'amputated')
    d8 = g.date(20, 240)
    u8 = log_line(g, q8, d8, g.injury(), 'partly amputated')
    r8 = report(g, 'SIR-SYN004', other_firm(g), q8['house'], q8['street'].split(' ', 1)[1], q8, d8 + datetime.timedelta(days=g.r.randrange(45, 90)),
                g.injury(), True, False, '', 'partly amputated')
    r9 = report(g, 'SIR-SYN005', other_firm(g), q9['house'], q9['street'].split(' ', 1)[1], q9, g.date(), g.injury(), True, False, '', 'amputated')
    unseen3001 = dict(plants=[q5, q6, q7, q8, q9], logs=[u5, u6, u7, u8], reports=[r6, r8, r9], inspections=[ins6], letters=[], forms=[], extra_300a={'Site-SYN7': 1})
    return {'seed1003': seed1003, 'unseen3001': unseen3001}


if __name__ == '__main__':
    print(json.dumps(generate(int(sys.argv[1]) if len(sys.argv) > 1 else SEED), indent=1, default=str))
