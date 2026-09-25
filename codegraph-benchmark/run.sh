#!/usr/bin/env bash
# One headless run of one scenario, one agent, one arm.
#
# Usage: run.sh <copilot|claude> <scenario-id> <with|without|hook> [run-index]
#        hook = with + CodeGraph's UserPromptSubmit prompt-hook (claude only)
# Env:   MODEL        model id               (default claude-sonnet-5 — same model for both agents)
#        EFFORT       reasoning effort       (default high)
#        OUT_DIR      results directory      (default ./results/adhoc)
#        RUN_TIMEOUT  seconds per run        (default 900)
#        MAX_CREDITS  copilot: optional --max-ai-credits cap per run
#        MAX_USD      claude:  --max-budget-usd per run (default 3)
#        CG_BIN       codegraph binary       (default: codegraph on PATH; bin/codegraph-dev = this repo's dist/)
#        CG_PROFILE   CODEGRAPH_MCP_PROFILE for the with-arm, e.g. "review" to also list codegraph_review
#        CLAUDE_BIN   claude binary          (default: claude on PATH, else newest VS Code extension binary)
#        CORPUS_DIR   where repos are cloned (default /tmp/codegraph-corpus)
#        DRY_RUN=1    print the agent command instead of running it
#
# The two arms differ ONLY in whether the codegraph MCP server is attached.
# Both arms: same model/effort/prompt, every other MCP server off, the user's
# global instructions/hooks/plugins off, file writes and network access denied
# (the answer must come from the repo, not from fetching upstream sources). The without-arm
# also denies the `codegraph` shell command so it can't reach the index via bash.
set -uo pipefail

AGENT="${1:?usage: run.sh <copilot|claude> <scenario-id> <with|without> [run-index]}"
ID="${2:?scenario id required}"
ARM="${3:?arm must be with|without|hook}"
N="${4:-1}"
case "$AGENT" in copilot|claude) ;; *) echo "agent must be copilot|claude" >&2; exit 2;; esac
case "$ARM" in with|without|hook) ;; *) echo "arm must be with|without|hook" >&2; exit 2;; esac
[ "$ARM" = hook ] && [ "$AGENT" != claude ] && { echo "arm hook is claude-only" >&2; exit 2; }
# The hook arm is the with-arm plus the hook; everything else keys off CG_ARM.
CG_ARM="$ARM"; [ "$ARM" = hook ] && CG_ARM=with

HERE="$(cd "$(dirname "$0")" && pwd)"
export SCENARIOS="$(realpath "${SCENARIOS:-$HERE/scenarios.json}")"
MODEL="${MODEL:-claude-sonnet-5}"
EFFORT="${EFFORT:-high}"
OUT_DIR="${OUT_DIR:-$HERE/results/adhoc}"
RUN_TIMEOUT="${RUN_TIMEOUT:-900}"
CG_BIN="${CG_BIN:-$(command -v codegraph)}"
mkdir -p "$OUT_DIR"
TAG="${AGENT}__${ID}__${ARM}__${N}"

# The user's global `codegraph prompt-hook` would inject codegraph context into every prompt.
# The hook arm wires it in explicitly (below) and so must not kill-switch it.
[ "$ARM" = hook ] || export CODEGRAPH_NO_PROMPT_HOOK=1

REPO="$(node "$HERE/lib/prepare.mjs" "$ID" | tail -1)" || { echo "prepare failed for $ID" >&2; exit 1; }
PROMPT="$(node -e '
const c=require(process.argv[1]); const s=c.scenarios.find(x=>x.id===process.argv[2]);
process.stdout.write(s.type==="review" ? (c.reviewPrompt ?? require(process.argv[3]).reviewPrompt) : s.prompt)' "$SCENARIOS" "$ID" "$HERE/scenarios.json")"

MCP_CFG="$OUT_DIR/mcp-codegraph-$(basename "$REPO").json"
MCP_ENV='{}'; [ -n "${CG_PROFILE:-}" ] && MCP_ENV="{\"CODEGRAPH_MCP_PROFILE\":\"$CG_PROFILE\"}"
printf '{"mcpServers":{"codegraph":{"type":"stdio","command":"%s","args":["serve","--mcp","--path","%s"],"env":%s,"tools":["*"]}}}\n' \
  "$CG_BIN" "$REPO" "$MCP_ENV" > "$MCP_CFG"

