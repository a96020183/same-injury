"""L1 go/no-go gate: can Zetaris join two kinds of source (if it cannot, this track is not submitted).
Source 1: Postgres (container l1-pg on the zetaris_default network), table sir_hard = 145 forward hard cases (SIR employer, UPA, zip).
Source 2: DOL API v4 registered as Lightning REST tables: related_activity (rel_act_nr = UPA), inspection (activity_nr).
One SQL statement: sir_hard JOIN related_activity (UPA) JOIN inspection (activity_nr).
Also tests: three C6 catalog commands, C5 CACHE TABLE, C8 EXPLAIN, C7 COMPILE USL + ACTIVATE USL TABLE (cross-source join as the activate query).
The DOL key only works as a URL parameter (header gives 401), and UPSERT AUTH defines token fetching, which does not fit, so the key is put
into the REST table endpoint at run time and stored in Zetaris's local metastore; this script masks it in all logs.
Output: out/zetaris_gate.json; SQL log runs/zetaris/sql_log.jsonl. Usage: python -I zetaris_gate.py"""
import sys, json, pathlib, urllib.parse
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'src'))
import zetaris as z
from envload import load_env

E = load_env()
PGPW = (HERE.parent / 'data' / 'l1pg_password_PRIVATE.txt').read_text().strip()
d3 = json.load(open(HERE.parent / 'out' / 'l1_3_dol_hard.json', encoding='utf-8'))
upas = sorted({int(r['upa']) for r in d3['rows'] if r['upa'].isdigit()})
acts = sorted({c['activity_nr'] for r in d3['rows'] for c in r['candidates']})
steps = []


def step(name, sql, expect=None, tag=None):
    ok, out, rec = z.run(sql, tag=tag or name)
    rows = (out or {}).get('data') if isinstance(out, dict) else None
    good = ok and (expect(out) if (expect and out is not None) else ok)
    steps.append(dict(step=name, ok=bool(good), error=rec['error'], rows=len(rows) if rows is not None else None,
                      head=(rec['preview'] or '')[:600]))
    print(('PASS ' if good else 'FAIL ') + name, '' if good else (rec['error'] or rec['preview'] or '')[:300], flush=True)
    return good, out


def dol_url(endpoint, filt):
    q = {'limit': 10000, 'filter_object': json.dumps(filt, separators=(',', ':')), 'X-API-KEY': E['DOL_API_KEY']}
    return f'https://apiprod.dol.gov/v4/get/OSHA/{endpoint}/json?' + urllib.parse.urlencode(q, quote_via=urllib.parse.quote)


# 0. clean up the previous run (rerunnable)
for q in ['DROP DATASOURCE l1_pg', 'DROP LIGHTNING DATABASE TABLE dol_related FROM l1_dol', 'DROP LIGHTNING DATABASE TABLE dol_inspection FROM l1_dol',
          'DROP LIGHTNING DATABASE l1_dol']:
    z.run(q, tag='cleanup')

# 1. source 1: Postgres
step('C2 CREATE DATASOURCE (Postgres)', f'''CREATE DATASOURCE l1_pg DESCRIBE BY "L1 plant group A Postgres" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://l1-pg:5432/l1",
  username "l1",
  password "{PGPW}",
  fetchsize "1000"
)''')
step('C2 REGISTER DATASOURCE TABLES', 'REGISTER DATASOURCE TABLES FROM l1_pg')
step('C6 SHOW DATASOURCES', 'SHOW DATASOURCES', lambda o: any('l1_pg' in str(r) for r in o.get('data', [])))
step('C6 SHOW DATASOURCE TABLES WITH STATISTICS', 'SHOW DATASOURCE TABLES l1_pg WITH STATISTICS', lambda o: len(o.get('data', [])) > 0)
ok, out = step('C6 DESCRIBE DATASOURCE TABLE', 'DESCRIBE DATASOURCE TABLE l1_pg.sir_hard', lambda o: len(o.get('data', [])) >= 8)
PG = 'l1_pg.sir_hard'
ok, out = step('C2 SELECT from Postgres', f'SELECT count(*) AS n FROM {PG}', lambda o: str(o['data'][0][0]) == '145')
if not ok:
    PG = 'l1_pg.public.sir_hard'
    step('C2 SELECT from Postgres (schema-qualified)', f'SELECT count(*) AS n FROM {PG}', lambda o: str(o['data'][0][0]) == '145')

