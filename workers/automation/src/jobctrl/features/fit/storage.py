"""Small SQLite adapter for Fit's own accepted records."""

from __future__ import annotations

import json
import asyncio
from contextlib import contextmanager

from jobctrl.app.errors import AppError, ConflictError, NotFoundError

from .serialization import encoded


class FitStore:
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
        self.profile.assert_current(snapshot, connection=connection, facts_only=not full_profile)
        guidance = self.settings.snapshot(connection).get("scoreCriteria", "") if self.settings is not None else ""
        if guidance != snapshot.scoring_guidance:
            raise ConflictError("The user scoring guidance changed during assessment.")

    def _assert_sources(self, connection, profile_snapshot, requirements_snapshot, *, full_profile=False):
        self._assert_profile(connection, profile_snapshot, full_profile=full_profile)
        self.requirements.assert_current(requirements_snapshot, connection=connection)

    def _assert_assessment(self, connection, assessment, *, expected_id=None):
        latest = self.latest_assessment(
            assessment["profile_id"], assessment["requirement_id"], assessment["requirement_revision"],
            source_fingerprint=assessment["source_fingerprint"], connection=connection,
        )
        actual = latest["assessment_id"] if latest else None
        expected = expected_id if expected_id is not None else assessment["assessment_id"]
        if actual != expected:
            raise ConflictError("The accepted person qualification changed during inference.")
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
        with self._database.transaction() as connection:
            self._check_cancelled(cancelled)
            self._assert_sources(connection, profile_snapshot, requirements_snapshot)
            latest = self.latest_assessment(
                record["profile_id"], record["requirement_id"], record["requirement_revision"],
                source_fingerprint=record["source_fingerprint"], connection=connection,
            )
            if (latest["assessment_id"] if latest else None) != expected_assessment_id:
                raise ConflictError("The accepted person qualification changed during inference.")
            return self.save_assessment(connection, record, facts)

    def publish_score(self, candidate, profile_snapshot, requirements_snapshot, expected_revision,
                      qualifications, reuse_if_unchanged, operation_id, input_fingerprint, *, cancelled=lambda: False):
        with self._database.transaction() as connection:
            self._check_cancelled(cancelled)
            self._assert_sources(connection, profile_snapshot, requirements_snapshot)
            previous = self._assert_score(connection, candidate["job_id"], expected_revision)
            for record in qualifications:
                self._assert_assessment(connection, record)
            source_binding = candidate["source_binding"]
            same_binding = previous is not None and all(
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
            self._assert_assessment(connection, assessment)
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
            query = """SELECT assessment_json FROM fit_assessments
                       WHERE profile_id=? AND requirement_id=? AND requirement_revision=?"""
            values = [profile_id, requirement_id, str(requirement_revision)]
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

    def save_assessment(self, conn, record: dict, sources: list[dict]) -> dict:
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
        return self._read(lambda conn: [json.loads(row[0]) for row in conn.execute(
            """SELECT binding_json FROM fit_wording_requests
            WHERE profile_id=? AND requirement_id=? AND requirement_revision=? ORDER BY rowid DESC""",
            (profile_id, requirement_id, str(requirement_revision)),
        )], connection)

    def save_wording_request(self, conn, binding: dict) -> None:
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

    def assessment_id_batch(self, bindings, connection=None):
        if connection is None:
            with self.read_snapshot() as read:
                return read.assessment_id_batch(bindings)
        rows = connection.execute(
            "WITH wanted AS (SELECT json_extract(value,'$.profile_id') profile_id,"
            " json_extract(value,'$.requirement_id') requirement_id,"
            " json_extract(value,'$.requirement_revision') requirement_revision,"
            " json_extract(value,'$.source_fingerprint') source_fingerprint FROM json_each(?)), ranked AS ("
            " SELECT a.profile_id,a.requirement_id,a.requirement_revision,a.source_fingerprint,a.assessment_id,"
            " row_number() OVER (PARTITION BY a.profile_id,a.requirement_id,a.requirement_revision,a.source_fingerprint"
            " ORDER BY a.rowid DESC) position FROM fit_assessments a JOIN wanted w"
            " ON a.profile_id=w.profile_id AND a.requirement_id=w.requirement_id"
            " AND a.requirement_revision=w.requirement_revision AND a.source_fingerprint=w.source_fingerprint)"
            " SELECT * FROM ranked WHERE position=1", (encoded(bindings),),
        )
        return {(row["profile_id"], row["requirement_id"], row["requirement_revision"], row["source_fingerprint"]):
                row["assessment_id"] for row in rows}

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
            if row["input_fingerprint"] != input_fingerprint:
                raise ConflictError("This durable Fit operation belongs to different input.")
            return json.loads(row["result_json"])
        return self._read(load, connection)

    def save_operation(self, conn, operation_id, input_fingerprint, result):
        if operation_id is None:
            return
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


class SqliteFitReadSession:
    """Typed read operations bound to one private adapter snapshot."""

    def __init__(self, store, connection):
        self._store, self._connection = store, connection

    def assessment(self, assessment_id):
        return self._store.assessment(assessment_id, self._connection)

    def latest_assessment(self, profile_id, requirement_id, requirement_revision, *, source_fingerprint=None):
        return self._store.latest_assessment(profile_id, requirement_id, requirement_revision,
                                             source_fingerprint=source_fingerprint, connection=self._connection)

    def assessment_sources(self, assessment_id):
        return self._store.assessment_sources(assessment_id, self._connection)

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

    def assessment_id_batch(self, bindings):
        return self._store.assessment_id_batch(bindings, self._connection)

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

    def authoring_request(self, origin_key, profile_id="default"):
        return self._store.profile.get_authoring_request(origin_key, profile_id=profile_id, connection=self._connection)

    def settings_snapshot(self):
        return self._store.settings.snapshot(self._connection) if self._store.settings is not None else {}

    def requirement_bindings(self, job_ids, *, postings=None):
        return self._store.requirements.job_bindings(job_ids, connection=self._connection, postings=postings)

    def validate_sources(self, profile_snapshot, requirements_snapshot, assessment=None, *, facts_only=True):
        self._store._assert_sources(self._connection, profile_snapshot, requirements_snapshot, full_profile=not facts_only)
        if assessment is not None:
            self._store._assert_assessment(self._connection, assessment)
