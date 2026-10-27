"""De-identify a sample folder in place: no published company name, address, city, ZIP, EIN or OSHA/DOL record number
survives; dates, injuries, narratives and the structure of every table stay as published.

  names     the four companies -> "Employer A".."Employer D" (whole string, no suffixes); other employers keep their
            "Employer <hex>" code; plant names -> "Plant <group><n>"; EIN -> EIN-<group>
  places    every city -> an invented town (per state), every ZIP -> an unassigned ZIP 00100-00499,
            every street address -> an invented one (same house + city -> same invented address everywhere, so
            "same house number, other ZIP" cases survive)
  numbers   OSHA report ID -> SIR-nnnnnn, referral (UPA) -> REF-nnnnnn, OSHA inspection field -> INSP-nnnnnn,
            DOL activity number -> DOL-nnnnnnn (the same number gets the same code in every table)
The mapping uses a random salt kept in data/private/deid_salt_PRIVATE.txt and is written to data/private/deid_map_PRIVATE.json,
so it cannot be recomputed from the public files. Usage: python -I scripts/deidentify.py <folder> [<folder> ...]"""
import sys, csv, json, re, hashlib, secrets, pathlib, io
if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
csv.field_size_limit(10 ** 9)

ROOT = pathlib.Path(__file__).resolve().parents[1]
_P = ['Ash', 'Brook', 'Cedar', 'Dun', 'Elm', 'Fair', 'Glen', 'Har', 'Ivy', 'Juni', 'King', 'Larch', 'Mill', 'North', 'Oak', 'Pine', 'Quarry',
      'Red', 'Stone', 'Thorn', 'Up', 'Vale', 'West', 'Yarrow', 'Alder', 'Birch', 'Copper', 'Drift', 'East', 'Fox', 'Grey', 'Haw', 'Iron', 'Kestrel']
_S = ['ford', 'haven', 'field', 'more', 'wood', 'view', 'rock', 'low', 'dale', 'ton', 'ley', 'mont', 'brook', 'gate', 'ridge', 'crest', 'ville',
      'bridge', 'bury', 'well', 'by', 'stead', 'hurst', 'mere']
# invented towns; any that is the name of a real place in the public files (data/private/real_places_PRIVATE.txt) is skipped
_REAL_F = ROOT / 'data' / 'private' / 'real_places_PRIVATE.txt'
_REAL = set(_REAL_F.read_text(encoding='utf-8').splitlines()) if _REAL_F.exists() else set()
TOWNS = [p + s for p in _P for s in _S if (p + s).upper() not in _REAL]
STREETS = ['Alder', 'Beacon', 'Canal', 'Depot', 'Elm', 'Foundry', 'Granary', 'Harbor', 'Industrial', 'Juniper', 'Kiln', 'Lumber', 'Mill', 'Quarry',
           'Railway', 'Silo', 'Tannery', 'Union', 'Wharf', 'Yard', 'Cooper', 'Forge', 'Ledger', 'Packard', 'Ridge', 'Sawmill', 'Turbine', 'Weir']
SALT_F = ROOT / 'data' / 'private' / 'deid_salt_PRIVATE.txt'
MAP_F = ROOT / 'data' / 'private' / 'deid_map_PRIVATE.json'
if not SALT_F.exists():
    SALT_F.write_text(secrets.token_hex(16))
SALT = SALT_F.read_text().strip()
M = json.loads(MAP_F.read_text(encoding='utf-8')) if MAP_F.exists() else {'city': {}, 'zip': {}, 'addr': {}, 'id': {}, 'street_src': []}
M.setdefault('street_src', [])
SUFFIX = ['Rd', 'Ave', 'St', 'Way', 'Pkwy', 'Dr']


def h(*parts):
    return int(hashlib.sha256(('|'.join([SALT, *map(str, parts)])).encode()).hexdigest(), 16)


def city(c, state=''):
    if not c:
        return c
    key = c.strip().upper()
    if key not in M['city']:
        used = set(M['city'].values())
        i = h('city', key)
        while TOWNS[i % len(TOWNS)].upper() in used:
            i += 1
        M['city'][key] = TOWNS[i % len(TOWNS)].upper()
    v = M['city'][key]
    return v if c.isupper() else v.title()


def zipc(z):
    d = re.sub(r'\D', '', z or '')[:5]
    if not d:
        return z
    d = d.zfill(5)
    if d not in M['zip']:
        used = set(M['zip'].values())
        i = h('zip', d)
        while f'00{100 + i % 400}' in used:
            i += 1
        M['zip'][d] = f'00{100 + i % 400}'
    return M['zip'][d]


def street(s, c):
    """same house number + same city -> same invented address"""
    if not s:
        return s
    num = (re.match(r'\s*(\d+)', s) or [None, ''])[1]
    key = f'{num}|{(c or "").strip().upper()}' if num else 'nonum|' + s.strip().upper()
    src = re.sub(r'\s+', ' ', s.replace('(street withheld)', '')).strip().upper()
    if src and src not in M['street_src'] and src.split(' ')[1:2] != [] and not (len(src.split(' ')) == 3 and src.split(' ')[1].title() in STREETS):
        M['street_src'].append(src)  # originals, for scripts/scan_identity.py (private file only)
    if key not in M['addr']:
        i = h('addr', key)
        M['addr'][key] = f"{(100 + i % 9800) if num else ''} {STREETS[(i // 9800) % len(STREETS)]} {SUFFIX[(i // 7) % len(SUFFIX)]}".strip()
    v = M['addr'][key]
    if '(street withheld)' in s:
        v = v.split()[0] + ' (street withheld)'
    return v.upper() if s.isupper() else v


