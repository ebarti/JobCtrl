#!/usr/bin/env bash
#
# reliability-demo.sh — durable-execution recovery demo (launch asset 9).
#
# Reproduces the "kill the worker mid-run, restart it, and watch the same run
# resume" story that backs the durability claim (docs/requirements.md TR-008;
# claims ledger CL-050). It is the scripted, re-runnable, self-asserting form of
# the reliability demo — it stays true as the code evolves, unlike a recording.
#
# WHAT IT PROVES (and asserts, failing loudly otherwise)
#   A JobCtl workflow that is in flight on one worker survives that worker
#   being killed and is resumed to a terminal state by a fresh worker, from
#   Temporal history, with the SAME workflow id AND the SAME run id — exactly
#   once. Nothing is lost, and nothing is double-applied, when a worker crashes.
#
# HOW IT STAYS HERMETIC
#   The demo drives DurabilityProbeWorkflow
#   (workers/automation/.../infrastructure/temporal/durability_probe.py): a
#   diagnostic workflow whose only in-flight state is a durable Temporal timer
#   (`workflow.sleep`). It fetches no job boards, spends no LLM tokens, opens no
#   browser, and submits nothing — the timer is what keeps the run "Running"
#   long enough to be killed mid-flight, which a no-op discover (finishing in
#   milliseconds) can never demonstrate. LANGFUSE_DISABLE=1 stops even
#   telemetry from leaving the machine.
#
# SAFETY GUARANTEES (read before running)
#   * ISOLATED STACK ONLY. Its own Temporal dev server on free, non-default
#     ports, its own JOBCTL_DIR under a throwaway temp dir, its own SQLite db.
#     It never touches ~/.jobctl or your real stack.
#   * NO REAL SPEND, NO CRAWL, NO SUBMISSION, NO NETWORK EGRESS. Only the
#     durable-timer probe workflow runs; `apply` is never invoked.
#   * KILLS ONLY ITS OWN PROCESS TREES. Every process it starts is tracked by
#     the exact PID it captured; cleanup kills that PID and its descendants and
#     nothing else. It never runs a broad `pkill`, so it cannot touch your real
#     worker.
#
# REQUIREMENTS: temporal CLI, uv, python3, sqlite3 on PATH.
# USAGE: scripts/reliability-demo.sh [burst_count] [hold_seconds]
#        defaults: burst_count=3, hold_seconds=25
set -euo pipefail

BURST="${1:-3}"
HOLD_SECONDS="${2:-25}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AUTOMATION="$REPO_ROOT/workers/automation"

for tool in temporal uv python3 sqlite3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FATAL: '$tool' not found on PATH." >&2; exit 2; }
done

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }

# Isolated, canonicalised workspace (macOS resolves /tmp -> /private/tmp; the
# worker heartbeat compares resolved paths, so canonicalise up front).
WORKDIR="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/jobctl-reliability-demo.XXXXXX")" && pwd -P)"
export JOBCTL_DIR="$WORKDIR/home"
mkdir -p "$JOBCTL_DIR"

# Draw two distinct ephemeral ports; never collide with the standard local
# stack (Temporal 7233 / UI 8233, API 8766, web 5173).
TEMPORAL_PORT="$(free_port)"
TEMPORAL_UI_PORT="$(free_port)"
while [[ "$TEMPORAL_UI_PORT" == "$TEMPORAL_PORT" ]]; do TEMPORAL_UI_PORT="$(free_port)"; done
for reserved in 7233 8233 8766 5173; do
  if [[ "$TEMPORAL_PORT" == "$reserved" || "$TEMPORAL_UI_PORT" == "$reserved" ]]; then
    echo "FATAL: drew a reserved port ($reserved); re-run." >&2; exit 2
  fi
done
export TEMPORAL_ADDRESS="127.0.0.1:$TEMPORAL_PORT"
export JOBCTL_SKIP_BROWSER_PREFLIGHT=1   # the probe needs no browser
export PLAYWRIGHT_SKIP_BROWSER_GC=1         # never GC other worktrees' browsers
export LANGFUSE_DISABLE=1                   # no telemetry leaves the machine

DB_PATH="$JOBCTL_DIR/jobctl.db"
TAG="$(date +%s)-$$"

TEMPORAL_PID=""; WORKER_PID=""

# Kill a PID and every descendant, collecting children BEFORE the parent dies
# (so reparented grandchildren are still reachable). `uv run` spawns the real
# Python worker as a child, so killing only the `uv` wrapper would orphan a live
# worker — this reaps the whole tree.
kill_tree() {
  local pid="$1" sig="${2:-TERM}" child
  [[ -z "${pid:-}" ]] && return 0
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child" "$sig"; done
  kill "-$sig" "$pid" 2>/dev/null || true
}

