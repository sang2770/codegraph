#!/usr/bin/env bash
# Run many scenarios × agents × both arms × N runs, then write the report.
#
# Usage: run-matrix.sh [scenario-regex]
#   run-matrix.sh                        # all 24 scenarios, AGENTS (default: copilot)
#   run-matrix.sh '^ex-'                 # express only
#   run-matrix.sh -- '-r[0-9]-'          # reviews only
#   run-matrix.sh -- '-a[0-9]-'          # analyses only
#   AGENTS=claude run-matrix.sh          # Claude Code only
#   AGENTS="copilot claude" run-matrix.sh   # both, compared side by side
# Env: AGENTS (default "copilot"), RUNS (default 2), ARMS (default "without with"),
#      plus everything run.sh reads (MODEL, EFFORT, MAX_USD, MAX_CREDITS, …).
#
# Agents and arms alternate inside each run (copilot/without, copilot/with,
# claude/without, …) so drift in API latency over the session hits every
# combination equally.
set -uo pipefail
[ "${1:-}" = "--" ] && shift
FILTER="${1:-.}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export SCENARIOS="$(realpath "${SCENARIOS:-$HERE/scenarios.json}")"
AGENTS="${AGENTS:-copilot}"
RUNS="${RUNS:-2}"
ARMS="${ARMS:-without with}"
export OUT_DIR="${OUT_DIR:-$HERE/results/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT_DIR"

for a in $AGENTS; do
  case "$a" in copilot|claude) ;; *) echo "unknown agent '$a' (copilot|claude)"; exit 2;; esac
done

mapfile -t IDS < <(node -e '
const re=new RegExp(process.argv[2]);
for (const s of require(process.argv[1]).scenarios) if (re.test(s.id)) console.log(s.id)' "$SCENARIOS" "$FILTER")
[ ${#IDS[@]} -gt 0 ] || { echo "no scenario matches '$FILTER'"; exit 1; }

TOTAL=$(( ${#IDS[@]} * RUNS * $(echo $ARMS | wc -w) * $(echo $AGENTS | wc -w) ))
cat > "$OUT_DIR/meta.json" <<JSON
{"started":"$(date -Iseconds)","filter":"$FILTER","agents":"$AGENTS","runs":$RUNS,"arms":"$ARMS","model":"${MODEL:-claude-sonnet-5}","effort":"${EFFORT:-high}","codegraph":"$(codegraph --version 2>/dev/null | tail -1)","scenarios":$(printf '%s\n' "${IDS[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.trim().split("\n"))))')}
JSON
echo "### $TOTAL runs ($AGENTS) → $OUT_DIR"

i=0
for id in "${IDS[@]}"; do
  for n in $(seq 1 "$RUNS"); do
    for agent in $AGENTS; do
      for arm in $ARMS; do
        i=$((i+1)); echo "[$i/$TOTAL]"
        "$HERE/run.sh" "$agent" "$id" "$arm" "$n"
      done
    done
  done
done

# Stop any daemons we pre-warmed.
for d in "${CORPUS_DIR:-/tmp/codegraph-corpus}"/*; do
  [ -S "$d/.codegraph/daemon.sock" ] && pkill -f "codegraph.*serve --mcp --path $d" 2>/dev/null
done
# Leave the corpus repos clean.
for r in $(node -e 'console.log(Object.keys(require(process.argv[1]).repos).join(" "))' "$SCENARIOS"); do
  [ -d "${CORPUS_DIR:-/tmp/codegraph-corpus}/$r" ] && node "$HERE/lib/prepare.mjs" --repo "$r" >/dev/null 2>&1
done

node "$HERE/lib/summarize.mjs" "$OUT_DIR"
