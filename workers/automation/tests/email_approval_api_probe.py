"""Cross-runtime probe used by the API test with an owned synthetic database.

External ports are fakes; no browser, model, or mail transport is started.
"""
import json
import socket
import sqlite3
import sys
from pathlib import Path

from jobctrl import browser_capabilities
from jobctrl.apply import launcher
from jobctrl.database import get_connection
from jobctrl.domain.apply import EmailOnlyApplication
from jobctrl.domain.apply.process_manager import _build_email_application_candidate, _candidate_payload
from jobctrl.domain.apply.use_cases import _email_application_context
from jobctrl.domain.ports.apply import AgentResult, BrowserSession, EmailApplicationSendResult
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.state import record_job_event

from tests.availability_fixture import seed_fresh_availability


def main():
    phase, db_path, job_id = sys.argv[1:4]
    conn = get_connection(db_path)
    snapshot = ProfileSnapshot.from_profile(Profile.from_dict(
        LOCAL_TENANT, {
            "personal": {"full_name": "Synthetic Élodie"},
            "resume": {"experience_entries": [{"id": "synthetic", "title": "Engineer", "company": "ExampleCo"}]},
        },
    ), version=7)
    if phase == "prepare":
        conn.execute("UPDATE job_enrichments SET full_description=? WHERE tenant_id=? AND job_id=?",
                     ("Apply to synthetic@example.com", LOCAL_TENANT, job_id))
        columns, joins = launcher._apply_candidate_select_parts()
        job = dict(conn.execute(f"SELECT {columns} FROM jobs {joins} WHERE jobs.job_id=?", (job_id,)).fetchone())
        candidate = _build_email_application_candidate("synthetic@example.com", _email_application_context(job, snapshot))
        record_job_event(conn, job_id, "apply", "EmailApplicationCandidateRecorded", payload=_candidate_payload(
            candidate, run_id="synthetic-review", duration_ms=0,
        ))
        conn.commit()
        print(json.dumps({"prepared": True}))
        return

    if phase != "run":
        raise ValueError("unknown synthetic phase")
    late_change = sys.argv[4]
    sends = []

    class Browser:
        def launch(self, config):
            return BrowserSession(config=config, pid=42)

        def cleanup(self, session):
            pass

    class Agent:
        def submit_application(self, **kwargs):
            if late_change == "defer":
                with sqlite3.connect(db_path) as writer:
                    writer.execute("UPDATE application_review_decisions SET decision='defer' WHERE job_id=?", (job_id,))
            return AgentResult(submission_result=EmailOnlyApplication(recipient_email="synthetic@example.com"), duration_ms=1)

    class Sender:
        def send_email_application(self, candidate, *, operation):
            with sqlite3.connect(db_path) as reader:
                assert reader.execute("SELECT count(*) FROM job_events WHERE event_type='ApplySubmitIntended'").fetchone()[0] == 1
            sends.append(candidate.attachment_bytes is not None)
            return EmailApplicationSendResult(provider="gmail", message_id="m1", thread_id="t1", operation=operation)

    import jobctrl.infrastructure.apply as adapters

    launcher.get_connection = lambda: get_connection(db_path)
    launcher.config.APPLY_WORKER_DIR = Path(db_path).parent / "workers"
    browser_capabilities.require_system_browser_capability = lambda _: Path("/synthetic/Chromium")
    adapters.LocalChromeAdapter = Browser
    adapters.ClaudeCodeCliAdapter = Agent
    adapters.GmailEmailApplicationSender = Sender
    socket.getaddrinfo = lambda *args, **kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))]
    seed_fresh_availability(conn, job_id)
    conn.commit()
    ctx = {"workflow_id": "synthetic-cross-runtime", "dry_run": False}
    job = launcher.acquire_job(target_job_id=job_id, worker_id=1, approval_required=True, run_ctx=ctx)
    if job is None:
        candidates = launcher._select_apply_candidates(conn, LOCAL_TENANT, job_id, 7)
        row = candidates[0] if candidates else None
        reason = launcher._approval_refusal_reason(
            conn, tenant_id=LOCAL_TENANT, job_id=job_id,
            materials_generation=row["materials_generation"],
            profile_version=launcher._current_profile_version(conn, tenant_id=LOCAL_TENANT),
            application_url=row["application_url"] or row["url"],
        ) if row else "no candidate"
        raise AssertionError(f"synthetic claim refused: candidate={bool(row)}, approval={reason}")
    result, _ = launcher.run_job(job, 9222, worker_id=1, snapshot=snapshot, run_ctx=ctx, tenant_id=LOCAL_TENANT)
    intents = conn.execute("SELECT count(*) FROM job_events WHERE event_type='ApplySubmitIntended'").fetchone()[0]
    print(json.dumps({"result": result.kind, "error": getattr(result, "error", None), "intents": intents, "sends": len(sends)}))


if __name__ == "__main__":
    main()