cleanup() {
  echo "--- cleanup: killing only captured process trees ---"
  kill_tree "$WORKER_PID" KILL
  kill_tree "$TEMPORAL_PID" KILL
  wait 2>/dev/null || true
  rm -rf "$WORKDIR" 2>/dev/null || true
  echo "--- cleanup done ---"
}
trap cleanup EXIT INT TERM

jh_python() { uv --project "$AUTOMATION" run python "$@"; }

# Resolve the task queue from the code so the demo never drifts from the worker.
TASK_QUEUE="$(jh_python -c 'from jobctl.infrastructure.temporal.task_queues import JOBCTL_TASK_QUEUE; print(JOBCTL_TASK_QUEUE)')"

tctl() { temporal --address "$TEMPORAL_ADDRESS" "$@"; }

# --- JSON helpers (parse `temporal ... -o json`; robust to enum prefixes) ----
wf_status() {
  tctl workflow describe -o json --workflow-id "$1" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
info = d.get("workflowExecutionInfo", d)
status = str(info.get("status", ""))
print(status.replace("WORKFLOW_EXECUTION_STATUS_", "").upper())
'
}
wf_runid() {
  tctl workflow describe -o json --workflow-id "$1" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
info = d.get("workflowExecutionInfo", d)
print(info.get("execution", {}).get("runId", ""))
'
}
wf_count() {  # $1 = visibility query
  tctl workflow count -o json --query "$1" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print(0); sys.exit(0)
print(int(d.get("count", 0) or 0))
'
}

fail() { echo "DEMO FAIL — $*" >&2; exit 1; }

echo "=== Isolated durable-execution reliability demo ==="
echo "workspace:        $JOBCTL_DIR"
echo "temporal address: $TEMPORAL_ADDRESS  (ui: 127.0.0.1:$TEMPORAL_UI_PORT)"
echo "task queue:       $TASK_QUEUE"
echo "burst:            $BURST probe workflow(s), hold ${HOLD_SECONDS}s each"

echo "--- 1/8 start isolated Temporal dev server ---"
temporal server start-dev \
  --port "$TEMPORAL_PORT" --ui-port "$TEMPORAL_UI_PORT" \
  --db-filename "$WORKDIR/temporal.db" --log-level error &
TEMPORAL_PID=$!
disown "$TEMPORAL_PID" 2>/dev/null || true   # we reap it via kill_tree, not job control
temporal_up=0
for _ in $(seq 1 30); do
  tctl operator namespace list >/dev/null 2>&1 && { temporal_up=1; break; }
  sleep 1
done
[[ "$temporal_up" -eq 1 ]] || fail "Temporal dev server did not become ready."

echo "--- 2/8 start worker A (init_db runs on bootstrap; no interactive wizard) ---"
uv --project "$AUTOMATION" run jobctl worker >"$WORKDIR/worker-a.log" 2>&1 &
WORKER_PID=$!
disown "$WORKER_PID" 2>/dev/null || true   # suppress job-control "Killed" noise on crash
worker_up=0
for _ in $(seq 1 60); do
  grep -q "running on task queue" "$WORKDIR/worker-a.log" 2>/dev/null && { worker_up=1; break; }
  kill -0 "$WORKER_PID" 2>/dev/null || break
  sleep 1
done
[[ "$worker_up" -eq 1 ]] || { echo "--- worker-a.log ---"; cat "$WORKDIR/worker-a.log"; fail "worker A did not start."; }

echo "--- 3/8 start a burst of $BURST durable-timer probe workflows ---"
declare -a WF_IDS=()
for i in $(seq 1 "$BURST"); do
  wf_id="durability-probe-local-${TAG}-${i}"
  WF_IDS+=("$wf_id")
  tctl workflow start \
    --task-queue "$TASK_QUEUE" --type DurabilityProbeWorkflow \
    --workflow-id "$wf_id" \
    --input "{\"tenant_id\":\"local\",\"hold_seconds\":${HOLD_SECONDS},\"expected_app_dir\":null,\"expected_db_path\":null}" \
    >/dev/null
done

