"""Small SQLite adapter for Fit's own accepted records."""

from __future__ import annotations

import json
import asyncio
from contextlib import contextmanager

from jobctrl.app.errors import AppError, ConflictError, NotFoundError

from .serialization import encoded
from .refresh_storage import RefreshStorage
from .association_storage import AssociationStorage
from .current_wording_storage import CurrentWordingStorage
from .cohort_storage import InitialCohortStorage
from .contract import CONTRACT_VERSION, current_contract, current_qualification, qualification_key, require_contract


class FitStore(RefreshStorage, AssociationStorage, CurrentWordingStorage, InitialCohortStorage):
    def __init__(self, database, events, profile, requirements, settings=None):
        if events is None or profile is None or requirements is None:
            raise RuntimeError("Fit requires committed events and public Profile/Requirements ports.")
        self._database = database
        self.events, self.profile, self.requirements, self.settings = events, profile, requirements, settings

    @contextmanager
    def read_snapshot(self, connection=None):
        if connection is not None:
            owns_scope = not connection.in_transaction
            if owns_scope:
                connection.execute("BEGIN")
            try:
                yield SqliteFitReadSession(self, connection)
            finally:
                if owns_scope:
                    connection.rollback()
            return
        with self._database.connect() as owned:
            owned.execute("BEGIN")
            try:
                yield SqliteFitReadSession(self, owned)
            finally:
                owned.rollback()

    def _assert_profile(self, connection, snapshot, *, full_profile=False):
        if getattr(snapshot, "manual_refresh", False):
            if getattr(snapshot, "refresh_operation_id", None):
                self._running_refresh(connection, snapshot.refresh_operation_id)
            self._assert_frozen_profile(connection, snapshot)
        else:
            self.profile.assert_current(snapshot, connection=connection, facts_only=not full_profile)
        guidance = self.settings.snapshot(connection).get("scoreCriteria", "") if self.settings is not None else ""
        if guidance != snapshot.scoring_guidance:
            raise ConflictError("The user scoring guidance changed during assessment.")

    def _assert_sources(self, connection, profile_snapshot, requirements_snapshot, *, full_profile=False):
        self._assert_profile(connection, profile_snapshot, full_profile=full_profile)
        if "demands" in requirements_snapshot and "snapshot_heads" in requirements_snapshot:
            self.requirements.assert_current_demand_catalog(requirements_snapshot, connection=connection)
        elif "meanings_fingerprint" in requirements_snapshot and "job_id" not in requirements_snapshot:
            self.requirements.assert_current_catalog(requirements_snapshot, connection=connection)
        else:
            self.requirements.assert_current(requirements_snapshot, connection=connection)

    def _assert_assessment(self, connection, assessment, *, expected_id=None):
        require_contract(assessment)
        if not current_qualification(assessment):
            raise ConflictError("The accepted qualification semantics changed. Start a manual Fit refresh.")
        latest = self.latest_assessment(
            assessment["profile_id"], assessment["requirement_id"], assessment["requirement_revision"],
            source_fingerprint=assessment["source_fingerprint"], connection=connection,
        )
        actual = latest["assessment_id"] if latest else None
        expected = expected_id if expected_id is not None else assessment["assessment_id"]
        if actual != expected:
            raise ConflictError("The accepted person qualification changed during inference.")
        if latest is not None and any(latest.get(key) != assessment.get(key) for key in (
                "demand_fingerprint", "definition", "capability_definition", "category",
                "qualification_semantics_version", "qualification_prompt_version")):
            raise ConflictError("The accepted qualification belongs to a different source demand.")
        return latest

    def _assert_score(self, connection, job_id, expected_revision):
        current = self.latest_score(job_id, connection)
        revision = current["revision"] if current else 0
        if revision != expected_revision:
            raise ConflictError("The saved Fit version has changed.", current_revision=revision)
        return current

    @staticmethod
    def _check_cancelled(cancelled):
        if cancelled():
            raise asyncio.CancelledError()

    def _event(self, connection, event_type, payload, aggregate_id):
        if self.events is None:
            raise RuntimeError("Fit publication requires its committed event adapter.")
        self.events.append(connection, event_type, payload, feature="fit", aggregate_id=aggregate_id)

    def publish_assessment(self, record, facts, profile_snapshot, requirements_snapshot,
                           expected_assessment_id, *, cancelled=lambda: False):
        return self.publish_assessments([record], facts, profile_snapshot, requirements_snapshot,
            {qualification_key(record): expected_assessment_id}, cancelled=cancelled)[0]

    def publish_assessments(self, records, facts, profile_snapshot, requirements_snapshot,
                            expected_assessment_ids, *, expected_prior_assessment_ids=None, initial_job_id=None,
                            cancelled=lambda: False):
        identifiers = [qualification_key(record) for record in records]
        if (len(identifiers) != len(set(identifiers)) or set(identifiers) != set(expected_assessment_ids)
                or expected_prior_assessment_ids is not None and set(identifiers) != set(expected_prior_assessment_ids)
                or initial_job_id is not None and (
                    requirements_snapshot.get("job_id") != initial_job_id or expected_prior_assessment_ids is None)):
            raise AppError("fit_qualification_partition_invalid", "The Fit publication requires one expected head for every candidate.", 422)
        with self._database.transaction() as connection:
            self._check_cancelled(cancelled)
            self._assert_sources(connection, profile_snapshot, requirements_snapshot)
            if initial_job_id is not None:
                self._assert_score(connection, initial_job_id, 0)
            for record in records:
                latest = self.latest_assessment(
                    record["profile_id"], record["requirement_id"], record["requirement_revision"],
                    source_fingerprint=record["source_fingerprint"], connection=connection,
                )
                key = qualification_key(record)
                if (latest["assessment_id"] if latest else None) != expected_assessment_ids[key]:
                    raise ConflictError("The accepted person qualification changed during inference.")
                if expected_prior_assessment_ids is not None:
                    previous = self.latest_requirement_assessment(record["profile_id"], record["requirement_id"],
                                                                  connection=connection, demand_fingerprint=record.get("demand_fingerprint"))
                    if (previous["assessment_id"] if previous else None) != expected_prior_assessment_ids[key]:
                        raise ConflictError("The historical person qualification changed during inference.")
            published = []
            for record in records:
                self._check_cancelled(cancelled)
                published.append(self.save_assessment(connection, record, facts))
            return published

    def publish_score(self, candidate, profile_snapshot, requirements_snapshot, expected_revision,
                      qualifications, reuse_if_unchanged, operation_id, input_fingerprint, *, cancelled=lambda: False):
        with self._database.transaction() as connection:
            self._check_cancelled(cancelled)
            self._assert_sources(connection, profile_snapshot, requirements_snapshot)
            previous = self._assert_score(connection, candidate["job_id"], expected_revision)
            for record in qualifications:
                self._assert_assessment(connection, record)
            source_binding = candidate["source_binding"]
            same_binding = current_contract(previous) and all(
                previous["source_binding"].get(key) == source_binding[key] for key in (
                    "profile_id", "source_fingerprint", "requirements_revision", "posting_revision",
                    "posting_hash", "assessment_ids", "requirements",
                )
            )
            if reuse_if_unchanged and same_binding:
                accepted = previous
            else:
                accepted = candidate
                self.save_score(connection, accepted, expected_revision=expected_revision)
                self._event(connection, "FitAssessed", {"jobId": accepted["job_id"], "revision": accepted["revision"],
                            "profileId": source_binding["profile_id"]}, accepted["job_id"])
            self.save_operation(connection, operation_id, input_fingerprint, {
                "contract_version": CONTRACT_VERSION,
                "job_id": accepted["job_id"], "score": accepted, "current": True, "stale_reasons": [], "coverage": None,
                "coverage_failure_code": "coverage_preparation_interrupted",
            })
            return accepted

    def publish_score_correction(self, corrected, anchor, expected_revision, operation_id, input_fingerprint):
        with self._database.transaction() as connection:
            previous = self._assert_score(connection, corrected["job_id"], expected_revision)
            if previous is None:
                raise NotFoundError("Assess this job before correcting its Fit score.")
            self.save_score(connection, corrected, expected_revision=expected_revision)
            self.save_anchor(connection, anchor)
            self._event(connection, "FitCorrected", {"jobId": corrected["job_id"], "revision": corrected["revision"],
                        "correctionId": anchor["correction_id"]}, corrected["job_id"])
            self.save_operation(connection, operation_id, input_fingerprint, {
                "contract_version": CONTRACT_VERSION,
                "job_id": corrected["job_id"], "score": corrected, "current": False, "stale_reasons": [], "coverage": None,
            })
            return corrected

    def publish_requirement_correction(self, record, facts, profile_snapshot, requirement_id,
                                       requirement_revision, expected_assessment_id):
        with self._database.transaction() as connection:
            self._assert_profile(connection, profile_snapshot)
            requirement = self.requirements.get_requirement(requirement_id, connection=connection)
            if str(requirement.get("requirement_revision") or requirement["revision"]) != str(requirement_revision):
                raise ConflictError("The canonical requirement has changed.")
            demands = self.requirements.demand_catalog_snapshot(connection=connection, active_only=True)
            if not any(qualification_key(row) == qualification_key(record)
                       and row["definition"] == record["definition"] for row in demands["demands"]):
                raise ConflictError("The corrected source demand changed before publication.")
            self._assert_assessment(connection, record, expected_id=expected_assessment_id)
            accepted = self.save_assessment(connection, record, facts)
            self._event(connection, "FitRequirementCorrected", {"requirementId": requirement_id,
                        "assessmentId": accepted["assessment_id"], "profileId": record["profile_id"]}, record["profile_id"])
            return accepted

    def publish_coverage(self, relation, profile_snapshot, requirements_snapshot, assessment, *, cancelled=lambda: False):
        with self._database.transaction() as connection:
            self._check_cancelled(cancelled)
            self._assert_sources(connection, profile_snapshot, requirements_snapshot, full_profile=True)
            self._assert_assessment(connection, assessment)
            self.save_coverage(connection, relation)
            self._event(connection, "FitCoverageUpdated", {"requirementId": relation["requirement_id"],
                        "variantId": relation["variant_id"], "relationId": relation["relation_id"]}, assessment["profile_id"])

    def publish_wording_request(self, binding, profile_snapshot, requirements_snapshot, assessment, *, cancelled=lambda: False):
        with self._database.transaction() as connection:
            self._check_cancelled(cancelled)
            self._assert_sources(connection, profile_snapshot, requirements_snapshot)
            for item in assessment if isinstance(assessment, list) else [assessment]:
                self._assert_assessment(connection, item)
            self.save_wording_request(connection, binding)

    def _read(self, callback, connection=None):
        if connection is not None:
            return callback(connection)
        with self._database.connect() as conn:
            return callback(conn)

    def assessment(self, assessment_id: str, connection=None) -> dict | None:
        def load(conn):
            row = conn.execute(
                "SELECT assessment_json FROM fit_assessments WHERE assessment_id=?", (assessment_id,),
            ).fetchone()
            return json.loads(row[0]) if row else None
        return self._read(load, connection)

    def latest_assessment(self, profile_id, requirement_id, requirement_revision, *, source_fingerprint=None,
                          connection=None) -> dict | None:
        def load(conn):
            # A bare canonical ID has several possible demand qualifications.
            # Historical reads use explicit assessment IDs, never a chosen head.
            if source_fingerprint is None:
                return None
            query = """SELECT assessment_json FROM fit_assessments
                       WHERE profile_id=? AND requirement_id=? AND requirement_revision=?
                       AND json_extract(assessment_json,'$.contract_version')=?"""
            values = [profile_id, requirement_id, str(requirement_revision), CONTRACT_VERSION]
            if source_fingerprint is not None:
                query += " AND source_fingerprint=?"
                values.append(source_fingerprint)
            row = conn.execute(query + " ORDER BY rowid DESC LIMIT 1", values).fetchone()
            return json.loads(row[0]) if row else None
        return self._read(load, connection)

    def assessment_sources(self, assessment_id, connection=None) -> list[dict]:
        def load(conn):
            row = conn.execute("SELECT sources_json FROM fit_assessments WHERE assessment_id=?",
                               (assessment_id,)).fetchone()
            return json.loads(row[0]) if row else []
        return self._read(load, connection)

    def coverage_relation(self, relation_id, connection=None):
        def load(conn):
            row = conn.execute("SELECT relation_json FROM fit_coverage_relations WHERE relation_id=?", (relation_id,)).fetchone()
            return json.loads(row[0]) if row else None
        return self._read(load, connection)

    def save_assessment(self, conn, record: dict, sources: list[dict]) -> dict:
        require_contract(record)
        if not current_qualification(record):
            raise ConflictError("The candidate qualification contract changed before publication.")
        previous = self.assessment(record["assessment_id"], conn)
        if previous is not None:
            if encoded(previous) != encoded(record):
                raise ConflictError("The accepted qualification receipt has changed.")
            return previous
        conn.execute(
            """INSERT INTO fit_assessments
            (assessment_id,profile_id,requirement_id,requirement_revision,fact_semantics_version,
             source_fingerprint,determination_id,origin,sources_json,assessment_json,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (record["assessment_id"], record["profile_id"], record["requirement_id"],
             str(record["requirement_revision"]), str(record["fact_semantics_version"]),
             record["source_fingerprint"], record["determination_id"], record["origin"],
             encoded(sources), encoded(record), record["created_at"]),
        )
        return record

    def coverage(self, profile_id, requirement_id, requirement_revision, assessment_id, variant_id,
                 variant_revision, connection=None) -> dict | None:
        def load(conn):
            row = conn.execute(
                """SELECT relation_json FROM fit_coverage_relations
                WHERE profile_id=? AND requirement_id=? AND requirement_revision=? AND assessment_id=?
                  AND variant_id=? AND variant_revision=? ORDER BY rowid DESC LIMIT 1""",
                (profile_id, requirement_id, str(requirement_revision), assessment_id, variant_id,
                 str(variant_revision)),
            ).fetchone()
            return json.loads(row[0]) if row else None
        return self._read(load, connection)

    def save_coverage(self, conn, relation: dict) -> None:
        require_contract(relation)
        row = conn.execute("SELECT relation_json FROM fit_coverage_relations WHERE relation_id=?",
                           (relation["relation_id"],)).fetchone()
        if row:
            if encoded(json.loads(row[0])) != encoded(relation):
                raise ConflictError("The accepted wording coverage receipt has changed.")
            return
        conn.execute(
            """INSERT INTO fit_coverage_relations
            (relation_id,profile_id,requirement_id,requirement_revision,assessment_id,achievement_id,
             variant_id,variant_revision,determination_id,relation_json,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (relation["relation_id"], relation["profile_id"], relation["requirement_id"],
             str(relation["requirement_revision"]), relation["assessment_id"], relation["achievement_id"],
             relation["variant_id"], str(relation["variant_revision"]), relation["determination_id"],
             encoded(relation), relation["created_at"]),
        )

    def prior_coverage(self, profile_id, requirement_id, requirement_revision, variant_id,
                       variant_revision, connection=None) -> list[dict]:
        return self._read(lambda conn: [json.loads(row[0]) for row in conn.execute(
            """SELECT relation_json FROM fit_coverage_relations
            WHERE profile_id=? AND requirement_id=? AND requirement_revision=?
              AND variant_id=? AND variant_revision=? ORDER BY rowid DESC""",
            (profile_id, requirement_id, str(requirement_revision), variant_id, str(variant_revision)),
        )], connection)

    def wording_requests(self, profile_id, requirement_id, requirement_revision, connection=None) -> list[dict]:
        def load(conn):
            bindings = []
            for row in conn.execute("SELECT binding_json FROM fit_wording_requests WHERE profile_id=? ORDER BY rowid DESC", (profile_id,)):
                binding = json.loads(row[0])
                members = binding.get("requirements", [binding])
                for member in members:
                    if (member["requirement_id"] == requirement_id
                            and str(member["requirement_revision"]) == str(requirement_revision)):
                        bindings.append({**binding, **member})
                        break
            return bindings
        return self._read(load, connection)

    def save_wording_request(self, conn, binding: dict) -> None:
        require_contract(binding)
        if "requirements" in binding:
            if not binding["requirements"]:
                raise ConflictError("A grouped wording request requires its exact requirement bindings.")
            binding = {**binding["requirements"][0], **binding}
        row = conn.execute("SELECT binding_json FROM fit_wording_requests WHERE origin_key=?",
                           (binding["origin_key"],)).fetchone()
        if row:
            if json.loads(row[0])["proposal_id"] != binding["proposal_id"]:
                raise ConflictError("The retained wording request identity has changed.")
            return
        conn.execute(
            """INSERT INTO fit_wording_requests
            (origin_key,profile_id,requirement_id,requirement_revision,proposal_id,binding_json,created_at)
            VALUES (?,?,?,?,?,?,?)""",
            (binding["origin_key"], binding["profile_id"], binding["requirement_id"],
             str(binding["requirement_revision"]), binding["proposal_id"], encoded(binding), binding["created_at"]),
        )

    def latest_score(self, job_id: str, connection=None) -> dict | None:
        def load(conn):
            row = conn.execute("SELECT score_json FROM fit_score_versions WHERE job_id=? ORDER BY revision DESC LIMIT 1",
                               (job_id,)).fetchone()
            return json.loads(row[0]) if row else None
        return self._read(load, connection)

    def save_score(self, conn, score: dict, *, expected_revision: int) -> None:
        require_contract(score)
        current = self.latest_score(score["job_id"], conn)
        revision = current["revision"] if current else 0
        if revision != expected_revision or score["revision"] != expected_revision + 1:
            raise ConflictError("The saved Fit version has changed.", current_revision=revision)
        conn.execute(
            """INSERT INTO fit_score_versions
            (job_id,revision,profile_id,fact_semantics_version,requirements_revision,score_json,created_at)
            VALUES (?,?,?,?,?,?,?)""",
            (score["job_id"], score["revision"], score["source_binding"]["profile_id"],
             str(score["source_binding"]["fact_semantics_version"]),
             str(score["source_binding"]["requirements_revision"]), encoded(score), score["created_at"]),
        )

    def history(self, job_id: str, connection=None) -> list[dict]:
        return self._read(lambda conn: [json.loads(row[0]) for row in conn.execute(
            "SELECT score_json FROM fit_score_versions WHERE job_id=? ORDER BY revision DESC", (job_id,),
        )], connection)

    def anchors(self, connection=None) -> list[dict]:
        return self._read(lambda conn: [json.loads(row[0]) for row in conn.execute(
            "SELECT anchor_json FROM fit_correction_anchors ORDER BY rowid DESC",
        )], connection)

    def save_anchor(self, conn, anchor: dict) -> None:
        conn.execute(
            """INSERT INTO fit_correction_anchors
            (correction_id,job_id,score_revision,original_score,corrected_score,anchor_json,created_at)
            VALUES (?,?,?,?,?,?,?)""",
            (anchor["correction_id"], anchor["job_id"], anchor["score_revision"], anchor["original_score"],
             anchor["corrected_score"], encoded(anchor), anchor["created_at"]),
        )

    def scored_job_ids(self, connection=None) -> list[str]:
        return self._read(lambda conn: [row[0] for row in conn.execute(
            "SELECT DISTINCT job_id FROM fit_score_versions ORDER BY job_id",
        )], connection)

    def score_batch(self, job_ids, connection=None):
        if connection is None:
            with self.read_snapshot() as read:
                return read.score_batch(job_ids)
        return {row["job_id"]: json.loads(row["score_json"]) for row in connection.execute(
            "WITH wanted AS (SELECT value job_id FROM json_each(?)), ranked AS ("
            " SELECT s.job_id,s.score_json,row_number() OVER (PARTITION BY s.job_id ORDER BY s.revision DESC) position"
            " FROM fit_score_versions s JOIN wanted w ON w.job_id=s.job_id)"
            " SELECT job_id,score_json FROM ranked WHERE position=1", (encoded(job_ids),),
        )}

    def superseded_assessments(self, assessment_ids, connection=None):
        if connection is None:
            with self.read_snapshot() as read:
                return read.superseded_assessments(assessment_ids)
        # An explicit source-bound user correction can invalidate its earlier
        # evidence decision. A repeat model call on identical inputs cannot.
        return {row[0] for row in connection.execute(
            "SELECT original.assessment_id FROM fit_assessments original "
            "WHERE original.assessment_id IN (SELECT value FROM json_each(?)) AND EXISTS ("
            " SELECT 1 FROM fit_assessments correction WHERE correction.profile_id=original.profile_id"
            " AND correction.requirement_id=original.requirement_id"
            " AND correction.requirement_revision=original.requirement_revision"
            " AND correction.source_fingerprint=original.source_fingerprint AND correction.rowid>original.rowid"
            " AND correction.origin='manual')",
            (encoded(assessment_ids),),
        )}

    def coverage_rows(self, assessment_ids, connection=None):
        if (not isinstance(assessment_ids, (list, tuple)) or len(assessment_ids) > 1000
                or any(not isinstance(item, str) or not item for item in assessment_ids)):
            raise AppError("invalid_assessment_selection", "Read coverage for at most 1,000 qualification records.")
        ids = list(dict.fromkeys(assessment_ids))
        if not ids:
            return []
        return self._read(lambda conn: [json.loads(row[0]) for row in conn.execute(
            "SELECT relation_json FROM fit_coverage_relations WHERE assessment_id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC",
            (encoded(ids),),
        )], connection)

    def operation(self, operation_id, input_fingerprint, connection=None):
        if operation_id is None:
            return None
        def load(conn):
            row = conn.execute("SELECT * FROM fit_operation_receipts WHERE operation_id=?", (operation_id,)).fetchone()
            if row is None:
                return None
            result = json.loads(row["result_json"])
            require_contract(result)
            if row["input_fingerprint"] != input_fingerprint:
                raise ConflictError("This durable Fit operation belongs to different input.")
            return result
        return self._read(load, connection)

    def save_operation(self, conn, operation_id, input_fingerprint, result):
        if operation_id is None:
            return
        require_contract(result)
        previous = self.operation(operation_id, input_fingerprint, conn)
        if previous is not None:
            return
        conn.execute("INSERT INTO fit_operation_receipts VALUES (?,?,?,?,?,?)", (
            operation_id, input_fingerprint, result["job_id"], result["score"]["revision"], encoded(result),
            result["score"]["created_at"],
        ))

    def complete_operation(self, operation_id, input_fingerprint, result):
        if operation_id is None:
            return
        with self._database.transaction() as conn:
            self.operation(operation_id, input_fingerprint, conn)
            conn.execute("UPDATE fit_operation_receipts SET result_json=? WHERE operation_id=? AND input_fingerprint=?",
                         (encoded(result), operation_id, input_fingerprint))

    def delete_job_data(self, job_id, connection=None):
        if connection is None:
            with self._database.transaction() as conn:
                return self.delete_job_data(job_id, conn)
        for table in ("fit_operation_receipts", "fit_correction_anchors", "fit_score_versions"):
            connection.execute(f"DELETE FROM {table} WHERE job_id=?", (job_id,))
        connection.execute("""
            UPDATE fit_initial_cohort_operations SET state_json='{"status":"source_deleted"}'
            WHERE EXISTS(SELECT 1 FROM json_each(state_json,'$.request.job_ids') WHERE value=?)
            """, (job_id,))
        connection.execute(
            "DELETE FROM fit_refresh_operations WHERE EXISTS(SELECT 1 FROM json_each(state_json,'$.job_ids') WHERE value=?)", (job_id,),
        )
        connection.execute(
            "DELETE FROM fit_assessments WHERE json_extract(assessment_json,'$.job_id')=?"
            " AND json_extract(assessment_json,'$.category') IN ('education','language')", (job_id,),
        )

    def delete_requirement_data(self, requirement_ids, connection=None):
        if connection is None or not connection.in_transaction:
            raise RuntimeError("Permanent requirement cleanup requires the owner's write transaction.")
        self._prune_wording_requests(set(requirement_ids), connection)
        for ident in requirement_ids:
            for table, field in (("fit_user_association_versions", "association_json"),
                                 ("fit_current_wording_versions", "assignment_json")):
                connection.execute(f"DELETE FROM {table} WHERE json_extract({field},'$.requirement_id')=?", (ident,))
            # Coverage owns the only local FK to assessments, so remove it first.
            for table in ("fit_coverage_relations", "fit_user_associations",
                          "fit_current_wordings", "fit_assessments"):
                connection.execute(f"DELETE FROM {table} WHERE requirement_id=?", (ident,))

    def _prune_wording_requests(self, requirement_ids, connection):
        """Keep surviving proposal suppression under its original Profile key."""
        if not requirement_ids:
            return
        for row in connection.execute("SELECT origin_key,binding_json FROM fit_wording_requests").fetchall():
            binding = json.loads(row["binding_json"])
            members = binding.get("requirements", [binding])
            surviving = [member for member in members if member["requirement_id"] not in requirement_ids]
            if len(surviving) == len(members):
                continue
            if not surviving:
                connection.execute("DELETE FROM fit_wording_requests WHERE origin_key=?", (row["origin_key"],))
                continue
            # save_wording_request mirrors the first member at the top level.
            # Remove that old mirror before indexing the first surviving member;
            # the grouped source inventory and immutable proposal key stay bound.
            retained = {key: value for key, value in binding.items() if key not in members[0]}
            retained = {**surviving[0], **retained, "requirements": surviving,
                        "evidence_refs": binding["evidence_refs"]}
            for field in ("gap_requirement_ids", "intended_requirement_ids"):
                if field in binding:
                    retained[field] = [ident for ident in binding[field] if ident not in requirement_ids]
            if "gap_requirement_ids" not in retained:
                proposal = self.profile.get_authoring_proposal(binding["proposal_id"], binding["profile_id"],
                    connection=connection, include_brief=True)
                gaps = (proposal or {}).get("brief", {}).get("origin_metadata", {}).get("gap_requirement_ids", [])
                retained["gap_requirement_ids"] = [ident for ident in gaps if ident not in requirement_ids]
            connection.execute(
                "UPDATE fit_wording_requests SET requirement_id=?,requirement_revision=?,binding_json=? WHERE origin_key=?",
                (retained["requirement_id"], str(retained["requirement_revision"]), encoded(retained), row["origin_key"]),
            )


class SqliteFitReadSession:
    """Typed read operations bound to one private adapter snapshot."""

    def __init__(self, store, connection):
        self._store, self._connection = store, connection
        self._demand_catalogs = {}

    def assessment(self, assessment_id):
        return self._store.assessment(assessment_id, self._connection)

    def latest_assessment(self, profile_id, requirement_id, requirement_revision, *, source_fingerprint=None):
        return self._store.latest_assessment(profile_id, requirement_id, requirement_revision,
                                             source_fingerprint=source_fingerprint, connection=self._connection)

    def assessment_sources(self, assessment_id):
        return self._store.assessment_sources(assessment_id, self._connection)

    def coverage_relation(self, relation_id):
        return self._store.coverage_relation(relation_id, self._connection)

    def coverage(self, profile_id, requirement_id, requirement_revision, assessment_id, variant_id, variant_revision):
        return self._store.coverage(profile_id, requirement_id, requirement_revision, assessment_id, variant_id,
                                    variant_revision, self._connection)

    def prior_coverage(self, profile_id, requirement_id, requirement_revision, variant_id, variant_revision):
        return self._store.prior_coverage(profile_id, requirement_id, requirement_revision, variant_id,
                                          variant_revision, self._connection)

    def wording_requests(self, profile_id, requirement_id, requirement_revision):
        return self._store.wording_requests(profile_id, requirement_id, requirement_revision, self._connection)

    def latest_score(self, job_id):
        return self._store.latest_score(job_id, self._connection)

    def history(self, job_id):
        return self._store.history(job_id, self._connection)

    def anchors(self):
        return self._store.anchors(self._connection)

    def scored_job_ids(self):
        return self._store.scored_job_ids(self._connection)

    def score_batch(self, job_ids):
        return self._store.score_batch(job_ids, self._connection)

    def superseded_assessments(self, assessment_ids):
        return self._store.superseded_assessments(assessment_ids, self._connection)

    def coverage_rows(self, assessment_ids):
        return self._store.coverage_rows(assessment_ids, self._connection)

    def operation(self, operation_id, input_fingerprint):
        return self._store.operation(operation_id, input_fingerprint, self._connection)

    def profile_snapshot(self, profile_id="default"):
        from .sources import FitProfileSnapshot
        return FitProfileSnapshot(self._store.profile.snapshot(profile_id, connection=self._connection),
                                  self.settings_snapshot().get("scoreCriteria", ""))

    def job_requirements(self, job_id):
        return self._store.requirements.get_job_requirements(job_id, connection=self._connection)

    def requirement(self, requirement_id, revision=None):
        return self._store.requirements.get_requirement(requirement_id, revision=revision, connection=self._connection)

    def catalog_snapshot(self):
        return self._store.requirements.catalog_snapshot(connection=self._connection)

    def library_catalog_snapshot(self):
        return self._store.requirements.library_catalog_snapshot(connection=self._connection)

    def demand_catalog_snapshot(self, *, active_only=False):
        if active_only not in self._demand_catalogs:
            self._demand_catalogs[active_only] = self._store.requirements.demand_catalog_snapshot(
                connection=self._connection, active_only=active_only)
        return self._demand_catalogs[active_only]

    def wording_library(self, profile_id="default"):
        return self._store.profile.library(profile_id, connection=self._connection)

    def library_records(self, profile_id="default"):
        return self._store.library_records(profile_id, connection=self._connection)

    def current_wording_heads(self, profile_id, achievement_ids=None):
        return self._store.current_wording_heads(profile_id, achievement_ids, self._connection)

    def current_wordings(self, profile_id, achievement_ids=None):
        return self._store.current_wordings(profile_id, achievement_ids, self._connection)

    def current_wordings_fingerprint(self, profile_id, achievement_ids=None):
        return self._store.current_wordings_fingerprint(profile_id, achievement_ids, self._connection)

    def wording_group_decision(self, group_key):
        return self._store.wording_group_decision(group_key, self._connection)

    def current_wording_history(self, assignment_id, profile_id, *, limit, offset):
        return self._store._current_wording_history(assignment_id, profile_id, limit=limit, offset=offset, connection=self._connection)

    def latest_requirement_assessment(self, profile_id, requirement_id, *, demand_fingerprint):
        return self._store.latest_requirement_assessment(profile_id, requirement_id, self._connection,
                                                         demand_fingerprint=demand_fingerprint)

    def completed_refresh(self, profile_id):
        return self._store.completed_refresh(profile_id, self._connection)

    def latest_refresh(self, profile_id):
        return self._store.latest_refresh(profile_id, self._connection)

    def authoring_proposals(self, profile_id="default"):
        return self._store.profile.library(profile_id, connection=self._connection)["proposals"]

    def authoring_proposal(self, proposal_id, profile_id="default", *, include_brief=False, follow_retry=False):
        return self._store.profile.get_authoring_proposal(proposal_id, profile_id=profile_id,
            connection=self._connection, include_brief=include_brief, follow_retry=follow_retry)

    def authoring_request(self, origin_key, profile_id="default"):
        return self._store.profile.get_authoring_request(origin_key, profile_id=profile_id, connection=self._connection)

    def settings_snapshot(self):
        return self._store.settings.snapshot(self._connection) if self._store.settings is not None else {}

    def requirement_bindings(self, job_ids, *, postings=None, scored=None):
        return self._store.requirements.job_bindings(job_ids, connection=self._connection, postings=postings, scored=scored)

    def validate_sources(self, profile_snapshot, requirements_snapshot, assessment=None, *, facts_only=True):
        self._store._assert_sources(self._connection, profile_snapshot, requirements_snapshot, full_profile=not facts_only)
        if assessment is not None:
            self._store._assert_assessment(self._connection, assessment)
