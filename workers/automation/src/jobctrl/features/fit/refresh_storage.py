"""Atomic persistence for an explicit, immutable-scope Fit refresh."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from jobctrl.app.errors import AppError, ConflictError, NotFoundError

from .qualification import now
from .serialization import encoded
from .contract import CONTRACT_VERSION, qualification_key, require_contract
from .models import QUALIFICATION_PROMPT_VERSION, QUALIFICATION_SEMANTICS_VERSION
from .sources import FrozenFitProfileSnapshot, approved_fingerprint, dto, fact_fingerprint, fingerprint


class RefreshStorage:
    def latest_requirement_assessment(self, profile_id, requirement_id, connection=None, *, demand_fingerprint):
        def load(conn):
            row = conn.execute(
                "SELECT assessment_json FROM fit_assessments WHERE profile_id=? AND requirement_id=?"
                " AND json_extract(assessment_json,'$.demand_fingerprint') IS ? ORDER BY rowid DESC LIMIT 1",
                (profile_id, requirement_id, demand_fingerprint),
            ).fetchone()
            return json.loads(row[0]) if row else None
        return self._read(load, connection)

    def refresh_operation(self, operation_id, connection=None):
        def load(conn):
            row = conn.execute("SELECT state_json FROM fit_refresh_operations WHERE operation_id=?", (operation_id,)).fetchone()
            return json.loads(row[0]) if row else None
        return self._read(load, connection)

    def latest_refresh(self, profile_id, connection=None):
        def load(conn):
            row = conn.execute(
                "SELECT state_json FROM fit_refresh_operations WHERE profile_id=? ORDER BY rowid DESC LIMIT 1", (profile_id,),
            ).fetchone()
            return json.loads(row[0]) if row else None
        return self._read(load, connection)

    def completed_refresh(self, profile_id, connection=None):
        def load(conn):
            row = conn.execute(
                "SELECT state_json FROM fit_refresh_operations WHERE profile_id=? AND status='completed'"
                " AND json_extract(state_json,'$.contract_version')=?"
                " AND json_extract(state_json,'$.qualification_semantics_version')=?"
                " AND json_extract(state_json,'$.qualification_prompt_version')=? ORDER BY rowid DESC LIMIT 1",
                (profile_id, CONTRACT_VERSION, QUALIFICATION_SEMANTICS_VERSION, QUALIFICATION_PROMPT_VERSION),
            ).fetchone()
            return json.loads(row[0]) if row else None
        return self._read(load, connection)

    def _write_refresh(self, connection, state):
        state["updated_at"] = now()
        connection.execute(
            "UPDATE fit_refresh_operations SET status=?,state_json=?,updated_at=? WHERE operation_id=?",
            (state["status"], encoded(state), state["updated_at"], state["operation_id"]),
        )
        self._event(connection, "FitRefreshUpdated", {
            "operationId": state["operation_id"], "profileId": state["profile_id"],
            "status": state["status"], "phase": state["phase"],
        }, state["profile_id"])
        return state

    def _running_refresh(self, connection, operation_id):
        state = self.refresh_operation(operation_id, connection)
        if state is None:
            raise NotFoundError("The manual Fit refresh was not found.")
        require_contract(state)
        if state["status"] != "running":
            raise AppError(state.get("failure_code") or "fit_refresh_terminal", "This manual Fit refresh is already terminal.", 409)
        if datetime.now(timezone.utc) >= datetime.fromisoformat(state["deadline_at"]):
            raise AppError("fit_refresh_time_limit", "The manual Fit refresh reached its fixed deadline.", 409)
        return state

    def _assert_refresh_inputs(self, connection, state):
        require_contract(state)
        if (state.get("qualification_semantics_version") != QUALIFICATION_SEMANTICS_VERSION
                or state.get("qualification_prompt_version") != QUALIFICATION_PROMPT_VERSION):
            raise AppError("fit_refresh_stale", "The qualification contract changed. Start a new manual refresh.", 409)
        snapshot = FrozenFitProfileSnapshot(state["snapshot"]["profile"], state["snapshot"]["guidance"])
        self._assert_profile(connection, snapshot, full_profile=True)
        self.requirements.assert_current_catalog(state["snapshot"]["catalog"], connection=connection)
        self.requirements.assert_current_demand_catalog(state["snapshot"]["demand_catalog"], connection=connection)
        expected_wordings = state.get("accepted_wordings_fingerprint", state["snapshot"].get("current_wordings_fingerprint"))
        if (expected_wordings is not None
                and self.current_wordings_fingerprint(state["profile_id"], connection=connection) != expected_wordings):
            raise ConflictError("The maintained wording assignments changed during the manual Fit refresh.")
        for job in state["snapshot"]["jobs"]:
            self.requirements.assert_current(job["requirements"], connection=connection)
            current = self.latest_score(job["job_id"], connection)
            expected = state.get("accepted_score_revisions", {}).get(job["job_id"], job["score_revision"])
            if (current["revision"] if current else 0) != expected:
                raise ConflictError("A selected job's accepted Fit score changed during the manual refresh.")
        for expected in state["snapshot"].get("retry_proposals", []):
            current = self.profile.get_authoring_proposal(expected["proposal_id"], state["profile_id"],
                                                          connection=connection, include_brief=True)
            if current != expected:
                raise ConflictError("A selected failed wording proposal changed during the manual retry.")
        accepted = state.get("accepted_assessment_ids", {})
        requirements = {qualification_key(row): row for row in
                        state["snapshot"]["demand_catalog"]["demands"] + state["snapshot"]["direct_requirements"]}
        for ident, before in state["snapshot"]["prior_assessments"].items():
            requirement = requirements[ident]
            current = self.latest_requirement_assessment(state["profile_id"], requirement["requirement_id"], connection,
                                                          demand_fingerprint=requirement.get("demand_fingerprint"))
            expected = accepted.get(ident, before["assessment_id"] if before else None)
            if (current["assessment_id"] if current else None) != expected:
                raise ConflictError("A catalog qualification changed during the manual refresh.")

    def start_refresh(self, state):
        require_contract(state)
        with self._database.transaction() as connection:
            previous = self.refresh_operation(state["operation_id"], connection)
            if previous is not None:
                require_contract(previous)
                if previous["input_fingerprint"] != state["input_fingerprint"]:
                    raise ConflictError("This manual Fit refresh belongs to different input.")
                return previous
            active = connection.execute(
                "SELECT operation_id FROM fit_refresh_operations WHERE profile_id=? AND status='running'", (state["profile_id"],),
            ).fetchone()
            if active:
                raise AppError("fit_refresh_busy", "A manual Fit refresh for this Profile is already active.", 409,
                               {"operationId": active[0]})
            self._assert_refresh_inputs(connection, state)
            connection.execute("INSERT INTO fit_refresh_operations VALUES(?,?,?,?,?,?,?)", (
                state["operation_id"], state["profile_id"], state["input_fingerprint"], state["status"],
                encoded(state), state["created_at"], state["updated_at"],
            ))
            return self._write_refresh(connection, state)

    def validate_refresh(self, operation_id):
        with self._database.connect() as connection:
            connection.execute("BEGIN")
            state = self._running_refresh(connection, operation_id)
            self._assert_refresh_inputs(connection, state)
            return state

    def update_refresh(self, operation_id, changes):
        with self._database.transaction() as connection:
            state = self._running_refresh(connection, operation_id)
            state.update(changes)
            return self._write_refresh(connection, state)

    def checkpoint_refresh(self, operation_id, key, value):
        with self._database.transaction() as connection:
            state = self._running_refresh(connection, operation_id)
            existing = state["checkpoints"].get(key)
            if existing is not None:
                return existing
            state["checkpoints"][key] = value
            if key.startswith("qualification:"):
                state["counters"]["requirements_assessed"] = sum(name.startswith("qualification:") for name in state["checkpoints"])
            self._write_refresh(connection, state)
            return value

    def unpublished_qualification_calls(self, state, key, expected):
        # A completed historical call already has a gateway pin in its raw result.
        # A started historical call has only an argument key and an operation lifetime.
        call = '$.calls."' + key + '"'
        pin = "COALESCE(json_extract(state_json,?),json_extract(state_json,?))"
        with self._database.connect() as connection:
            rows = connection.execute(
                "SELECT created_at,updated_at,(status='stale' AND json_extract(state_json,'$.failure_code')='revision_conflict' "
                "AND json_extract(state_json,'$.phase') IN ('qualification','publication')) eligible, "
                + pin + " receipt_id," + pin + " gateway_input FROM fit_refresh_operations "
                "WHERE profile_id=? AND status IN ('stale','failed','limited','cancelled') AND json_extract(state_json,'$.factual_published')=0 "
                "AND json_extract(state_json,'$.job_ids')=? AND json_extract(state_json,'$.contract_version')=? "
                "AND json_extract(state_json,'$.qualification_semantics_version')=? "
                "AND json_extract(state_json,'$.qualification_prompt_version')=? "
                "AND json_extract(state_json,?)='fit.qualification-batch' AND (gateway_input IS NULL OR gateway_input=?)",
                (call + ".receipt_id", call + ".result.provenance.receipt_id", call + ".input_fingerprint",
                 call + ".result.provenance.input_fingerprint", state["profile_id"], encoded(state["job_ids"]),
                 state["contract_version"], state["qualification_semantics_version"], state["qualification_prompt_version"],
                 call + ".kind", expected),
            ).fetchall()
        return [dict(row) for row in rows]

    def adopt_refresh_qualification(self, operation_id, key, authority, lookup):
        with self._database.transaction() as connection:
            state = self._running_refresh(connection, operation_id)
            self._assert_refresh_inputs(connection, state)
            if key in state["calls"]:
                raise ConflictError("Another worker already claimed this qualification.")
            raw = lookup(connection)
            if raw is None:
                return None
            state["calls"][key] = {**authority, "kind": "fit.qualification-batch", "status": "completed",
                "receipt_id": raw["provenance"]["receipt_id"], "origin": "reused_settled_receipt", "result": raw}
            state["counters"]["qualification_receipts_reused"] = 1
            self._write_refresh(connection, state)
            return raw

    def reserve_refresh_call(self, operation_id, key, kind, *, authority=None, connection=None):
        if connection is None:
            with self._database.transaction() as owned:
                return self.reserve_refresh_call(operation_id, key, kind, authority=authority, connection=owned)
        state = self._running_refresh(connection, operation_id)
        if authority is not None:
            self._assert_refresh_inputs(connection, state)
        prior = state["calls"].get(key)
        if prior is not None:
            if authority is None and prior["status"] == "completed":
                return prior["result"]
            raise AppError("fit_refresh_interrupted", "A previous model call already owns this determination.", 409)
        if state["counters"]["model_calls"] >= state["limits"]["max_model_calls"]:
            raise AppError("fit_refresh_model_limit", "The manual Fit refresh reached its model-call limit.", 409)
        state["counters"]["model_calls"] += 1
        state["calls"][key] = {"status": "started", "kind": kind, **(authority or {})}
        self._write_refresh(connection, state)
        return None

    def pin_refresh_qualification_transport(self, operation_id, version, expected_calls_fingerprint):
        with self._database.transaction() as connection:
            state = self._running_refresh(connection, operation_id)
            if (fingerprint(state["calls"]) != expected_calls_fingerprint
                    or state.get("qualification_transport_version") not in {None, version}):
                raise ConflictError("The retained qualification request changed before transport admission.")
            state["qualification_transport_version"] = version
            self._write_refresh(connection, state)

    def complete_refresh_call(self, operation_id, key, result):
        with self._database.transaction() as connection:
            state = self._running_refresh(connection, operation_id)
            state["calls"][key] = {**state["calls"][key], "status": "completed", "result": result}
            self._write_refresh(connection, state)

    def reserve_refresh_wording(self, operation_id, achievement_id):
        with self._database.transaction() as connection:
            state = self._running_refresh(connection, operation_id)
            if achievement_id in state["wording_achievements"]:
                return
            if state["counters"]["wording_proposals"] >= state["limits"]["max_wording_proposals"]:
                raise AppError("fit_refresh_wording_limit", "The manual Fit refresh reached its wording-proposal limit.", 409)
            state["wording_achievements"].append(achievement_id)
            state["counters"]["wording_proposals"] += 1
            self._write_refresh(connection, state)

    def publish_refresh(self, operation_id, candidates, scores, *, cancelled=lambda: False):
        with self._database.transaction() as connection:
            state = self._running_refresh(connection, operation_id)
            self._check_cancelled(cancelled)
            self._assert_refresh_inputs(connection, state)
            if state.get("factual_published"):
                return state
            facts = state["snapshot"]["facts"]
            for record in candidates.values():
                self.save_assessment(connection, record, facts)
            revisions = {job["job_id"]: job["score_revision"] for job in state["snapshot"]["jobs"]}
            for score in scores:
                self.save_score(connection, score, expected_revision=score["revision"] - 1)
                revisions[score["job_id"]] = score["revision"]
                self._event(connection, "FitAssessed", {"jobId": score["job_id"], "revision": score["revision"],
                            "profileId": state["profile_id"]}, score["job_id"])
            state.update({"factual_published": True,
                          "accepted_assessment_ids": {ident: row["assessment_id"] for ident, row in candidates.items()},
                          "accepted_score_revisions": revisions, "phase": "coverage"})
            self._check_cancelled(cancelled)
            return self._write_refresh(connection, state)

    def finish_refresh(self, operation_id, status, failure_code=None, *, connection=None):
        if connection is None:
            with self._database.transaction() as owned:
                return self.finish_refresh(operation_id, status, failure_code, connection=owned)
        state = self.refresh_operation(operation_id, connection)
        if state is None or state["status"] != "running":
            return state
        state["status"] = status
        state["failure_code"] = failure_code
        if status == "completed":
            state["phase"] = "complete"
        return self._write_refresh(connection, state)

    def wording_group_decision(self, group_key, connection=None):
        def load(conn):
            row = conn.execute("SELECT decision_json FROM fit_wording_group_decisions WHERE group_key=?", (group_key,)).fetchone()
            return json.loads(row[0]) if row else None
        return self._read(load, connection)

    def publish_wording_group_decision(self, record, profile_snapshot, requirements_snapshot, assessments, *, cancelled=lambda: False):
        require_contract(record)
        with self._database.transaction() as connection:
            self._check_cancelled(cancelled)
            self._assert_sources(connection, profile_snapshot, requirements_snapshot, full_profile=True)
            for assessment in assessments:
                self._assert_assessment(connection, assessment)
            previous = self.wording_group_decision(record["group_key"], connection)
            if previous is not None:
                require_contract(previous)
                return previous
            connection.execute("INSERT INTO fit_wording_group_decisions VALUES(?,?)", (record["group_key"], encoded(record)))
            return record

    def _assert_frozen_profile(self, connection, snapshot):
        with self.read_snapshot(connection) as read:
            current = dto(read.profile_snapshot(snapshot.profile_id))
        frozen = dto(snapshot)
        if (fact_fingerprint(current) != fact_fingerprint(frozen)
                or approved_fingerprint(current) != approved_fingerprint(frozen)):
            raise ConflictError("Saved Profile facts or approved wording changed during the manual Fit refresh.")
