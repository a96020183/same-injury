# Sealed exam: five unseen companies

The main score for Layer 1: on a company the agent has never seen, which tables are the injury log, and which columns hold
the date, the body part, the narrative and the site. Opened and scored 2026-10-23 (UTC).

## Check it yourself (one command, no keys)

```
python -I scripts/verify_exam.py
```

It recomputes the SHA-256 of the generator and the scorer (they must equal the values recorded before the exam was
opened), checks every published exam file and prediction against `docs/sealed_exam/SHA256SUMS.txt`, and re-scores both
runs with `score()` from the hashed scorer. Exit code 0 means every hash matched and the scores below were reproduced.

## Result: two runs, reported separately

Each run: 5 companies, 20 injury-log tables, 80 field pairs. 95% Wilson intervals per run.

| | Injury logs found | Precision (tables) | Fields mapped right | Precision (fields) |
|---|---|---|---|---|
| **Agent, run 1** | 19/20 (0.95; 0.76–0.99) | 19/19 | 73/80 (0.91; 0.83–0.96) | 73/73 |
| **Agent, run 2** | 20/20 (1.00; 0.84–1.00) | 20/20 | 79/80 (0.99; 0.93–1.00) | 79/79 |
| Rule baseline (no model) | 11/20 (0.55; 0.34–0.74) | 11/11 | 39/80 (0.49; 0.38–0.60) | 39/39 |
| Keyword baseline | 8/20 (0.40; 0.22–0.61) | 8/28 | 32/80 (0.40; 0.30–0.51) | 32/100 |

The intervals treat tables and field pairs as independent. They come from only five companies, so read them as optimistic.
Precision was 1.00 in both runs: the agent never called a distractor (first-aid logs, behaviour-observation cards, training
records) an injury log and never mapped a field to a wrong column. Every miss is on the transcribed paper log, where the
body part sits inside one free-text column: run 1 missed one such table (the Evaluator rejected its date format three
times and sent it to a person) and left body part empty on three; run 2 left it empty on one.

## How the two runs happened

Both runs used the same code and prompts, frozen before the exam zip was opened. Run 1 was an operator error: I started
the runner under a monitor, stopped the monitor (which did not stop the runner) and started a second runner. The two
worked on the same company folders at the same time; traces mixed, and each company's prediction is from whichever process
finished last. I then ran all five companies again with one locked runner (run 2). Run 2 started after run 1's score was
known, so neither run is "the" score: both are listed, and the lower one (run 1) is the one to quote.

The commit that froze the code (`bbb4f77`) was in the git history that was rebuilt (2026-10-24, again 2026-10-26) to remove every real name,
address and record number. What still ties the exam to "before opening" is the four SHA-256 values below, recorded
2026-10-23 before the zip was opened. The two that are in this repo (generator, scorer) are byte-identical today. These
values are self-reported: they were not posted anywhere with an outside timestamp, and two of them cover private files.

## What the exam is

- **Same generator as development, different companies and seeds.** `scripts/gen_composite.py` builds each company from
  four real companies' public OSHA injury records, re-sharded into four plant systems (Postgres, MySQL, a CSV export, a
  transcribed paper log) with random table names, column names and date formats; 40% of injury tables get opaque column
  names `f1…f9` (7 of the 20 here); every plant system also gets distractor tables with a date and a body part.
  Development used seeds 1000–1012. The exam used seeds 2000–2004, and its companies were drawn only from pool companies
  that no development seed used. The generator writes the answers.
- **Sealed.** The exam was written straight into a zip on 2026-10-23 and only its SHA-256 was printed. Before opening, all
  four recorded hashes were checked and matched:

  | File | SHA-256 |
  |---|---|
  | `sealed/discovery_exam_2000-2004.zip` (private: real names) | `e2180861afc974367d4f4aea39672b8a93eb092b9529d1419d688597c6d1dd9c` |
  | `scripts/gen_composite.py` | `ac7a75b921e1b69deaee29548955ff617982396b7fa8204281dae472be5465d9` |
  | `scripts/score_discovery.py` | `a9e3add09b27b84327c644a721b6153f5f295f525b0c1735fc8c80c95960175f` |
  | `data/composite/pool_PRIVATE.json` (private: real names) | `214892d009dff60ad5b3396d775bfc0e84afb549c284345a64653afb3714405d` |

- **Published copy.** `docs/sealed_exam/package/<seed>/` holds every exam table and the answer key, made from the zip by
  `scripts/package_exam.py`: addresses, towns, ZIPs and EINs replaced by codes (`scripts/deidentify.py`), and every
  narrative rewritten (`scripts/paraphrase.py`: side, body part, mechanism, outcome kept; no published sentence); table names,
  column names, date formats and everything the scorer reads are unchanged. `docs/sealed_exam/predictions/` holds what
  each run predicted (`run1`, `run2`, `rules`), with the model call log. The keyword baseline is recomputed from the tables.
- Only the table CSVs were extracted for the runs. The answer files were extracted after run 1, deleted before run 2, and
  extracted again only for scoring.

## How it was run

- `npm run exam -- <company>/tables` with `SAMPLE_MODE=false`. In both runs the tables were served by the bundled emulator
  (the same SQL the agent sends to Zetaris).
- Models: every call through Nightshift, streaming, `meterless-tier-split: off`, a fresh `meterless-scope: iso-<uuid>`
  per request. The fast lane requested `nvidia/nemotron-3.5-lightning-30b-a3b`. Run 2: 31 calls, all served by
  `nvidia/nemotron-3-ultra-550b-a55b`, none fell back. Run 1 (surviving logs): 34 calls, served by ultra-550b ×31,
  lightning-30b ×2, super-vl-120b ×1; three Planner replies were not JSON and the labelled rule fallback was used.
- Rule baseline: the same agent with no model (`L1_MODEL_OFFLINE=true`). Keyword baseline: `keyword_baseline()` in the
  hashed scorer.

## On live Zetaris

`scripts/load_company_zetaris.py` puts one exam company into real systems behind the local Zetaris (Postgres, MySQL, CSV
on S3) under its own role, which sees only that company's sources. `npm run exam -- <tables> --live <tag>` then runs
Discovery against Zetaris. Result on exam company 2003 (2026-10-24, after the exam was scored; same code as the app at that date, not the frozen exam code): 4/4 injury logs, 16/16 field pairs, no wrong picks; 57 Zetaris queries as the company's own role, 8 Nemotron calls through Nightshift (`docs/sealed_exam/live/2003_live_zetaris.json`; run before the narratives in the published copy were rewritten). One company is a check that the live path works, not a second score.

## Limits

- Five companies. The exam measures Layer 1 (discovery and field mapping), not Layer 2 (which records are the same injury).
- The paper-log table varies from run to run; everything else was right in both runs.
