#!/usr/bin/env bash
# Free checks before spending credits: tools, corpus, index, MCP handshake, agent command lines.
# Env: AGENTS (default "copilot claude") — which agents to check.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export SCENARIOS="$(realpath "${SCENARIOS:-$HERE/scenarios.json}")"
CG_BIN="${CG_BIN:-$(command -v codegraph)}"
fail=0
ok()   { echo "  ✓ $*"; }
bad()  { echo "  ✗ $*"; fail=1; }

echo "Tools"
AGENTS="${AGENTS:-copilot claude}"
if [[ " $AGENTS " == *" copilot "* ]]; then
  command -v copilot >/dev/null && ok "copilot $(copilot --version 2>/dev/null | head -1)" || bad "copilot CLI not found (npm i -g @github/copilot) — or run with AGENTS=claude"
fi
if [[ " $AGENTS " == *" claude "* ]]; then
  CB="${CLAUDE_BIN:-$(command -v claude 2>/dev/null)}"
  { [ -n "$CB" ] && [ -x "$CB" ]; } || CB="$(ls -d "$HOME"/.vscode-server/extensions/anthropic.claude-code-*/resources/native-binary/claude "$HOME"/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null | sort -V | tail -1)"
  [ -x "$CB" ] && ok "claude $("$CB" --version 2>/dev/null | head -1) ($CB)" || bad "claude binary not found (set CLAUDE_BIN) — or run with AGENTS=copilot"
fi
[ -n "$CG_BIN" ] && ok "codegraph $("$CG_BIN" --version 2>/dev/null | tail -1) ($CG_BIN)" || bad "codegraph not found"
command -v node >/dev/null && ok "node $(node --version)" || bad "node not found"
command -v git  >/dev/null && ok "git" || bad "git not found"

echo "Scenario file: $SCENARIOS"
todo=$(node -e '
const c=require(process.argv[1]); const bad=[];
for (const s of c.scenarios) if (JSON.stringify([s.prompt,s.expect,s.seed,s.detect]).includes("TODO")) bad.push(s.id);
for (const [k,r] of Object.entries(c.repos)) if (!r.url || !r.sha) bad.push("repo:"+k);
console.log(bad.join(" "))' "$SCENARIOS")
[ -z "$todo" ] && ok "no TODO left" || bad "still has TODO / missing fields: $todo"

echo "Corpus + index"
for r in $(node -e 'console.log(Object.keys(require(process.argv[1]).repos).join(" "))' "$SCENARIOS"); do
  dir="$(node "$HERE/lib/prepare.mjs" --repo "$r" 2>/dev/null | tail -1)"
  if [ -d "$dir/.codegraph" ]; then
    files=$("$CG_BIN" status -j "$dir" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).fileCount)}catch{console.log("?")}})')
    ok "$r: $dir ($files indexed files)"
    code=$(node -e 'console.log(require(process.argv[1]).repos[process.argv[2]].codeFiles ?? "")' "$SCENARIOS" "$r")
    if [ -n "$code" ] && [ "$files" != "?" ] && [ $((files * 2)) -lt "$code" ]; then
      echo "  ! $r: only $files of ~$code code files indexed — the project's language may be unsupported; check \`codegraph status $dir\`"
    fi
  else
    bad "$r: prepare/index failed"
  fi
done

echo "Seeds (every scenario applies cleanly)"
n=0; for id in $(node -e 'console.log(require(process.argv[1]).scenarios.map(s=>s.id).join(" "))' "$SCENARIOS"); do
  node "$HERE/lib/prepare.mjs" "$id" >/dev/null 2>"/tmp/preflight-$$.err" && n=$((n+1)) || bad "$id: $(tail -1 /tmp/preflight-$$.err)"
done; ok "$n scenarios prepared"; rm -f "/tmp/preflight-$$.err"

echo "CodeGraph MCP handshake (what the 'with' arm attaches)"
FIRST_REPO="$(node -e 'console.log(Object.keys(require(process.argv[1]).repos)[0])' "$SCENARIOS")"
FIRST_ID="$(node -e 'console.log(require(process.argv[1]).scenarios[0].id)' "$SCENARIOS")"
dir="$(node "$HERE/lib/prepare.mjs" --repo "$FIRST_REPO" 2>/dev/null | tail -1)"
node - "$CG_BIN" "$dir" <<'JS'
const { spawn } = require('child_process');
const p = spawn(process.argv[2], ['serve', '--mcp', '--path', process.argv[3]], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = '';
const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
const t = setTimeout(() => { console.log('  ✗ no tools/list answer within 20s'); p.kill(); process.exit(1); }, 20000);
p.stdout.on('data', (d) => {
  buf += d;
  for (const line of buf.split('\n').slice(0, -1)) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }
    if (m.id === 2) { clearTimeout(t); console.log('  ✓ tools: ' + m.result.tools.map((x) => x.name).join(', ')); p.kill(); process.exit(0); }
  }
  buf = buf.split('\n').at(-1);
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'preflight', version: '1' } } });
JS
[ $? -eq 0 ] || fail=1

echo "Agent command lines (dry run; only the arm-specific tail is shown)"
for agent in $AGENTS; do
  for arm in without with; do
    line="$(DRY_RUN=1 "$HERE/run.sh" "$agent" "$FIRST_ID" "$arm")" || { bad "$agent/$arm dry run failed"; continue; }
    printf '  %-7s %-7s …%s\n' "$agent" "$arm" "$(echo "$line" | grep -oE -- '--(disable-builtin-mcps|strict-mcp-config).*')"
  done
done

for r in $(node -e 'console.log(Object.keys(require(process.argv[1]).repos).join(" "))' "$SCENARIOS"); do node "$HERE/lib/prepare.mjs" --repo "$r" >/dev/null 2>&1; done
pkill -f "serve --mcp --path ${CORPUS_DIR:-/tmp/codegraph-corpus}/" 2>/dev/null
rm -rf "$HERE/results/adhoc"; rmdir "$HERE/results" 2>/dev/null
[ $fail -eq 0 ] && echo "PREFLIGHT OK" || { echo "PREFLIGHT FAILED"; exit 1; }
