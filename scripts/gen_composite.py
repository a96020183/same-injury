"""拼成公司產生器（V8 §4.6、§4.11 檢查三、L1-2）。
一個種子 → 一家拼成公司：從 63 家池用 random.Random(seed).sample 抽 4 家（與 r8_l1.py 相同），每家當一組 plant group。
每組放進一種「系統」：postgres／mysql／csv（MinIO 匯出）／scan（紙本，VL 讀成一欄自由文字）。
每組有：事故表（ITA 2024 全部案件，欄名、日期格式隨機）、據點主檔、1–2 張干擾表（維修工單、虛驚事件、訓練紀錄、人資名冊）；
全公司一張 300A 年度彙總（CSV）。據點名稱遮掉，地址、州、郵遞區號保留（本來就是公開檔）。
答案在產生時寫好：每張表的類別（incident／summary／site_master／distractor），事故表的欄位對照（date、body_part、narrative、site 四個計分欄，加其他欄）。

種子 1003 是 V8 示範公司：系統固定為 A=postgres（OSHA 301 式欄名、ISO 日期）、B=mysql（inc_dt、body_pt、dd/mm/yyyy）、C=csv（Excel 式寬表）、D=scan。
開發種子 1000–1012 → data/composite/<seed>/。
考題種子 2000–2004 → 直接寫進 sealed/discovery_exam_2000-2004.zip，不落地、不印內容，只印 SHA-256。
考題種子的 4 家只從「開發種子 1000–1012 沒抽到的公司」裡抽（比 V8 更嚴：確保考題公司開發時沒看過）。

v2（2026-10-23）：v1 封存後自測發現關鍵字基準就能拿 0.75 召回、1.0 精確，在沒人看過考題前改難：
事故表 40% 改用不透明欄名 f1…f9；每組加一張「急救紀錄」或「行為觀察卡」干擾表（有日期、有部位，但不是紀錄簿）。種子 1003 不變。
用法：python -I gen_composite.py dev | exam"""
import sys, json, random, hashlib, io, csv, zipfile, pathlib, datetime, re

ROOT = pathlib.Path(__file__).resolve().parents[1]
POOL = json.load(open(ROOT / 'data' / 'composite' / 'pool_PRIVATE.json', encoding='utf-8'))['pool']
DEV, EXAM = list(range(1000, 1013)), list(range(2000, 2005))

BANK = {
    'case_id': ['case_number', 'case_no', 'CaseNo', 'Case #', 'incident_id', 'rec_id', 'log_line'],
    'site': ['establishment', 'site', 'plant', 'facility_code', 'loc', 'Site Name', 'plant_id'],
    'date': ['date_of_injury', 'inc_dt', 'Incident Date', 'evt_date', 'DateOfEvent', 'occurred_on', 'dt'],
    'body_part': ['part_of_body', 'body_pt', 'Body Part Affected', 'bp', 'injured_part', 'anatomy'],
    'narrative': ['what_happened', 'descr', 'Description of Incident', 'narr', 'event_text', 'notes'],
    'injury': ['nature_of_injury', 'inj_type', 'Injury Type', 'nature', 'dx'],
    'outcome': ['outcome', 'classif', 'Case Classification', 'result_cd', 'severity'],
    'days_away': ['days_away', 'dafw', 'Days Away From Work', 'lost_days', 'away_ct'],
    'job_title': ['job_title', 'occupation', 'Job Title', 'position', 'role'],
}
FIXED_1003 = {
    'postgres': dict(case_id='case_number', site='establishment', date='date_of_injury', body_part='part_of_body', narrative='what_happened',
                     injury='nature_of_injury', outcome='outcome', days_away='days_away', job_title='job_title', fmt='%Y-%m-%d', table='injury_log'),
    'mysql': dict(case_id='rec_id', site='plant_id', date='inc_dt', body_part='body_pt', narrative='descr', injury='inj_type',
                  outcome='classif', days_away='dafw', job_title='occupation', fmt='%d/%m/%Y', table='inc_rpt'),
    'csv': dict(case_id='Case #', site='Site Name', date='Incident Date', body_part='Body Part Affected', narrative='Description of Incident',
                injury='Injury Type', outcome='Case Classification', days_away='Days Away From Work', job_title='Job Title', fmt='%m/%d/%y',
                table='EHS_Export_2024'),
}
FMTS = ['%Y-%m-%d', '%d/%m/%Y', '%m/%d/%y', '%Y%m%d', '%d-%b-%Y']
INC_NAMES = ['injury_log', 'inc_rpt', 'safety_events', 'recordables', 'tbl_ehs_01', 'case_register', 'EHS_Export_2024']
DIS = {
    'work_orders': (['wo_hist', 'maint_orders', 'cmms_wo', 'tbl_mx_02'], ['wo_id', 'asset', 'opened', 'site', 'problem', 'status']),
    'near_miss': (['near_miss', 'nm_log', 'good_catch', 'tbl_ehs_02'], ['nm_id', 'reported_on', 'site', 'what_could_have_happened', 'potential']),
    'training': (['training_completions', 'lms_export', 'trn_rec'], ['emp_id', 'course', 'completed_on', 'site', 'score']),
    'hr_roster': (['hr_roster', 'emp_master', 'people_dim'], ['emp_id', 'hire_date', 'job_title', 'site', 'shift']),
    # 難的干擾表：有日期、有部位，但不是紀錄簿（急救、虛驚）
    'first_aid': (['first_aid_log', 'fa_visits', 'nurse_log'], ['visit_id', 'visit_date', 'site', 'body_part', 'complaint', 'treatment']),
    'near_miss_bp': (['hazard_obs', 'bbs_cards', 'nm_detail'], ['obs_id', 'obs_date', 'site', 'body_part_at_risk', 'description']),
}
# 舊系統常見的不透明欄名：機率 0.4 整張事故表改用 f1…f9（順序打亂），只能從值判斷
OPAQUE_P = 0.4
FA = ['Small cut on {p}, bandage applied', 'Dust in eye, flushed', 'Minor burn on {p} from oven door', 'Splinter in {p}', 'Headache, rested 15 min']
TREAT = ['bandage', 'eye wash', 'ice pack', 'cold compress', 'none']
NM = ['Employee almost caught {p} in {m} while clearing jam', 'Guard found open on {m}; no one hurt', '{p} came close to {m} during cleaning, stopped by co-worker',
      'Pallet fell near walkway by {m}', 'Wet floor near {m}, slip without fall']
