"""Atomic initial-cohort authority and model-free per-job score checkpoints."""

import json

from jobctrl.app.errors import AppError, ConflictError

from .contract import qualification_key
from .serialization import encoded
from .sources import FrozenFitProfileSnapshot, fact_sources, qualification_fingerprint

SCHEMA = """
CREATE TABLE fit_initial_cohort_operations (
 operation_id TEXT PRIMARY KEY, input_fingerprint TEXT NOT NULL, state_json TEXT NOT NULL
);
"""
COHORT_VERSION = "fit-initial-cohort-v1"


class InitialCohortStorage:
    def initial_cohort_operation(self, operation_id, input_fingerprint=None, connection=None):
        if connection is None:
            with self._database.connect() as connection:
                return self.initial_cohort_operation(operation_id, input_fingerprint, connection)
        row = connection.execute("SELECT * FROM fit_initial_cohort_operations WHERE operation_id=?", (operation_id,)).fetchone()
        if row is None:
            return None
        if input_fingerprint is not None and row["input_fingerprint"] != input_fingerprint:
            raise ConflictError("The initial Fit cohort identity belongs to different input.")
        state = json.loads(row["state_json"])
        if state.get("status") == "source_deleted":
            raise ConflictError("A source in this frozen Fit operation was permanently deleted.")
        return state

    def _write_initial_cohort(self, connection, state):
        connection.execute("UPDATE fit_initial_cohort_operations SET state_json=? WHERE operation_id=?",
                           (encoded(state), state["operation_id"]))
        return state

    def _assert_initial_cohort(self, connection, state):
        if state["cohort_version"] != COHORT_VERSION:
            raise AppError("fit_cohort_contract_changed", "The saved initial Fit cohort uses another contract.", 409)
        snapshot = FrozenFitProfileSnapshot(state["profile"], state["guidance"], manual_refresh=False)
        self._assert_profile(connection, snapshot, full_profile=True)
        facts = fact_sources(state["profile"])
        for job in state["jobs"]:
            self.requirements.assert_current(job["requirements"], connection=connection)
            expected = state["published_jobs"].get(job["job_id"], {}).get("revision", job["score_revision"])
            self._assert_score(connection, job["job_id"], expected)
        for row in state["requirements"]:
            key = qualification_key(row)
            published = state.get("accepted_assessment_ids", {}).get(key) if key in state["missing_keys"] else None
            current = self.latest_assessment(state["profile"]["profile_id"], row["requirement_id"], row["requirement_revision"],
                source_fingerprint=qualification_fingerprint(state["profile"], row, facts), connection=connection)
            if (current["assessment_id"] if current else None) != (published or state["current_heads"][key]):
                raise ConflictError("A cohort qualification changed during inference.")
            previous = self.latest_requirement_assessment(state["profile"]["profile_id"], row["requirement_id"],
                connection=connection, demand_fingerprint=row.get("demand_fingerprint"))
            if (previous["assessment_id"] if previous else None) != (published or state["prior_heads"][key]):
                raise ConflictError("A historical cohort qualification changed during inference.")
        return snapshot

    def validate_initial_cohort(self, state):
        with self._database.connect() as connection:
            self._assert_initial_cohort(connection, state)

    def start_initial_cohort(self, state):
        with self._database.transaction() as connection:
            prior = self.initial_cohort_operation(state["operation_id"], state["input_fingerprint"], connection)
            if prior is not None:
                return prior
            self._assert_initial_cohort(connection, state)
            connection.execute("INSERT INTO fit_initial_cohort_operations VALUES (?,?,?)",
                (state["operation_id"], state["input_fingerprint"], encoded(state)))
            return state

    def reserve_initial_cohort_call(self, operation_id, arguments_fingerprint, selection, execution_identity, input_fingerprint, *, connection):
        state = self.initial_cohort_operation(operation_id, connection=connection)
        self._assert_initial_cohort(connection, state)
        if state.get("call") is not None:
            raise AppError("fit_cohort_interrupted", "The initial cohort already has a retained model attempt.", 409)
        state["call"] = {"status": "started", "arguments_fingerprint": arguments_fingerprint,
                         "selection": selection, "execution": execution_identity, "input_fingerprint": input_fingerprint}
        self._write_initial_cohort(connection, state)

    def complete_initial_cohort_call(self, operation_id, result):
        with self._database.transaction() as connection:
            state = self.initial_cohort_operation(operation_id, connection=connection)
            # Retain actual raw authority even if a concurrent source change will
            # subsequently refuse publication; never lose a settled receipt.
            call = state["call"]
            if (call["input_fingerprint"] != result["provenance"]["input_fingerprint"]
                    or call["status"] == "completed" and call["result"] != result):
                raise ConflictError("The cohort already retained a different model result.")
            call.update(status="completed", result=result)
            self._write_initial_cohort(connection, state)

    def publish_initial_cohort(self, operation_id, candidates, facts, *, cancelled=lambda: False):
        with self._database.transaction() as connection:
            state = self.initial_cohort_operation(operation_id, connection=connection)
            self._check_cancelled(cancelled)
            self._assert_initial_cohort(connection, state)
            if state["status"] == "qualified":
                return state
            keys = [qualification_key(row) for row in candidates]
            if len(keys) != len(set(keys)) or set(keys) != set(state["missing_keys"]):
                raise AppError("fit_qualification_partition_invalid", "The cohort batch must cover every missing binding.", 422)
            accepted = dict(state["reused_assessment_ids"])
            for row in candidates:
                self._check_cancelled(cancelled)
                self.save_assessment(connection, row, facts)
                accepted[qualification_key(row)] = row["assessment_id"]
            state.update(status="qualified", accepted_assessment_ids=accepted)
            self._check_cancelled(cancelled)
            return self._write_initial_cohort(connection, state)

    def publish_initial_cohort_score(self, state_id, candidate, expected_revision, operation_id, input_fingerprint, *, cancelled=lambda: False):
        with self._database.transaction() as connection:
            state = self.initial_cohort_operation(state_id, connection=connection)
            self._check_cancelled(cancelled)
            self._assert_initial_cohort(connection, state)
            job = next(row for row in state["jobs"] if row["job_id"] == candidate["job_id"])
            if state["status"] != "qualified" or expected_revision != job["score_revision"]:
                raise ConflictError("The initial cohort score inputs changed.")
            prior = state["published_jobs"].get(candidate["job_id"])
            if prior is not None:
                if prior["operation_id"] != operation_id or prior["input_fingerprint"] != input_fingerprint:
                    raise ConflictError("The cohort score identity belongs to different publication.")
                return self.latest_score(candidate["job_id"], connection)
            previous = self._assert_score(connection, candidate["job_id"], expected_revision)
            for row in candidate["assessments"]:
                self._assert_assessment(connection, row)
            if previous is not None:
                # Only a captured already-current score may be retained; no
                # post-edit qualification permission is created by this path.
                if previous["source_binding"] != candidate["source_binding"]:
                    raise ConflictError("An existing cohort score requires an explicit manual refresh.")
                accepted = previous
            else:
                self.save_score(connection, candidate, expected_revision=0)
                self._event(connection, "FitAssessed", {"jobId": candidate["job_id"], "revision": candidate["revision"],
                            "profileId": state["profile"]["profile_id"]}, candidate["job_id"])
                accepted = candidate
            state["published_jobs"][candidate["job_id"]] = {"revision": accepted["revision"],
                "operation_id": operation_id, "input_fingerprint": input_fingerprint}
            self._check_cancelled(cancelled)
            self._write_initial_cohort(connection, state)
            return accepted
