"""Which OSHA employer string is one of the composite's four source companies ("Employer A-D"), and which is someone else
("Firm <hex>"). QA round 6 found a hospital coded as a source company: the old rule accepted ANY shared word of four
letters or more, so a town word in both names was enough. Now a name counts as the company only when most of the
company's own distinctive words (place names and generic words removed) appear in it.
  python -I scripts/employer_codes.py      runs the self-test"""
import re, hashlib

GENERIC = {'inc', 'llc', 'co', 'corp', 'corporation', 'company', 'the', 'of', 'and', 'ltd', 'lp', 'dba', 'usa', 'us', 'group', 'services', 'service',
           'holdings', 'enterprises', 'industries', 'international', 'america', 'american', 'national', 'foods', 'food', 'plant', 'facility'}


def words(s):
    return {w.lower() for w in re.findall(r'[A-Za-z]{4,}', s or '')}


def company_words(company, places=()):
    """the distinctive words of a company name (not generic, not a place name of any of its sites); the first of them,
    the brand, comes first"""
    pl = set()
    for p in places:
        pl |= words(p)
    ordered = [w.lower() for w in re.findall(r'[A-Za-z]{4,}', company or '') if w.lower() not in GENERIC and w.lower() not in pl]
    return list(dict.fromkeys(ordered))


def employer_code(name, companies):
    """companies: list of company_words() sets, in A-D order"""
    toks = words(name) - GENERIC
    for i, cw in enumerate(companies):
        # the brand word must be there (a shared town or trade word is not enough), or most of the company's words
        if cw and (cw[0] in toks or len(toks & set(cw)) / len(cw) >= 0.6):
            return f'Employer {"ABCD"[i]}'
    return 'Firm ' + hashlib.sha256(('emp|' + (name or '')).encode()).hexdigest()[:4].upper()


def _selftest():
    comp = [company_words('Granite Mill Provisions', ['Millbrook', 'Elm Grove']), company_words('Harbor Bakeries Holdings', ['Seaview'])]
    assert employer_code('Granite Mill Provisions, LLC', comp) == 'Employer A'
    assert employer_code('GRANITE MILL PROVISIONS PLANT 4', comp) == 'Employer A'
    assert employer_code('Millbrook Regional Hospital', comp).startswith('Firm '), 'a town word is not the company'
    assert employer_code('Elm Grove Medical Center', comp).startswith('Firm ')
    assert employer_code('Mill Valley Hospital', comp).startswith('Firm '), 'one shared word of three is not enough'
    assert employer_code('Harbor Bakeries', comp) == 'Employer B'
    assert employer_code('HARBOR GLOBAL SUPPLY', comp) == 'Employer B', 'the brand word alone is the company'
    assert employer_code('Bakeries Shared Billing Office', comp).startswith('Firm '), 'a trade word alone is not'
    print('employer_codes self-test: ok')


if __name__ == '__main__':
    _selftest()