WO = ['Replace guard on {m}', 'Belt misaligned on {m}', 'Hydraulic leak at {m}', 'Lockout point missing label on {m}', 'Sensor fault {m}']
MACH = ['line 3 conveyor', 'slicer', 'mixer', 'packaging line', 'palletizer', 'grinder', 'oven loader', 'band saw']
PARTS = ['hand', 'finger', 'arm', 'foot']
COURSES = ['LOTO', 'Forklift', 'Machine Guarding', 'Knife Safety', 'Hazcom']


def fmt_date(s, f):
    for p in ('%d%b%Y', '%m/%d/%Y', '%Y-%m-%d'):
        try:
            return datetime.datetime.strptime((s or '').strip(), p).strftime(f)
        except ValueError:
            pass
    return s or ''


def mask(seed, e):
    return 'Site-' + hashlib.sha256(f'{seed}|{e}'.encode()).hexdigest()[:4].upper()


def build(seed, pool_idx):
    rnd = random.Random(seed)
    picks = rnd.sample(pool_idx, 4)
    kinds = ['postgres', 'mysql', 'csv', 'scan']
    if seed != 1003:
        rnd.shuffle(kinds)
    tables, answer = {}, dict(seed=seed, tables={}, field_map={}, systems={})
    s300rows = []
    for g, (pi, kind) in enumerate(zip(picks, kinds)):
        grp = 'ABCD'[g]
        comp = POOL[pi]
        ests = comp['establishments']
        system = f'plant_group_{grp}:{kind}'
        answer['systems'][grp] = kind
        # site master
        sm = f'{system}/sites' if seed == 1003 else f'{system}/' + rnd.choice(['sites', 'facility_dim', 'loc_master', 'plants'])
        tables[sm] = [dict(code=mask(seed, e['establishment_id']), street=e['street'], city=e['city'], state=e['state'], zip=e['zip'], ein=e['ein'])
                      for e in ests]
        answer['tables'][sm] = 'site_master'
        # incident table
        rows = [(mask(seed, e['establishment_id']), c) for e in ests for c in e['cases']]
        if kind == 'scan':
            name = f'{system}/scanned_log_transcribed'
            tables[name] = [dict(page=i // 6 + 1, site=s, transcribed_text=(
                f"Case {c['case_number']} on {fmt_date(c['date_of_incident'], '%m/%d/%Y')}. Job: {c['job_description']}. "
                f"{c['new_nar_what_happened'] or ''} Injury: {c['new_nar_injury_illness'] or ''}").strip()) for i, (s, c) in enumerate(rows)]
            answer['tables'][name] = 'incident'
            answer['field_map'][name] = dict(site='site', narrative='transcribed_text', date='transcribed_text', body_part='transcribed_text')
        else:
            if seed == 1003:
                cols = FIXED_1003[kind]
                tname, f = cols['table'], cols['fmt']
            else:
                cols = {k: rnd.choice(v) for k, v in BANK.items()}
                if rnd.random() < OPAQUE_P:
                    opaque = [f'f{i}' for i in range(1, len(BANK) + 1)]
                    rnd.shuffle(opaque)
                    cols = dict(zip(BANK, opaque))
                tname, f = rnd.choice(INC_NAMES), rnd.choice(FMTS)
            name = f'{system}/{tname}'
            out = []
            for s, c in rows:
                out.append({cols['case_id']: c['case_number'], cols['site']: s, cols['date']: fmt_date(c['date_of_incident'], f),
                            cols['body_part']: c['part_title_pred'], cols['narrative']: ' '.join(x for x in (c['new_nar_before_incident'], c['new_nar_what_happened']) if x),
                            cols['injury']: c['new_nar_injury_illness'], cols['outcome']: c['incident_outcome'], cols['days_away']: c['dafw_num_away'],
                            cols['job_title']: c['job_description']})
            tables[name] = out
            answer['tables'][name] = 'incident'
            answer['field_map'][name] = {k: cols[k] for k in BANK}
            answer['field_map'][name]['_date_format'] = f
        # distractors
        dks = rnd.sample(['work_orders', 'near_miss', 'training', 'hr_roster'], rnd.choice([1, 2]))
        if seed != 1003:
            dks.append(rnd.choice(['first_aid', 'near_miss_bp']))
        for dk in dks:
            names, cols = DIS[dk]
            dn = f'{system}/' + rnd.choice(names)
            drows = []
            for i in range(rnd.randint(8, 25)):
                e = rnd.choice(ests)
                site = mask(seed, e['establishment_id'])
                day = (datetime.date(2024, 1, 1) + datetime.timedelta(days=rnd.randint(0, 365))).strftime(f if kind != 'scan' else '%m/%d/%Y')
                m, p = rnd.choice(MACH), rnd.choice(PARTS)
                vals = {'work_orders': [f'WO{rnd.randint(10000, 99999)}', m, day, site, rnd.choice(WO).format(m=m), rnd.choice(['open', 'closed'])],
                        'near_miss': [f'NM{i + 1:03d}', day, site, rnd.choice(NM).format(m=m, p=p), rnd.choice(['low', 'med', 'high'])],
                        'training': [f'E{rnd.randint(1000, 9999)}', rnd.choice(COURSES), day, site, rnd.randint(70, 100)],
                        'hr_roster': [f'E{rnd.randint(1000, 9999)}', day, rnd.choice(['Operator', 'Sanitation', 'Maintenance Tech', 'Packer']), site,
                                      rnd.choice(['1st', '2nd', '3rd'])],
                        'first_aid': [f'FA{i + 1:03d}', day, site, p, rnd.choice(FA).format(p=p), rnd.choice(TREAT)],
                        'near_miss_bp': [f'OB{i + 1:03d}', day, site, p, rnd.choice(NM).format(m=m, p=p)]}[dk]
                drows.append(dict(zip(cols, vals)))
            tables[dn] = drows
            answer['tables'][dn] = 'distractor'
        for e in ests:
            if e.get('s300'):
                s300rows.append(dict({'Establishment': mask(seed, e['establishment_id'])}, **{k.replace('_', ' ').title(): v for k, v in e['s300'].items()}))
    sname = 'minio:csv/annual_summary_300A' if seed == 1003 else 'minio:csv/' + rnd.choice(['annual_summary_300A', 'form300a', 'yr_totals'])
    tables[sname] = s300rows
    answer['tables'][sname] = 'summary'
    answer['n_establishments'] = sum(len(POOL[pi]['establishments']) for pi in picks)
    answer['_pool_index_PRIVATE'] = picks
    return tables, answer


