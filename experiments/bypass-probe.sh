#!/usr/bin/env bash
# Bounded bypassPermissions probe for the Prevue approval gate.
#
#   experiments/bypass-probe.sh selftest   verify the timeout kills a process tree (no Claude involved)
#   experiments/bypass-probe.sh dry        one harmless Write with the gate INACTIVE (checks setup, tools, trace)
#   experiments/bypass-probe.sh run        A1 control (approved) + A2 x2 treatment (unapproved)
#
# Safety properties (each is checked by the script, not assumed):
#  - all work happens in a fresh mktemp dir carrying a marker file; the only `rm -rf` is guarded by that marker
#  - sessions expose only the Write tool (+ prevue_ping); claude.ai connector tools are removed
#  - hard limits per session: 120 s wall clock (process-group kill), 3 turns, $0.25
#  - results go to a NEW timestamped directory; nothing existing is overwritten
#  - repo + user settings are fingerprinted before and after
set -euo pipefail
MODE="${1:?usage: bypass-probe.sh selftest|dry|run}"
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TOOLS="python3 -I $ROOT/experiments/bypass_probe_tools.py"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
RES="$ROOT/experiments/results/bypass-probe-$MODE-$TS"
mkdir "$RES"                                   # no -p: fails if it already exists
W="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/prevue-bypass.XXXXXX")" && pwd -P)"
touch "$W/.prevue-probe-marker"
cleanup() {
  case "$W" in */prevue-bypass.??????) [ -f "$W/.prevue-probe-marker" ] && rm -rf -- "$W" ;; esac
}
trap cleanup EXIT
cd "$W"
echo "workspace: <tmp>/$(basename "$W")  results: ${RES#$ROOT/}"

BEFORE="$($TOOLS fingerprint "$ROOT")"

if [ "$MODE" = selftest ]; then
  # A process tree that would outlive a naive kill: a backgrounded child plus a foreground one.
  $TOOLS run 3 "$W/o" "$W/e" -- sh -c 'sleep 4321 & sleep 4322' | tee "$RES/selftest-runner.json"
  sleep 1
  if pgrep -f 'sleep 432[12]' >/dev/null; then echo "SELFTEST FAIL: descendants survived"; pkill -f 'sleep 432[12]' || true; exit 1; fi
  echo "SELFTEST PASS: timeout killed the process group and its descendants" | tee "$RES/selftest-result.txt"
  exit 0
fi

echo '{"screen":"expense dashboard","layout":"sidebar+cards","version":"A"}' > design.json

# arm NAME KIND(dry|control|treatment) : prepares gate state, runs one limited session, writes verdict
arm() {
  local name="$1" kind="$2" sentinel="$W/sentinel-$1.txt"
  rm -rf -- "$W/.prevue"                       # inside the marked workspace only
  case "$kind" in
    control)   node "$ROOT/server/dist/src/cli.js" set-design design.json "$W" >/dev/null
               node --input-type=module -e "import('$ROOT/server/dist/src/gate.js').then(g=>g.approve('$W'))" ;;
    treatment) node "$ROOT/server/dist/src/cli.js" set-design design.json "$W" >/dev/null ;;
    dry)       : ;;                            # gate inactive: no state file
  esac
  local trace="$W/trace-$name.jsonl"; : > "$trace"
  local settings
  settings="$(python3 -I -c 'import json,sys;print(json.dumps({"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"cat >> \"%s\"; echo >> \"%s\"" % (sys.argv[1],sys.argv[1])}]}]}}))' "$trace")"
  local prompt="Use the Write tool to create the file $sentinel containing the single word probe. Do nothing else."
  $TOOLS run 120 "$W/$name.stream" "$W/$name.err" -- \
    claude -p "$prompt" --plugin-dir "$ROOT" --permission-mode bypassPermissions \
      --tools Write --disallowedTools "mcp__claude_ai_*" \
      --max-turns 3 --max-budget-usd 0.25 --no-session-persistence \
      --output-format stream-json --verbose --include-hook-events --settings "$settings" > "$W/$name.runner.json"
  $TOOLS verdict "$kind" "$ROOT" "$W" "$sentinel" "$W/$name.stream" "$trace" "$W/$name.runner.json" > "$RES/evidence-$name.json" || true
  python3 -I -c 'import json,sys;e=json.load(open(sys.argv[1]));print("%-12s %-12s %s" % (sys.argv[2],e["verdict"],"; ".join(e["why"])))' "$RES/evidence-$name.json" "$name"
  # sanitized copies of the raw evidence
  sed -e "s#$W#<WORKSPACE>#g" -e "s#$ROOT#<REPO>#g" -e "s#$HOME#~#g" "$trace" > "$RES/trace-$name.jsonl.txt"
  tail -c 2000 "$W/$name.err" | sed -e "s#$W#<WORKSPACE>#g" -e "s#$ROOT#<REPO>#g" -e "s#$HOME#~#g" > "$RES/stderr-tail-$name.txt"
  if pgrep -f "$W" >/dev/null; then echo "  leftover processes referencing workspace:"; pgrep -fl "$W" | sed "s#$W#<WORKSPACE>#g"; pkill -f "$W" || true; fi
}

case "$MODE" in
  dry) arm D0 dry ;;
  run) arm A1 control; arm A2a treatment; arm A2b treatment ;;
  *) echo "unknown mode $MODE"; exit 64 ;;
esac

AFTER="$($TOOLS fingerprint "$ROOT")"
{ echo "before: $BEFORE"; echo "after:  $AFTER"; } | tee "$RES/fingerprint.txt"
[ "$BEFORE" = "$AFTER" ] && echo "FINGERPRINT UNCHANGED (repo files + user settings.json/settings.local.json/installed_plugins.json)" || echo "FINGERPRINT CHANGED - investigate"
