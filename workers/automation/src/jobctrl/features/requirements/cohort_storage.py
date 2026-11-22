"""Requirements-owned durable staging; unpublished extraction is not acceptance."""

import json

from jobctrl.app.errors import ConflictError

from .domain import RequirementError, canonical_json, now

SCHEMA = """
CREATE TABLE requirements_cohort_operations (
 operation_id TEXT PRIMARY KEY, input_fingerprint TEXT NOT NULL, state_json TEXT NOT NULL
);
"""


class CohortStorage:
    def record_cohort_attempts(self, job_operations, state, failure_code, connection):
        if state == "running":
            # An explicit retry can inherit a completed extraction and resume
            # its original normalization without issuing another extraction.
            connection.executemany(
                "UPDATE requirements_attempts SET state='running',failure_code=NULL,completed_at=NULL "
                "WHERE job_id=? AND attempt_id=? AND state IN ('blocked','cancelled')", job_operations)
        elif state in {"blocked", "cancelled"}:
            stamp = now()
            connection.executemany(
                "UPDATE requirements_attempts SET state=?,failure_code=?,completed_at=? "
                "WHERE job_id=? AND attempt_id=? AND state='running'",
                ((state, failure_code, stamp, job_id, operation_id) for job_id, operation_id in job_operations))
        else:
            raise ValueError("Unknown cohort attempt state")

    def cohort_operation(self, operation_id, input_fingerprint=None, connection=None):
        if connection is None:
            with self.database.connect() as connection:
                return self.cohort_operation(operation_id, input_fingerprint, connection)
        row = connection.execute("SELECT * FROM requirements_cohort_operations WHERE operation_id=?", (operation_id,)).fetchone()
        if row is None:
            return None
        if input_fingerprint is not None and row["input_fingerprint"] != input_fingerprint:
            raise ConflictError("The Requirements cohort identity belongs to different input.")
        state = json.loads(row["state_json"])
        if state.get("status") == "source_deleted":
            raise ConflictError("A source in this frozen requirement operation was permanently deleted.")
        return state

    def start_cohort_operation(self, operation_id, input_fingerprint, state, guard):
        with self.database.transaction() as connection:
            saved = self.cohort_operation(operation_id, input_fingerprint, connection)
            if saved is not None:
                return saved
            guard(connection)
            connection.execute("INSERT INTO requirements_cohort_operations VALUES (?,?,?)",
                               (operation_id, input_fingerprint, canonical_json(state)))
            return state

    def update_cohort_operation(self, operation_id, changes, guard=None, connection=None):
        if connection is None:
            with self.database.transaction() as connection:
                return self.update_cohort_operation(operation_id, changes, guard, connection)
        if guard is not None:
            guard(connection)
        state = self.cohort_operation(operation_id, connection=connection)
        state.update(changes)
        connection.execute("UPDATE requirements_cohort_operations SET state_json=? WHERE operation_id=?",
                           (canonical_json(state), operation_id))
        return state

    def reserve_cohort_call(self, operation_id, model_fingerprint, request, guard, *, connection, normalization=False):
        guard(connection)
        state = self.cohort_operation(operation_id, connection=connection)
        if state.get("model_fingerprint") is not None:
            raise RequirementError("requirements_cohort_interrupted")
        state["model_fingerprint"] = model_fingerprint
        if request.get("input_fingerprint") != model_fingerprint:
            raise ConflictError("The cohort request does not match its retained call.")
        if normalization:
            self.reserve_normalization_call(operation_id, model_fingerprint, guard, connection=connection)
        state["model_request"] = request
        connection.execute("UPDATE requirements_cohort_operations SET state_json=? WHERE operation_id=?",
                           (canonical_json(state), operation_id))
        return 1
