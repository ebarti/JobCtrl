"""SQLite checkpoint adapter for explicit preparation recipes."""

from __future__ import annotations

import json
from contextlib import nullcontext

from jobctrl.app.errors import AppError, ConflictError, NotFoundError
from jobctrl.app.events import now

SCHEMA = """
CREATE TABLE preparation_runs (
 run_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, targets_json TEXT,
 status TEXT NOT NULL, parent_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX preparation_runs_updated ON preparation_runs(updated_at);
CREATE TABLE preparation_steps (
 run_id TEXT NOT NULL, job_id TEXT NOT NULL, stage TEXT NOT NULL,
 status TEXT NOT NULL, input_json TEXT, result_json TEXT, error_code TEXT,
 updated_at TEXT NOT NULL, PRIMARY KEY(run_id,job_id,stage),
 FOREIGN KEY(run_id) REFERENCES preparation_runs(run_id) ON DELETE CASCADE
);
CREATE TABLE preparation_job_claims (
 job_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, created_at TEXT NOT NULL
);
"""


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


class PreparationStore:
    def __init__(self, database, events):
        self.database, self.events = database, events

    def claim_job(self, run_id, job_id, owner_reclaimable):
        with self.database.transaction() as conn:
            row = conn.execute("SELECT run_id FROM preparation_job_claims WHERE job_id=?", (job_id,)).fetchone()
            if row and row[0] != run_id:
                if not owner_reclaimable(row[0]):
                    raise AppError("preparation_job_busy", "Another preparation owns this job.", 409)
                conn.execute("DELETE FROM preparation_job_claims WHERE job_id=? AND run_id=?", (job_id, row[0]))
            conn.execute("INSERT OR IGNORE INTO preparation_job_claims VALUES(?,?,?)", (job_id, run_id, now()))
    def release_job(self, run_id, job_id):
        with self.database.transaction() as conn:
            conn.execute("DELETE FROM preparation_job_claims WHERE job_id=? AND run_id=?", (job_id, run_id))


    def _event(self, conn, run_id, status, *, job_id=None, stage=None):
        payload = {"runId": run_id, "status": status}
        if job_id is not None:
            payload["jobId"] = job_id
        if stage is not None:
            payload["stage"] = stage
        level = "error" if status == "failed" else "warn" if status in {"partial", "cancelled", "warning", "blocked"} else "info"
        self.events.append(conn, "PreparationUpdated", payload, feature="preparation", aggregate_id=run_id,
                           level=level, stage=stage)


    def open_run(self, run_id, request, parent=None):
        with self.database.transaction() as conn:
            row = conn.execute("SELECT * FROM preparation_runs WHERE run_id=?", (run_id,)).fetchone()
            if row:
                if row["request_json"] != _json(request) or row["parent_run_id"] != parent:
                    raise ConflictError("The preparation identity belongs to different input.")
                return
            stamp = now()
            conn.execute("INSERT INTO preparation_runs VALUES(?,?,?,?,?,?,?)",
                         (run_id, _json(request), None, "running", parent, stamp, stamp))
            self._event(conn, run_id, "running")


    def set_status(self, run_id, status):
        with self.database.transaction() as conn:
            conn.execute("UPDATE preparation_runs SET status=?,updated_at=? WHERE run_id=?", (status, now(), run_id))
            self._event(conn, run_id, status)

    def finalize_run(self, run_id, status, error_code, connection):
        """Seal interrupted preparation in the action owner's transaction."""
        if status not in {"failed", "cancelled"}:
            return
        changed = connection.execute(
            "UPDATE preparation_runs SET status=?,updated_at=? WHERE run_id=? AND status='running'",
            (status, now(), run_id),
        ).rowcount
        if not changed:
            return
        steps = connection.execute(
            "SELECT job_id,stage FROM preparation_steps WHERE run_id=? AND status IN ('pending','running')", (run_id,),
        ).fetchall()
        for step in steps:
            connection.execute(
                "UPDATE preparation_steps SET status=?,error_code=?,updated_at=? WHERE run_id=? AND job_id=? AND stage=?",
                (status, error_code, now(), run_id, step["job_id"], step["stage"]),
            )
            self._event(connection, run_id, status, job_id=step["job_id"] or None, stage=step["stage"])
        connection.execute("DELETE FROM preparation_job_claims WHERE run_id=?", (run_id,))
        self._event(connection, run_id, status)


    def step(self, run_id, job_id, stage):
        with self.database.connect() as conn:
            row = conn.execute("SELECT * FROM preparation_steps WHERE run_id=? AND job_id=? AND stage=?",
                               (run_id, job_id, stage)).fetchone()
        if not row:
            return None
        return {"jobId": row["job_id"] or None, "stage": row["stage"], "status": row["status"],
                "input": json.loads(row["input_json"]) if row["input_json"] else None,
                "result": json.loads(row["result_json"]) if row["result_json"] else None,
                "errorCode": row["error_code"], "updatedAt": row["updated_at"]}


    def start_step(self, run_id, job_id, stage, inputs):
        with self.database.transaction() as conn:
            row = conn.execute("SELECT input_json FROM preparation_steps WHERE run_id=? AND job_id=? AND stage=?",
                               (run_id, job_id, stage)).fetchone()
            if row:
                if row["input_json"] is None:
                    conn.execute("UPDATE preparation_steps SET input_json=?,status='running',updated_at=? WHERE run_id=? AND job_id=? AND stage=?",
                                 (_json(inputs), now(), run_id, job_id, stage))
                    saved = inputs
                else:
                    saved = json.loads(row["input_json"])
                    conn.execute("UPDATE preparation_steps SET status='running',updated_at=? WHERE run_id=? AND job_id=? AND stage=?",
                                 (now(), run_id, job_id, stage))
            else:
                saved = inputs
                conn.execute("INSERT INTO preparation_steps VALUES(?,?,?,?,?,?,?,?)",
                             (run_id, job_id, stage, "running", _json(inputs), None, None, now()))
            self._event(conn, run_id, "running", job_id=job_id or None, stage=stage)
            return saved


    def finish_step(self, run_id, job_id, stage, status, *, result=None, error_code=None):
        with self.database.transaction() as conn:
            conn.execute("INSERT INTO preparation_steps VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id,job_id,stage) "
                         "DO UPDATE SET status=excluded.status,result_json=excluded.result_json,error_code=excluded.error_code,updated_at=excluded.updated_at",
                         (run_id, job_id, stage, status, None, _json(result) if result is not None else None, error_code, now()))
            self._event(conn, run_id, status, job_id=job_id or None, stage=stage)


    def get_run(self, run_id):
        with self.database.connect() as conn:
            row = conn.execute("SELECT * FROM preparation_runs WHERE run_id=?", (run_id,)).fetchone()
            if row is None:
                raise NotFoundError("The preparation run does not exist.")
            steps = conn.execute("SELECT * FROM preparation_steps WHERE run_id=? ORDER BY rowid", (run_id,)).fetchall()
        return {"runId": run_id, "status": row["status"], "recipe": json.loads(row["request_json"])["recipe"],
                "scope": json.loads(row["request_json"])["scope"], "cohortFrozen": row["targets_json"] is not None,
                "parentRunId": row["parent_run_id"], "jobIds": json.loads(row["targets_json"]) if row["targets_json"] else [],
                "createdAt": row["created_at"], "updatedAt": row["updated_at"],
                "steps": [{"jobId": step["job_id"] or None, "stage": step["stage"], "status": step["status"],
                           "result": json.loads(step["result_json"]) if step["result_json"] else None,
                           "errorCode": step["error_code"], "updatedAt": step["updated_at"]} for step in steps]}


    def list_runs(self, limit=100):
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise AppError("invalid_pagination", "Use a limit from 1 to 1,000.")
        with self.database.connect() as conn:
            ids = [row[0] for row in conn.execute("SELECT run_id FROM preparation_runs ORDER BY created_at DESC LIMIT ?", (limit,))]
        return {"runs": [self.get_run(run_id) for run_id in ids]}

    def _telemetry(self, *, run_id=None, limit=100):
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise AppError("invalid_pagination", "Use a limit from 1 to 1,000.")
        with self.database.connect() as conn:
            conn.execute("BEGIN")
            rows = conn.execute(
                "SELECT run_id,status,parent_run_id,created_at,updated_at,targets_json,"
                "json_extract(request_json,'$.recipe') recipe,json_extract(request_json,'$.scope') scope "
                "FROM preparation_runs WHERE (? IS NULL OR run_id=?) ORDER BY created_at DESC,run_id DESC LIMIT ?",
                (run_id, run_id, limit),
            ).fetchall()
            ids = [row["run_id"] for row in rows]
            steps = conn.execute(
                "SELECT run_id,job_id,stage,status,error_code,updated_at FROM preparation_steps "
                "WHERE run_id IN (SELECT value FROM json_each(?)) ORDER BY rowid", (_json(ids),),
            ).fetchall() if ids else []
        grouped = {identifier: [] for identifier in ids}
        for step in steps:
            grouped[step["run_id"]].append({"jobId": step["job_id"] or None, "stage": step["stage"],
                                             "status": step["status"], "errorCode": step["error_code"],
                                             "updatedAt": step["updated_at"]})
        return [{"runId": row["run_id"], "status": row["status"], "recipe": row["recipe"], "scope": row["scope"],
                 "cohortFrozen": row["targets_json"] is not None, "parentRunId": row["parent_run_id"],
                 "jobIds": json.loads(row["targets_json"]) if row["targets_json"] else [],
                 "createdAt": row["created_at"], "updatedAt": row["updated_at"], "steps": grouped[row["run_id"]]}
                for row in rows]

    def telemetry_runs(self, limit=100):
        return {"runs": self._telemetry(limit=limit)}

    def telemetry_run(self, run_id):
        rows = self._telemetry(run_id=run_id, limit=1)
        if not rows:
            raise NotFoundError("The preparation run does not exist.")
        return rows[0]


    def job_summaries(self, job_ids, connection=None):
        """Return recorded preparation outcomes for a bounded job selection."""
        if not isinstance(job_ids, (list, tuple)) or len(job_ids) > 1000 or any(
            not isinstance(job_id, str) or not job_id or len(job_id) > 120 for job_id in job_ids
        ):
            raise AppError("invalid_job_selection", "Select up to 1,000 saved jobs.")
        ids = list(dict.fromkeys(job_ids))
        result = {job_id: {"stage": None, "state": "unknown", "updated_at": None,
                           "run_id": None, "recipe": None, "error_code": None} for job_id in ids}
        if not ids:
            return result
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            rows = conn.execute(
                "WITH wanted AS (SELECT value AS job_id FROM json_each(?)), ranked AS ("
                " SELECT s.job_id,s.stage,s.status,s.updated_at,s.run_id,s.error_code,r.request_json,"
                " row_number() OVER (PARTITION BY s.job_id ORDER BY s.updated_at DESC,s.rowid DESC) AS position"
                " FROM preparation_steps s JOIN wanted w ON w.job_id=s.job_id"
                " JOIN preparation_runs r ON r.run_id=s.run_id) SELECT * FROM ranked WHERE position=1",
                (_json(ids),),
            ).fetchall()
        for row in rows:
            result[row["job_id"]] = {"stage": row["stage"], "state": row["status"],
                                      "updated_at": row["updated_at"], "run_id": row["run_id"],
                                      "recipe": json.loads(row["request_json"])["recipe"],
                                      "error_code": row["error_code"]}
        return result


    def request(self, run_id):
        with self.database.connect() as conn:
            row = conn.execute("SELECT request_json FROM preparation_runs WHERE run_id=?", (run_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def targets(self, run_id):
        with self.database.connect() as conn:
            row = conn.execute("SELECT targets_json FROM preparation_runs WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            raise NotFoundError("The preparation run does not exist.")
        return json.loads(row[0]) if row[0] is not None else None

    def save_targets(self, run_id, ids):
        with self.database.transaction() as conn:
            conn.execute("UPDATE preparation_runs SET targets_json=?,updated_at=? WHERE run_id=? AND targets_json IS NULL", (_json(ids), now(), run_id))
            saved = conn.execute("SELECT targets_json FROM preparation_runs WHERE run_id=?", (run_id,)).fetchone()[0]
        return json.loads(saved)

    def inherit_retry_steps(self, run_id, parent, job_ids):
        with self.database.transaction() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO preparation_steps "
                "SELECT ?,job_id,stage,status,input_json,result_json,error_code,? FROM preparation_steps "
                "WHERE run_id=? AND job_id='' AND stage='discover' AND status='succeeded'",
                (run_id, now(), parent),
            )
            for job_id in job_ids:
                conn.execute(
                    "INSERT OR IGNORE INTO preparation_steps "
                    "SELECT ?,job_id,stage,status,input_json,result_json,error_code,? FROM preparation_steps "
                    "WHERE run_id=? AND job_id=? AND status IN ('succeeded','skipped','warning')",
                    (run_id, now(), parent, job_id),
                )
                # A cancelled stage may already have a committed feature result.
                # Preserve its original operation identity and frozen inputs.
                conn.execute(
                    "INSERT OR IGNORE INTO preparation_steps "
                    "SELECT ?,job_id,stage,'pending',input_json,NULL,NULL,? FROM preparation_steps "
                    "WHERE run_id=? AND job_id=? AND status='cancelled' AND input_json IS NOT NULL",
                    (run_id, now(), parent, job_id),
                )
