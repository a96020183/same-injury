#!/bin/bash
# One case run live in product mode, with the Power contract's header `meterless-scope: user` (the product's default),
# next to the recordings, which are made with a fresh `iso-<uuid>` per request (scripts/record_live.sh; why: README,
# Sponsor technology). The case is the demo's pair at the invented plant Site-SYN1 (its log line and SIR-SYN001): the replies
# the recording holds for its two lanes are removed from a copy of the sample, so those calls go to Nightshift live
# under `user`; every other call replays the recording and every SQL answer replays the recorded Zetaris answers.
# One model request at a time. Writes docs/trace/user_scope_<run>_{model_calls,http_log,trace}.jsonl and _items.json; http_log holds
# the request headers each live call actually carried (read back from the Request fetch sent; the token masked).
#   bash scripts/user_scope_case.sh      (needs the Nightshift token in ../.env; not for judges)
set -eu
cd "$(dirname "$0")/.."
unset METERLESS_SCOPE
export L1_PARENT_ENV=1 SAMPLE_MODE=true L1_RUNS_DIR="$PWD/runs/user_scope"
tmp="$PWD/runs/user_scope_sample"
rm -rf "$tmp" && mkdir -p "$tmp" && cp -r sample/seed1003/. "$tmp/"
# the two lanes of that pair in the published demo run (lane numbers come from the run)
items=$(ls -t docs/trace/demo_*_items.json | head -1)
lanes=$(node -e 'const it = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(it.filter((i) => i.site === "Site-SYN1").map((i) => i.lane).join("|"))' "$items")
node -e '
const fs = require("fs"), f = process.argv[1], rx = new RegExp(`"tag":"[^"]*\\.(${process.argv[2]})(\\.|")`);
const keep = fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l && !rx.test(l));
fs.writeFileSync(f, keep.join("\n") + "\n");' "$tmp/model_cassette.jsonl" "$lanes"
L1_SAMPLE_DIR="$tmp" node --no-warnings --import tsx app/cli.ts --approve-all > runs/user_scope_run.log 2>&1
run=$(ls -t runs/user_scope | head -1)
for k in model_calls.jsonl http_log.jsonl trace.jsonl items.json; do cp "runs/user_scope/$run/$k" "docs/trace/user_scope_${run}_$k"; done
echo "run $run · requests sent with meterless-scope: user: $(grep -c '"meterless-scope":"user"' "docs/trace/user_scope_${run}_http_log.jsonl")"
