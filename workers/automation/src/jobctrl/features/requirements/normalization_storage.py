"""Requirements-owned atomic reconciliation and retained alias authority."""

from __future__ import annotations

import json
from contextlib import nullcontext

from jobctrl.app.errors import ConflictError

from .domain import RequirementError, canonical_json, current_contract, fingerprint, now
from .normalization_domain import NORMALIZATION_VERSION
from .normalization_citations import CITATION_BINDER_VERSION, citation_binding_summary
from .normalization_partitions import NORMALIZATION_BINDING_VERSION, partition_binding_summary
from .normalization_partitions_v4 import NORMALIZATION_BINDING_VERSION as NORMALIZATION_V4_BINDING_VERSION


class NormalizationStore:
    def aliases(self, connection=None):
        if connection is None:
            with self.read_session() as connection:
                return self.aliases(connection)
        return dict(connection.execute("SELECT requirement_id,root_requirement_id FROM requirements_aliases"))

    def alias_root(self, requirement_id, connection=None):
        if connection is None:
            with self.read_session() as connection:
                return self.alias_root(requirement_id, connection)
        aliases = self.aliases(connection)
        seen = set()
        while requirement_id in aliases:
            if requirement_id in seen:
                raise RequirementError("requirements_alias_cycle")
            seen.add(requirement_id)
            requirement_id = aliases[requirement_id]
        return requirement_id

    def normalization_capture(self, connection=None):
        if connection is None:
            with self.read_session() as connection:
                return self.normalization_capture(connection)
        epoch, roots = self.catalog_snapshot(connection)
        members = [self._meaning(row) for row in connection.execute(
            "SELECT h.requirement_id,h.revision,m.meaning_json,m.provenance_json,m.created_at "
            "FROM requirements_heads h JOIN requirements_meanings m "
            "ON m.requirement_id=h.requirement_id AND m.revision=h.revision ORDER BY h.requirement_id"
        )]
        snapshots = [json.loads(row[0]) for row in connection.execute(
            "SELECT s.snapshot_json FROM requirements_accepted a JOIN requirements_snapshots s "
            "ON s.job_id=a.job_id AND s.revision=a.revision ORDER BY s.job_id"
        )]
        return {"catalog_revision": epoch, "roots": roots,
                "member_heads": [{"requirement_id": row["requirement_id"], "revision": row["revision"]}
                                 for row in members if current_contract(row)],
                "members": [row for row in members if current_contract(row)],
                "aliases": [dict(row) for row in connection.execute(
                    "SELECT * FROM requirements_aliases ORDER BY requirement_id")],
                "accepted_heads": [{"job_id": row["job_id"], "revision": row["revision"],
                    "posting_revision": row["posting_revision"], "posting_hash": row["posting_hash"],
                    "contract_version": row.get("contract_version"), "snapshot_fingerprint": fingerprint(row)}
                    for row in snapshots],
                "snapshots": [row for row in snapshots if current_contract(row)]}

    def publish_empty_snapshot(self, *, posting, expected_revision, fields, extraction_receipt, attempt_id,
                               cancelled, posting_guard, connection=None):
        """Publish a proved empty reusable set without inventing semantic work.

        Language exclusions and direct-only/empty postings create no capability
        or normalized reusable demand. The extraction receipt is their complete
        authority; retained catalog identity and its certificate stay untouched.
        """
        with (self.database.transaction() if connection is None else nullcontext(connection)) as connection:
            if cancelled():
                raise RequirementError("cancelled")
            posting_guard(posting["job_id"], posting["revision"], posting["source_hash"], connection=connection)
            previous = self.current_snapshot(posting["job_id"], connection)
            if (previous["revision"] if previous else 0) != expected_revision:
                raise ConflictError("The accepted requirement snapshot changed.")
            epoch = connection.execute("SELECT revision FROM requirements_catalog WHERE singleton=1").fetchone()[0]
            snapshot = {"contract_version": extraction_receipt["contract_version"], **fields,
                "job_id": posting["job_id"], "revision": expected_revision + 1,
                "posting_revision": posting["revision"], "posting_hash": posting["source_hash"],
                "source_id": posting["source_id"], "source_revision": posting["source_revision"],
                "catalog_revision": epoch, "requirements": [], "created_at": now(),
                "extraction_determination_id": extraction_receipt["receipt_id"],
                "normalization_version": NORMALIZATION_VERSION,
                "normalization_provenance": {"kind": "empty_reusable_inventory", "extraction": extraction_receipt,
                                             "normalization_version": NORMALIZATION_VERSION}}
            connection.execute("INSERT INTO requirements_snapshots VALUES (?,?,?,?,?,?,?,?,?)",
                (posting["job_id"], snapshot["revision"], posting["revision"], posting["source_hash"], epoch,
                 extraction_receipt["receipt_id"], canonical_json(snapshot), attempt_id, snapshot["created_at"]))
            connection.execute("INSERT INTO requirements_accepted VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET revision=excluded.revision",
                               (posting["job_id"], snapshot["revision"]))
            connection.execute("UPDATE requirements_attempts SET state='accepted',completed_at=? WHERE attempt_id=?", (now(), attempt_id))
            if cancelled():
                raise RequirementError("cancelled")
            self.events.append(connection, "RequirementsUpdated", {"jobId": posting["job_id"], "revision": snapshot["revision"],
                "catalogRevision": epoch}, feature="requirements", aggregate_id=posting["job_id"])
            return snapshot

    def assert_normalization_capture(self, captured, connection):
        current = self.normalization_capture(connection)
        if current["catalog_revision"] != captured["catalog_revision"]:
            raise RequirementError("catalog_changed")
        if canonical_json(current) != canonical_json(captured):
            raise ConflictError("The complete retained requirement sources changed during consolidation.")

    def normalization_certificate(self, connection=None):
        if connection is None:
            with self.read_session() as connection:
                return self.normalization_certificate(connection)
        row = connection.execute("SELECT * FROM requirements_reconciliation_certificate WHERE singleton=1").fetchone()
        if row is None:
            return None
        return {"catalog_revision": row["catalog_revision"], "normalization_version": row["normalization_version"],
                "input_fingerprint": row["input_fingerprint"], "reconciliation_id": row["reconciliation_id"],
                "authority": json.loads(row["authority_json"])}

    def normalization_action(self, operation_id, input_fingerprint):
        with self.read_session() as connection:
            row = connection.execute("SELECT * FROM requirements_reconciliations WHERE operation_id=?", (operation_id,)).fetchone()
            if row is None:
                return None
            if row["action_fingerprint"] != input_fingerprint:
                raise ConflictError("The consolidation operation ID belongs to another input.")
            stored = json.loads(row["report_json"])
            if "storage_version" in stored:
                if stored["storage_version"] not in (CITATION_BINDER_VERSION, NORMALIZATION_V4_BINDING_VERSION, NORMALIZATION_BINDING_VERSION):
                    raise RequirementError("requirements_citation_wire_changed")
                return stored["report"]
            return stored

    def normalization_model_call(self, input_fingerprint):
        with self.read_session() as connection:
            row = connection.execute("SELECT * FROM requirements_normalization_cache WHERE input_fingerprint=?", (input_fingerprint,)).fetchone()
            if row is None:
                return None
            return {"input_fingerprint": row["input_fingerprint"], "operation": row["operation"],
                    "result": json.loads(row["result_json"]), "provenance": json.loads(row["provenance_json"])}

    def assert_normalization_call_available(self, operation_id, input_fingerprint, connection=None):
        with self.read_session() if connection is None else nullcontext(connection) as connection:
            previous = connection.execute("SELECT input_fingerprint FROM requirements_normalization_intents WHERE operation_id=?",
                                          (operation_id,)).fetchone()
        if previous is not None:
            if previous["input_fingerprint"] != input_fingerprint:
                raise ConflictError("The consolidation operation's complete semantic input changed. Start a new explicit operation.")
            raise RequirementError("requirements_consolidation_call_unsettled")

    def reserve_normalization_call(self, operation_id, input_fingerprint, guard, *, connection):
        """An interrupted unreceipted dispatch cannot spend another allowance."""
        guard(connection)
        self.assert_normalization_call_available(operation_id, input_fingerprint, connection)
        connection.execute("INSERT INTO requirements_normalization_intents VALUES (?,?,?,?)",
                           (operation_id, input_fingerprint, NORMALIZATION_VERSION, now()))
        return 1

    def save_normalization_model_call(self, *, input_fingerprint, operation, catalog_revision, result, provenance, guard):
        with self.database.transaction() as connection:
            guard(connection)
            epoch = connection.execute("SELECT revision FROM requirements_catalog WHERE singleton=1").fetchone()[0]
            if epoch != catalog_revision:
                raise RequirementError("catalog_changed")
            connection.execute("INSERT INTO requirements_normalization_cache VALUES (?,?,?,?,?,?) "
                               "ON CONFLICT(input_fingerprint) DO NOTHING",
                (input_fingerprint, operation, catalog_revision, canonical_json(result), canonical_json(provenance), now()))
        return self.normalization_model_call(input_fingerprint)

    def publish_normalization(self, *, captured, meanings, aliases, replacements, operation_id, input_fingerprint,
                              decision, selection, intermediate_selection, partition_binding, citation_binding,
                              receipt, authority_receipt, report, guard, cancelled, revision_action=None):
        if (canonical_json(authority_receipt["value"]) != canonical_json(selection)
                or fingerprint(selection) != partition_binding["raw_selection_fingerprint"]
                or fingerprint(intermediate_selection) != partition_binding["intermediate_fingerprint"]
                or partition_binding["intermediate_fingerprint"] != citation_binding["selection_fingerprint"]
                or fingerprint(decision) != citation_binding["derived_fingerprint"]
                or receipt["accepted_result_fingerprint"] != partition_binding["raw_selection_fingerprint"]):
            raise RequirementError("model_cache_receipt_invalid")
        with self.database.transaction() as connection:
            if cancelled():
                raise RequirementError("cancelled")
            self.assert_normalization_capture(captured, connection)
            guard(connection)
            for meaning in meanings:
                connection.execute("INSERT INTO requirements_meanings VALUES (?,?,?,?,?)",
                    (meaning["requirement_id"], meaning["revision"], self._document(meaning),
                     canonical_json(meaning["provenance"]), meaning["created_at"]))
                connection.execute("INSERT INTO requirements_heads VALUES (?,?) ON CONFLICT(requirement_id) "
                                   "DO UPDATE SET revision=excluded.revision", (meaning["requirement_id"], meaning["revision"]))
            for ident, root in aliases.items():
                if ident == root:
                    connection.execute("DELETE FROM requirements_aliases WHERE requirement_id=?", (ident,))
                else:
                    connection.execute("INSERT INTO requirements_aliases VALUES (?,?,?,?) ON CONFLICT(requirement_id) "
                        "DO UPDATE SET root_requirement_id=excluded.root_requirement_id,reconciliation_id=excluded.reconciliation_id,created_at=excluded.created_at",
                        (ident, root, operation_id, now()))
            old_aliases = {row["requirement_id"]: row["root_requirement_id"] for row in captured["aliases"]}
            changed = bool(meanings or replacements) or any(old_aliases.get(ident, ident) != root for ident, root in aliases.items())
            epoch = captured["catalog_revision"] + int(changed)
            connection.execute("DELETE FROM requirements_retrieval")
            for meaning in self.normalization_capture(connection)["roots"]:
                connection.execute("INSERT INTO requirements_retrieval(requirement_id,revision,document) VALUES (?,?,?)",
                                   (meaning["requirement_id"], meaning["revision"], self._document(meaning)))
            connection.execute("UPDATE requirements_catalog SET revision=?,indexed_revision=? WHERE singleton=1", (epoch, epoch))
            affected = []
            for snapshot in replacements:
                snapshot = {**snapshot, "catalog_revision": epoch}
                job_id = snapshot["job_id"]
                attempt_id = snapshot.pop("_attempt_id")
                connection.execute("INSERT INTO requirements_snapshots VALUES (?,?,?,?,?,?,?,?,?)",
                    (job_id, snapshot["revision"], snapshot["posting_revision"], snapshot["posting_hash"], epoch,
                     snapshot["extraction_determination_id"], canonical_json(snapshot), attempt_id, snapshot["created_at"]))
                connection.execute("INSERT INTO requirements_accepted VALUES (?,?) ON CONFLICT(job_id) "
                                   "DO UPDATE SET revision=excluded.revision", (job_id, snapshot["revision"]))
                for row in snapshot["requirements"]:
                    connection.execute("INSERT INTO requirements_occurrences VALUES (?,?,?,?,?,?)",
                        (row["occurrence_id"], job_id, snapshot["revision"], row["requirement_id"],
                         row["requirement_revision"], canonical_json(row)))
                connection.execute("UPDATE requirements_attempts SET state='accepted',completed_at=? WHERE attempt_id=?",
                                   (now(), attempt_id))
                affected.append({"job_id": job_id, "revision": snapshot["revision"]})
                self.events.append(connection, "RequirementsUpdated", {"jobId": job_id, "revision": snapshot["revision"],
                    "catalogRevision": epoch}, feature="requirements", aggregate_id=job_id)
            if revision_action is not None:
                connection.execute("INSERT INTO requirements_revision_actions VALUES (?,?,?,?)",
                    (revision_action["operation_id"], revision_action["input_fingerprint"],
                     revision_action["requirement_id"], revision_action["revision"]))
            report = {**report, "catalog_revision": epoch, "affected_jobs": affected,
                      "normalization_version": NORMALIZATION_VERSION, "reconciliation_id": operation_id,
                      "input_fingerprint": receipt["input_fingerprint"], "receipt": receipt}
            authority = {"member_roots": aliases, "root_heads": report["roots"],
                         "decision_fingerprint": fingerprint(selection),
                         "intermediate_fingerprint": partition_binding["intermediate_fingerprint"],
                         "derived_fingerprint": fingerprint(decision),
                         "partition_binding": partition_binding_summary(partition_binding),
                         "citation_binding": citation_binding_summary(citation_binding), "receipt": receipt,
                         "corrections": decision["corrections"]}
            stored_report = {"storage_version": NORMALIZATION_BINDING_VERSION, "report": report,
                             "intermediate_selection": intermediate_selection, "partition_binding": partition_binding,
                             "derived_decision": decision, "citation_binding": citation_binding}
            connection.execute("INSERT INTO requirements_reconciliations VALUES (?,?,?,?,?,?,?,?,?)",
                (operation_id, input_fingerprint, receipt["input_fingerprint"], captured["catalog_revision"], epoch, canonical_json(selection),
                 canonical_json(authority_receipt), canonical_json(stored_report), now()))
            connection.execute("INSERT INTO requirements_reconciliation_certificate VALUES (1,?,?,?,?,?) "
                               "ON CONFLICT(singleton) DO UPDATE SET catalog_revision=excluded.catalog_revision,"
                               "normalization_version=excluded.normalization_version,input_fingerprint=excluded.input_fingerprint,"
                               "reconciliation_id=excluded.reconciliation_id,authority_json=excluded.authority_json",
                (epoch, NORMALIZATION_VERSION, receipt["input_fingerprint"], operation_id, canonical_json(authority)))
            if cancelled():
                raise RequirementError("cancelled")
            self.events.append(connection, "RequirementsConsolidated", {"catalogRevision": epoch,
                "rootCount": len(report["roots"]), "affectedJobCount": len(affected)}, feature="requirements", aggregate_id="catalog")
            return report
