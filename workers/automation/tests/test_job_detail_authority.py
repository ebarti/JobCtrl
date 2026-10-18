"""Python preserves API-owned detail while CLI/workflow projections stay useful."""

import json

from jobctrl.database import close_connection, init_db
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder


JOB = "00000000-0000-4000-8000-000000000101"


def test_python_refresh_does_not_read_or_write_detail_and_uses_canonical_funnel(tmp_path):
    path = tmp_path / "owned.db"
    conn = init_db(path)
    try:
        conn.execute("INSERT INTO jobs (tenant_id,job_id,url,title) VALUES ('local',?,'https://example.invalid/job','Owned')", (JOB,))
        conn.execute("INSERT INTO job_stage_states (tenant_id,job_id,stage,state,updated_at) VALUES ('local',?,'enrich','failed','2026-10-17')", (JOB,))
        conn.execute("INSERT INTO job_detail_projections (tenant_id,job_id,description_preview,stages_json) VALUES ('local',?,'accepted detail','[]')", (JOB,))
        before = tuple(conn.execute("SELECT * FROM job_detail_projections").fetchone())
        for operation in ("INSERT", "UPDATE", "DELETE"):
            conn.execute(f"CREATE TEMP TRIGGER deny_detail_{operation} BEFORE {operation} ON job_detail_projections "
                         "BEGIN SELECT RAISE(ABORT, 'foreign detail writer'); END")
        conn.commit()
        statements = []
        conn.set_trace_callback(statements.append)
        ProjectionBuilder(conn_factory=lambda: conn).refresh()
        conn.set_trace_callback(None)
        assert not any("job_detail_projections" in statement for statement in statements)
        assert tuple(conn.execute("SELECT * FROM job_detail_projections").fetchone()) == before
        funnel = json.loads(conn.execute("SELECT funnel_json FROM dashboard_projections").fetchone()[0])
        assert next(stage for stage in funnel if stage["stage"] == "enrich")["failed"] == 1
    finally:
        close_connection(path)