def rid(kind, v):
    v = (v or '').strip()
    if not v or v.startswith(kind + '-'):
        return v
    key = f'{kind}|{v}'
    if key not in M['id']:
        width = 7 if kind == 'DOL' else 6
        i = h('id', key)
        used = set(M['id'].values())
        while f'{kind}-{str(i % 10 ** width).zfill(width)}' in used:
            i += 1
        M['id'][key] = f'{kind}-{str(i % 10 ** width).zfill(width)}'
    return M['id'][key]


def employer(n):
    m = re.search(r'\b(employer|holdco)\s+([a-d])\b', n or '', re.I)
    if m:
        return f'Employer {m.group(2).upper()}'
    h4 = re.fullmatch(r'Employer ([0-9A-F]{4})', (n or '').strip())
    return f'Firm {h4.group(1)}' if h4 else n  # other employers: never "Employer <letter>…", which reads like one of ours


def read(p):
    with open(p, encoding='utf-8', newline='') as f:
        return list(csv.DictReader(f))


def write(p, rows):
    with open(p, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]) if rows else [])
        w.writeheader()
        w.writerows(rows)


def city_words(text, proper_only=False):
    """replace real town names inside free text (proper_only: only Capitalized / UPPER forms, for columns of unknown meaning)"""
    for real in sorted(M['city'], key=len, reverse=True):
        if proper_only:
            for form in (real.upper(), real.title()):
                text = re.sub(r'\b' + re.escape(form) + r'\b', M['city'][real] if form.isupper() else M['city'][real].title(), text)
        else:
            text = re.sub(r'\b' + re.escape(real) + r'\b', M['city'][real], text, flags=re.I)
    return text


def process(folder, all_text=False):
    """all_text: also check every column of every non-site table (exam tables have opaque column names)"""
    folder = pathlib.Path(folder)
    for p in sorted(folder.rglob('*.csv')):
        rows = read(p)
        if not rows:
            continue
        cols = list(rows[0])
        lc = {c.lower(): c for c in cols}
        changed = False
        # site master tables (any name): code + street + city + state + zip (+ names, ein)
        if {'street', 'city', 'zip'} <= set(lc):
            for i, r in enumerate(rows):
                r[lc['street']] = street(r[lc['street']], r[lc['city']])
                r[lc['city']] = city(r[lc['city']], r.get(lc.get('state', ''), ''))
                r[lc['zip']] = zipc(r[lc['zip']])
                if 'ein' in lc and r[lc['ein']]:
                    r[lc['ein']] = 'EIN-' + (re.search(r'EIN-([A-Z])', r[lc['ein']]) or [None, 'X'])[1] if 'EIN-' in r[lc['ein']] else 'EIN-' + str(h('ein', r[lc['ein']]) % 900 + 100)
                if 'legal_name' in lc:
                    r[lc['legal_name']] = employer(r[lc['legal_name']])
                if 'plant_name' in lc:
                    grp = (re.search(r'Employer ([A-D])', r.get(lc.get('legal_name', ''), '')) or [None, 'X'])[1]
                    r[lc['plant_name']] = f'Plant {grp}{i + 1}'
            changed = True
        if 'employer' in lc and 'address1' in lc:  # OSHA severe injury reports
            for r in rows:
                r[lc['address1']] = street(r[lc['address1']], r[lc['city']])
                r[lc['city']] = city(r[lc['city']])
                r[lc['zip']] = zipc(r[lc['zip']])
                r[lc['employer']] = employer(r[lc['employer']])
                r[lc['id']] = rid('SIR', r[lc['id']])
                r[lc['upa']] = rid('REF', r[lc['upa']])
                if 'inspection' in lc:
                    r[lc['inspection']] = rid('INSP', r[lc['inspection']])
            changed = True
        if 'estab_name' in lc:  # DOL inspections
            for r in rows:
                r[lc['site_address']] = street(r[lc['site_address']], r[lc['site_city']])
                r[lc['site_city']] = city(r[lc['site_city']])
                r[lc['site_zip']] = zipc(r[lc['site_zip']])
                r[lc['estab_name']] = employer(r[lc['estab_name']])
                r[lc['activity_nr']] = rid('DOL', r[lc['activity_nr']])
            changed = True
        if 'rel_act_nr' in lc:  # DOL related activity
            for r in rows:
                r[lc['activity_nr']] = rid('DOL', r[lc['activity_nr']])
                r[lc['rel_act_nr']] = rid('REF', r[lc['rel_act_nr']])
            changed = True
        if 'subject' in lc:  # reply letters cite the referral number
            for r in rows:
                for c in ('subject', 'body'):
                    if c in lc:
                        r[lc[c]] = re.sub(r'referral (\d+)', lambda m: 'referral ' + rid('REF', m.group(1)), r[lc[c]])
            changed = True
        if changed:
            write(p, rows)
    # free text last, once every town is known
    for p in sorted(folder.rglob('*.csv')):
        rows = read(p)
        if not rows:
            continue
        text_cols = [c for c in rows[0] if c.lower() in ('final narrative', 'transcribed_text') or 'narr' in c.lower() or 'descr' in c.lower() or 'happen' in c.lower()]
        other = [c for c in rows[0] if c not in text_cols] if all_text and not {'street', 'city', 'zip'} <= {c.lower() for c in rows[0]} else []
        if text_cols or other:
            for r in rows:
                for c in text_cols:
                    r[c] = city_words(r[c] or '')
                for c in other:
                    r[c] = city_words(r[c] or '', proper_only=True)
            write(p, rows)
    MAP_F.write_text(json.dumps(M, indent=1), encoding='utf-8')
    print('de-identified', folder, 'towns', len(M['city']), 'zips', len(M['zip']), 'addresses', len(M['addr']), 'ids', len(M['id']))


if __name__ == '__main__':
    for f in sys.argv[1:]:
        process(f)
