#!/bin/bash
# How the recorded runs in this repository are made (needs Zetaris, Nightshift and the private keys; not for judges).
# One model request at a time; METERLESS_SCOPE=iso so Nightshift's H-MEM cannot hand one lane another lane's answer
# (the product's default is the contract's `user`; see README, Sponsor technology).
#   bash scripts/record_live.sh [demo] [unseen1] [unseen2] [variants] [vl]     (no argument: all, in this order)
set -u
cd "$(dirname "$0")/.."
export METERLESS_SCOPE=iso L1_PARENT_ENV=1
steps="${*:-demo unseen1 unseen2 variants vl}"
for s in $steps; do
  echo "== $s $(date -u +%FT%TZ)"
  case $s in
    demo)     rm -f sample/seed1003/model_cassette.jsonl sample/seed1003/zetaris_cassette.jsonl
              SAMPLE_MODE=false node --no-warnings --import tsx app/cli.ts --approve-all --live --record > runs/seed1003_run.log 2>&1; echo "exit $?" ;;
    unseen1)  rm -f sample/unseen3001/zetaris_cassette.jsonl sample/unseen3001/model_cassette.jsonl
              SAMPLE_MODE=false L1_EXAM_OUT=runs/live_unseen3001 node --no-warnings --import tsx app/exam.ts sample/unseen3001/tables --live unseen3001 --record 2>&1 | tail -1 ;;
    unseen2)  rm -f sample/unseen3001/full/model_cassette.jsonl sample/unseen3001/full/zetaris_cassette.jsonl
              ( export SAMPLE_MODE=false L1_SAMPLE_DIR="$PWD/sample/unseen3001/full" L1_AGENT_ROLE=L1_UNSEEN3001 L1_USL_NAME=unseen3001_records
                export ZETARIS_AGENT_API_KEY="$(cat data/private/zetaris_unseen3001_key_PRIVATE.txt)"
                node --no-warnings --import tsx app/cli.ts --approve-all --live --record > runs/unseen_full_run.log 2>&1; echo "exit $?" ) ;;
    variants) rm -rf sample/variants
              SAMPLE_MODE=false node --no-warnings --import tsx scripts/variants.ts --record > runs/variants_record.log 2>&1; echo "exit $?" ;;
    vl)       SAMPLE_MODE=false node --no-warnings --import tsx app/vl.ts --record > runs/vl_record.log 2>&1; echo "exit $?" ;;
  esac
done
echo "== all done $(date -u +%FT%TZ)"
