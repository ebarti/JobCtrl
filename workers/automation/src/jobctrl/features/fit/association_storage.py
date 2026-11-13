"""Fit-owned user associations. No assessment, score or approval is written."""

from __future__ import annotations

import json

from jobctrl.app.errors import ConflictError, NotFoundError

from .associations import association_view, binding_fingerprint, validate_association
from .qualification import now
from .serialization import encoded
from .contract import CONTRACT_VERSION, current_contract, require_contract
from .sources import dto, fingerprint


SCHEMA = """
CREATE TABLE fit_user_associations (
    association_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    requirement_id TEXT NOT NULL,
    achievement_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','removed')),
    binding_fingerprint TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    association_json TEXT NOT NULL,
    PRIMARY KEY(profile_id,association_id)
);
CREATE UNIQUE INDEX fit_user_association_active ON fit_user_associations(profile_id,achievement_id,requirement_id) WHERE state='active';
CREATE TABLE fit_user_association_versions (
    profile_id TEXT NOT NULL,
    association_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    association_json TEXT NOT NULL,
    PRIMARY KEY(profile_id,association_id,revision)
);
"""


class AssociationStorage:
    def association_records(self, profile_id, connection=None):
        return self._read(lambda conn: [json.loads(row[0]) for row in conn.execute(
            "SELECT association_json FROM fit_user_associations WHERE profile_id=? ORDER BY association_id", (profile_id,),
        )], connection)

    def library_records(self, profile_id, connection=None):
        def read(conn):
            assessments = [json.loads(row[0]) for row in conn.execute(
                "WITH ranked AS (SELECT assessment_json,row_number() OVER "
                "(PARTITION BY requirement_id ORDER BY rowid DESC) position FROM fit_assessments WHERE profile_id=?) "
                "SELECT assessment_json FROM ranked WHERE position=1", (profile_id,),
            )]
            coverage = [json.loads(row[0]) for row in conn.execute(
                "SELECT relation_json FROM fit_coverage_relations WHERE profile_id=? ORDER BY rowid DESC", (profile_id,),
            )]
            return {"assessments": assessments, "coverage": coverage,
                    "associations": self.association_records(profile_id, conn)}
        return self._read(read, connection)

    def _association_view(self, record, connection):
        if not current_contract(record):
            return {**record, "current": False, "stale_reasons": ["contract_changed"]}
        try:
            profile = dto(self.profile.snapshot(record["profile_id"], connection=connection))
        except NotFoundError:
            profile = None
        requirement = self.requirements.get_requirement(record["requirement_id"], connection=connection)
        library = self.profile.library(record["profile_id"], connection=connection)
        return association_view(record, requirement, profile, library)

    def _write_association(self, connection, record, request_fingerprint):
        connection.execute(
            "INSERT INTO fit_user_associations VALUES(?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(profile_id,association_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,"
            "binding_fingerprint=excluded.binding_fingerprint,association_json=excluded.association_json",
            (record["association_id"], record["profile_id"], record["revision"], record["requirement_id"], record["achievement_id"], record["state"],
             binding_fingerprint(record), request_fingerprint, encoded(record)),
        )
        connection.execute("INSERT INTO fit_user_association_versions VALUES(?,?,?,?)",
                           (record["profile_id"], record["association_id"], record["revision"], encoded(record)))
        self._event(connection, "FitAssociationUpdated", {
            "profileId": record["profile_id"], "associationId": record["association_id"],
            "requirementId": record["requirement_id"], "revision": record["revision"],
        }, record["profile_id"])

    def create_association(self, request):
        with self._database.transaction() as connection:
            request_fingerprint = fingerprint(request)
            previous = connection.execute(
                "SELECT * FROM fit_user_associations WHERE profile_id=? AND association_id=?",
                (request["profile_id"], request["association_id"]),
            ).fetchone()
            if previous is not None:
                require_contract(json.loads(previous["association_json"]))
                if previous["request_fingerprint"] != request_fingerprint:
                    raise ConflictError("This association request identity already belongs to different input.")
                return self._association_view(json.loads(previous["association_json"]), connection)
            profile = dto(self.profile.snapshot(request["profile_id"], connection=connection))
            requirement = self.requirements.get_requirement(request["requirement_id"], connection=connection)
            library = self.profile.library(request["profile_id"], connection=connection)
            validate_association(request, requirement, profile, library)
            record = {**request, "contract_version": CONTRACT_VERSION, "revision": 1, "origin": "user", "assessment_status": "unassessed",
                      "state": "active", "role_id": next(role["role_id"] for role in profile["roles"]
                          if any(row["achievement_id"] == request["achievement_id"] for row in role["achievements"])),
                      "created_at": now(), "updated_at": now()}
            duplicate = connection.execute(
                "SELECT association_id FROM fit_user_associations WHERE profile_id=? AND achievement_id=? AND requirement_id=? AND state='active'",
                (record["profile_id"], record["achievement_id"], record["requirement_id"]),
            ).fetchone()
            if duplicate is not None:
                raise ConflictError("This achievement already has an active association with the requirement. Revise that association.", association_id=duplicate[0])
            self._write_association(connection, record, request_fingerprint)
            return self._association_view(record, connection)

    def revise_association(self, association_id, request):
        with self._database.transaction() as connection:
            row = connection.execute("SELECT * FROM fit_user_associations WHERE profile_id=? AND association_id=?",
                                     (request["profile_id"], association_id)).fetchone()
            if row is None:
                raise NotFoundError("The association does not exist.")
            previous = json.loads(row["association_json"])
            require_contract(previous)
            replay_fingerprint = fingerprint({"operation": "revise", "request": request})
            if (previous["revision"] == request["expected_revision"] + 1
                    and previous.get("last_request_fingerprint") == replay_fingerprint):
                return self._association_view(previous, connection)
            if (request["association_id"] != association_id or previous["revision"] != request["expected_revision"]
                    or previous["state"] != "active" or any(previous[key] != request[key] for key in ("achievement_id", "requirement_id"))):
                raise ConflictError("The active association changed. Review its current revision and identities.")
            profile = dto(self.profile.snapshot(request["profile_id"], connection=connection))
            requirement = self.requirements.get_requirement(request["requirement_id"], connection=connection)
            library = self.profile.library(request["profile_id"], connection=connection)
            validate_association(request, requirement, profile, library)
            if binding_fingerprint(previous) == binding_fingerprint(request):
                return self._association_view(previous, connection)
            record = {**previous, **{key: request[key] for key in (
                "expected_profile_revision", "requirement_revision", "achievement_source_refs", "wording",
            )}, "role_id": next(role["role_id"] for role in profile["roles"]
                     if any(item["achievement_id"] == request["achievement_id"] for item in role["achievements"])),
                "revision": previous["revision"] + 1, "last_request_fingerprint": replay_fingerprint, "updated_at": now()}
            self._write_association(connection, record, row["request_fingerprint"])
            return self._association_view(record, connection)

    def set_association_state(self, association_id, request):
        with self._database.transaction() as connection:
            row = connection.execute("SELECT * FROM fit_user_associations WHERE profile_id=? AND association_id=?",
                                     (request["profile_id"], association_id)).fetchone()
            if row is None:
                raise NotFoundError("The association does not exist.")
            previous = json.loads(row["association_json"])
            require_contract(previous)
            replay_fingerprint = fingerprint({"operation": "state", "association_id": association_id, "request": request})
            if (previous["revision"] == request["expected_revision"] + 1
                    and previous.get("last_request_fingerprint") == replay_fingerprint):
                return self._association_view(previous, connection)
            if previous["revision"] != request["expected_revision"]:
                raise ConflictError("The association changed. Review its current state before trying again.")
            if previous["state"] == request["state"]:
                return self._association_view(previous, connection)
            if request["state"] == "active":
                duplicate = connection.execute(
                    "SELECT association_id FROM fit_user_associations WHERE profile_id=? AND achievement_id=? AND requirement_id=? AND state='active'",
                    (request["profile_id"], previous["achievement_id"], previous["requirement_id"]),
                ).fetchone()
                if duplicate is not None:
                    raise ConflictError("This exact association is already active.", association_id=duplicate[0])
            # Restore the original pins. A newer Profile/meaning never silently
            # rebinds historical user intent, even when this makes it stale.
            record = {**previous, "revision": previous["revision"] + 1, "state": request["state"],
                      "last_request_fingerprint": replay_fingerprint, "updated_at": now()}
            self._write_association(connection, record, row["request_fingerprint"])
            return self._association_view(record, connection)

    def association_history(self, association_id, profile_id, *, limit=50, offset=0):
        with self._database.connect() as connection:
            connection.execute("BEGIN")
            head = connection.execute("SELECT revision FROM fit_user_associations WHERE profile_id=? AND association_id=?",
                                      (profile_id, association_id)).fetchone()
            if head is None:
                raise NotFoundError("The association does not exist.")
            rows = [self._association_view(json.loads(row[0]), connection) for row in connection.execute(
                "SELECT association_json FROM fit_user_association_versions WHERE profile_id=? AND association_id=? "
                "ORDER BY revision DESC LIMIT ? OFFSET ?", (profile_id, association_id, limit, offset),
            )]
            return {"association_id": association_id, "profile_id": profile_id, "current_revision": head[0],
                    "total": head[0], "limit": limit, "offset": offset, "rows": rows}