echo "--- 4/8 confirm every run is in flight (Running) + capture its run id ---"
declare -a RUN_IDS=()
sleep 2
for wf_id in "${WF_IDS[@]}"; do
  status="$(wf_status "$wf_id")"
  run_id="$(wf_runid "$wf_id")"
  echo "    $wf_id  status=$status  run=$run_id"
  [[ "$status" == "RUNNING" ]] || fail "$wf_id was $status before the kill (not in flight). Increase hold_seconds (arg 2, currently ${HOLD_SECONDS})."
  [[ -n "$run_id" ]] || fail "could not capture run id for $wf_id."
  RUN_IDS+=("$run_id")
done
running_now="$(wf_count 'WorkflowType="DurabilityProbeWorkflow" AND ExecutionStatus="Running"')"
[[ "$running_now" -eq "$BURST" ]] || fail "expected $BURST Running probes at kill time, saw $running_now."

echo "--- 5/8 CRASH worker A by its captured PID tree ($WORKER_PID) ---"
kill_tree "$WORKER_PID" KILL
WORKER_PID=""
sleep 3
if pgrep -f "$AUTOMATION/.venv/bin/jobctl worker" >/dev/null 2>&1; then
  fail "worker A process survived the kill."
fi

echo "--- 6/8 assert every run is STILL Running with NO worker (durably held) ---"
still_running="$(wf_count 'WorkflowType="DurabilityProbeWorkflow" AND ExecutionStatus="Running"')"
echo "    Running with no worker: $still_running / $BURST"
[[ "$still_running" -eq "$BURST" ]] || fail "runs did not survive the worker crash ($still_running/$BURST Running)."
tctl workflow list --query 'ExecutionStatus="Running"' 2>/dev/null || true

echo "--- 7/8 start worker B — it must resume the in-flight runs from history ---"
uv --project "$AUTOMATION" run jobctl worker >"$WORKDIR/worker-b.log" 2>&1 &
WORKER_PID=$!
disown "$WORKER_PID" 2>/dev/null || true
for _ in $(seq 1 60); do
  grep -q "running on task queue" "$WORKDIR/worker-b.log" 2>/dev/null && break
  kill -0 "$WORKER_PID" 2>/dev/null || break
  sleep 1
done

echo "--- 8/8 wait for the SAME runs to reach Completed, then assert recovery ---"
deadline=$(( $(date +%s) + HOLD_SECONDS + 90 ))
for wf_id in "${WF_IDS[@]}"; do
  while :; do
    status="$(wf_status "$wf_id")"
    [[ "$status" == "COMPLETED" ]] && break
    case "$status" in FAILED|TERMINATED|TIMED_OUT|CANCELED) fail "$wf_id ended $status, not Completed." ;; esac
    [[ "$(date +%s)" -ge "$deadline" ]] && fail "$wf_id did not complete before the deadline (last status=$status)."
    sleep 2
  done
done

# Same-run-resumed: the terminal run id must equal the one captured before the
# kill (a worker crash resumes the run; it does not start a new one).
for idx in "${!WF_IDS[@]}"; do
  wf_id="${WF_IDS[$idx]}"
  before="${RUN_IDS[$idx]}"
  after="$(wf_runid "$wf_id")"
  [[ "$after" == "$before" ]] || fail "$wf_id resumed as a DIFFERENT run ($before -> $after)."
done

# At-most-once, two independent ledgers: Temporal's own visibility count, and
# the product read-model projection (PK = workflow_id, so it cannot double-count).
completed_temporal="$(wf_count 'WorkflowType="DurabilityProbeWorkflow" AND ExecutionStatus="Completed"')"
completed_readmodel="$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM workflow_run_projections WHERE workflow_type='DurabilityProbeWorkflow' AND status='succeeded';" 2>/dev/null || echo 0)"
[[ "$completed_temporal" -eq "$BURST" ]] || fail "Temporal shows $completed_temporal Completed probes, expected $BURST."
[[ "$completed_readmodel" -eq "$BURST" ]] || fail "read model shows $completed_readmodel succeeded probes, expected $BURST."

echo
echo "final workflow states (Temporal):"
tctl workflow list --query 'WorkflowType="DurabilityProbeWorkflow"' 2>/dev/null || true
echo "runs as JobCtl's read model sees them:"
sqlite3 -header -column "$DB_PATH" \
  "SELECT workflow_id, status, temporal_run_id FROM workflow_run_projections
   WHERE workflow_type='DurabilityProbeWorkflow' ORDER BY workflow_id;" 2>/dev/null || true

echo
echo "DEMO PASS — $BURST run(s) were in flight at the crash, survived with no"
echo "worker running, and the SAME run ids resumed to Completed exactly once"
echo "(verified in both Temporal and the read-model projection)."
