"""SQLite adapter; only requirement-owned tables are read or written here."""

from __future__ import annotations

import json
from contextlib import contextmanager

from jobctrl.app.errors import ConflictError, NotFoundError

from .domain import RequirementError, canonical_json, now


class SqliteRequirementStore:
    def __init__(self, database, events):
        self.database = database
        self.events = events

    @contextmanager
    def read_session(self):
        with self.database.connect() as connection:
            connection.execute("BEGIN")
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

    def job_bindings(self, job_ids, connection):
        if not job_ids:
            return {}
        placeholders = ",".join("?" for _ in job_ids)
        rows = connection.execute(
            "SELECT s.job_id,s.revision,s.posting_revision,s.posting_hash, "
            "(SELECT json_group_array(json_object( "
            "'requirement_id',json_extract(item.value,'$.requirement_id'), "
            "'accepted_revision',json_extract(item.value,'$.requirement_revision'), "
            "'current_revision',h.revision)) "
            "FROM json_each(s.snapshot_json,'$.requirements') item "
            "LEFT JOIN requirements_heads h ON h.requirement_id=json_extract(item.value,'$.requirement_id')) AS bindings_json "
            "FROM requirements_accepted a JOIN requirements_snapshots s ON s.job_id=a.job_id AND s.revision=a.revision "
            f"WHERE a.job_id IN ({placeholders})", tuple(job_ids),
        ).fetchall()
        bindings = {}
        for row in rows:
            records = json.loads(row["bindings_json"])
            accepted = {(item["requirement_id"], item["accepted_revision"]) for item in records}
            current = {(item["requirement_id"], item["current_revision"]) for item in records if item["current_revision"] is not None}
            bindings[row["job_id"]] = {
                "revision": row["revision"], "posting_revision": row["posting_revision"], "posting_hash": row["posting_hash"],
                "stale": any(item["accepted_revision"] != item["current_revision"] for item in records),
                "requirement_revisions": [{"requirement_id": ident, "requirement_revision": revision} for ident, revision in sorted(accepted)],
                "current_requirement_revisions": [{"requirement_id": ident, "requirement_revision": revision} for ident, revision in sorted(current)],
            }
        return bindings

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

    def catalog_snapshot(self, query):
        with self.database.connect() as connection:
            # A read transaction binds index, heads and epoch to one snapshot.
            connection.execute("BEGIN")
            meta = connection.execute("SELECT revision,indexed_revision FROM requirements_catalog WHERE singleton=1").fetchone()
            if meta[0] != meta[1]:
                raise RequirementError("retrieval_index_stale")
            rows = connection.execute(
                "SELECT m.* FROM requirements_heads h JOIN requirements_meanings m "
                "ON m.requirement_id=h.requirement_id AND m.revision=h.revision ORDER BY m.requirement_id"
            ).fetchall()
            meanings = [self._meaning(row) for row in rows]
            index = connection.execute("SELECT requirement_id,revision,document FROM requirements_retrieval").fetchall()
            expected = {(m["requirement_id"], m["revision"]): self._document(m) for m in meanings}
            actual = {(r[0], int(r[1])): r[2] for r in index}
            if len(index) != len(actual) or actual != expected:
                raise RequirementError("retrieval_index_stale")
            # FTS is ONLY a retrieval order. Every non-retrieved candidate is
            # still scanned before newness; no score or cutoff decides meaning.
            preferred = []
            if query.strip():
                literal_phrase = '"' + query.replace('"', '""') + '"'
                preferred = [r[0] for r in connection.execute(
                    "SELECT requirement_id FROM requirements_retrieval WHERE requirements_retrieval MATCH ? "
                    "ORDER BY bm25(requirements_retrieval), requirement_id LIMIT 16", (literal_phrase,),
                )]
            rank = {ident: index for index, ident in enumerate(preferred)}
            meanings.sort(key=lambda m: (rank.get(m["requirement_id"], len(rank)), m["requirement_id"]))
            return int(meta[0]), meanings

    def retrieval_ids(self, query, catalog_revision):
        with self.read_session() as connection:
            meta = connection.execute("SELECT revision,indexed_revision FROM requirements_catalog WHERE singleton=1").fetchone()
            if meta[0] != catalog_revision:
                raise RequirementError("catalog_changed")
            if meta[1] != meta[0]:
                raise RequirementError("retrieval_index_stale")
            if not query.strip():
                return []
            literal_phrase = '"' + query.replace('"', '""') + '"'
            return [row[0] for row in connection.execute(
                "SELECT requirement_id FROM requirements_retrieval WHERE requirements_retrieval MATCH ? "
                "ORDER BY bm25(requirements_retrieval),requirement_id LIMIT 16", (literal_phrase,),
            )]

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

    @staticmethod
    def _document(meaning):
        return canonical_json({k: meaning[k] for k in ("definition", "qualifiers", "scope")})

    def catalog(self, *, limit=50, offset=0, query=""):
        revision, meanings = self.catalog_snapshot(query)
        # q is a literal catalog filter, never equivalence or novelty authority.
        if query:
            meanings = [row for row in meanings if query.casefold() in self._document(row).casefold()]
        return {"catalog_revision": revision, "total": len(meanings), "requirements": meanings[offset:offset + limit]}

    def index_status(self):
        with self.read_session() as connection:
            meta = connection.execute("SELECT revision,indexed_revision FROM requirements_catalog WHERE singleton=1").fetchone()
            meanings = [self._meaning(row) for row in connection.execute(
                "SELECT m.* FROM requirements_heads h JOIN requirements_meanings m "
                "ON m.requirement_id=h.requirement_id AND m.revision=h.revision",
            )]
            indexed = connection.execute("SELECT requirement_id,revision,document FROM requirements_retrieval").fetchall()
            expected = {(m["requirement_id"], m["revision"]): self._document(m) for m in meanings}
            actual = {(row[0], int(row[1])): row[2] for row in indexed}
            return {"catalog_revision": meta[0], "indexed_revision": meta[1], "meaning_count": len(meanings),
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

    def delete_job_data(self, job_id, connection=None):
        if connection is None:
            with self.database.transaction() as connection:
                return self.delete_job_data(job_id, connection)
        # Jobs owns deletion authorization and the enclosing transaction. Only
        # private per-job requirement state is removed here; reusable catalog
        # meanings and immutable model authority remain independently owned.
        connection.execute("DELETE FROM requirements_occurrences WHERE job_id=?", (job_id,))
        connection.execute("DELETE FROM requirements_accepted WHERE job_id=?", (job_id,))
        connection.execute("DELETE FROM requirements_snapshots WHERE job_id=?", (job_id,))
        connection.execute("DELETE FROM requirements_attempts WHERE job_id=?", (job_id,))
        connection.execute("DELETE FROM requirements_model_cache WHERE job_id=?", (job_id,))

    def latest_attempt(self, job_id, connection=None):
        if connection is None:
            with self.database.connect() as connection:
                return self.latest_attempt(job_id, connection)
        row = connection.execute(
            "SELECT * FROM requirements_attempts WHERE job_id=? ORDER BY started_at DESC,attempt_id DESC LIMIT 1", (job_id,),
        ).fetchone()
        return dict(row) if row else None

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

    def accepted_action(self, attempt_id, input_fingerprint):
        with self.read_session() as connection:
            attempt = connection.execute("SELECT * FROM requirements_attempts WHERE attempt_id=?", (attempt_id,)).fetchone()
            if attempt is None:
                return None
            if attempt["input_fingerprint"] != input_fingerprint:
                raise ConflictError("The requirement action ID belongs to another input.")
            row = connection.execute("SELECT snapshot_json FROM requirements_snapshots WHERE attempt_id=?", (attempt_id,)).fetchone()
            return json.loads(row[0]) if row else None

    def accepted_revision_action(self, operation_id, input_fingerprint):
        with self.read_session() as connection:
            row = connection.execute("SELECT * FROM requirements_revision_actions WHERE action_id=?", (operation_id,)).fetchone()
            if row is None:
                return None
            if row["input_fingerprint"] != input_fingerprint:
                raise ConflictError("The requirement action ID belongs to another input.")
            meaning = self.get_meaning(row["requirement_id"], row["revision"], connection)
            head = self.get_meaning(row["requirement_id"], connection=connection)
            return {**meaning, "stale": head["revision"] != meaning["revision"], "reused_action": True}

    def finish_attempt(self, attempt_id, state, failure_code=None):
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE requirements_attempts SET state=?,failure_code=?,completed_at=? "
                "WHERE attempt_id=? AND state='running'", (state, failure_code, now(), attempt_id),
            )

    def revise_meaning(self, *, revised, expected_revision, catalog_revision, posting, posting_guard, cancelled,
                       operation_id=None, input_fingerprint=None):
        with self.database.transaction() as connection:
            if cancelled():
                raise RequirementError("cancelled")
            posting_guard(posting["job_id"], posting["revision"], posting["source_hash"], connection=connection)
            current = self.get_meaning(revised["requirement_id"], connection=connection)
            if current["revision"] != expected_revision:
                raise ConflictError("The canonical requirement changed.")
            epoch = connection.execute("SELECT revision FROM requirements_catalog WHERE singleton=1").fetchone()[0]
            if epoch != catalog_revision:
                raise RequirementError("catalog_changed")
            connection.execute(
                "INSERT INTO requirements_meanings VALUES (?,?,?,?,?)",
                (revised["requirement_id"], revised["revision"], self._document(revised),
                 canonical_json(revised["provenance"]), revised["created_at"]),
            )
            connection.execute("UPDATE requirements_heads SET revision=? WHERE requirement_id=?",
                               (revised["revision"], revised["requirement_id"]))
            connection.execute("DELETE FROM requirements_retrieval WHERE requirement_id=?", (revised["requirement_id"],))
            connection.execute("INSERT INTO requirements_retrieval(requirement_id,revision,document) VALUES (?,?,?)",
                               (revised["requirement_id"], revised["revision"], self._document(revised)))
            connection.execute("UPDATE requirements_catalog SET revision=?,indexed_revision=? WHERE singleton=1", (epoch + 1, epoch + 1))
            if operation_id:
                connection.execute("INSERT INTO requirements_revision_actions VALUES (?,?,?,?)",
                                   (operation_id, input_fingerprint, revised["requirement_id"], revised["revision"]))
            if cancelled():
                raise RequirementError("cancelled")
            self.events.append(connection, "RequirementMeaningRevised", {
                "requirementId": revised["requirement_id"], "revision": revised["revision"], "catalogRevision": epoch + 1,
            }, feature="requirements", aggregate_id=revised["requirement_id"])
            return revised

    def assert_snapshot_current(self, snapshot, connection):
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

    def publish(
        self, *, posting, expected_revision, catalog_revision, meanings, occurrences,
        extraction_id, attempt_id, posting_guard, cancelled, event_type="RequirementsUpdated",
    ):
        with self.database.transaction() as connection:
            if cancelled():
                raise RequirementError("cancelled")
            posting_guard(posting["job_id"], posting["revision"], posting["source_hash"], connection=connection)
            previous = self.current_snapshot(posting["job_id"], connection)
            if (previous["revision"] if previous else 0) != expected_revision:
                raise ConflictError("The accepted requirement snapshot changed.")
            actual_catalog = connection.execute(
                "SELECT revision FROM requirements_catalog WHERE singleton=1",
            ).fetchone()[0]
            if actual_catalog != catalog_revision:
                raise RequirementError("catalog_changed")
            for meaning in meanings:
                connection.execute(
                    "INSERT INTO requirements_meanings VALUES (?,?,?,?,?)",
                    (meaning["requirement_id"], meaning["revision"], self._document(meaning),
                     canonical_json(meaning["provenance"]), meaning["created_at"]),
                )
                connection.execute("INSERT INTO requirements_heads VALUES (?,?)", (meaning["requirement_id"], meaning["revision"]))
                connection.execute(
                    "INSERT INTO requirements_retrieval(requirement_id,revision,document) VALUES (?,?,?)",
                    (meaning["requirement_id"], meaning["revision"], self._document(meaning)),
                )
            new_catalog_revision = catalog_revision + len(meanings)
            connection.execute(
                "UPDATE requirements_catalog SET revision=?,indexed_revision=? WHERE singleton=1",
                (new_catalog_revision, new_catalog_revision),
            )
            snapshot = {
                "job_id": posting["job_id"], "revision": expected_revision + 1,
                "posting_revision": posting["revision"], "posting_hash": posting["source_hash"],
                "source_id": posting["source_id"], "source_revision": posting["source_revision"],
                "catalog_revision": new_catalog_revision, "requirements": occurrences,
                "extraction_determination_id": extraction_id, "created_at": now(),
            }
            connection.execute(
                "INSERT INTO requirements_snapshots VALUES (?,?,?,?,?,?,?,?,?)",
                (posting["job_id"], snapshot["revision"], posting["revision"], posting["source_hash"],
                 new_catalog_revision, extraction_id, canonical_json(snapshot), attempt_id, snapshot["created_at"]),
            )
            connection.execute(
                "INSERT INTO requirements_accepted VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET revision=excluded.revision",
                (posting["job_id"], snapshot["revision"]),
            )
            for row in occurrences:
                connection.execute(
                    "INSERT INTO requirements_occurrences VALUES (?,?,?,?,?,?)",
                    (row["occurrence_id"], posting["job_id"], snapshot["revision"], row["requirement_id"],
                     row["requirement_revision"], canonical_json(row)),
                )
            connection.execute(
                "UPDATE requirements_attempts SET state='accepted',completed_at=? WHERE attempt_id=?", (now(), attempt_id),
            )
            if cancelled():
                raise RequirementError("cancelled")
            self.events.append(
                connection, event_type, {"jobId": posting["job_id"], "revision": snapshot["revision"],
                "catalogRevision": new_catalog_revision}, feature="requirements", aggregate_id=posting["job_id"],
            )
            return snapshot
