"""Zetaris governance for the demo: the agents run as a separate, non-admin Zetaris user whose role sees employer
identity masked by Zetaris' own column policies; the reviewer (admin) sees everything and is the only one who can
COMPILE USL.

  1. CREATE ROLE 'L1_AGENT'; create user agent@l1.local (GENERAL); ASSIGN USER ... TO ROLE
  2. GRANT SELECT ON <table> TO ROLE 'L1_AGENT' for the tables the agents may read (default deny for the rest)
  3. column policy "identity_masked" on every table that names an employer or an address, attached to the role:
       names (OSHA employer, DOL establishment, plant names, legal names, EIN)  -> MASKED, every letter and digit hidden
       street addresses                                                         -> MASKED letters only: the house number
                                                                                   stays, so "same street number" is still testable
     ZIP, city and state stay visible. The policy is written with the same API the Zetaris UI uses
     (POST /access-control/cbac/generic/{datasource|filestore}/{source}/{table}).
  4. log in as the agent user once and create its API key -> data/private/zetaris_agent_key_PRIVATE.txt
Secrets are generated locally, never printed. Usage: python -I scripts/setup_governance.py [--check]"""
import sys, io, json, uuid, base64, secrets, pathlib, urllib.request, urllib.error
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
import zetaris as z
from envload import load_env, redact

