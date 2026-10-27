"""DOL API v4 client (OSHA inspections).
Endpoint per DOL API User Guide (2024-08-05):
  https://apiprod.dol.gov/v4/get/<agency>/<api_url>/<format>?X-API-KEY=...&limit=&offset=&fields=&filter_object=
  api_url comes from https://apiprod.dol.gov/v4/datasets: OSHA inspection, accident, accident_abstract, accident_injury ...
Tested (2026-10-23): the key only works as query parameter X-API-KEY (header gives 401); an empty filter result is 204 with no body; rapid calls get 429.
Responses are cached in data/dol/cache (snapshot for reviewers, no keys). All error messages are redacted first."""
import json, time, hashlib, pathlib, urllib.parse, urllib.request, urllib.error
from envload import load_env, redact

BASE = 'https://apiprod.dol.gov/v4/get'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
CACHE = pathlib.Path(__file__).resolve().parents[1] / 'data' / 'dol' / 'cache'
_last = [0.0]
MIN_GAP = 1.5  # seconds; client-side throttle


def get(agency, endpoint, filt=None, fields=None, limit=10, offset=0, meta=False, timeout=120, retries=7, use_cache=True):
    env = load_env()
    q = {'limit': limit, 'offset': offset}
    if fields:
        q['fields'] = ','.join(fields)
    if filt is not None:
        q['filter_object'] = json.dumps(filt, separators=(',', ':'))
    path = f"{agency}/{endpoint}/json" + ('/metadata' if meta else '')
    ck = CACHE / (hashlib.sha1((path + json.dumps(q, sort_keys=True)).encode()).hexdigest() + '.json')
    if use_cache and ck.exists():
        return 200, json.loads(ck.read_text(encoding='utf-8'))
    url = f"{BASE}/{path}?" + urllib.parse.urlencode(dict(q, **{'X-API-KEY': env['DOL_API_KEY']}))
    hdr = {'User-Agent': UA, 'Accept': 'application/json'}
    last = None
    for a in range(retries):
        wait = MIN_GAP - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=timeout) as r:
                b = r.read()
                d = {'data': []} if (r.status == 204 or not b) else json.loads(b.decode('utf-8'))
                CACHE.mkdir(parents=True, exist_ok=True)
                ck.write_text(json.dumps(d, ensure_ascii=False), encoding='utf-8')
                return 200, d
        except urllib.error.HTTPError as e:
            last = (e.code, redact(e.read().decode('utf-8', 'replace')[:300], env))
            if e.code in (400, 401, 403, 404):
                return last
            time.sleep(30 * (a + 1) if e.code == 429 else 2 ** a * 2)
        except Exception as e:  # timeout, connection
            last = (-1, redact(repr(e), env))
            time.sleep(2 ** a * 2)
    return last
