"""Download the public OSHA files behind the sample (not needed for SAMPLE_MODE; the repo sample is pseudonymized).

The published records name real employers, so they are never committed. This script puts them in data/public/
(git-ignored); build_sample.py --real then rebuilds the slice with published names for a local live run.

  OSHA Severe Injury Reports   https://www.osha.gov/severe-injury-reports   (CSV/ZIP "January2015to<Month><Year>")
  OSHA ITA case detail + 300A  https://www.osha.gov/Establishment-Specific-Injury-and-Illness-Data  (2024 and 2025 files)
  DOL enforcement API (OSHA)   https://dataportal.dol.gov  (free key; src/dol.py; only the rows the sample needs are fetched)

Direct file URLs change when OSHA republishes; pass them explicitly if the defaults fail:
  python -I scripts/fetch_public_data.py --sir <url> --ita-case <url> --ita-300a <url>
Then:
  (the company pool is built by a private tool kept outside the repository: which companies make up the demo and exam
   companies, and in what order, is not reproducible from this repository)
  python -I scripts/gen_composite.py dev
  python -I scripts/build_sample.py data/public/<SIR CSV> --real      # published names, data/real_seed1003/
  python -I scripts/build_sample.py data/public/<SIR CSV>             # pseudonymized, sample/seed1003/ (needs data/private/pseudonym_config_PRIVATE.json)"""
import sys, pathlib, urllib.request, zipfile, io

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'public'
DEFAULTS = {
    '--sir': 'https://www.osha.gov/sites/default/files/January2015toNovember2025.zip',
    '--ita-case': 'https://www.osha.gov/sites/default/files/ITA_Case_Detail_Data_2024_through_12-31-2025.zip',
    '--ita-300a': 'https://www.osha.gov/sites/default/files/ITA_300A_Summary_Data_2024_through_12-31-2025.zip',
}


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (same-injury sample builder)'})
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read()


if __name__ == '__main__':
    args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
    OUT.mkdir(parents=True, exist_ok=True)
    for key, default in DEFAULTS.items():
        url = args.get(key, default)
        try:
            data = fetch(url)
        except Exception as e:
            print(f'{key}: could not download {url} ({type(e).__name__}). Download it from the page in this docstring and put it in {OUT}.')
            continue
        if url.endswith('.zip'):
            zipfile.ZipFile(io.BytesIO(data)).extractall(OUT)
            print(f'{key}: unzipped into {OUT}')
        else:
            (OUT / url.rsplit('/', 1)[-1]).write_bytes(data)
            print(f'{key}: saved {url.rsplit("/", 1)[-1]}')
