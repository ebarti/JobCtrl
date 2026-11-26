"""PostgreSQL adapter; only requirement-owned tables are read or written here."""

from __future__ import annotations

import json
from contextlib import contextmanager, nullcontext

from jobctrl.app.errors import AppError, ConflictError, NotFoundError

from .domain import (CONTRACT_VERSION, MEANING_KEYS, RequirementError, canonical_json, current_contract,
                     fingerprint, now, regrouped_original_demands, snapshot_demand_fingerprints)
from .normalization_storage import NormalizationStore
from .cohort_storage import CohortStorage
from .normalization_domain import NORMALIZATION_VERSION


class PostgresRequirementStore(NormalizationStore, CohortStorage):
    def admit_catalog_prompt(self, operation_id, prompt_version, connection):
        connection.execute("INSERT INTO requirements_refresh_transport VALUES (?,?)", (operation_id, prompt_version))

    def catalog_prompt(self, operation_id):
        with self.read_session() as connection:
            row = connection.execute("SELECT prompt_version FROM requirements_refresh_transport WHERE operation_id=?",
                                     (operation_id,)).fetchone()
        return row["prompt_version"] if row is not None else None

    def admit_consolidation_prompt(self, operation_id, current, predecessor):
        # This synchronous public endpoint accepts caller-owned operation IDs.
        # A paid or published pre-pin operation still owns its original request.
        with self.database.transaction() as connection:
            row = connection.execute("SELECT prompt_version FROM requirements_refresh_transport WHERE operation_id=?",
                                     (operation_id,)).fetchone()
            if row is not None:
                return row["prompt_version"]
            previous = connection.execute(
                "SELECT 1 FROM requirements_normalization_intents WHERE operation_id=? "
                "UNION ALL SELECT 1 FROM requirements_reconciliations WHERE operation_id=? LIMIT 1",
                (operation_id, operation_id)).fetchone()
            version = predecessor if previous is not None else current
            self.admit_catalog_prompt(operation_id, version, connection)
            return version

    def __init__(self, database, events):
        self.database = database
        self.events = events

    @contextmanager
    def read_session(self):
        with self.database.connect() as connection:
            yield connection

    def current_snapshot(self, job_id, connection=None):
        if connection is None:
            with self.database.connect() as connection:
                return self.current_snapshot(job_id, connection)
        row = connection.execute(
            "SELECT s.snapshot_json FROM requirements_accepted a JOIN requirements_snapshots s "
            "ON s.job_id=a.job_id AND s.revision=a.revision WHERE a.job_id=?", (job_id,),
        ).fetchone()
        return json.loads(row[0]) if row else None

    def job_bindings(self, job_ids, connection, *, scored=None):
        if not job_ids:
            return {}
        rows = [
            (row, json.loads(row["snapshot_json"])) for row in connection.execute(
                "SELECT s.job_id,s.revision,s.posting_revision,s.posting_hash,s.snapshot_json "
                "FROM requirements_accepted a JOIN requirements_snapshots s ON s.job_id=a.job_id AND s.revision=a.revision "
                "WHERE a.job_id=ANY(?::text[])", (list(job_ids),),
            )
        ]
        requirement_ids = {
            item["requirement_id"] for _, snapshot in rows for item in snapshot.get("requirements", [])
        }
        heads = dict(connection.execute(
            "SELECT requirement_id,revision FROM requirements_heads WHERE requirement_id=ANY(?::text[])",
            (sorted(requirement_ids),),
        )) if requirement_ids else {}
        bindings, comparisons, snapshots = {}, [], {}
        for row, snapshot in rows:
            accepted = {(item["requirement_id"], item["requirement_revision"]) for item in snapshot.get("requirements", [])}
            current = {(ident, heads[ident]) for ident, _ in accepted if ident in heads}
            reasons = [] if current_contract(snapshot) else ["contract_changed"]
            if current_contract(snapshot) and snapshot.get("normalization_version") != NORMALIZATION_VERSION:
                reasons.append("consolidation_required")
            demands = {item["requirement_id"]: item.get("normalized_demand", {}).get("demand_fingerprint")
                       for item in snapshot.get("requirements", [])}
            if any(revision != heads.get(ident) for ident, revision in accepted):
                reasons.append("requirement_revised")
            direct = [{"requirement_id": item["requirement_id"], "requirement_revision": item["revision"]}
                      for field in ("education", "languages") for item in snapshot.get(field, [])] if current_contract(snapshot) else []
            try:
                job_demands = snapshot_demand_fingerprints(snapshot)
            except (RequirementError, AppError):
                job_demands = None
            bindings[row["job_id"]] = {
                "contract_version": snapshot.get("contract_version"), "normalization_version": snapshot.get("normalization_version"),
                "status": snapshot.get("status"),
                "stale_reasons": reasons,
                "revision": row["revision"], "posting_revision": row["posting_revision"], "posting_hash": row["posting_hash"],
                "stale": bool(reasons),
                "job_demands": job_demands,
                "regrouped": False,
                "requirement_revisions": [{"requirement_id": ident, "requirement_revision": revision,
                    "demand_fingerprint": demands.get(ident)} for ident, revision in sorted(accepted)] + direct,
                "current_requirement_revisions": [{"requirement_id": ident, "requirement_revision": revision,
                    "demand_fingerprint": demands.get(ident)} for ident, revision in sorted(current)] + direct,
            }
            basis = (scored or {}).get(row["job_id"])
            if (basis and job_demands is not None and basis["job_demands"] != job_demands
                    and basis["revision"] < row["revision"] and basis["posting_hash"] == row["posting_hash"]):
                comparisons.append({"job_id": row["job_id"], "before": basis["revision"], "after": row["revision"]})
                snapshots[row["job_id"]] = snapshot
        if comparisons:
            for row in self._regrouping_sources(comparisons, connection):
                job_id = row["job_id"]
                earlier = json.loads(row["snapshot_json"])
                try:
                    checked = snapshot_demand_fingerprints(earlier)
                except (RequirementError, AppError):
                    continue
                if checked == scored[job_id]["job_demands"]:
                    bindings[job_id]["regrouped"] = regrouped_original_demands(earlier, snapshots[job_id])
        return bindings

    @staticmethod
    def _regrouping_sources(comparisons, connection):
        # Every intervening snapshot must be an accepted catalog replacement
        # of the same extracted posting. A job proposal uses its own attempt
        # ID, and an explicit canonical correction has a separate action row.
        rows = connection.execute("""
            SELECT old.job_id,old.snapshot_json,revised.revision AS intervening_revision,
                   revised.snapshot_json AS intervening_snapshot,reconciliation.operation_id,
                   (revised.posting_hash=old.posting_hash
                    AND revised.extraction_determination_id=old.extraction_determination_id
                    AND correction.action_id IS NULL) AS same_extraction
            FROM jsonb_to_recordset(?::jsonb) AS requested(job_id text, "before" integer, "after" integer)
            JOIN requirements_snapshots old ON old.job_id=requested.job_id AND old.revision=requested."before"
            LEFT JOIN requirements_snapshots revised
              ON revised.job_id=old.job_id AND revised.revision>old.revision AND revised.revision<=requested."after"
            LEFT JOIN requirements_reconciliations reconciliation
              ON revised.attempt_id=('normalization:' || reconciliation.operation_id || ':' || old.job_id)
            LEFT JOIN requirements_revision_actions correction ON correction.action_id=reconciliation.operation_id
        """, (canonical_json(comparisons),))
        sources, rejected = {}, set()
        for row in rows:
            job_id = row["job_id"]
            sources.setdefault(job_id, row)
            if row["intervening_revision"] is None:
                continue
            snapshot = json.loads(row["intervening_snapshot"])
            if (not row["same_extraction"] or row["operation_id"] is None
                    or (snapshot.get("normalization_provenance") or {}).get("reconciliation_id") != row["operation_id"]):
                rejected.add(job_id)
        return [row for job_id, row in sources.items() if job_id not in rejected]

    def get_meaning(self, requirement_id, revision=None, connection=None):
        if connection is None:
            with self.database.connect() as connection:
                return self.get_meaning(requirement_id, revision, connection)
        if revision is None:
            row = connection.execute(
                "SELECT revision FROM requirements_heads WHERE requirement_id=?", (requirement_id,),
            ).fetchone()
            if row is None:
                raise NotFoundError("The requirement does not exist.")
            revision = row[0]
        row = connection.execute(
            "SELECT * FROM requirements_meanings WHERE requirement_id=? AND revision=?", (requirement_id, revision),
        ).fetchone()
        if row is None:
            raise NotFoundError("The requirement revision does not exist.")
        return self._meaning(row)

    @staticmethod
    def _meaning(row):
        return {
            "requirement_id": row["requirement_id"], "revision": row["revision"],
            **json.loads(row["meaning_json"]), "provenance": json.loads(row["provenance_json"]),
            "created_at": row["created_at"],
        }

    def catalog_revision(self, connection):
        row = connection.execute("SELECT revision FROM requirements_catalog WHERE singleton=1").fetchone()
        if row is None:
            raise RequirementError("catalog_snapshot_invalid")
        return int(row[0])

    def catalog_snapshot(self, connection=None):
        if connection is None:
            with self.read_session() as connection:
                return self.catalog_snapshot(connection)
        # Read every canonical head and its full meaning under one epoch.
        # A caller's existing transaction can bind this inventory to its other
        # public source reads and eventual publication guard.
        # A repairable FTS index is never the semantic source inventory.
        revision = self.catalog_revision(connection)
        rows = connection.execute(
            "SELECT h.requirement_id,h.revision,m.meaning_json,m.provenance_json,m.created_at "
            "FROM requirements_heads h LEFT JOIN requirements_meanings m "
            "ON m.requirement_id=h.requirement_id AND m.revision=h.revision "
            "WHERE NOT EXISTS(SELECT 1 FROM requirements_aliases a WHERE a.requirement_id=h.requirement_id) ORDER BY h.requirement_id"
        ).fetchall()
        if any(row["meaning_json"] is None for row in rows):
            raise RequirementError("catalog_snapshot_invalid")
        return revision, [meaning for row in rows if current_contract(meaning := self._meaning(row))]

    def model_call(self, input_fingerprint):
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM requirements_model_cache WHERE input_fingerprint=?", (input_fingerprint,)).fetchone()
        if row is None:
            return None
        try:
            return {"input_fingerprint": row["input_fingerprint"], "operation": row["operation"],
                    "result": json.loads(row["result_json"]), "provenance": json.loads(row["provenance_json"])}
        except (ValueError, TypeError):
            raise RequirementError("model_cache_binding_invalid") from None

    def save_model_call(self, *, input_fingerprint, operation, posting, catalog_revision, result, provenance, posting_guard):
        with self.database.transaction() as connection:
            posting_guard(posting["job_id"], posting["revision"], posting["source_hash"], connection=connection)
            if catalog_revision is not None:
                epoch = connection.execute("SELECT revision FROM requirements_catalog WHERE singleton=1").fetchone()[0]
                if epoch != catalog_revision:
                    raise RequirementError("catalog_changed")
            connection.execute(
                "INSERT INTO requirements_model_cache VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(input_fingerprint) DO NOTHING",
                (input_fingerprint, operation, posting["job_id"], posting["revision"], posting["source_hash"],
                 catalog_revision, canonical_json(result), canonical_json(provenance), now()),
            )
        # A racing exact call may have committed first. Reuse that immutable
        # accepted record rather than silently mixing competing determinations.
        saved = self.model_call(input_fingerprint)
        if saved is None:
            raise RequirementError("model_cache_binding_invalid")
        return saved

    def check_correction_call(self, attempt_id, input_fingerprint, maximum, connection=None):
        operation = "requirements.correct_occurrences.call_intent"
        key = fingerprint({"operation": operation, "attempt_id": attempt_id, "input": input_fingerprint})
        with self.read_session() if connection is None else nullcontext(connection) as connection:
            if connection.execute("SELECT 1 FROM requirements_model_cache WHERE input_fingerprint=?", (key,)).fetchone():
                raise RequirementError("requirements_correction_call_unsettled")
            used = connection.execute(
                "SELECT count(*) FROM requirements_model_cache WHERE operation=? "
                "AND (result_json::jsonb ->> 'attempt_id')=?", (operation, attempt_id),
            ).fetchone()[0]
        if used >= maximum:
            raise RequirementError("requirements_catalog_unavailable", details={"reason": "model_call_bound",
                                   "maximum_new_model_calls": maximum})
        return operation, key, used

    def reserve_correction_call(self, attempt_id, input_fingerprint, maximum, posting, posting_guard, *, connection):
        """Append an admission intent before dispatch; retries cannot reset work."""
        posting_guard(posting["job_id"], posting["revision"], posting["source_hash"], connection=connection)
        operation, key, used = self.check_correction_call(attempt_id, input_fingerprint, maximum, connection)
        connection.execute("INSERT INTO requirements_model_cache VALUES (?,?,?,?,?,?,?,?,?)", (
            key, operation, posting["job_id"], posting["revision"], posting["source_hash"], None,
            canonical_json({"contract_version": CONTRACT_VERSION, "attempt_id": attempt_id,
                            "input_fingerprint": input_fingerprint}), "{}", now(),
        ))
        return used + 1

    @staticmethod
    def _document(meaning):
        return canonical_json({k: meaning[k] for k in MEANING_KEYS})

    def accepted_occurrence_jobs(self, connection, requirement_id=None):
        """Return accepted occurrence roots; Jobs owns whether each job exists."""
        rows = connection.execute(
            "SELECT o.requirement_id,o.job_id,o.occurrence_json FROM requirements_occurrences o "
            "JOIN requirements_accepted a ON a.job_id=o.job_id AND a.revision=o.snapshot_revision"
            + (" WHERE o.requirement_id=?" if requirement_id is not None else ""),
            (requirement_id,) if requirement_id is not None else (),
        )
        return list(dict.fromkeys((ident, job_id) for ident, job_id, occurrence in rows
                                  if current_contract(json.loads(occurrence))))

    def index_status(self):
        with self.read_session() as connection:
            meta = connection.execute("SELECT revision,indexed_revision FROM requirements_catalog WHERE singleton=1").fetchone()
            meanings = [self._meaning(row) for row in connection.execute(
                "SELECT m.* FROM requirements_heads h JOIN requirements_meanings m "
                "ON m.requirement_id=h.requirement_id AND m.revision=h.revision",
            )]
            meanings = [meaning for meaning in meanings if current_contract(meaning)]
            indexed = [
                (ident, revision, document) for ident, revision, document, meaning in connection.execute(
                    "SELECT r.requirement_id,r.revision,r.document,m.meaning_json FROM requirements_retrieval r "
                    "JOIN requirements_meanings m ON m.requirement_id=r.requirement_id AND m.revision=r.revision"
                ) if current_contract(json.loads(meaning))
            ]
            expected = {(m["requirement_id"], m["revision"]): self._document(m) for m in meanings}
            actual = {(ident, revision): document for ident, revision, document in indexed}
            return {"contract_version": CONTRACT_VERSION, "catalog_revision": meta[0], "indexed_revision": meta[1], "meaning_count": len(meanings),
                    "indexed_count": len(indexed), "fresh": meta[0] == meta[1] and len(indexed) == len(actual) and expected == actual}

    def rebuild_index(self, expected_catalog_revision):
        with self.database.transaction() as connection:
            revision = connection.execute("SELECT revision FROM requirements_catalog WHERE singleton=1").fetchone()[0]
            if revision != expected_catalog_revision:
                raise ConflictError("The requirement catalog changed before index repair.")
            connection.execute("DELETE FROM requirements_retrieval")
            for row in connection.execute(
                "SELECT m.* FROM requirements_heads h JOIN requirements_meanings m "
                "ON m.requirement_id=h.requirement_id AND m.revision=h.revision",
            ).fetchall():
                meaning = self._meaning(row)
                if not current_contract(meaning):
                    continue
                connection.execute("INSERT INTO requirements_retrieval(requirement_id,revision,document) VALUES (?,?,?)",
                                   (meaning["requirement_id"], meaning["revision"], self._document(meaning)))
            connection.execute("UPDATE requirements_catalog SET indexed_revision=? WHERE singleton=1", (revision,))
            self.events.append(connection, "RequirementIndexRebuilt", {"catalogRevision": revision},
                               feature="requirements", aggregate_id="catalog")
        return self.index_status()

    def occurrences(self, requirement_id, *, limit=100, offset=0, connection=None):
        if connection is None:
            with self.database.connect() as connection:
                return self.occurrences(requirement_id, limit=limit, offset=offset, connection=connection)
        rows = connection.execute(
            "SELECT o.occurrence_json FROM requirements_occurrences o "
            "JOIN requirements_accepted a ON a.job_id=o.job_id AND a.revision=o.snapshot_revision "
            "WHERE o.requirement_id=? ORDER BY o.job_id,o.occurrence_id LIMIT ? OFFSET ?",
            (requirement_id, limit, offset),
        ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def history(self, requirement_id, *, kind, limit, offset, connection):
        """Read retained owner records, including superseded job snapshots."""
        root = self.alias_root(requirement_id, connection)
        identifiers = [requirement_id]
        if root == requirement_id:
            identifiers.extend(ident for ident, target in self.aliases(connection).items() if target == root)
        placeholders = ",".join("?" for _ in identifiers)
        if kind == "revisions":
            total = connection.execute(f"SELECT count(*) FROM requirements_meanings WHERE requirement_id IN ({placeholders})",
                                       identifiers).fetchone()[0]
            rows = [self._meaning(row) for row in connection.execute(
                f"SELECT * FROM requirements_meanings WHERE requirement_id IN ({placeholders}) ORDER BY created_at DESC,requirement_id,revision DESC LIMIT ? OFFSET ?",
                (*identifiers, limit, offset),
            )]
        else:
            total = connection.execute(f"SELECT count(*) FROM requirements_occurrences WHERE requirement_id IN ({placeholders})",
                                       identifiers).fetchone()[0]
            rows = [{**json.loads(row["occurrence_json"]), "snapshot_revision": row["snapshot_revision"],
                     "accepted": row["accepted_revision"] == row["snapshot_revision"]}
                    for row in connection.execute(
                        "SELECT o.*,a.revision accepted_revision FROM requirements_occurrences o "
                        "LEFT JOIN requirements_accepted a ON a.job_id=o.job_id "
                        f"WHERE o.requirement_id IN ({placeholders}) ORDER BY o.snapshot_revision DESC,o.job_id,o.occurrence_id LIMIT ? OFFSET ?",
                        (*identifiers, limit, offset),
                    )]
        return {"total": total, "rows": rows}

    def delete_job_data(self, job_id, connection=None):
        if connection is None:
            with self.database.transaction() as connection:
                return self.delete_job_data(job_id, connection)
        # Jobs owns deletion authorization and the enclosing transaction.
        cohorts = []
        for ident, raw in connection.execute("SELECT operation_id,state_json FROM requirements_cohort_operations"):
            state = json.loads(raw)
            captured = state.get("captured") or {}
            if ((state.get("request") or {}).get("job_id") == job_id
                    or any(item.get("job_id") == job_id for item in state.get("prepared") or [])
                    or any(item.get("job_id") == job_id for item in captured.get("accepted_heads") or [])
                    or any((item.get("provenance", {}).get("posting") or {}).get("job_id") == job_id
                           for item in captured.get("members") or [])):
                cohorts.append(ident)
        if cohorts:
            connection.execute(
                "UPDATE requirements_cohort_operations SET state_json=? WHERE operation_id=ANY(?::text[])",
                ('{"status":"source_deleted"}', cohorts),
            )
        connection.execute("DELETE FROM requirements_occurrences WHERE job_id=?", (job_id,))
        connection.execute("DELETE FROM requirements_accepted WHERE job_id=?", (job_id,))
        connection.execute("DELETE FROM requirements_snapshots WHERE job_id=?", (job_id,))
        connection.execute("DELETE FROM requirements_attempts WHERE job_id=?", (job_id,))
        connection.execute("DELETE FROM requirements_model_cache WHERE job_id=?", (job_id,))

    def orphaned_meaning_ids_for_job(self, job_id, connection):
        aliases = self.aliases(connection)

        def root_of(ident):
            seen = set()
            while ident in aliases:
                if ident in seen:
                    raise RequirementError("requirements_alias_cycle")
                seen.add(ident)
                ident = aliases[ident]
            return ident

        candidates = {root_of(row[0]) for row in connection.execute(
            "SELECT DISTINCT requirement_id FROM requirements_occurrences WHERE job_id=?", (job_id,))}
        retained = {root_of(row[0]) for row in connection.execute(
            "SELECT DISTINCT requirement_id FROM requirements_occurrences WHERE job_id<>?", (job_id,))}
        orphaned = candidates - retained
        return sorted(row[0] for row in connection.execute("SELECT requirement_id FROM requirements_heads") if root_of(row[0]) in orphaned)

    def delete_meanings(self, requirement_ids, job_id, connection):
        if not requirement_ids:
            return
        for ident in requirement_ids:
            connection.execute("DELETE FROM requirements_aliases WHERE requirement_id=? OR root_requirement_id=?", (ident, ident))
            connection.execute("DELETE FROM requirements_revision_actions WHERE requirement_id=?", (ident,))
            connection.execute("DELETE FROM requirements_heads WHERE requirement_id=?", (ident,))
            connection.execute("DELETE FROM requirements_retrieval WHERE requirement_id=?", (ident,))
            connection.execute("DELETE FROM requirements_meanings WHERE requirement_id=?", (ident,))
        connection.execute(
            "UPDATE requirements_catalog SET revision=revision+?, "
            "indexed_revision=CASE WHEN indexed_revision=revision THEN indexed_revision+? ELSE indexed_revision END "
            "WHERE singleton=1", (len(requirement_ids), len(requirement_ids)),
        )
        epoch = connection.execute("SELECT revision FROM requirements_catalog WHERE singleton=1").fetchone()[0]
        self.events.append(connection, "RequirementMeaningsDeleted", {
            "jobId": job_id, "requirementCount": len(requirement_ids), "catalogRevision": epoch,
        }, feature="requirements", aggregate_id=job_id)

    def latest_attempt(self, job_id, connection=None):
        if connection is None:
            with self.database.connect() as connection:
                return self.latest_attempt(job_id, connection)
        row = connection.execute(
            "SELECT a.*,r.details_json FROM requirements_attempts a LEFT JOIN requirements_attempt_refusals r "
            "ON r.attempt_id=a.attempt_id AND r.completed_at=a.completed_at "
            "WHERE a.job_id=? ORDER BY a.started_at DESC,a.attempt_id DESC LIMIT 1", (job_id,),
        ).fetchone()
        if row is None:
            return None
        attempt = dict(row)
        details = attempt.pop("details_json")
        if details is not None:
            attempt["failure_details"] = json.loads(details)
        return attempt

    def attempt_fingerprint(self, attempt_id):
        with self.database.connect() as conn:
            row = conn.execute("SELECT input_fingerprint FROM requirements_attempts WHERE attempt_id=?", (attempt_id,)).fetchone()
            return row[0] if row else None

    def start_attempt(self, attempt):
        with self.database.transaction() as connection:
            saved = connection.execute("SELECT * FROM requirements_attempts WHERE attempt_id=?", (attempt["attempt_id"],)).fetchone()
            if saved:
                if any(saved[key] != attempt[key] for key in ("job_id", "posting_revision", "expected_revision", "input_fingerprint")):
                    raise ConflictError("The requirement action ID belongs to another input.")
                if saved["state"] == "accepted":
                    return
                # An interrupted attempt has no accepted write to replace.
                # Stable durable run identity admits a fresh model attempt;
                # provider spend/capacity authority remains in the gateway.
                connection.execute("UPDATE requirements_attempts SET state='running',failure_code=NULL,completed_at=NULL WHERE attempt_id=?",
                                   (attempt["attempt_id"],))
                return
            connection.execute(
                "INSERT INTO requirements_attempts VALUES (?,?,?,?,?, 'running', NULL,?,NULL)",
                (attempt["attempt_id"], attempt["job_id"], attempt["posting_revision"], attempt["expected_revision"],
                 attempt["input_fingerprint"], now()),
            )

    def accepted_action(self, attempt_id, input_fingerprint, connection=None):
        from contextlib import nullcontext
        with (self.read_session() if connection is None else nullcontext(connection)) as connection:
            attempt = connection.execute("SELECT * FROM requirements_attempts WHERE attempt_id=?", (attempt_id,)).fetchone()
            if attempt is None:
                return None
            if attempt["input_fingerprint"] != input_fingerprint:
                raise ConflictError("The requirement action ID belongs to another input.")
            row = connection.execute("SELECT snapshot_json FROM requirements_snapshots WHERE attempt_id=?", (attempt_id,)).fetchone()
            snapshot = json.loads(row[0]) if row else None
            if snapshot is not None and not current_contract(snapshot):
                raise RequirementError("requirements_contract_changed")
            return snapshot

    def accepted_revision_action(self, operation_id, input_fingerprint):
        with self.read_session() as connection:
            row = connection.execute("SELECT * FROM requirements_revision_actions WHERE action_id=?", (operation_id,)).fetchone()
            if row is None:
                return None
            if row["input_fingerprint"] != input_fingerprint:
                raise ConflictError("The requirement action ID belongs to another input.")
            meaning = self.get_meaning(row["requirement_id"], row["revision"], connection)
            head = self.get_meaning(row["requirement_id"], connection=connection)
            if not current_contract(meaning):
                raise RequirementError("requirements_contract_changed")
            return {**meaning, "stale": head["revision"] != meaning["revision"], "reused_action": True}

    def finish_attempt(self, attempt_id, state, failure_code=None, *, details=None):
        completed_at = now()
        with self.database.transaction() as connection:
            changed = connection.execute(
                "UPDATE requirements_attempts SET state=?,failure_code=?,completed_at=? "
                "WHERE attempt_id=? AND state='running'", (state, failure_code, completed_at, attempt_id),
            ).rowcount
            if changed and details:
                connection.execute("INSERT INTO requirements_attempt_refusals VALUES (?,?,?)",
                                   (attempt_id, completed_at, canonical_json(details)))

    def revise_meaning(self, **kwargs):
        raise RequirementError("requirements_consolidation_required")

    def assert_snapshot_current(self, snapshot, connection):
        if not current_contract(snapshot):
            raise ConflictError("The requirement contract changed. Refresh requirements first.", reason="contract_changed")
        saved = self.current_snapshot(snapshot["job_id"], connection)
        if saved is None or saved["revision"] != snapshot["revision"]:
            raise ConflictError("The accepted requirement snapshot changed.")
        if any(k not in snapshot for k in saved) or canonical_json(saved) != canonical_json({k: snapshot[k] for k in saved}):
            raise ConflictError("The requirement snapshot identity is invalid.")
        for row in saved["requirements"]:
            head = connection.execute(
                "SELECT revision FROM requirements_heads WHERE requirement_id=?", (row["requirement_id"],),
            ).fetchone()
            if head is None or head[0] != row["requirement_revision"]:
                raise ConflictError("A canonical requirement meaning changed.")

    def publish(self, **kwargs):
        raise RequirementError("requirements_consolidation_required")
