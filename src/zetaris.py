"""Zetaris REST client: POST {ZETARIS_REST_URL}/sql-editor/sqls/run (Bearer API key, X-Org-ID, fresh X-Request-ID per call).
Keys read from .env; every SQL statement and response is masked (incl. DOL key, local Postgres password) before logging to runs/zetaris/sql_log.jsonl."""
import json, time, uuid, pathlib, urllib.request, urllib.error
from envload import load_env, redact

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOG = ROOT / 'runs' / 'zetaris' / 'sql_log.jsonl'
_E = load_env()
PGPW_FILE = ROOT / 'data' / 'l1pg_password_PRIVATE.txt'
EXTRA = [PGPW_FILE.read_text().strip()] if PGPW_FILE.exists() else []


def _scrub(s):
    s = redact(str(s), _E)
    for v in EXTRA:
        s = s.replace(v, '<redacted>')
    return s


def run(sql, limit=1000, timeout=600, tag=''):
    body = {'queryId': str(uuid.uuid4()), 'sql': sql, 'source': 'SqlEditor', 'limit': limit}
    req = urllib.request.Request(_E['ZETARIS_REST_URL'].rstrip('/') + '/sql-editor/sqls/run', data=json.dumps(body).encode(), method='POST',
                                 headers={'Authorization': 'Bearer ' + _E['ZETARIS_API_KEY'], 'X-Org-ID': _E.get('ZETARIS_ORG_ID', '1'),
                                          'X-Request-ID': str(uuid.uuid4()), 'Content-Type': 'application/json'})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read().decode('utf-8'))
        ok, err = True, None
    except urllib.error.HTTPError as e:
        out, ok, err = None, False, f'HTTP {e.code} ' + e.read().decode('utf-8', 'replace')[:1500]
    except Exception as e:
        out, ok, err = None, False, f'{type(e).__name__}: {e}'
    rec = dict(ts=time.strftime('%Y-%m-%dT%H:%M:%S'), tag=tag, sql=_scrub(sql), ok=ok, secs=round(time.time() - t0, 1),
               error=_scrub(err) if err else None,
               preview=_scrub(json.dumps(out, ensure_ascii=False)[:1500]) if out is not None else None)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    return ok, out, rec
