"""Load one composite company (exam package or the unseen demo company) into real systems behind the local Zetaris,
and give it its own Zetaris role, so the Discovery agent can run on it live and see only that company.

  input   a tables folder as written by gen_composite.py: plant_group_<X>-<kind>__<table>.csv and minio-csv__<table>.csv
  systems kind postgres / scan -> a Postgres database (l1-pg); mysql -> a MySQL database (l1-mysql);
          csv and the HQ files -> CSV on the S3 store (l1-s3), Zetaris LIGHTNING DATABASE + FILESTORE tables
  names   sources are <tag>_pg, <tag>_paper, <tag>_my, <tag>_files, <tag>_hq: nothing says "plant_a".
          Descriptions are the same neutral ones the exam emulator uses ("plant group B system").
  access  role L1_<TAG>, user <tag>@l1.local: ASSIGN the five sources, GRANT SELECT on each table, nothing else.
          Its API key goes to data/private/zetaris_<tag>_key_PRIVATE.txt (never printed).
  output  runs/live_<tag>/names.json: Zetaris table -> the generator's table key, for scoring

Usage: python -I scripts/load_company_zetaris.py <tables folder> <tag>"""
import sys, json, pathlib, secrets, datetime, urllib.request, urllib.error
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / 'src'))
import setup_zetaris as SZ  # noqa: E402  (loaders, S3 and filestore helpers; its main block does not run)
import setup_governance as G  # noqa: E402  (REST helper, same as the UI uses)
import s3put  # noqa: E402

src, tag = pathlib.Path(sys.argv[1]), sys.argv[2].lower()
assert tag.isidentifier() and len(tag) <= 12, 'tag: short identifier'
NAME = {'postgres': 'pg', 'scan': 'paper', 'mysql': 'my', 'csv': 'files'}
groups, names = {}, {}
for f in sorted(src.glob('*.csv')):
    sysname, table = f.stem.split('__', 1)
    if sysname.startswith('plant_group_'):
        g, kind = sysname[len('plant_group_'):].split('-', 1)
        source, desc = f'{tag}_{NAME[kind]}', f'plant group {g} ' + ('exports' if kind == 'csv' else 'system')
        key = f'plant_group_{g}:{kind}/{table}'
    elif sysname == 'synthetic-csv':  # the invented plants: a test system of their own (QA round 10)
        kind, source, desc, key = 'csv', f'{tag}_extra', 'separate plant system', f'synthetic:csv/{table}'
    else:
        kind, source, desc, key = 'csv', f'{tag}_hq', 'headquarters shared drive', f'minio:csv/{table}'
    groups.setdefault(source, dict(kind=kind, desc=desc, files=[]))['files'].append(f)
    names[f'{source}.{table.lower()}'] = key

stage = ROOT / 'runs' / f'live_{tag}' / 'stage'
for source, g in groups.items():
    d = stage / source
    d.mkdir(parents=True, exist_ok=True)
    for f in g['files']:
        (d / (f.stem.split('__', 1)[1] + '.csv')).write_bytes(f.read_bytes())
    if g['kind'] in ('postgres', 'scan'):
        SZ.load_pg(source, d)
    elif g['kind'] == 'mysql':
        SZ.load_mysql(source, d)
    else:
        for f in sorted(d.glob('*.csv')):
            s3put.put(SZ.S3_HOST, 'l1data', f'{tag}/{source}/{f.name}', f.read_bytes())

# catalog
for source, g in groups.items():
    if g['kind'] in ('postgres', 'scan', 'mysql'):
        SZ.z.run(f'DROP DATASOURCE {source}', tag='cleanup')
        if g['kind'] == 'mysql':
            SZ.step(f'CREATE DATASOURCE {source}', f'''CREATE DATASOURCE {source} DESCRIBE BY "{g['desc']}" OPTIONS (
  jdbcdriver "com.mysql.cj.jdbc.Driver", jdbcurl "jdbc:mysql://l1-mysql:3306/{source}?nullDatabaseMeansCurrent=true", username "l1", password "{SZ.MYPW}", fetchsize "1000")''')
        else:
            SZ.step(f'CREATE DATASOURCE {source}', f'''CREATE DATASOURCE {source} DESCRIBE BY "{g['desc']}" OPTIONS (
  jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://l1-pg:5432/{source}", username "l1", password "{SZ.PGPW}", fetchsize "1000")''')
        SZ.step(f'REGISTER {source}', f'REGISTER DATASOURCE TABLES FROM {source}')
    else:
        ok, out, _ = SZ.z.run(f'SHOW LIGHTNING TABLES {source}', tag='cleanup')
        for r in (out or {}).get('data', []) if ok else []:
            SZ.z.run(f'DROP LIGHTNING DATABASE TABLE {r[0]} FROM {source}', tag='cleanup')
        SZ.z.run(f'DROP LIGHTNING DATABASE {source}', tag='cleanup')
        SZ.step(f'CREATE LIGHTNING DATABASE {source}', f'CREATE LIGHTNING DATABASE {source} DESCRIBE BY "{g["desc"]}"')
        for f in sorted((stage / source).glob('*.csv')):
            SZ.filestore(source, f.stem.lower(), f'{tag}/{source}/{f.name}')

