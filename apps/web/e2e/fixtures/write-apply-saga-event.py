"""Write a synthetic saga checkpoint through the production Apply repository."""

import os
import sys
from pathlib import Path

db_path = Path(sys.argv[1]).resolve(strict=True)
job_id, run_id, count = sys.argv[2], sys.argv[3], int(sys.argv[4])
workspace = Path(os.environ["JOBCTRL_E2E_APP_DIR"]).resolve(strict=True)
expected_db = Path(os.environ["JOBCTRL_E2E_DB_PATH"]).resolve(strict=True)
if db_path != expected_db or workspace not in db_path.parents or not (workspace / ".jobctrl-e2e-owned.json").is_file():
    raise RuntimeError("Apply fixture requires the owned E2E workspace")
if count not in (1, 2) or not run_id.startswith("qa-"):
    raise ValueError("Invalid synthetic Apply fixture")

import jobctrl.apply.launcher as launcher
from jobctrl.database import close_connection, get_connection
from jobctrl.domain.apply.aggregate import ApplyRun
from jobctrl.domain.apply.value_objects import ApplyRunId
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT

launcher.get_connection = lambda: get_connection(db_path)
run = ApplyRun.start(tenant_id=LOCAL_TENANT, run_id=ApplyRunId(run_id), job_id=JobId(job_id),
                     started_at="2026-05-04T12:00:00Z", dry_run=True)
for event_type, message, occurred_at in (
    ("SagaStarted", "Missed synthetic Apply event", "2026-05-04T12:00:01Z"),
    ("BrowserLaunched", "Live synthetic Apply event", "2026-05-04T12:00:02Z"),
)[:count]:
    run = run.record_event(event_type=event_type, message=message, occurred_at=occurred_at,
                           payload={"private_synthetic_canary": "not-in-summary"})
try:
    launcher.SqliteApplyRunRepository().save(run)
finally:
    close_connection(db_path)
