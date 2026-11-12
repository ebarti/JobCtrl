"""Atomic maintained-wording heads/history, with one head per requirement pair."""

from __future__ import annotations

from contextlib import nullcontext
import json

from jobctrl.app.errors import AppError, ConflictError, NotFoundError

from .current_wording import ASSIGNMENT_PINS, assignment_reasons, assignment_view, require_current_assignment
from .current_wording_authority import validate_selection
from .qualification import now
from .serialization import encoded
from .sources import achievements, dto, fact_fingerprint, fingerprint


SCHEMA = """
CREATE TABLE fit_current_wordings (
    assignment_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    achievement_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    state TEXT NOT NULL CHECK(state IN ('active','removed')),
    assignment_json TEXT NOT NULL,
    UNIQUE(profile_id,achievement_id,requirement_id)
);
CREATE TABLE fit_current_wording_versions (
    assignment_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    assignment_json TEXT NOT NULL,
    PRIMARY KEY(assignment_id,revision)
);
"""


class CurrentWordingStorage:
    @staticmethod
    def _guard_manual_replacement(request, heads, read, profile, resulting_heads=None):
        variant = next(row for row in profile["approved_variants"] if row["variant_id"] == request["variant_id"])
        provenance = variant.get("provenance", {})
        replacements = provenance.get("replaces_variant_ids", [])
        if provenance.get("replaces_variant_id"):
            replacements = [*replacements, {"variant_id": provenance["replaces_variant_id"],
                                           "variant_revision": provenance.get("replaces_variant_revision")}]
        prior = {(row["variant_id"], str(row["variant_revision"])) for row in replacements}
        required = set(provenance.get("intended_requirement_ids", []))
        required.update(row["requirement_id"] for row in heads if row["state"] == "active"
                        and (row["variant_id"], str(row["variant_revision"])) in prior)
        for ident in required - {request["requirement_id"]}:
            mapped = next((row for row in (heads if resulting_heads is None else resulting_heads)
                           if row["state"] == "active" and row["requirement_id"] == ident
                           and row["achievement_id"] == request["achievement_id"]), None)
            if (mapped is None or any(str(mapped[key]) != str(request[key]) for key in ("variant_id", "variant_revision", "approval_id"))
                    or assignment_reasons(mapped, read, profile)):
                raise AppError("fit_wording_consolidation_required",
                    "Update affected matches to activate this revision across its complete replacement requirement set.", 409)

    @staticmethod
    def _guard_manual_variants(request, heads):
        def exact(row):
            return row["variant_id"], str(row["variant_revision"]), row["approval_id"]
        active = [row for row in heads if row["state"] == "active"]
        resulting = {exact(row) for row in active if row["requirement_id"] != request["requirement_id"]} | {exact(request)}
        if len(resulting) > 1:
            raise AppError("fit_wording_consolidation_required",
                "Update affected matches to review the complete requirement set before maintaining another wording.", 409)

    def current_wording_heads(self, profile_id, achievement_ids=None, connection=None):
        def load(conn):
            rows = [json.loads(row[0]) for row in conn.execute(
                "SELECT assignment_json FROM fit_current_wordings WHERE profile_id=? ORDER BY achievement_id,requirement_id",
                (profile_id,),
            )]
            return rows if achievement_ids is None else [row for row in rows if row["achievement_id"] in achievement_ids]
        return self._read(load, connection)

    def current_wordings(self, profile_id, achievement_ids=None, connection=None):
        return [row for row in self.current_wording_heads(profile_id, achievement_ids, connection) if row["state"] == "active"]

    def current_wordings_fingerprint(self, profile_id, achievement_ids=None, connection=None):
        return fingerprint(self.current_wordings(profile_id, achievement_ids, connection))

    def _write_current_wording(self, connection, record):
        connection.execute(
            "INSERT INTO fit_current_wordings VALUES(?,?,?,?,?,?,?) ON CONFLICT(assignment_id) DO UPDATE SET "
            "revision=excluded.revision,state=excluded.state,assignment_json=excluded.assignment_json",
            (record["assignment_id"], record["profile_id"], record["achievement_id"], record["requirement_id"],
             record["revision"], record["state"], encoded(record)),
        )
        connection.execute("INSERT INTO fit_current_wording_versions VALUES(?,?,?)",
                           (record["assignment_id"], record["revision"], encoded(record)))
        self._event(connection, "FitCurrentWordingUpdated", {"profileId": record["profile_id"],
                    "assignmentId": record["assignment_id"], "requirementId": record["requirement_id"],
                    "achievementId": record["achievement_id"], "revision": record["revision"]}, record["profile_id"])

    def _activate_current_wording(self, connection, pins, previous, profile, selection_provenance, request_fingerprint=None):
        pins = {**pins, "requirement_revision": int(pins["requirement_revision"]), "variant_revision": int(pins["variant_revision"])}
        if (previous is not None and previous["state"] == "active" and all(previous[key] == pins[key] for key in ASSIGNMENT_PINS)
                and previous["selection_provenance"] == selection_provenance):
            return previous
        created = now()
        record = {**{key: pins[key] for key in ASSIGNMENT_PINS},
            "assignment_id": previous["assignment_id"] if previous else "fit-wording-" + fingerprint({key: pins[key]
                for key in ("profile_id", "achievement_id", "requirement_id")}),
            "revision": previous["revision"] + 1 if previous else 1, "state": "active",
            "profile_revision": profile["profile_revision"], "fact_semantics_version": profile["fact_semantics_version"],
            "achievement_source_refs": achievements(profile)[pins["achievement_id"]]["source_refs"],
            "selection_provenance": selection_provenance,
            "created_at": previous["created_at"] if previous else created, "updated_at": created}
        if request_fingerprint is not None:
            record["last_request_fingerprint"] = request_fingerprint
        self._write_current_wording(connection, record)
        return record

    def set_current_wording(self, request):
        with self._database.transaction() as connection:
            with self.read_snapshot(connection) as read:
                profile = dto(read.profile_snapshot(request["profile_id"]))
                heads = read.current_wording_heads(request["profile_id"], [request["achievement_id"]])
                previous = next((row for row in heads if row["requirement_id"] == request["requirement_id"]), None)
                replay_fingerprint = fingerprint({"operation": "set", "request": request})
                if (previous is not None and previous["revision"] == request["expected_revision"] + 1
                        and previous.get("last_request_fingerprint") == replay_fingerprint):
                    return assignment_view(previous, read, profile)
                if profile["profile_revision"] != request["expected_profile_revision"]:
                    raise ConflictError("The reviewed Profile changed before wording selection.")
                if (previous["revision"] if previous else 0) != request["expected_revision"]:
                    raise ConflictError("The maintained wording changed. Review its current assignment.")
                require_current_assignment(request, read, profile)
                if (previous is not None and previous["state"] == "active"
                        and all(str(previous[key]) == str(request[key]) for key in ASSIGNMENT_PINS)):
                    return assignment_view(previous, read, profile)
                self._guard_manual_replacement(request, heads, read, profile)
                self._guard_manual_variants(request, heads)
                accepted = self._activate_current_wording(connection, request, previous, profile,
                    {"kind": "user", "origin": "user"}, request_fingerprint=replay_fingerprint)
                return assignment_view(accepted, read, profile)

    def publish_current_wordings(self, assignments, expected_assignments_fingerprint, profile_snapshot,
                                requirements_snapshot, selection_provenance, connection=None, achievement_ids=None,
                                *, cancelled=lambda: False):
        """Replace a complete selected achievement group, never discard unknown support."""
        profile = dto(profile_snapshot)
        selected_ids = set(achievement_ids if achievement_ids is not None else [row["achievement_id"] for row in assignments])
        pairs = {(row["achievement_id"], row["requirement_id"]) for row in assignments}
        if (not selected_ids or len(pairs) != len(assignments) or any(
                row["profile_id"] != profile["profile_id"] or row["achievement_id"] not in selected_ids for row in assignments)):
            raise AppError("fit_current_wording_scope_invalid", "Supply one exact assignment per selected requirement and achievement.", 422)
        with self._database.transaction() if connection is None else nullcontext(connection) as conn:
            if not conn.in_transaction:
                raise RuntimeError("Maintained wording publication requires a write transaction")
            self._check_cancelled(cancelled)
            operation_id = selection_provenance.get("operation_id")
            operation_state = None
            if operation_id:
                operation_state = self._running_refresh(conn, operation_id)
                if operation_state["profile_id"] != profile["profile_id"]:
                    raise ConflictError("The wording selection belongs to a different manual refresh.")
                expected_global = operation_state.get("accepted_wordings_fingerprint",
                    operation_state["snapshot"].get("current_wordings_fingerprint"))
                if expected_global is None:
                    raise ConflictError("The manual refresh has no admitted wording snapshot. Start a new update.")
                # A group-local CAS cannot fence a manual writer in another
                # achievement. Check the operation's original/last-own global
                # snapshot under the same writer lock before any publication.
                self._assert_refresh_inputs(conn, operation_state)
            self._assert_sources(conn, profile_snapshot, requirements_snapshot, full_profile=True)
            with self.read_snapshot(conn) as read:
                heads = read.current_wording_heads(profile["profile_id"], selected_ids)
                previous = {(row["achievement_id"], row["requirement_id"]): row for row in heads}
                exact_replay = False
                if read.current_wordings_fingerprint(profile["profile_id"], selected_ids) != expected_assignments_fingerprint:
                    active = {pair: row for pair, row in previous.items() if row["state"] == "active"}
                    exact_replay = (bool(selection_provenance.get("group_key")) and set(active) == pairs
                        and (bool(assignments) or bool(heads) and all(row["selection_provenance"] == selection_provenance for row in heads))
                        and all(active[(row["achievement_id"], row["requirement_id"])]["selection_provenance"] == selection_provenance
                            and all(str(active[(row["achievement_id"], row["requirement_id"])][key]) == str(row[key]) for key in ASSIGNMENT_PINS)
                            for row in assignments))
                    if not exact_replay:
                        raise ConflictError("The maintained wording group changed during review.")
                for row in assignments:
                    require_current_assignment(row, read, profile)
                if not exact_replay:
                    validate_selection(assignments, previous, selection_provenance, read, profile)
                prospective = [{**row, "state": "active"} for row in assignments]
                for row in assignments:
                    self._guard_manual_replacement(row, heads, read, profile, resulting_heads=prospective)
                for pair, row in previous.items():
                    if row["state"] != "active" or pair in pairs:
                        continue
                    requirement = read.requirement(row["requirement_id"])
                    assessment = read.latest_assessment(profile["profile_id"], row["requirement_id"], requirement["revision"],
                                                        source_fingerprint=fact_fingerprint(profile))
                    if (assessment is None or assessment["source_fingerprint"] != fact_fingerprint(profile)
                            or str(assessment["requirement_revision"]) != str(requirement["revision"])
                            or row["achievement_id"] in assessment["achievement_ids"]):
                        raise ConflictError("The complete maintained wording group must retain every supported requirement.")
                accepted = [self._activate_current_wording(conn, row, previous.get((row["achievement_id"], row["requirement_id"])),
                            profile, selection_provenance) for row in assignments]
                for pair, row in previous.items():
                    if row["state"] == "active" and pair not in pairs:
                        self._write_current_wording(conn, {**row, "revision": row["revision"] + 1, "state": "removed",
                                                    "updated_at": now(), "selection_provenance": selection_provenance})
                if operation_state is not None:
                    operation_state["accepted_wordings_fingerprint"] = read.current_wordings_fingerprint(profile["profile_id"])
                    self._write_refresh(conn, operation_state)
                self._check_cancelled(cancelled)
                return accepted

    def set_current_wording_state(self, assignment_id, request):
        with self._database.transaction() as connection:
            row = connection.execute("SELECT assignment_json FROM fit_current_wordings WHERE profile_id=? AND assignment_id=?",
                                     (request["profile_id"], assignment_id)).fetchone()
            if row is None:
                raise NotFoundError("The maintained wording assignment does not exist.")
            previous = json.loads(row[0])
            with self.read_snapshot(connection) as read:
                try:
                    profile = dto(read.profile_snapshot(request["profile_id"]))
                except NotFoundError:
                    profile = None
                replay_fingerprint = fingerprint({"operation": "state", "assignment_id": assignment_id, "request": request})
                if (previous["revision"] == request["expected_revision"] + 1
                        and previous.get("last_request_fingerprint") == replay_fingerprint):
                    return assignment_view(previous, read, profile)
                if previous["revision"] != request["expected_revision"]:
                    raise ConflictError("The maintained wording assignment changed.")
                if request["state"] == "active":
                    require_current_assignment(previous, read, profile)
                if previous["state"] == request["state"]:
                    return assignment_view(previous, read, profile)
                if request["state"] == "active":
                    heads = read.current_wording_heads(request["profile_id"], [previous["achievement_id"]])
                    self._guard_manual_replacement(previous, heads, read, profile)
                    self._guard_manual_variants(previous, heads)
                accepted = {**previous, "state": request["state"], "revision": previous["revision"] + 1,
                            "selection_provenance": {"kind": "user", "origin": "user"},
                            "last_request_fingerprint": replay_fingerprint, "updated_at": now()}
                self._write_current_wording(connection, accepted)
                return assignment_view(accepted, read, profile)

    def current_wording_history(self, assignment_id, profile_id, *, limit=50, offset=0):
        with self.read_snapshot() as read:
            return read.current_wording_history(assignment_id, profile_id, limit=limit, offset=offset)

    def _current_wording_history(self, assignment_id, profile_id, *, limit, offset, connection):
        head = connection.execute("SELECT revision FROM fit_current_wordings WHERE assignment_id=? AND profile_id=?",
                                  (assignment_id, profile_id)).fetchone()
        if head is None:
            raise NotFoundError("The maintained wording assignment does not exist.")
        with self.read_snapshot(connection) as read:
            try:
                profile = dto(read.profile_snapshot(profile_id))
            except NotFoundError:
                profile = None
            rows = [assignment_view(json.loads(row[0]), read, profile) for row in connection.execute(
                "SELECT assignment_json FROM fit_current_wording_versions WHERE assignment_id=? ORDER BY revision DESC LIMIT ? OFFSET ?",
                (assignment_id, limit, offset),
            )]
        return {"assignment_id": assignment_id, "profile_id": profile_id, "current_revision": head[0],
                "total": head[0], "limit": limit, "offset": offset, "rows": rows}
