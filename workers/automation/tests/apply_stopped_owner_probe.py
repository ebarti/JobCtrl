"""Owned crash fixture: claim in a real process, then exit without settlement."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

directory = Path(sys.argv[1]).resolve()
assert (directory / "owned-owner-probe").read_text() == "synthetic apply owner 1173"
os.environ["JOBCTRL_DIR"] = str(directory)
os.environ["LANGFUSE_DISABLE"] = "1"

from jobctrl import config, database  # noqa: E402
from jobctrl.apply import launcher  # noqa: E402
from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state  # noqa: E402

config.DB_PATH = database.DB_PATH = directory / "jobctrl.db"
mode = sys.argv[3]
assert mode in {"none", "intent", "api_none", "api_intent"}
if mode.startswith("api_"):
    assert not config.DB_PATH.exists()
    from tests.test_exact_v7_apply_acquire_job_identity import _insert_ready_job

    conn = database.init_db(config.DB_PATH)
    _insert_ready_job(conn, "local", sys.argv[2])
    ensure_job_stage_rows(conn, sys.argv[2])
    set_stage_state(conn, sys.argv[2], "score", "succeeded", validate_transition=False)
    conn.commit()
else:
    conn = database.get_connection(config.DB_PATH)
launcher.get_connection = lambda: conn
context = {"workflow_id": "owned-crashed-apply"}
job = launcher.acquire_job(target_job_id=sys.argv[2], approval_required=False, run_ctx=context)
assert job is not None
if mode in {"intent", "api_intent"}:
    record_job_event(conn, job["job_id"], "apply", "ApplySubmitIntended", payload={"run_id": context["run_id"]})
    conn.commit()
(directory / "owner-ready.json").write_text(json.dumps(context))
sys.stdin.readline()  # Parent commits Skip while this exact owner is alive.
os._exit(0)  # Deliberately bypass finally/atexit and local settlement.