if [ "$AGENT" = copilot ]; then
  BIN=copilot
  mapfile -t OTHER_SERVERS < <(node -e '
  try { const c=require(process.argv[1]); for (const k of Object.keys(c.mcpServers||{})) if (k!=="codegraph") console.log(k) } catch {}' \
    "${COPILOT_HOME:-$HOME/.copilot}/mcp-config.json")
  ARGS=(-p "$PROMPT"
    --model "$MODEL" --effort "$EFFORT"
    --allow-all-tools --deny-tool=write
    --deny-tool=web_fetch --deny-tool='shell(gh)' --deny-tool='shell(curl)' --deny-tool='shell(wget)'
    --no-ask-user --no-custom-instructions --no-auto-update
    --disable-builtin-mcps
    --output-format json
    --log-dir "$OUT_DIR/logs")
  for s in "${OTHER_SERVERS[@]}"; do ARGS+=(--disable-mcp-server "$s"); done
  [ -n "${MAX_CREDITS:-}" ] && ARGS+=(--max-ai-credits "$MAX_CREDITS")
  if [ "$CG_ARM" = with ]; then
    ARGS+=(--additional-mcp-config "@$MCP_CFG" --allow-all-mcp-server-instructions)
  else
    ARGS+=(--disable-mcp-server codegraph --deny-tool='shell(codegraph)')
  fi
else
  BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null)}"
  if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
    BIN="$(ls -d "$HOME"/.vscode-server/extensions/anthropic.claude-code-*/resources/native-binary/claude \
                  "$HOME"/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null | sort -V | tail -1)"
  fi
  [ -x "$BIN" ] || { echo "claude binary not found (set CLAUDE_BIN)" >&2; exit 1; }
  EMPTY_CFG="$OUT_DIR/mcp-empty.json"; echo '{"mcpServers":{}}' > "$EMPTY_CFG"
  DISALLOW=(Edit Write NotebookEdit WebFetch WebSearch 'Bash(gh:*)' 'Bash(curl:*)' 'Bash(wget:*)')
  [ "$CG_ARM" = without ] && DISALLOW+=('Bash(codegraph:*)')
  # Managed settings can disable bypassPermissions (disableBypassPermissionsMode), which
  # silently drops the run to "default" mode where headless -p DENIES every tool not
  # pre-approved — MCP tools included. Allow-list explicitly so both modes behave the same;
  # --disallowedTools still wins over these.
  ALLOW=(Read Grep Glob Bash Agent Task ToolSearch)
  [ "$CG_ARM" = with ] && ALLOW+=(mcp__codegraph)
  # --setting-sources project,local skips ~/.claude (global hooks, plugins, CLAUDE.md);
  # the corpus repos carry no project settings of their own.
  ARGS=(-p "$PROMPT"
    --model "$MODEL" --effort "$EFFORT"
    --output-format stream-json --verbose
    --permission-mode bypassPermissions
    --allowedTools "${ALLOW[@]}"
    --disallowedTools "${DISALLOW[@]}"
    --setting-sources project,local
    --disable-slash-commands
    --no-session-persistence
    --max-budget-usd "${MAX_USD:-3}"
    --strict-mcp-config)
  if [ "$ARM" = hook ]; then
    HOOK_CFG="$OUT_DIR/hook-settings.json"
    printf '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"%s prompt-hook","timeout":60}]}]}}\n' "$CG_BIN" > "$HOOK_CFG"
    # --include-hook-events puts what the hook injected into the log, so a run can be checked.
    ARGS+=(--settings "$HOOK_CFG" --include-hook-events)
  fi
  if [ "$CG_ARM" = with ]; then
    ARGS+=(--mcp-config "$MCP_CFG")
  else
    ARGS+=(--mcp-config "$EMPTY_CFG")
  fi
fi

