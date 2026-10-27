"""Load the demo composite company (sample/seed1003) into four real systems and register them in the local Zetaris.

  plant group A  -> Postgres  (container l1-pg, database plant_a)        Zetaris DATASOURCE plant_a
  plant group B  -> MySQL 8.4 (container l1-mysql, database plant_b)     Zetaris DATASOURCE plant_b
  plant group C  -> CSV export on the S3 store (container l1-s3)         Zetaris LIGHTNING DATABASE plant_c (FILESTORE tables)
  plant group D  -> paper log read into Postgres (l1-pg, plant_d)        Zetaris DATASOURCE plant_d
  HQ files       -> 300A yearly summary + reply letters on S3            Zetaris LIGHTNING DATABASE hq_files
  OSHA public    -> Severe Injury Reports slice + State Plan list on S3  Zetaris LIGHTNING DATABASE osha_public
  DOL            -> inspection + related_activity snapshot on S3        Zetaris LIGHTNING DATABASE dol
  invented plants -> the synthetic test system (sites + injury log) on S3  Zetaris LIGHTNING DATABASE extra_sites
                    (every SYNTHETIC plant and log line, apart from every real employer's system: scripts/gen_synthetic.py)
                    (the live DOL REST tables were proven in scripts/zetaris_gate.py; the agent reads the snapshot so a run is repeatable)

Every value is loaded as text: the plant systems really disagree on date formats, and the agent has to discover that.
Descriptions given to Zetaris are neutral ("plant group B system") so that the catalog does not give the answer away.
Secrets: ../.env (Zetaris) and data/private/*_PRIVATE.txt (local DB / S3 passwords). Logged SQL is scrubbed.
Usage: python -I scripts/setup_zetaris.py"""
import sys, io, csv, json, pathlib, subprocess
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / 'src'))
import zetaris as z
import s3put

S = ROOT / 'sample' / 'seed1003'
PRIV = ROOT / 'data' / 'private'
PGPW = (ROOT / 'data' / 'l1pg_password_PRIVATE.txt').read_text().strip()
MYPW = (PRIV / 'mysql_l1_PRIVATE.txt').read_text().strip()
MYROOT = (PRIV / 'mysql_root_PRIVATE.txt').read_text().strip()
S3SK = s3put.secret()
z.EXTRA += [MYPW, MYROOT, S3SK]
S3_HOST = 'http://127.0.0.1:58334'   # from the laptop
S3_ZET = 'http://l1-s3:8333'         # from inside the Zetaris network
log = []


def sh(cmd, stdin=None):
    r = subprocess.run(cmd, input=stdin, capture_output=True)
    if r.returncode != 0:
        raise SystemExit(f'failed: {cmd[:4]} {z._scrub(r.stderr.decode("utf-8", "replace"))[:400]}')
    return r.stdout.decode('utf-8', 'replace')


def rows(p):
    with open(p, encoding='utf-8', newline='') as f:
        rd = csv.reader(f)
        head = next(rd)
        return head, list(rd)


def ident(c):
    return '"' + c.replace('"', '""') + '"'


def load_pg(db, folder):
    sh(['docker', 'exec', 'l1-pg', 'psql', '-U', 'l1', '-d', 'l1', '-c', f'DROP DATABASE IF EXISTS {db}'])
    sh(['docker', 'exec', 'l1-pg', 'psql', '-U', 'l1', '-d', 'l1', '-c', f'CREATE DATABASE {db}'])
    for f in sorted(folder.glob('*.csv')):
        head, _ = rows(f)
        ddl = f'CREATE TABLE {f.stem.lower()} (' + ', '.join(f'{ident(c)} text' for c in head) + ');'
        sh(['docker', 'exec', 'l1-pg', 'psql', '-U', 'l1', '-d', db, '-c', ddl])
        sh(['docker', 'exec', '-i', 'l1-pg', 'psql', '-U', 'l1', '-d', db, '-c', f"\\copy {f.stem.lower()} FROM STDIN WITH (FORMAT csv, HEADER true)"],
           stdin=f.read_bytes())
        print('pg', db, f.stem)


def my_lit(v):
    return "'" + v.replace('\\', '\\\\').replace("'", "''") + "'"


def load_mysql(db, folder):
    stmts = [f'DROP DATABASE IF EXISTS {db};', f'CREATE DATABASE {db};', f"GRANT ALL ON {db}.* TO 'l1'@'%';", f'USE {db};']
    for f in sorted(folder.glob('*.csv')):
        head, data = rows(f)
        t = f.stem.lower()
        stmts.append(f'CREATE TABLE `{t}` (' + ', '.join(f'`{c}` TEXT' for c in head) + ') DEFAULT CHARSET=utf8mb4;')
        for r in data:
            stmts.append(f'INSERT INTO `{t}` VALUES (' + ', '.join(my_lit(v) for v in r) + ');')
        print('mysql', db, t, len(data))
    sh(['docker', 'exec', '-i', '-e', f'MYSQL_PWD={MYROOT}', 'l1-mysql', 'mysql', '-uroot', '--default-character-set=utf8mb4'],
       stdin='\n'.join(stmts).encode('utf-8'))


def step(name, sql, must=True):
    ok, out, rec = z.run(sql, tag='setup:' + name)
    log.append(dict(step=name, ok=ok, error=rec['error']))
    print(('PASS ' if ok else 'FAIL ') + name, '' if ok else (rec['error'] or '')[:300])
    if must and not ok:
        raise SystemExit('stop')
    return ok, out


