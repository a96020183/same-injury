#!/usr/bin/env bash
# Live integration: local Zetaris + Nightshift, one model request at a time (llm.ts serialises).
# Records the SAMPLE_MODE cassettes. Logs go to runs/integration_<time>/ (git-ignored except the summary we copy out).
set -u
cd "$(dirname "$0")/.."
OUT="runs/app/integration_$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
export SAMPLE_MODE=false L1_MODEL_OFFLINE=false
echo "1/3 full run: live Zetaris + Nightshift, recording cassettes"
node --no-warnings --import tsx app/cli.ts --live --approve-all --record > "$OUT/demo.txt" 2>&1; echo "exit $?" >> "$OUT/demo.txt"
tail -25 "$OUT/demo.txt"
echo "2/3 discovery exam on development company 1000 (live models)"
node --no-warnings --import tsx app/exam.ts data/composite/1000 > "$OUT/exam_1000.txt" 2>&1; grep -E "^score|models" "$OUT/exam_1000.txt"
echo "3/3 replay check (SAMPLE_MODE, no network)"
SAMPLE_MODE=true L1_MODEL_OFFLINE=true node --no-warnings --import tsx app/cli.ts --approve-all > "$OUT/replay.txt" 2>&1; tail -4 "$OUT/replay.txt"
echo "logs: $OUT"