def to_csv(rows):
    if not rows:
        return ''
    b = io.StringIO()
    w = csv.DictWriter(b, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
    return b.getvalue()


def safe(name):
    return re.sub(r'[^A-Za-z0-9_.\-]+', '_', name.replace('/', '__').replace(':', '-'))


if __name__ == '__main__':
    mode = sys.argv[1]
    all_idx = list(range(len(POOL)))
    if mode == 'dev':
        for s in DEV:
            tables, ans = build(s, all_idx)
            d = ROOT / 'data' / 'composite' / str(s)
            d.mkdir(parents=True, exist_ok=True)
            for n, rows in tables.items():
                (d / (safe(n) + '.csv')).write_text(to_csv(rows), encoding='utf-8')
            json.dump(ans, open(d / 'answers_PRIVATE.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
            print(s, 'tables', len(tables), 'incident', sum(v == 'incident' for v in ans['tables'].values()), 'est', ans['n_establishments'])
    elif mode == 'exam':
        used = set()
        for s in DEV:
            used.update(random.Random(s).sample(all_idx, 4))
        unseen = [i for i in all_idx if i not in used]
        print('pool', len(all_idx), 'used_by_dev_seeds', len(used), 'unseen', len(unseen))
        if len(unseen) < 4:
            raise SystemExit('not enough unseen companies')
        zpath = ROOT / 'sealed' / 'discovery_exam_2000-2004.zip'
        zpath.parent.mkdir(exist_ok=True)
        with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
            for s in EXAM:
                tables, ans = build(s, unseen)
                for n, rows in tables.items():
                    z.writestr(zipfile.ZipInfo(f'{s}/tables/{safe(n)}.csv', (2026, 10, 23, 0, 0, 0)), to_csv(rows))
                z.writestr(zipfile.ZipInfo(f'{s}/answers.json', (2026, 10, 23, 0, 0, 0)), json.dumps(ans, indent=1, ensure_ascii=False))
        h = hashlib.sha256(zpath.read_bytes()).hexdigest()
        print('sealed', zpath.name, 'bytes', zpath.stat().st_size, 'sha256', h)
