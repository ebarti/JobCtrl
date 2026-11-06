"""Literal authored targets plus source-bound recall query planning."""

from __future__ import annotations

import re
from uuid import uuid4
from pydantic import Field, StrictInt, StrictStr

from jobctrl.app.errors import AppError, NotFoundError
from jobctrl.semantic import Citation, DeterminationFailure, DeterminationModel, Source, validate_citations
from jobctrl.features.discovery.domain import fingerprint, now
from jobctrl.features.discovery.ports import DiscoveryStore, ModelPort


FIELDS = {
    "roles": "target_role",
    "tracks": "target_track",
    "seniority": "target_seniority_floor",
    "functions": "target_functions",
    "specializations": "target_specializations",
    "locations": "target_locations",
    "work_models": "target_work_models",
}


def literal_rows(value):
    if not isinstance(value, str) or not value.strip():
        return []
    # Existing authored field-label syntax is formatting, never a role/place
    # classification or query expansion.
    value = re.sub(r"^\s*Target (?:roles?|locations?):\s*", "", value, flags=re.IGNORECASE)
    return [row.strip() for row in value.replace(";", "\n").split("\n")]


class RecallQuery(DeterminationModel):
    query: StrictStr = Field(min_length=1, max_length=1000)
    tier: StrictInt = Field(ge=1, le=3)
    source_scope: list[StrictStr] = Field(max_length=30)
    citations: list[Citation] = Field(min_length=1, max_length=20)
    rationale: StrictStr = Field(min_length=1, max_length=3000)


class QueryPlan(DeterminationModel):
    queries: list[RecallQuery] = Field(max_length=30)
    rationale: StrictStr = Field(min_length=1, max_length=3000)


class TargetPlanner:
    def __init__(self, repository: DiscoveryStore, profile, model: ModelPort):
        self.repository, self.profile, self.model = repository, profile, model

    def _source(self):
        if self.profile is None:
            return None, {}
        try:
            snapshot = self.profile.snapshot()
        except NotFoundError:
            return None, {}
        experience = snapshot.document.get("experience") or {}
        return snapshot, {key: experience.get(field, "") for key, field in FIELDS.items()}

    def read(self):
        snapshot, target = self._source()
        if snapshot is None:
            return {"ok": True, "current": False, "accepted": None, "targets": target}
        accepted = self.repository.latest_target_plan()
        return {
            "ok": True,
            "current": bool(accepted and accepted["profileFingerprint"] == snapshot.fingerprint),
            "accepted": accepted,
            "targets": target,
            "profileRevision": snapshot.profile_revision,
        }

    async def refresh(self, *, force=False, operation_id=None, expected_profile_revision=None):
        operation_fingerprint = fingerprint({"force": force, "expected_profile_revision": expected_profile_revision})
        if operation_id:
            accepted = self.repository.target_plan_operation(operation_id)
            if accepted:
                if accepted.get("operationFingerprint") != operation_fingerprint:
                    raise AppError(
                        "target_plan_operation_conflict", "This target-plan operation belongs to different input.", 409
                    )
                snapshot, target = self._source()
                return {
                    "ok": True,
                    "current": bool(snapshot and accepted["profileFingerprint"] == snapshot.fingerprint),
                    "accepted": accepted,
                    "targets": target,
                    "profileRevision": snapshot.profile_revision if snapshot else None,
                }
        snapshot, target = self._source()
        if snapshot is None or not any(target.values()):
            return {"ok": True, "current": False, "accepted": None, "targets": target}
        if expected_profile_revision is not None and expected_profile_revision != snapshot.profile_revision:
            raise AppError("target_profile_changed", "The saved Profile targets changed.", 409)
        previous = self.read()
        if previous["current"] and not force:
            if operation_id is None:
                return previous
            accepted = {
                **previous["accepted"],
                "planId": fingerprint([snapshot.fingerprint, operation_id]),
                "operationId": operation_id,
                "operationFingerprint": operation_fingerprint,
                "createdAt": now(),
            }
            accepted = self.repository.save_target_plan(
                accepted, lambda conn: self.profile.assert_current(snapshot, connection=conn)
            )
            return {**previous, "accepted": accepted}
        sources = [
            Source(source_id="target:" + key, text=value)
            for key, value in target.items()
            if isinstance(value, str) and value.strip()
        ]
        queries = [
            {"query": role, "tier": 1, "source_scope": [], "authority": "literal_authored_target"}
            for role in literal_rows(target["roles"])
            if role
        ]
        receipt = None
        if any(target.get(key) for key in ("tracks", "seniority", "functions", "specializations")):
            result = await self.model.determine(
                operation="discovery.query_plan",
                instructions=(
                    "Prepare bounded high-recall job-board search queries from the user's explicitly authored target fields only. "
                    "Do not infer preferred roles, seniority, geography or work authorization from employment history. "
                    "Preserve specific authored role queries; propose complementary function/track/specialization/seniority recall queries "
                    "where the saved fields support them. Declare tier 1-3 and optional exact board source_scope. Every query needs "
                    "verbatim target citations and an explanation; query generation is not evidence that a returned job fits. "
                    "Never invent a location or silently tighten/broaden work-model rows. Return at most thirty queries."
                ),
                sources=[s.model_dump() for s in sources],
                response_schema=QueryPlan.model_json_schema(),
                context={"profileRevision": snapshot.profile_revision},
                prompt_version="discovery-query-plan-v1",
                lane="enrichment",
            )
            plan = QueryPlan.model_validate(result.value)
            try:
                validate_citations(plan, sources)
            except DeterminationFailure as error:
                raise AppError(error.code, "The query plan is not bound to the saved targets.", 409) from None
            queries.extend(query.model_dump() for query in plan.queries)
            receipt = result.provenance
        places, models = literal_rows(target["locations"]), literal_rows(target["work_models"])
        locations = []
        for index in range(max(len(places), len(models))):
            place = places[index] if index < len(places) else ""
            choices = (models[index] if index < len(models) else "").split(",")
            choices = [choice.strip() for choice in choices if choice.strip()]
            if not choices:
                if place:
                    locations.append({"location": place, "remote": False})
                continue
            for choice in choices:
                if choice.casefold() in {"remote", "work_model.remote"}:
                    locations.append({"location": place, "remote": True})
                elif choice.casefold() in {"hybrid", "on-site", "onsite", "work_model.hybrid", "work_model.onsite"}:
                    if not place:
                        raise AppError(
                            "target_location_required", "Hybrid and On-site targets require an explicit location.", 409
                        )
                    locations.append({"location": place, "remote": False})
                else:
                    raise AppError("invalid_target_work_model", "The saved work-model choice is not supported.", 409)
        accepted = {
            "planId": fingerprint([snapshot.fingerprint, operation_id or str(uuid4())]),
            "profileRevision": snapshot.profile_revision,
            "profileFingerprint": snapshot.fingerprint,
            "targets": target,
            "queries": list({fingerprint([q["query"], q.get("source_scope")]): q for q in queries}.values()),
            "locations": list({fingerprint(row): row for row in locations}.values()),
            "provenance": receipt,
            "createdAt": now(),
            "operationId": operation_id,
            "operationFingerprint": operation_fingerprint,
        }
        accepted = self.repository.save_target_plan(
            accepted, lambda conn: self.profile.assert_current(snapshot, connection=conn)
        )
        return {
            "ok": True,
            "current": True,
            "accepted": accepted,
            "targets": target,
            "profileRevision": snapshot.profile_revision,
        }
