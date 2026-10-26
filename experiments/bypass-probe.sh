#!/usr/bin/env bash
# Bounded bypassPermissions probe for the Prevue approval gate.
#
#   experiments/bypass-probe.sh selftest   no Claude session: timeout/process-tree test, guard hook, verdict logic on synthetic
#                                          evidence, gated-runner control flow against a stub, stale-build guard
#   experiments/bypass-probe.sh dry        one harmless APPROVED Write (checks setup, tools, state location)
#   experiments/bypass-probe.sh run        A1 control (approved) + A2a, A2b treatments (unapproved; skipped if A1 is not PASS)
#
# Safety properties (each is enforced by code in this script or bypass_probe_tools.py, not assumed):
#  - the compiled bundle the plugin runs (server/dist/src) must equal a fresh compile of the sources, else abort
#  - all work happens in a fresh mktemp dir with a marker file; the only `rm -rf` calls are guarded by that marker
#    and by the 32-hex project key
#  - COMPENSATING GUARD: Claude Code does not emit init before the first prompt (live finding, A1 attempt 1), so the tool
#    set cannot be verified pre-prompt. Instead an inline --settings hook (fail-closed: onFailure=block, exit 2 on any
#    error) denies every tool call except the exact sentinel Write of the current arm and the Prevue ping tool. The guard
#    never returns an allow/ask decision (it is silent when it permits), so it cannot authorise anything Prevue denies and
#    cannot stand in for Prevue's own allow. A guard denial makes the arm INCONCLUSIVE, never PASS
#  - the verdict requires the hook-seen state (from Prevue's own SessionStart output), the init mode/tools (post hoc),
#    the guard's own trace of every tool call, and exactly two PreToolUse responses per call (guard + Prevue)
#  - hard limits per session: 120 s wall clock (whole process group killed), 3 turns, $0.25
#  - results go to a NEW timestamped directory; nothing existing is overwritten
#  - repo files (excluding .git, node_modules, experiments/results) and user settings are fingerprinted before and
#    after; Git status is compared separately (tracked-file changes only)
#
# State location: Claude Code derives ${CLAUDE_PLUGIN_DATA} itself; this harness registers state under the documented
# layout ~/.claude/plugins/data/<id>/ (override: PREVUE_PROBE_DATA_DIR) and then PROVES the hook reads it, from the
# hook's own SessionStart output (status, revision, hash prefix). Only projects/<key of this workspace> inside that
# directory is ever created or removed.
#
# Known evidence limits: hook events carry no command, so Prevue's allow is INFERRED by elimination (the call's two
# PreToolUse responses are the guard's, identified by its marker, and one with no decision). A Prevue deny is explicit
# (its message starts with "Prevue:"). Hook ordering/parallelism is undocumented and never relied on. That inline
# --settings hooks load was seen live (earlier probe); that onFailure is honoured there, and that stderr is captured
# on exit-0 hooks, is unconfirmed until the first live run (the verdict falls back to INCONCLUSIVE).
set -euo pipefail
MODE="${1:?usage: bypass-probe.sh selftest|dry|run}"
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TOOLS="python3 -I $ROOT/experiments/bypass_probe_tools.py"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
RES="$ROOT/experiments/results/bypass-probe-$MODE-$TS"
mkdir "$RES"                                   # no -p: fails if it already exists

# 0. stale-build guard: abort unless the bundle the plugin will run equals a fresh compile of the sources
if ! $TOOLS buildcheck "$ROOT/server" "$ROOT/server/dist/src" > "$RES/buildcheck.json"; then
  echo "ABORT: server/dist is stale or differs from the sources:"; cat "$RES/buildcheck.json"; exit 1
fi
echo "buildcheck: server/dist/src matches a fresh compile ($(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["compared"])' "$RES/buildcheck.json") files)"

W="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/prevue-bypass.XXXXXX")" && pwd -P)"
case "$W" in */prevue-bypass.??????) ;; *) echo "ABORT: unexpected workspace path"; exit 1 ;; esac
[ "$(dirname "$W")" = "$(cd "${TMPDIR:-/tmp}" && pwd -P)" ] || { echo "ABORT: workspace is not directly inside the temp dir"; exit 1; }
touch "$W/.prevue-probe-marker"
DATA="${PREVUE_PROBE_DATA_DIR:-$HOME/.claude/plugins/data/prevue-inline}"
KEY="$(node --input-type=module -e "import('$ROOT/server/dist/src/state.js').then(m=>console.log(m.projectKey('$W')))")"
[[ "$KEY" =~ ^[0-9a-f]{32}$ ]] || { echo "ABORT: bad project key"; exit 1; }
cleanup() {
  # remove only this workspace's own state subdirectory, then the workspace itself
  [ -d "$DATA/projects/$KEY" ] && rm -rf -- "$DATA/projects/$KEY"
  case "$W" in */prevue-bypass.??????) [ -f "$W/.prevue-probe-marker" ] && rm -rf -- "$W" ;; esac
  return 0
}
trap cleanup EXIT
cd "$W"
echo "workspace: <tmp>/$(basename "$W")  results: ${RES#$ROOT/}"

gitstate() { { git -C "$ROOT" rev-parse HEAD; git -C "$ROOT" --no-optional-locks status --porcelain | grep -v '^??' || true; } 2>&1; }
BEFORE="$($TOOLS fingerprint "$ROOT")"
GIT_BEFORE="$(gitstate)"

