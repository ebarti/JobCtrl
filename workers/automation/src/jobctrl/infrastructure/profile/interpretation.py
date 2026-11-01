"""Persist suggestions against the exact profile version without altering facts."""

import hashlib

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.profile.interpretation import ModelCandidateInterpreter
from jobctrl.infrastructure.determinations import determination_dependencies


class PersistedCandidateInterpreter:
    def __init__(self, connection, *, tenant_id="local", dependencies=None):
        self._connection, self._tenant_id = connection, str(tenant_id)
        self._dependencies = dependencies or determination_dependencies(connection, tenant_id=tenant_id, lane="profile")

    def interpret(self, snapshot):
        tenant = str(snapshot.tenant_id)
        dependencies = {**self._dependencies, "tenant_id": tenant}
        repository = dependencies["repository"]
        request_entity = f"{snapshot.profile_id}:{snapshot.version}"
        request_fingerprint = hashlib.sha256(request_entity.encode()).hexdigest()
        try:
            result, envelope = ModelCandidateInterpreter(**dependencies).interpret(
                profile=snapshot.as_dict(), profile_version=snapshot.version, entity_id=snapshot.profile_id
            )
        except DeterminationFailure as error:
            repository.record_state(
                tenant_id=tenant,
                entity_id=request_entity,
                kind="candidate_interpretation_request",
                fingerprint=request_fingerprint,
                state="blocked",
                failure_code=error.code,
            )
            raise
        repository.record_state(
            tenant_id=tenant,
            entity_id=request_entity,
            kind="candidate_interpretation_request",
            fingerprint=request_fingerprint,
            state="accepted",
            determination_id=envelope.determination_id,
        )
        conn = self._connection
        with conn:
            conn.execute(
                "INSERT INTO candidate_interpretation_suggestions (tenant_id,profile_id,profile_version,determination_id,status) VALUES (?,?,?,?, 'pending_confirmation') ON CONFLICT DO NOTHING",
                (tenant, snapshot.profile_id, snapshot.version, envelope.determination_id),
            )
            self._dependencies["repository"].bind(
                tenant_id=tenant,
                entity_kind="profile",
                entity_id=snapshot.profile_id,
                entity_version=str(snapshot.version),
                determination_kind="candidate_interpretation",
                determination_id=envelope.determination_id,
            )
        return result, envelope

    def suggest(self, snapshot, maximum=5):
        result, envelope = self.interpret(snapshot)
        confirmation = self._connection.execute(
            "SELECT status FROM candidate_interpretation_suggestions WHERE tenant_id=? AND profile_id=? AND profile_version=? AND determination_id=?",
            (str(snapshot.tenant_id), snapshot.profile_id, snapshot.version, envelope.determination_id),
        ).fetchone()
        return {
            "profileVersion": snapshot.version,
            "determinationId": envelope.determination_id,
            "status": confirmation[0],
            "suggestions": [
                {
                    "title": item.title,
                    "classification": item.classification,
                    "track": item.track,
                    "seniority": item.seniority,
                    "evidenceIds": list(dict.fromkeys(c.source_id for c in item.citations)),
                    "citations": [c.model_dump() for c in item.citations],
                    "rationale": item.rationale,
                }
                for item in result.target_roles[:maximum]
            ],
            "preferenceSuggestions": [
                {
                    "location": item.location,
                    "workModel": item.work_model,
                    "evidenceIds": list(dict.fromkeys(c.source_id for c in item.citations)),
                    "citations": [c.model_dump() for c in item.citations],
                    "rationale": item.rationale,
                }
                for item in result.target_preferences[:maximum]
            ],
            "strategy": "model",
            "warnings": [],
        }