E = load_env()
BASE = E['ZETARIS_REST_URL'].rstrip('/')
PRIV = ROOT / 'data' / 'private'
AGENT = 'agent@l1.local'
ROLE = 'L1_AGENT'
PWF = PRIV / 'zetaris_agent_password_PRIVATE.txt'
KEYF = PRIV / 'zetaris_agent_key_PRIVATE.txt'
if not PWF.exists():
    PWF.write_text('Aa1!' + ''.join(secrets.choice('abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(20)))
PW = PWF.read_text().strip()
z.EXTRA += [PW] + ([KEYF.read_text().strip()] if KEYF.exists() else [])

# every letter/digit hidden for names; letters only for street addresses (house number stays)
MASK_ALL = '[A-Za-z0-9]'
MASK_LETTERS = '[A-Za-z]'
POLICY = {
    ('filestore', 'osha_public', 'severe_injury_reports'): {'Employer': MASK_ALL, 'Address1': MASK_LETTERS},
    ('filestore', 'dol', 'inspection'): {'estab_name': MASK_ALL, 'site_address': MASK_LETTERS},
    ('filestore', 'plant_c', 'sites'): {'plant_name': MASK_ALL, 'legal_name': MASK_ALL, 'ein': MASK_ALL, 'street': MASK_LETTERS},
    ('datasource', 'plant_a', 'sites'): {'plant_name': MASK_ALL, 'legal_name': MASK_ALL, 'ein': MASK_ALL, 'street': MASK_LETTERS},
    ('datasource', 'plant_b', 'sites'): {'plant_name': MASK_ALL, 'legal_name': MASK_ALL, 'ein': MASK_ALL, 'street': MASK_LETTERS},
    ('datasource', 'plant_d', 'sites'): {'plant_name': MASK_ALL, 'legal_name': MASK_ALL, 'ein': MASK_ALL, 'street': MASK_LETTERS},
    ('filestore', 'extra_sites', 'sites'): {'plant_name': MASK_ALL, 'legal_name': MASK_ALL, 'ein': MASK_ALL, 'street': MASK_LETTERS},
}
READ = {
    'DATASOURCE': ['plant_a.injury_log', 'plant_a.sites', 'plant_a.emp_master', 'plant_a.lms_export', 'plant_b.inc_rpt', 'plant_b.sites', 'plant_b.lms_export',
                   'plant_d.scanned_log_transcribed', 'plant_d.sites', 'plant_d.good_catch'],
    'LIGHTNING DATABASE': ['plant_c.ehs_export_2024', 'plant_c.sites', 'plant_c.cmms_wo', 'plant_c.hr_roster', 'hq_files.annual_summary_300a', 'hq_files.reply_letters',
                  'osha_public.severe_injury_reports', 'osha_public.state_plans', 'dol.inspection', 'dol.related_activity',
                  'extra_sites.sites', 'extra_sites.injury_log'],
}


def api(method, path, body=None, token=None, basic=None):
    h = {'X-Org-ID': E.get('ZETARIS_ORG_ID', '1'), 'X-Request-ID': str(uuid.uuid4()), 'Content-Type': 'application/json'}
    h['Authorization'] = ('Basic ' + basic) if basic else ('Bearer ' + (token or E['ZETARIS_API_KEY']))
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode('utf-8', 'replace')
            return r.status, (json.loads(t) if t.strip().startswith(('{', '[')) else t)
    except urllib.error.HTTPError as e:
        return e.code, redact(e.read().decode('utf-8', 'replace')[:600], E)


def sql(q, must=False):
    ok, out, rec = z.run(q, tag='governance')
    print(('ok   ' if ok else 'FAIL ') + q.split('\n')[0][:110], '' if ok else (rec['error'] or '')[:200])
    if must and not ok:
        raise SystemExit('stop')
    return ok, out


def describe(kind, src, table):
    ok, out = sql(f'DESCRIBE DATASOURCE TABLE {src}.{table}')
    return [r[0] for r in (out or {}).get('data', [])]


def field(name, regex=None):
    meta = {'filter': '', 'options': [{'key': 'regex', 'value': regex}] if regex else [], 'policy': 'masked' if regex else 'grant', 'policy_source': 'user_defined'}
    return {'name': name, 'isNullable': True, 'dataType': {'json': '"string"', 'simpleString': 'string', 'typeName': 'string'}, 'metadata': meta}


if __name__ == '__main__':
    if '--check' not in sys.argv:
        sql(f"CREATE ROLE '{ROLE}' DESCRIBE BY 'Same_Injury_agents,identity_masked'")
        st, out = api('POST', '/users', {'email': AGENT, 'name': 'Same Injury agents', 'level': 'GENERAL', 'password': PW, 'isLdap': False, 'status': 'Active'})
        print('create user', st, out if st >= 300 else '')
        sql(f"ASSIGN USER '{AGENT}' TO ROLE '{ROLE}'")
        sql(f"ASSIGN DATASOURCE plant_a, plant_b, plant_d TO ROLE '{ROLE}'")
        sql(f"ASSIGN LIGHTNING DATABASE plant_c, hq_files, osha_public, dol, extra_sites TO ROLE '{ROLE}'")
        # the unified model's namespace: the agents may read USL tables there (each table still needs GRANT, done after COMPILE)
        sql("CREATE NAMESPACE IF NOT EXISTS lightning.metastore"); sql("CREATE NAMESPACE IF NOT EXISTS lightning.metastore.l1")
        st, out = api('POST', '/access-control/assign/role/usl-namespace', {'roleNames': [ROLE.lower()], 'namespace': 'metastore.l1'})
        print('assign USL namespace', st, '' if st < 300 else out)
        for kind, tables in READ.items():
            for t in tables:
                sql(f"GRANT SELECT ON {kind} TABLE {t} TO ROLE '{ROLE}'")
        for (kind, src, table), masks in POLICY.items():
            cols = describe(kind, src, table)
            st, cur = api('GET', f'/access-control/cbac/generic/{kind}/{src}/{table}')
            base = cur if isinstance(cur, dict) else {}
            body = {**base, 'id': f'{src}.{table}', 'partitionColumns': base.get('partitionColumns', []), 'version': base.get('version', 0),
                    'users': [{'username': AGENT, 'roleSelected': ROLE.lower(), 'userLevelPolicy': 'identity_masked'}],
                    'roles': [{'roleName': ROLE.lower(), 'policy': 'identity_masked'}],
                    'policies': [{'policyName': 'identity_masked', 'filter': '', 'fields': [field(c, masks.get(c)) for c in cols]}]}
            st, out = api('POST', f'/access-control/cbac/generic/{kind}/{src}/{table}', body)
            print('policy', src, table, st, '' if st < 300 else out)
        # agent API key: log in once as the agent user
        if not KEYF.exists():
            # same login route the Zetaris UI uses
            req = urllib.request.Request('http://localhost:3000/api/auth/login', data=json.dumps({'username': AGENT, 'password': PW}).encode(), method='POST',
                                         headers={'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    tok = json.loads(r.read().decode())
            except urllib.error.HTTPError as e:
                tok = {'_error': e.code}
            print('agent login keys', sorted(tok.keys()))
            token = next((tok[k] for k in ('idToken', 'token', 'accessToken', 'access_token') if isinstance(tok.get(k), str)), None)
            if token:
                st, k = api('POST', '/auth/api-key', {'name': 'same-injury-agents', 'expiryDate': (__import__('datetime').datetime.utcnow() + __import__('datetime').timedelta(days=30)).replace(microsecond=0).isoformat() + '.000Z'}, token=token)
                print('agent api key', st, sorted(k.keys()) if isinstance(k, dict) else str(k)[:200])
                key = next((k[x] for x in ('apiKey', 'key', 'token', 'value') if isinstance(k, dict) and isinstance(k.get(x), str)), None)
                if key:
                    KEYF.write_text(key)
    # check: the same query as admin and as the agent
    if KEYF.exists():
        q = "SELECT ID, Employer, Address1, City, Zip FROM osha_public.severe_injury_reports WHERE ID = 'SIR-SYN002'"
        ok, out, rec = z.run(q, tag='governance-admin')
        print('admin sees ', (out or {}).get('data'))
        import importlib
        z._E['ZETARIS_API_KEY_SAVED'] = z._E['ZETARIS_API_KEY']
        z._E['ZETARIS_API_KEY'] = KEYF.read_text().strip()
        ok, out, rec = z.run(q, tag='governance-agent')
        print('agent sees ', (out or {}).get('data') if ok else rec['error'][:300])
        ok, out, rec = z.run('SHOW DATASOURCES', tag='governance-agent')
        print('agent catalog', [r[0] for r in (out or {}).get('data', [])] if ok else rec['error'][:200])
        z._E['ZETARIS_API_KEY'] = z._E.pop('ZETARIS_API_KEY_SAVED')
