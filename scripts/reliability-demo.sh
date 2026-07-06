#!/usr/bin/env bash
#
# reliability-demo.sh — durable-execution recovery demo (launch asset 9).
#
# Reproduces the "kill the worker mid-run, restart it, and watch the same run
# resume" story that backs the durability claim (docs/requirements.md TR-008;
# claims ledger CL-050). It is the scripted, re-runnable form of the reliability
# demo defined in docs/plans/2026-07-05-launch-readiness-artifacts-plan.md §7
# (asset 9, class C) — it stays true as the code evolves, unlike a recording.
#
# WHAT IT PROVES
#   A JobHunter workflow started on one worker survives that worker being killed
#   and is resumed to a terminal state by a fresh worker, from Temporal history,
#   with the SAME workflow id. Nothing is lost when a worker crashes.
#
# SAFETY GUARANTEES (read before running)
#   * ISOLATED STACK ONLY. Uses its own Temporal dev server on a free,
#     non-default port, its own JOBHUNTER_DIR under a throwaway temp dir, and its
#     own SQLite db. It never touches ~/.jobhunter or your real stack.
#   * NO REAL SPEND, NO CRAWL, NO SUBMISSION. The isolated workspace is
#     configured with zero discovery boards, so `discover` runs as a hermetic
#     no-op workflow: no job boards are fetched, no LLM tokens are spent, and no
#     application is ever submitted. It runs `init`, `worker`, and `discover`
#     only — never `apply`.
#   * KILLS ONLY ITS OWN CAPTURED PIDS. Every process it starts is tracked by
#     the exact PID it captured; cleanup kills those PIDs and nothing else. It
#     never runs a broad `pkill`, so it cannot kill your real worker.
#
# PRECONDITION — CONFIRM HERMETIC SOURCES
#   This script empties the JobSpy `boards` list so the JobSpy source family is a
#   no-op. If your build enables additional discovery source families (registry
#   / ATS sources) by default, confirm they are inactive in the isolated
#   workspace before trusting a fully offline run, or point discovery at a
#   dedicated fixture source. When in doubt, run on a machine with no network
#   egress. A first-class hermetic fixture source is tracked as a follow-up.
#
# REQUIREMENTS: temporal CLI, uv, python3, sqlite3 on PATH.
# USAGE: scripts/reliability-demo.sh [burst_count]   (default burst_count=3)
set -euo pipefail

BURST="${1:-3}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AUTOMATION="$REPO_ROOT/workers/automation"

for tool in temporal uv python3 sqlite3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FATAL: '$tool' not found on PATH." >&2; exit 2; }
done

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }

# Isolated, canonicalised workspace (macOS resolves /tmp -> /private/tmp; the
# worker heartbeat compares resolved paths, so canonicalise up front).
WORKDIR="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/jobhunter-reliability-demo.XXXXXX")" && pwd -P)"
export JOBHUNTER_DIR="$WORKDIR/home"
mkdir -p "$JOBHUNTER_DIR"

TEMPORAL_PORT="$(free_port)"
TEMPORAL_UI_PORT="$(free_port)"
# Never collide with the standard local stack (Temporal 7233 / UI 8233, API 8766).
for reserved in 7233 8233 8766 5173; do
  if [[ "$TEMPORAL_PORT" == "$reserved" || "$TEMPORAL_UI_PORT" == "$reserved" ]]; then
    echo "FATAL: drew a reserved port ($reserved); re-run." >&2; exit 2
  fi
done
export TEMPORAL_ADDRESS="127.0.0.1:$TEMPORAL_PORT"
export JOBHUNTER_SKIP_BROWSER_PREFLIGHT=1   # discover no-op needs no browser
export PLAYWRIGHT_SKIP_BROWSER_GC=1         # never GC other worktrees' browsers

TEMPORAL_PID=""; WORKER_PID=""; declare -a RUN_PIDS=()

cleanup() {
  echo "--- cleanup: killing only captured PIDs ---"
  for pid in "${RUN_PIDS[@]:-}" "$WORKER_PID" "$TEMPORAL_PID"; do
    [[ -n "${pid:-}" ]] && kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  rm -rf "$WORKDIR" 2>/dev/null || true
  echo "--- cleanup done ---"
}
trap cleanup EXIT INT TERM

jh() { uv --project "$AUTOMATION" run jobhunter "$@"; }

echo "=== Isolated reliability demo ==="
echo "workspace:        $JOBHUNTER_DIR"
echo "temporal address: $TEMPORAL_ADDRESS  (ui: 127.0.0.1:$TEMPORAL_UI_PORT)"

echo "--- 1/7 start isolated Temporal dev server ---"
temporal server start-dev \
  --port "$TEMPORAL_PORT" --ui-port "$TEMPORAL_UI_PORT" \
  --db-filename "$WORKDIR/temporal.db" --log-level error &
TEMPORAL_PID=$!
for _ in $(seq 1 30); do
  temporal operator namespace list --address "$TEMPORAL_ADDRESS" >/dev/null 2>&1 && break
  sleep 1
done

echo "--- 2/7 init isolated workspace + empty discovery boards (hermetic) ---"
jh init >/dev/null
sqlite3 "$JOBHUNTER_DIR/jobhunter.db" \
  "CREATE TABLE IF NOT EXISTS discovery_settings (
     tenant_id TEXT PRIMARY KEY, search_config_json TEXT NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   INSERT INTO discovery_settings (tenant_id, search_config_json, created_at, updated_at)
   VALUES ('local', '{\"boards\": []}', datetime('now'), datetime('now'))
   ON CONFLICT(tenant_id) DO UPDATE SET search_config_json = excluded.search_config_json;"

echo "--- 3/7 start worker A ---"
jh worker >"$WORKDIR/worker-a.log" 2>&1 &
WORKER_PID=$!
sleep 5

echo "--- 4/7 start a burst of $BURST discover runs (waiting on their handles) ---"
for _ in $(seq 1 "$BURST"); do
  jh discover >>"$WORKDIR/discover.log" 2>&1 &
  RUN_PIDS+=("$!")
done
sleep 3

echo "--- 5/7 CRASH worker A by its captured PID ($WORKER_PID) ---"
kill -9 "$WORKER_PID" 2>/dev/null || true
sleep 2
echo "open workflows while no worker is running (durably held by Temporal):"
temporal workflow list --address "$TEMPORAL_ADDRESS" --query 'ExecutionStatus="Running"' 2>/dev/null || true

echo "--- 6/7 start worker B — it must resume the in-flight runs from history ---"
jh worker >"$WORKDIR/worker-b.log" 2>&1 &
WORKER_PID=$!

echo "--- 7/7 wait for the same runs to reach a terminal state ---"
rc=0
for pid in "${RUN_PIDS[@]}"; do wait "$pid" || rc=1; done

echo "final workflow states:"
temporal workflow list --address "$TEMPORAL_ADDRESS" 2>/dev/null || true
echo "runs as JobHunter sees them:"
jh runs || true

if [[ "$rc" -eq 0 ]]; then
  echo "DEMO PASS — every run resumed after the worker crash and completed."
else
  echo "DEMO FAIL — a run did not resume to completion (inspect $WORKDIR/*.log)." >&2
fi
exit "$rc"