# 2. source 2: DOL REST
step('C5 CREATE LIGHTNING DATABASE', 'CREATE LIGHTNING DATABASE l1_dol DESCRIBE BY "DOL OSHA enforcement API v4"')
rest = '''CREATE LIGHTNING REST TABLE {t} FROM l1_dol REQUEST (
  endpoint "{u}",
  method "GET",
  http_encoding "URLENCODED",
  response_type "JSON",
  insecure_ssl "false"
) HEADER () BODY ()'''
step('C5 CREATE LIGHTNING REST TABLE related_activity',
     rest.format(t='dol_related', u=dol_url('related_activity', {'and': [{'field': 'rel_act_nr', 'operator': 'in', 'value': upas},
                                                                         {'field': 'rel_type', 'operator': 'eq', 'value': 'R'}]})))
step('C5 CREATE LIGHTNING REST TABLE inspection',
     rest.format(t='dol_inspection', u=dol_url('inspection', {'field': 'activity_nr', 'operator': 'in', 'value': acts})))
REL = '(SELECT d.rel_act_nr, d.activity_nr FROM l1_dol.dol_related LATERAL VIEW explode(data) t AS d)'
INS = '(SELECT i.activity_nr, i.estab_name, i.site_zip, i.open_date FROM l1_dol.dol_inspection LATERAL VIEW explode(data) t AS i)'
step('C5 SELECT REST (explode data)', f'SELECT count(*) AS n FROM {REL} r', lambda o: int(o['data'][0][0]) > 0)
step('C5 CACHE TABLE related', 'CACHE TABLE l1_dol.dol_related')
step('C5 CACHE TABLE inspection', 'CACHE TABLE l1_dol.dol_inspection')

# 3. go/no-go gate: one SQL statement across two sources
JOIN = f'''SELECT s.sir_id, s.employer, s.zip, CAST(r.activity_nr AS BIGINT) AS activity_nr, i.estab_name, i.site_zip, i.open_date
FROM {PG} s
JOIN {REL} r ON CAST(s.upa AS BIGINT) = CAST(r.rel_act_nr AS BIGINT)
JOIN {INS} i ON CAST(r.activity_nr AS BIGINT) = CAST(i.activity_nr AS BIGINT)'''
ok, out = step('GATE join Postgres x REST (2 sources)', JOIN, lambda o: len(o.get('data', [])) >= 40)
join_rows = (out or {}).get('data', []) if ok else []
step('C8 EXPLAIN QUERY AS SELECT', 'EXPLAIN QUERY AS ' + JOIN)

# 4. USL
# tested: a fresh install lacks even the parent namespace lightning.metastore; create it first (the manual only mentions the child)
step('C7 CREATE NAMESPACE parent', 'CREATE NAMESPACE IF NOT EXISTS lightning.metastore')
step('C7 CREATE NAMESPACE', 'CREATE NAMESPACE IF NOT EXISTS lightning.metastore.l1')
step('C7 COMPILE USL (DEPLOY)', '''COMPILE USL same_injury DEPLOY NAMESPACE lightning.metastore.l1 DDL
CREATE TABLE sir_report (
  sir_id varchar(20) NOT NULL PRIMARY KEY,
  employer varchar(300),
  zip varchar(10)
);
CREATE TABLE dol_link (
  sir_id varchar(20) NOT NULL FOREIGN KEY REFERENCES sir_report(sir_id),
  activity_nr bigint,
  estab_name varchar(300),
  site_zip varchar(10)
)''')
step('C7 ACTIVATE USL TABLE sir_report (Postgres)', f'''ACTIVATE USL TABLE lightning.metastore.l1.same_injury.sir_report AS
SELECT COALESCE(sir_id, '') AS sir_id, employer, zip FROM {PG}''')
step('C7 ACTIVATE USL TABLE dol_link (cross-source join)', f'''ACTIVATE USL TABLE lightning.metastore.l1.same_injury.dol_link AS
SELECT COALESCE(s.sir_id, '') AS sir_id, CAST(r.activity_nr AS BIGINT) AS activity_nr, i.estab_name, i.site_zip
FROM {PG} s
JOIN {REL} r ON CAST(s.upa AS BIGINT) = CAST(r.rel_act_nr AS BIGINT)
JOIN {INS} i ON CAST(r.activity_nr AS BIGINT) = CAST(i.activity_nr AS BIGINT)''')
step('C7 SELECT USL tables', '''SELECT count(*) AS n FROM lightning.metastore.l1.same_injury.sir_report s
JOIN lightning.metastore.l1.same_injury.dol_link d ON s.sir_id = d.sir_id''', lambda o: int(o['data'][0][0]) >= 40)
step('C7 SHOW NAMESPACES OR TABLES', 'SHOW NAMESPACES OR TABLES IN lightning.metastore.l1')

res = dict(steps=steps, gate_join_rows=len(join_rows), upas=len(upas), acts=len(acts),
           gate='PASS' if any(s['step'].startswith('GATE') and s['ok'] for s in steps) else 'FAIL')
json.dump(res, open(HERE.parent / 'out' / 'zetaris_gate.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('GATE', res['gate'], 'join rows', len(join_rows))
