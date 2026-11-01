"""Owned worker-to-API fixture; fake process/Gmail transports, real Apply writes.

This fixture generates synthetic runtime choices, not recorded model output.
The API supplies its own temporary directory; no default user state is opened.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
os.environ["JOBCTRL_DIR"] = str(root / "sandbox")
os.environ["LANGFUSE_DISABLE"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from tests.test_apply_regressions import _owned_email_probe, _private_stream_agent_factory, _email_counts  # noqa: E402
from jobctrl import config  # noqa: E402
from jobctrl.apply import launcher  # noqa: E402
from jobctrl.database import close_connection  # noqa: E402
from jobctrl.state import record_job_event  # noqa: E402

config.ensure_dirs()
with pytest.MonkeyPatch.context() as monkeypatch:
    factory, canary, preflights, spends = _private_stream_agent_factory(root, monkeypatch)
    db_path, conn, job_id, ctx, calls, repo, execute, attachment = _owned_email_probe(
        root, monkeypatch, body=b"{}", live_bus=True, agent_factory=factory)
    try:
        execute()
        launcher.mark_result(job_id, "applied", run_ctx=ctx)
        counts = _email_counts(conn, job_id)
        assert len(calls) == counts["ApplySubmitIntended"] == 1
        assert counts["EmailApplicationSent"] == counts["ApplicationSubmitted"] == 0
        assert preflights == ["apply"] and len(spends) == 1
        conn.execute("UPDATE job_stage_states SET error_message=? WHERE job_id=? AND stage='apply'",
                     ("Apply reached the submit-intent checkpoint, but the external outcome is ambiguous: email_send_outcome_ambiguous:" + canary, job_id))
        # Immutable historical producer shape, independent of current sender output.
        record_job_event(conn, job_id, "apply", "ApplicationFailed", payload={
            "run_id": "historical-email-run", "result": "needs_verification",
            "reason": "email_send_outcome_ambiguous:" + canary,
        }, message=canary)
        conn.commit()
        execute.assert_preserved()
        print(json.dumps({"dbPath": str(db_path), "jobId": str(job_id), "runId": ctx["run_id"],
            "canary": canary, "httpCalls": len(calls), "intent": counts["ApplySubmitIntended"],
            "confirmation": counts["EmailApplicationSent"], "submitted": counts["ApplicationSubmitted"]}))
    finally:
        close_connection(db_path)