def filestore(db, table, key):
    step(f'{db}.{table}', f'''CREATE LIGHTNING FILESTORE TABLE {table} FROM {db} FORMAT CSV OPTIONS (
  path "s3a://l1data/{key}",
  awsAccessKeyId "l1key",
  awsSecretAccessKey "{S3SK}",
  s3Endpoint "{S3_ZET}",
  header "true",
  delimiter ",",
  multiLine "true",
  escape "\\""
)''')


if __name__ == '__main__':
    # 1. systems
    load_pg('plant_a', S / 'group_a_postgres')
    load_pg('plant_d', S / 'group_d_scan')
    load_mysql('plant_b', S / 'group_b_mysql')
    import time, urllib.request, urllib.error
    for _ in range(60):  # SeaweedFS takes ~20 s to open its S3 port after the container starts
        try:
            urllib.request.urlopen(S3_HOST + '/', timeout=3)
            break
        except urllib.error.HTTPError:
            break
        except Exception:
            time.sleep(2)
    up = {}
    for sub, prefix in (('group_c_csv', 'plant_c'), ('shared', 'hq'), ('dol', 'dol'), ('reference', 'osha'), ('synthetic_csv', 'synthetic')):
        for f in sorted((S / sub).glob('*.csv')):
            key = f'{prefix}/{f.name}'
            if f.name == 'osha_sir_2024.csv':
                key = 'osha/osha_sir_2024.csv'
            up[key] = s3put.put(S3_HOST, 'l1data', key, f.read_bytes())
    print('s3', up)

    # 2. Zetaris catalog
    # the day-one gate objects (l1_pg, l1_dol) would sit in the catalog next to the plant systems; the gate is archived in
    # out/zetaris_gate.json and scripts/zetaris_gate.py re-creates them
    z.run('DROP LIGHTNING DATABASE TABLE dol_related FROM l1_dol', tag='cleanup')
    z.run('DROP LIGHTNING DATABASE TABLE dol_inspection FROM l1_dol', tag='cleanup')
    z.run('DROP LIGHTNING DATABASE l1_dol', tag='cleanup')
    for q in ['DROP DATASOURCE l1_pg', 'DROP DATASOURCE plant_a', 'DROP DATASOURCE plant_b', 'DROP DATASOURCE plant_d']:
        z.run(q, tag='cleanup')
    for db in ('plant_c', 'hq_files', 'osha_public', 'dol', 'extra_sites'):
        ok, out, _ = z.run(f'SHOW LIGHTNING TABLES {db}', tag='cleanup')
        for r in (out or {}).get('data', []) if ok else []:
            z.run(f'DROP LIGHTNING DATABASE TABLE {r[0]} FROM {db}', tag='cleanup')
        z.run(f'DROP LIGHTNING DATABASE {db}', tag='cleanup')
    for name, db, desc in (('plant_a', 'plant_a', 'plant group A system'), ('plant_d', 'plant_d', 'plant group D system')):
        step(f'CREATE DATASOURCE {name}', f'''CREATE DATASOURCE {name} DESCRIBE BY "{desc}" OPTIONS (
  jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://l1-pg:5432/{db}", username "l1", password "{PGPW}", fetchsize "1000")''')
        step(f'REGISTER {name}', f'REGISTER DATASOURCE TABLES FROM {name}')
    step('CREATE DATASOURCE plant_b', f'''CREATE DATASOURCE plant_b DESCRIBE BY "plant group B system" OPTIONS (
  jdbcdriver "com.mysql.cj.jdbc.Driver", jdbcurl "jdbc:mysql://l1-mysql:3306/plant_b?nullDatabaseMeansCurrent=true", username "l1", password "{MYPW}", fetchsize "1000")''')
    step('REGISTER plant_b', 'REGISTER DATASOURCE TABLES FROM plant_b')
    for db, desc in (('plant_c', 'plant group C exports'), ('hq_files', 'headquarters shared drive'), ('osha_public', 'OSHA public files'),
                     ('dol', 'DOL enforcement data snapshot'), ('extra_sites', 'separate plant system')):
        step(f'CREATE LIGHTNING DATABASE {db}', f'CREATE LIGHTNING DATABASE {db} DESCRIBE BY "{desc}"')
    for f in sorted((S / 'group_c_csv').glob('*.csv')):
        filestore('plant_c', f.stem.lower(), f'plant_c/{f.name}')
    filestore('hq_files', 'annual_summary_300a', 'hq/annual_summary_300A.csv')
    filestore('hq_files', 'reply_letters', 'hq/reply_letters.csv')
    filestore('osha_public', 'severe_injury_reports', 'osha/osha_sir_2024.csv')
    filestore('osha_public', 'state_plans', 'osha/state_plans.csv')
    filestore('dol', 'inspection', 'dol/inspection.csv')
    filestore('dol', 'related_activity', 'dol/related_activity.csv')
    filestore('extra_sites', 'sites', 'synthetic/sites.csv')
    filestore('extra_sites', 'injury_log', 'synthetic/injury_log.csv')

    # 3. smoke: one row count per system
    for t in ('plant_a.injury_log', 'plant_b.inc_rpt', 'plant_c.ehs_export_2024', 'plant_d.scanned_log_transcribed', 'osha_public.severe_injury_reports',
              'dol.inspection', 'hq_files.annual_summary_300a', 'extra_sites.injury_log'):
        ok, out = step(f'count {t}', f'SELECT count(*) AS n FROM {t}', must=False)
        print('   rows', (out or {}).get('data'))
    json.dump(log, open(ROOT / 'out' / 'setup_zetaris.json', 'w', encoding='utf-8'), indent=1)
