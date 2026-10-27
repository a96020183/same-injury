"""Read .env from the parent dev folder; return values only, never print."""
import os, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]  # parent dev folder (one level above l1)


def load_env():
    p = ROOT / '.env'
    env = {}
    for line in p.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    for k, v in env.items():
        os.environ.setdefault(k, v)
    return env


def redact(text, env=None):
    """Mask any key value in a string (error messages may contain URLs)."""
    env = env or load_env()
    for k, v in env.items():
        if v and len(v) >= 8 and any(s in k for s in ('KEY', 'TOKEN', 'PASSWORD')):
            text = text.replace(v, '<redacted>')
    return text