if [ -n "${DRY_RUN:-}" ]; then
  printf 'cd %q && %q' "$REPO" "$BIN"; printf ' %q' "${ARGS[@]}"; echo
  exit 0
fi

# Pre-warm the daemon so the agent's first turn doesn't race MCP startup.
if [ "$CG_ARM" = with ] && [ ! -S "$REPO/.codegraph/daemon.sock" ]; then
  CODEGRAPH_MCP_PROFILE="${CG_PROFILE:-}" CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=3600000 "$CG_BIN" serve --mcp --path "$REPO" </dev/null >/dev/null 2>&1 &
  for _ in $(seq 1 150); do [ -S "$REPO/.codegraph/daemon.sock" ] && break; sleep 0.1; done
fi

STATE="${COPILOT_HOME:-$HOME/.copilot}/session-state"
[ "$AGENT" = copilot ] && { mkdir -p "$STATE"; BEFORE="$(ls -1 "$STATE" 2>/dev/null | sort)"; }
DIFF_BEFORE="$(git -C "$REPO" diff | sha1sum)"
echo "→ [$TAG] model=$MODEL effort=$EFFORT repo=$REPO"
START_MS=$(date +%s%3N)
# Don't inherit a parent Claude Code session's env (session id, effort, entrypoint…) when
# this script is itself launched from inside Claude Code.
( cd "$REPO" && for v in $(compgen -e | grep -E '^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK)'); do unset "$v"; done
  timeout "$RUN_TIMEOUT" "$BIN" "${ARGS[@]}" ) > "$OUT_DIR/$TAG.stdout.jsonl" 2> "$OUT_DIR/$TAG.stderr"
EXIT=$?
END_MS=$(date +%s%3N)

EVENTS="$OUT_DIR/$TAG.stdout.jsonl"
if [ "$AGENT" = copilot ]; then
  # The session's own event log carries session.shutdown (tokens, credits).
  NEW_SESSION="$(comm -13 <(echo "$BEFORE") <(ls -1 "$STATE" | sort) | head -1)"
  if [ -n "$NEW_SESSION" ] && [ -f "$STATE/$NEW_SESSION/events.jsonl" ]; then
    cp "$STATE/$NEW_SESSION/events.jsonl" "$OUT_DIR/$TAG.events.jsonl"
    EVENTS="$OUT_DIR/$TAG.events.jsonl"
  fi
fi

TAMPERED=0; [ "$(git -C "$REPO" diff | sha1sum)" != "$DIFF_BEFORE" ] && TAMPERED=1
AGENT_VERSION="$("$BIN" --version 2>/dev/null | head -1)"

node "$HERE/lib/parse.mjs" \
  --agent "$AGENT" --agent-version "$AGENT_VERSION" \
  --id "$ID" --arm "$ARM" --run "$N" --model "$MODEL" --effort "$EFFORT" \
  --exit "$EXIT" --wall-ms "$((END_MS - START_MS))" \
  --cg-version "$("$CG_BIN" --version 2>/dev/null | tail -1)${CG_PROFILE:+ (profile $CG_PROFILE)}" \
  --tampered "$TAMPERED" --answer-out "$OUT_DIR/$TAG.answer.md" \
  --events "$EVENTS" --stdout "$OUT_DIR/$TAG.stdout.jsonl" \
  >> "$OUT_DIR/results.jsonl"
tail -1 "$OUT_DIR/results.jsonl" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);
const cost = r.costUsd!=null ? `$${r.costUsd.toFixed(3)}` : `credits ${r.nanoAiu==null?"?":(r.nanoAiu/1e9).toFixed(2)} premium ${r.premiumRequests}`;
console.log(`  exit ${r.exit} | ${(r.wallMs/1000).toFixed(0)}s | tools ${r.tools.total} (codegraph ${r.tools.codegraph}, read ${r.tools.read+r.tools.bashRead}, search ${r.tools.search+r.tools.bashSearch}) | tokens in ${r.tokens.input} (cached ${r.tokens.cacheRead}) out ${r.tokens.output} | ${cost} | score ${r.score.expect}${r.score.detected===null?"":" detected="+r.score.detected}`)})'
