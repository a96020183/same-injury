"""Nightshift (Meterless) client, OpenAI-compatible. URL and token read from ../../.env; no key is printed or stored.
Each call is logged to runs/calls.jsonl: requested model, served model, latency, token counts, whether reasoning text was included.
NVIDIA free tier limit: at most 2 concurrent requests; other projects share it, so L1 uses only 1. Exponential backoff on failure."""
import json, re, time, threading, base64, pathlib, urllib.request, urllib.error
from envload import load_env

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOG = ROOT / 'runs' / 'calls.jsonl'
_E = load_env()
BASE = _E['METERLESS_BASE_URL'].rstrip('/')
_TOKEN = _E['METERLESS_RUNTIME_TOKEN']
_sem = threading.BoundedSemaphore(1)
_lock = threading.Lock()
THINK = re.compile(r'<think>.*?</think>', re.S)


def _hdr():
    return {'Authorization': 'Bearer ' + _TOKEN, 'Content-Type': 'application/json',
            'meterless-app': 'l1', 'meterless-scope': 'iso-' + str(__import__('uuid').uuid4())}


def _scrub(s):
    s = str(s)
    if _TOKEN:
        s = s.replace(_TOKEN, '<redacted>')
    return re.sub(r'(?i)(bearer\s+)\S+', r'\1<redacted>', s)


def _log(rec):
    LOG.parent.mkdir(exist_ok=True)
    with _lock, open(LOG, 'a', encoding='utf-8') as f:
        f.write(_scrub(json.dumps(rec, ensure_ascii=False)) + '\n')


def strip_reasoning(text):
    """Strip <think>...</think>; if only a closing </think> exists, drop everything before it."""
    if not text:
        return ''
    t = THINK.sub('', text)
    if '</think>' in t:
        t = t.rsplit('</think>', 1)[1]
    return t.strip()


def models():
    req = urllib.request.Request(BASE + '/models', headers=_hdr())
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


def image_part(path):
    b = pathlib.Path(path).read_bytes()
    mime = 'image/png' if str(path).lower().endswith('.png') else 'image/jpeg'
    return {'type': 'image_url', 'image_url': {'url': f'data:{mime};base64,' + base64.b64encode(b).decode()}}


def chat(messages, model, max_tokens=1500, temperature=0.0, tag='', timeout=300, retries=5, extra_body=None):
    body = dict(model=model, messages=messages, max_tokens=max_tokens, temperature=temperature)
    if extra_body:
        body.update(extra_body)
    data = json.dumps(body).encode('utf-8')
    last = None
    for attempt in range(retries):
        t0 = time.time()
        try:
            with _sem:
                req = urllib.request.Request(BASE + '/chat/completions', data=data, headers=_hdr(), method='POST')
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    hdrs = dict(r.headers)
                    out = json.loads(r.read().decode('utf-8'))
            msg = out['choices'][0]['message']
            raw = msg.get('content') or ''
            rec = dict(ts=time.strftime('%Y-%m-%dT%H:%M:%S'), tag=tag, requested=model, served=out.get('model'),
                       latency=round(time.time() - t0, 2), usage=out.get('usage'), attempt=attempt,
                       had_think='</think>' in raw or bool(msg.get('reasoning_content')),
                       route_headers={k: v for k, v in hdrs.items() if re.search(r'meterless|model|route|provider|lane', k, re.I)})
            _log(rec)
            return dict(text=strip_reasoning(raw), served=out.get('model'), usage=out.get('usage'), headers=rec['route_headers'])
        except urllib.error.HTTPError as e:
            try:
                body_txt = e.read().decode('utf-8', 'replace')[:300]
            except Exception:
                body_txt = ''
            last = f'HTTP {e.code} {body_txt}'
        except Exception as e:
            last = f'{type(e).__name__}: {e}'
        _log(dict(ts=time.strftime('%Y-%m-%dT%H:%M:%S'), tag=tag, requested=model, error=_scrub(last), attempt=attempt))
        time.sleep(min(90, 5 * 2 ** attempt))
    raise RuntimeError(_scrub(last))