# a role that sees this company only
ROLE, USER = f'L1_{tag.upper()}', f'{tag}@l1.local'
pwf, keyf = ROOT / 'data' / 'private' / f'zetaris_{tag}_password_PRIVATE.txt', ROOT / 'data' / 'private' / f'zetaris_{tag}_key_PRIVATE.txt'
if not pwf.exists():
    pwf.write_text('Aa1!' + ''.join(secrets.choice('abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(20)))
pw = pwf.read_text().strip()
SZ.z.EXTRA.append(pw)
G.sql(f"CREATE ROLE '{ROLE}' DESCRIBE BY 'one_composite_company'")
st, out = G.api('POST', '/users', {'email': USER, 'name': f'Same Injury agents {tag}', 'level': 'GENERAL', 'password': pw, 'isLdap': False, 'status': 'Active'})
print('create user', st, '' if st < 300 or st == 409 else out)
G.sql(f"ASSIGN USER '{USER}' TO ROLE '{ROLE}'")
ds = [s for s, g in groups.items() if g['kind'] in ('postgres', 'scan', 'mysql')]
lb = [s for s, g in groups.items() if g['kind'] == 'csv']
G.sql(f"ASSIGN DATASOURCE {', '.join(ds)} TO ROLE '{ROLE}'")
G.sql(f"ASSIGN LIGHTNING DATABASE {', '.join(lb)} TO ROLE '{ROLE}'")
for fq in names:
    kind = 'DATASOURCE' if fq.split('.')[0] in ds else 'LIGHTNING DATABASE'
    G.sql(f"GRANT SELECT ON {kind} TABLE {fq} TO ROLE '{ROLE}'")
if not keyf.exists():
    req = urllib.request.Request('http://localhost:3000/api/auth/login', data=json.dumps({'username': USER, 'password': pw}).encode(), method='POST',
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        token = json.loads(r.read().decode()).get('idToken')
    exp = (datetime.datetime.utcnow() + datetime.timedelta(days=30)).replace(microsecond=0).isoformat() + '.000Z'
    st, k = G.api('POST', '/auth/api-key', {'name': f'same-injury-{tag}', 'expiryDate': exp}, token=token)
    key = next((k[x] for x in ('apiKey', 'key', 'token', 'value') if isinstance(k, dict) and isinstance(k.get(x), str)), None)
    print('api key for the role', st, 'saved' if key else 'missing')
    if key:
        keyf.write_text(key)
out = ROOT / 'runs' / f'live_{tag}'
json.dump(dict(tag=tag, role=ROLE, sources={s: dict(kind=g['kind'], description=g['desc']) for s, g in groups.items()}, names=names),
          open(out / 'names.json', 'w', encoding='utf-8'), indent=1)
print('loaded', len(names), 'tables in', len(groups), 'sources; role', ROLE, '->', (out / 'names.json').relative_to(ROOT))

# --public <folder>: the company's second layer (OSHA reports, State Plans, DOL) as <tag>_public, readable by the role,
# with employer and street names masked for it, and the USL namespace assigned so it can read its unified model
if '--public' in sys.argv:
    pub = pathlib.Path(sys.argv[sys.argv.index('--public') + 1])
    src = f'{tag}_public'
    TABLES = {'severe_injury_reports': 'osha_sir_2024.csv', 'state_plans': 'state_plans.csv', 'inspection': 'inspection.csv', 'related_activity': 'related_activity.csv'}
    for t, f in TABLES.items():
        s3put.put(SZ.S3_HOST, 'l1data', f'{tag}/{src}/{f}', (pub / f).read_bytes())
    ok, out, _ = SZ.z.run(f'SHOW LIGHTNING TABLES {src}', tag='cleanup')
    for r in (out or {}).get('data', []) if ok else []:
        SZ.z.run(f'DROP LIGHTNING DATABASE TABLE {r[0]} FROM {src}', tag='cleanup')
    SZ.z.run(f'DROP LIGHTNING DATABASE {src}', tag='cleanup')
    SZ.step(f'CREATE LIGHTNING DATABASE {src}', f'CREATE LIGHTNING DATABASE {src} DESCRIBE BY "OSHA and DOL public files"')
    for t, f in TABLES.items():
        SZ.filestore(src, t, f'{tag}/{src}/{f}')
        G.sql(f"GRANT SELECT ON LIGHTNING DATABASE TABLE {src}.{t} TO ROLE '{ROLE}'")
    G.sql(f"ASSIGN LIGHTNING DATABASE {src} TO ROLE '{ROLE}'")
    st, out = G.api('POST', '/access-control/assign/role/usl-namespace', {'roleNames': [ROLE.lower()], 'namespace': 'metastore.l1'})
    print('assign USL namespace', st)
    for table, masks in (('severe_injury_reports', {'Employer': G.MASK_ALL, 'Address1': G.MASK_LETTERS}), ('inspection', {'estab_name': G.MASK_ALL, 'site_address': G.MASK_LETTERS})):
        cols = G.describe('filestore', src, table)
        st, cur = G.api('GET', f'/access-control/cbac/generic/filestore/{src}/{table}')
        base = cur if isinstance(cur, dict) else {}
        body = {**base, 'id': f'{src}.{table}', 'partitionColumns': base.get('partitionColumns', []), 'version': base.get('version', 0),
                'users': [{'username': USER, 'roleSelected': ROLE.lower(), 'userLevelPolicy': 'identity_masked'}],
                'roles': [{'roleName': ROLE.lower(), 'policy': 'identity_masked'}],
                'policies': [{'policyName': 'identity_masked', 'filter': '', 'fields': [G.field(c, masks.get(c)) for c in cols]}]}
        st, out = G.api('POST', f'/access-control/cbac/generic/filestore/{src}/{table}', body)
        print('policy', src, table, st)