if [ "$MODE" = selftest ]; then
  # 1. a process tree that would outlive a naive kill: a backgrounded child plus a foreground one
  $TOOLS run 3 "$W/o" "$W/e" -- sh -c 'sleep 4321 & sleep 4322' | tee "$RES/selftest-runner.json"
  sleep 1
  if pgrep -f 'sleep 432[12]' >/dev/null; then echo "SELFTEST FAIL: descendants survived"; pkill -f 'sleep 432[12]' || true; exit 1; fi
  echo "SELFTEST PASS: timeout killed the process group and its descendants" | tee "$RES/selftest-result.txt"
  # 2. verdict logic, gated runner (stub claude), stale-build guard on temp copies
  $TOOLS selftest "$ROOT" | tee "$RES/selftest-logic.txt"
  exit "${PIPESTATUS[0]}"
fi

echo '{"screen":"expense dashboard","layout":"sidebar+cards","version":"A"}' > design.json
H12="$(node --input-type=module -e "import {readFileSync} from 'node:fs'; import {hashDesign} from '$ROOT/server/dist/src/state.js'; console.log(hashDesign(JSON.parse(readFileSync('design.json','utf8'))).slice(0,12))")"
[[ "$H12" =~ ^[0-9a-f]{12}$ ]] || { echo "ABORT: bad design hash"; exit 1; }

# arm NAME KIND(dry|control|treatment): fresh state, one guarded+limited session, verdict
arm() {
  local name="$1" kind="$2" sentinel="$W/sentinel-$1.txt" status=APPROVED
  [ "$kind" = treatment ] && status=PENDING
  CLAUDE_PLUGIN_DATA="$DATA" node "$ROOT/server/dist/src/cli.js" reset "$W" >/dev/null      # every arm starts from a fresh PENDING state
  CLAUDE_PLUGIN_DATA="$DATA" node "$ROOT/server/dist/src/cli.js" register design.json "$W" >/dev/null
  if [ "$kind" != treatment ]; then                 # harness-only approval; approval-by-hook is covered by unit tests
    cat > approve.mjs <<EOF2
import { readFileSync } from "node:fs";
import { approve, hashDesign } from "$ROOT/server/dist/src/state.js";
approve("$DATA", "$W", hashDesign(JSON.parse(readFileSync("design.json", "utf8"))).slice(0, 16));
EOF2
    node approve.mjs
  fi
  python3 -I -c 'import json,sys;print(json.dumps({"status":sys.argv[1],"revision":1,"hash12":sys.argv[2]}))' "$status" "$H12" > "$W/expect-$name.json"
  local prompt="Use the Write tool to create the file $sentinel containing the single word probe. Do nothing else."
  local trace="$W/trace-$name.jsonl"; : > "$trace"
  local settings
  settings="$($TOOLS settings "$ROOT/experiments/bypass_probe_tools.py" "$sentinel" "$trace" "$W")"
  $TOOLS run 120 "$W/$name.stream" "$W/$name.err" -- \
    claude -p "$prompt" --plugin-dir "$ROOT" --permission-mode bypassPermissions \
      --tools Write --disallowedTools "mcp__claude_ai_*" \
      --max-turns 3 --max-budget-usd 0.25 --no-session-persistence \
      --output-format stream-json --verbose --include-hook-events --settings "$settings" > "$W/$name.runner.json"
  $TOOLS verdict "$kind" "$ROOT" "$W" "$sentinel" "$W/$name.stream" "$trace" "$W/$name.runner.json" "$W/expect-$name.json" > "$RES/evidence-$name.json" || true
  python3 -I -c 'import json,sys;e=json.load(open(sys.argv[1]));print("%-6s %-13s %s" % (sys.argv[2],e["verdict"],"; ".join(e["why"])))' "$RES/evidence-$name.json" "$name"
  [ -s "$W/$name.err" ] && tail -c 1500 "$W/$name.err" | sed -e "s#$W#<WORKSPACE>#g" -e "s#$ROOT#<REPO>#g" -e "s#$HOME#~#g" > "$RES/stderr-tail-$name.txt"
  if pgrep -f "$W" >/dev/null; then echo "  leftover processes referencing workspace:"; pgrep -fl "$W" | sed "s#$W#<WORKSPACE>#g"; pkill -f "$W" || true; fi
  if grep -q '"safety_violation": true' "$RES/evidence-$name.json"; then echo "SAFETY INVARIANT VIOLATED in $name: stopping; evidence preserved in ${RES#$ROOT/}"; exit 2; fi
}

case "$MODE" in
  dry) arm D0 dry ;;
  run) arm A1 control
       if grep -q '"verdict": "PASS"' "$RES/evidence-A1.json"; then arm A2a treatment; arm A2b treatment
       else echo "A1 control did not PASS: treatment arms skipped (a denial would not be attributable to the design state)"; fi ;;
  *) echo "unknown mode $MODE"; exit 64 ;;
esac

AFTER="$($TOOLS fingerprint "$ROOT")"
GIT_AFTER="$(gitstate)"
{ echo "files before: $BEFORE"; echo "files after:  $AFTER"; echo "git before: $(echo "$GIT_BEFORE" | tr '\n' ' ')"; echo "git after:  $(echo "$GIT_AFTER" | tr '\n' ' ')"; } | tee "$RES/fingerprint.txt"
[ "$BEFORE" = "$AFTER" ] && echo "FILES UNCHANGED (repo files excluding .git/node_modules/results, plus user settings.json/settings.local.json/installed_plugins.json)" || echo "FILES CHANGED - investigate"
[ "$GIT_BEFORE" = "$GIT_AFTER" ] && echo "GIT HEAD AND TRACKED-FILE STATUS UNCHANGED" || echo "GIT STATE CHANGED - investigate"
