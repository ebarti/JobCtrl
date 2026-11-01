"""Fresh-interpreter regression probe, invoked only by the owned Skip fixture."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

path = Path(sys.argv[1]).resolve()
job_id = sys.argv[2]
assert path.name == "jobctrl.db"
assert (path.parent / "owned_skip_probe").read_text() == "synthetic #1173"
os.environ["JOBCTRL_DIR"] = str(path.parent)
os.environ["LANGFUSE_DISABLE"] = "1"

from jobctrl import config, database  # noqa: E402
from jobctrl.apply import launcher  # noqa: E402
from jobctrl.state import reset_job_stage  # noqa: E402

config.DB_PATH = database.DB_PATH = path
conn = database.get_connection(path)
intents = conn.execute(
    "SELECT payload_json FROM job_events WHERE tenant_id='local' AND job_id=? "
    "AND event_type='ApplySubmitIntended'", (job_id,),
).fetchall()
assert len(intents) == 1  # Never attempt a reset without this conservative stop.
before = conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0]
for target in [job_id, None]:
    assert launcher.acquire_job(target_job_id=target, approval_required=False) is None
try:
    reset_job_stage(conn, job_id, "apply", reset_attempts=True)
except ValueError as error:
    assert "intent" in str(error)
else:
    raise AssertionError("Restart authorized a blind retry")
assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == before
print(json.dumps({"job": job_id, "intent_runs": [json.loads(row[0])["run_id"] for row in intents],
                  "new_events": 0, "new_claims": 0, "new_sender_calls": 0, "reset": "refused",
                  "stage": dict(conn.execute("SELECT state,version,attempt_count FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='apply'", (job_id,)).fetchone())}))
database.close_connection(path)
