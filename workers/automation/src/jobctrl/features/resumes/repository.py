"""SQLite aggregate adapter and committed invalidations for the Resumes owner."""

from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timezone
import json
import os
from uuid import uuid4

from .domain import ResumeError, canonical


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def artifact_authority(artifact):
    return {key: artifact[key] for key in ("artifact_id", "path", "filename", "sha256", "size_bytes",
                                         "file_identity", "root_identity", "resume_id", "revision_id") if key in artifact}


def state_artifacts(state):
    artifacts = [artifact for revision in state["revisions"] for artifact in revision["renders"]]
    artifacts.extend(row["pdf"] for row in state["acceptances"])
    artifacts.extend(artifact for locale in state["locales"] for artifact in locale["renders"])
    return {artifact["artifact_id"]: artifact for artifact in artifacts}


class SqliteResumeRepository:
    def __init__(self, runtime):
        self.runtime = runtime

    def get(self, resume_id, *, connection=None):
        with nullcontext(connection) if connection is not None else self.runtime.database.connect() as conn:
            row = conn.execute("SELECT state_json FROM resumes_documents WHERE resume_id = ?", (resume_id,)).fetchone()
            if row is None:
                raise ResumeError("resume_not_found")
            return json.loads(row["state_json"])

    def list(self, *, job_id=None, connection=None):
        with nullcontext(connection) if connection is not None else self.runtime.database.connect() as conn:
            if job_id is None:
                rows = conn.execute("SELECT state_json FROM resumes_documents ORDER BY updated_at, resume_id").fetchall()
            else:
                rows = conn.execute("SELECT state_json FROM resumes_documents WHERE job_id = ? ORDER BY updated_at, resume_id",
                                    (job_id,)).fetchall()
            return [json.loads(row["state_json"]) for row in rows]

    def list_for_jobs(self, job_ids, connection=None):
        if not job_ids:
            return []
        if len(job_ids) > 1000:
            raise ResumeError("resume_job_query_too_large")
        with nullcontext(connection) if connection is not None else self.runtime.database.connect() as conn:
            markers = ",".join("?" for _ in job_ids)
            return [json.loads(row["state_json"]) for row in conn.execute(
                f"SELECT state_json FROM resumes_documents WHERE job_id IN ({markers}) ORDER BY updated_at,resume_id", job_ids)]

    def record_composition_failure(self, *, job_id, profile_id, code, details, resume_id=None, expected_version=None):
        if resume_id is not None:
            def mutate(state, conn):
                state.setdefault("composition_attempts", []).append({"status": "failed", "failure_code": code,
                                                                     "details": details, "created_at": now()})
            return self.change(resume_id, expected_version, mutate, event="ResumeCompositionFailed")
        with self.runtime.database.transaction() as conn:
            self.runtime.events.append(conn, "ResumeCompositionFailed", {"jobId": job_id, "profileId": profile_id,
                                       "failureCode": code, "resource": (details or {}).get("resource")},
                                       feature="resumes", aggregate_id=job_id)
        return None

    def operation_result(self, operation, *, connection=None):
        if operation is None:
            return None
        with nullcontext(connection) if connection is not None else self.runtime.database.connect() as conn:
            row = conn.execute("SELECT input_hash,result_json FROM resumes_operation_receipts WHERE operation_id = ?",
                               (operation["operation_id"],)).fetchone()
            if row is None:
                return None
            if row["input_hash"] != operation["input_hash"]:
                raise ResumeError("resume_operation_input_conflict")
            return json.loads(row["result_json"])

    @staticmethod
    def _receipt(conn, operation, state):
        if operation is not None:
            conn.execute("INSERT INTO resumes_operation_receipts(operation_id,input_hash,result_json) VALUES(?,?,?)",
                         (operation["operation_id"], operation["input_hash"], canonical(state)))

    def create(self, state, *, fence, event, operation=None):
        with self.runtime.database.transaction() as conn:
            previous = self.operation_result(operation, connection=conn)
            if previous is not None:
                return previous
            fence(conn)
            conn.execute("INSERT INTO resumes_documents(resume_id,job_id,version,state_json,updated_at) VALUES(?,?,?,?,?)",
                         (state["resume_id"], state["job_id"], state["version"], canonical(state), now()))
            self._register_files(conn, state)
            self._event(conn, state, event)
            self._receipt(conn, operation, state)
        return state

    def change(self, resume_id, expected_version, mutate, *, event, operation=None):
        if type(expected_version) is not int or expected_version < 1:
            raise ResumeError("expected_version_required")
        with self.runtime.database.transaction() as conn:
            previous = self.operation_result(operation, connection=conn)
            if previous is not None:
                return previous
            state = self.get(resume_id, connection=conn)
            if state["version"] != expected_version:
                raise ResumeError("resume_version_conflict")
            mutate(state, conn)
            state["version"] += 1
            state["updated_at"] = now()
            count = conn.execute(
                "UPDATE resumes_documents SET state_json = ?,version = ?,updated_at = ? WHERE resume_id = ? AND version = ?",
                (canonical(state), state["version"], state["updated_at"], resume_id, expected_version),
            ).rowcount
            if count != 1:
                raise ResumeError("resume_version_conflict")
            self._register_files(conn, state)
            self._event(conn, state, event)
            self._receipt(conn, operation, state)
        return state

    def _event(self, conn, state, event):
        self.runtime.events.append(conn, event, {"resumeId": state["resume_id"], "jobId": state["job_id"],
                                               "version": state["version"]},
                                   feature="resumes", aggregate_id=state["resume_id"])

    def record_file_intent(self, artifact, binding):
        """Durable inode ownership before any PDF bytes are written."""
        with self.runtime.database.transaction() as conn:
            state = self.get(binding["resume_id"], connection=conn)
            authority = artifact_authority({**artifact, "resume_id": binding["resume_id"], "revision_id": binding["revision_id"]})
            conn.execute("INSERT INTO resumes_artifact_retirements "
                         "(artifact_id,job_id,artifact_json,status,reason,owner_pid,created_at,updated_at) "
                         "VALUES(?,?,?,'rendering','render_intent',?,?,?)",
                         (authority["artifact_id"], state["job_id"], canonical(authority), os.getpid(), now(), now()))

    def _register_files(self, conn, state):
        for artifact in state_artifacts(state).values():
            previous = conn.execute("SELECT artifact_json,status FROM resumes_artifact_retirements WHERE artifact_id=?",
                                    (artifact["artifact_id"],)).fetchone()
            authority = canonical(artifact_authority(artifact))
            if previous is not None and previous["artifact_json"] != authority:
                raise ResumeError("resume_artifact_registration_conflict")
            if previous is not None and previous["status"] not in {"rendering", "registered"}:
                raise ResumeError("resume_artifact_retirement_conflict")
            conn.execute("INSERT INTO resumes_artifact_retirements "
                         "(artifact_id,job_id,artifact_json,status,reason,created_at,updated_at) "
                         "VALUES(?,?,?,'registered','registered_render',?,?) "
                         "ON CONFLICT(artifact_id) DO UPDATE SET status='registered',reason='registered_render',owner_pid=NULL,updated_at=excluded.updated_at",
                         (artifact["artifact_id"], state["job_id"], authority, now(), now()))

    def abandon_file_intent(self, artifact_id):
        with self.runtime.database.transaction() as conn:
            conn.execute("UPDATE resumes_artifact_retirements SET status='pending',reason='unpublished_render',"
                         "owner_pid=NULL,updated_at=? WHERE artifact_id=? AND status='rendering'", (now(), artifact_id))

    def orphan_job_ids(self):
        with self.runtime.database.connect() as conn:
            rows = conn.execute("SELECT artifact_id,job_id,owner_pid,status FROM resumes_artifact_retirements "
                                "WHERE status IN ('rendering','pending','retiring') ORDER BY created_at LIMIT 100").fetchall()
        jobs = []
        for row in rows:
            if row["status"] == "pending":
                jobs.append(row["job_id"])
                continue
            if type(row["owner_pid"]) is not int or row["owner_pid"] <= 0:
                continue
            try:
                os.kill(row["owner_pid"], 0)
            except ProcessLookupError:
                self.abandon_file_intent(row["artifact_id"])
                jobs.append(row["job_id"])
            except PermissionError:
                pass
        return list(dict.fromkeys(jobs))

    def templates(self, connection=None):
        with nullcontext(connection) if connection is not None else self.runtime.database.connect() as conn:
            return [json.loads(row["state_json"]) for row in conn.execute(
                "SELECT state_json FROM resumes_templates ORDER BY template_id").fetchall()]

    def template_preference(self, connection=None):
        with nullcontext(connection) if connection is not None else self.runtime.database.connect() as conn:
            row = conn.execute("SELECT state_json FROM resumes_template_preferences WHERE singleton = 1").fetchone()
            return json.loads(row["state_json"]) if row else None

    def set_template_preference(self, preference, *, expected_revision=None, expected_active_version_id=None):
        with self.runtime.database.transaction() as conn:
            if expected_active_version_id is not None:
                template = conn.execute("SELECT state_json FROM resumes_templates WHERE template_id = ?",
                                        (preference["template_id"],)).fetchone()
                active_id = json.loads(template["state_json"])["version_id"] if template else (
                    "built_in:modern-html:v1" if preference["template_id"] == "built_in:modern-html" else None)
                if active_id != expected_active_version_id:
                    raise ResumeError("resume_template_version_conflict")
            row = conn.execute("SELECT revision FROM resumes_template_preferences WHERE singleton = 1").fetchone()
            if expected_revision is not None and (row["revision"] if row else 0) != expected_revision:
                raise ResumeError("resume_template_version_conflict")
            revision = (row["revision"] if row else 0) + 1
            preference = {**preference, "preference_revision": revision}
            conn.execute("INSERT INTO resumes_template_preferences(singleton,revision,state_json) VALUES(1,?,?) "
                         "ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json",
                         (revision, canonical(preference)))
            self.runtime.events.append(conn, "ResumeTemplateUpdated", {"preferenceRevision": revision},
                                       feature="resumes", aggregate_id="default")
            return preference

    def delete_job_data(self, job_id, connection=None):
        with nullcontext(connection) if connection is not None else self.runtime.database.transaction() as conn:
            for state in self.list(job_id=job_id, connection=conn):
                for artifact in state_artifacts(state).values():
                    previous = conn.execute("SELECT artifact_json FROM resumes_artifact_retirements WHERE artifact_id=?",
                                            (artifact["artifact_id"],)).fetchone()
                    encoded = canonical(artifact_authority(artifact))
                    if previous is not None and previous["artifact_json"] != encoded:
                        raise ResumeError("resume_retirement_identity_conflict")
                    conn.execute("INSERT INTO resumes_artifact_retirements "
                                 "(artifact_id,job_id,artifact_json,status,reason,created_at,updated_at) VALUES(?,?,?,'pending','job_deleted',?,?) "
                                 "ON CONFLICT(artifact_id) DO UPDATE SET status='pending',reason='job_deleted',owner_pid=NULL,updated_at=excluded.updated_at",
                                 (artifact["artifact_id"], job_id, encoded, now(), now()))
            conn.execute("DELETE FROM resumes_operation_receipts WHERE json_extract(result_json,'$.job_id') = ?", (job_id,))
            for state in self.list(job_id=job_id, connection=conn):
                self._event(conn, state, "ResumeDeleted")
            conn.execute("DELETE FROM resumes_documents WHERE job_id = ?", (job_id,))

    def retirement_candidates(self, job_ids):
        if not job_ids:
            return []
        with self.runtime.database.connect() as conn:
            markers = ",".join("?" for _ in job_ids)
            return [dict(row) for row in conn.execute(
                f"SELECT artifact_id FROM resumes_artifact_retirements WHERE job_id IN ({markers}) AND status IN ('pending','retiring') "
                "ORDER BY created_at,artifact_id LIMIT 100", job_ids)]

    def claim_retirement(self, artifact_id):
        with self.runtime.database.transaction() as conn:
            row = conn.execute("SELECT * FROM resumes_artifact_retirements WHERE artifact_id=?", (artifact_id,)).fetchone()
            if row is None or row["status"] in {"complete", "registered", "rendering"}:
                return None
            # JSON authority is owned here. An exact registered reference is a
            # refusal even if a damaged journal was incorrectly labelled pending.
            for state in self.list(job_id=row["job_id"], connection=conn):
                if artifact_id in state_artifacts(state):
                    return None
            if row["status"] == "retiring" and row["owner_pid"]:
                try:
                    os.kill(row["owner_pid"], 0)
                    return None  # Liveness only refuses a peer; it never grants file authority.
                except PermissionError:
                    return None
                except ProcessLookupError:
                    pass
            claim_name = row["claim_name"] or f".retired-{artifact_id}-{uuid4().hex}.pdf"
            conn.execute("UPDATE resumes_artifact_retirements SET status='retiring',claim_name=?,owner_pid=?,"
                         "failure_code=NULL,updated_at=? WHERE artifact_id=?", (claim_name, os.getpid(), now(), artifact_id))
            return {"artifact": json.loads(row["artifact_json"]), "claim_name": claim_name,
                    "allow_partial": row["reason"] == "unpublished_render"}

    def finish_retirement(self, artifact_id, *, failure_code=None):
        with self.runtime.database.transaction() as conn:
            conn.execute("UPDATE resumes_artifact_retirements SET status=?,owner_pid=NULL,failure_code=?,updated_at=? "
                         "WHERE artifact_id=?", ("pending" if failure_code else "complete", failure_code, now(), artifact_id))
            self.runtime.events.append(conn, "ResumeArtifactRetirementUpdated", {"artifactId": artifact_id,
                                       "status": "pending" if failure_code else "complete", "failureCode": failure_code},
                                       feature="resumes", aggregate_id=artifact_id)

    def retirement_summary(self, job_ids):
        if not job_ids:
            return {"pending": 0, "complete": 0}
        with self.runtime.database.connect() as conn:
            markers = ",".join("?" for _ in job_ids)
            rows = conn.execute(f"SELECT status,count(*) AS n FROM resumes_artifact_retirements WHERE job_id IN ({markers}) "
                                "GROUP BY status", job_ids).fetchall()
            return {"pending": sum(row["n"] for row in rows if row["status"] not in {"complete", "registered"}),
                    "complete": sum(row["n"] for row in rows if row["status"] == "complete")}

    def save_template(self, template_id, expected_version, theme, layout, display_name):
        with self.runtime.database.transaction() as conn:
            row = conn.execute("SELECT version,state_json FROM resumes_templates WHERE template_id = ?", (template_id,)).fetchone()
            if (row is None and expected_version not in (None, 0)) or (
                row is not None and row["version"] != expected_version
            ):
                raise ResumeError("resume_template_version_conflict")
            version = (row["version"] if row else 0) + 1
            previous = json.loads(row["state_json"]) if row else None
            history = previous.get("versions", []) if previous else []
            version_id = f"{template_id}:v{version}"
            version_row = {"version_id": version_id, "version": version, "theme": theme, "layout": layout,
                           "display_name": display_name, "created_at": now()}
            state = {"template_id": template_id, "version": version, "theme": theme, "layout": layout,
                     "display_name": display_name, "updated_at": now(), "version_id": version_id,
                     "created_at": previous["created_at"] if previous else now(),
                     "versions": [*history, version_row]}
            conn.execute("INSERT INTO resumes_templates(template_id,version,state_json) VALUES(?,?,?) "
                         "ON CONFLICT(template_id) DO UPDATE SET version=excluded.version,state_json=excluded.state_json",
                         (template_id, version, canonical(state)))
            self.runtime.events.append(conn, "ResumeTemplateUpdated", {"templateId": template_id, "version": version},
                                       feature="resumes", aggregate_id=template_id)
            return state
