"""Private cohort snapshots and reviewed milestones in the existing event journal.

The semantic envelope is the comparison authority. Journal records retain its
exact sources and explicit user decisions without changing profile or scores.
"""

from collections import Counter
from datetime import date, datetime, timezone
import hashlib
import json
from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import Field, StrictInt, StrictStr, TypeAdapter, ValidationError

from jobctrl.domain.determinations import (
    DeterminationFailure,
    DeterminationModel,
    Source,
    validate_citations,
)
from jobctrl.domain.operations.career_learning import (
    CareerDemandComparison,
    compare_career_demand,
    validate_career_comparison,
)
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository, determination_dependencies
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository


class CompareCommand(DeterminationModel):
    action: Literal["compare"]
    cohortId: StrictStr | None = None
    expectedRevision: StrictInt = Field(ge=0)
    title: StrictStr = Field(min_length=1, max_length=160)
    asOf: StrictStr
    jobIds: list[StrictStr] = Field(min_length=1, max_length=30)
    aspirations: StrictStr = Field(max_length=2000)
    expectedSnapshotFingerprint: StrictStr | None = None


class PreviewCommand(DeterminationModel):
    action: Literal["preview"]
    jobIds: list[StrictStr] = Field(min_length=1, max_length=30)


class ChooseCommand(DeterminationModel):
    action: Literal["choose"]
    cohortId: StrictStr
    expectedRevision: StrictInt = Field(ge=1)
    determinationId: StrictStr
    proposalId: StrictStr


class UpdateCommand(DeterminationModel):
    action: Literal["update"]
    milestoneId: StrictStr
    expectedRevision: StrictInt = Field(ge=1)
    status: Literal["planned", "in_progress", "completed", "abandoned"]
    completionEvidence: StrictStr = Field(max_length=4000)


Command = TypeAdapter(
    Annotated[PreviewCommand | CompareCommand | ChooseCommand | UpdateCommand, Field(discriminator="action")]
)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _latest(conn, tenant, kind, identity):
    row = conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND entity_kind=? AND entity_ref=? ORDER BY event_id DESC LIMIT 1",
        (tenant, "career_" + kind, identity),
    ).fetchone()
    return json.loads(row[0]) if row else None


def _record(conn, tenant, kind, identity, value):
    conn.execute(
        "INSERT INTO job_events(tenant_id,identity_version,event_type,occurred_at,payload_json,entity_kind,entity_ref) VALUES(?,1,'CareerLearningRecorded',?,?,?,?)",
        (tenant, _now(), _json(value), "career_" + kind, identity),
    )


def _profile(conn, tenant):
    row = conn.execute(
        "SELECT version FROM candidate_profiles WHERE tenant_id=? AND profile_id='default'",
        (tenant,),
    ).fetchone()
    if row is None:
        return None, []
    version, resume = SqliteProfileRepository(conn, publisher=None).load_saved_resume(TenantId(tenant))
    # These are the same saved achievement IDs used by the Career Evidence Map.
    # Preserve exact identifiers/text rather than normalizing them on this read.
    evidence = [item for entry in resume["experience_entries"] for item in entry["achievement_evidence"]]
    if any(item.get("confirmation_review_required") for item in evidence):
        raise DeterminationFailure("legacy_evidence_review_required")
    return version, evidence


def _jobs(conn, tenant, ids):
    jobs = []
    for job_id in ids:
        row = conn.execute(
            "SELECT j.job_id,j.title,j.company,j.description,j.full_description,e.full_description AS enriched_description "
            "FROM jobs j LEFT JOIN job_enrichments e ON e.tenant_id=j.tenant_id AND e.job_id=j.job_id "
            "WHERE j.tenant_id=? AND j.job_id=?",
            (tenant, job_id),
        ).fetchone()
        if not row:
            raise DeterminationFailure("job_not_found")
        job = dict(row)
        text = str(job["enriched_description"] or job["full_description"] or job["description"] or "")
        urls = [
            entry[0]
            for entry in conn.execute(
                "SELECT application_url FROM job_application_locators WHERE tenant_id=? AND job_id=? ORDER BY application_url",
                (tenant, job_id),
            )
        ]
        jobs.append(
            {
                "jobId": job_id,
                "title": job["title"] or "Untitled job",
                "company": job["company"] or "",
                "sourceId": "posting:" + job_id,
                "text": text,
                "applicationUrls": urls,
            }
        )
    return jobs


def _snapshot(conn, tenant, job_ids):
    # Pin all source rows together, and release the SQLite reader before the model call.
    conn.execute("SAVEPOINT career_sources")
    try:
        counts = Counter(job_ids)
        jobs = _jobs(conn, tenant, sorted(counts))
        profile_version, evidence = _profile(conn, tenant)
    finally:
        conn.execute("RELEASE career_sources")
    evidence_counts = Counter(item["id"] for item in evidence)
    confirmed = [
        item
        for item in evidence
        if item["user_confirmed"] and not item.get("confirmation_review_required")
        and item["evidence_strength"] in {"supported", "verified"}
        and isinstance(item["id"], str)
        and item["id"].strip()
        and len(item["id"]) <= 200
        and evidence_counts[item["id"]] == 1
        and any(str(item[key]).strip() for key in ("source_text", "scope", "action", "outcome"))
    ]
    if len(confirmed) > 200:
        raise DeterminationFailure("cohort_source_budget_exceeded")
    evidence_sources = [
        Source(
            source_id=item["id"],
            text=json.dumps(
                {key: item[key] for key in ("source_text", "scope", "action", "tools", "metrics", "outcome")},
                ensure_ascii=False,
            ),
        ).model_dump()
        for item in confirmed
    ]
    posting_namespace = {job["sourceId"] for job in jobs}
    if any(source["source_id"] in posting_namespace for source in evidence_sources):
        raise DeterminationFailure("duplicate_source_id")
    # A generic application URL is not a duplicate identity. Require exact full
    # title/employer/description equality too; never use prose similarity.
    groups = []
    for job in jobs:
        linked = [
            group
            for group in groups
            if any(
                set(other["applicationUrls"]) & set(job["applicationUrls"])
                and bool(job["text"].strip())
                and all(other[key] == job[key] for key in ("title", "company", "text"))
                for other in group
            )
        ]
        group = [job]
        for previous in linked:
            group.extend(previous)
            groups.remove(previous)
        groups.append(group)
    duplicates = [sorted(job["jobId"] for job in group) for group in groups if len(group) > 1]
    representatives = {
        min(group, key=lambda job: (not bool(job["text"].strip()), job["jobId"]))["jobId"] for group in groups
    }
    postings = [
        Source(source_id=job["sourceId"], text=job["text"]).model_dump()
        for job in jobs
        if job["jobId"] in representatives and job["text"].strip()
    ]
    sources = [*postings, *evidence_sources]
    if sum(len(source["text"]) for source in sources) > 120000:
        raise DeterminationFailure("cohort_source_budget_exceeded")
    return {
        "profileVersion": profile_version,
        "jobs": jobs,
        "sources": sources,
        "selectedCount": len(job_ids),
        "cohortSize": len(jobs),
        "analyzedCount": len(postings),
        "missingDescriptions": [job["jobId"] for job in jobs if not job["text"].strip()],
        "duplicateSelections": [{"jobId": key, "count": count} for key, count in sorted(counts.items()) if count > 1],
        "duplicateIdentities": duplicates,
        "confirmedEvidenceCount": len(confirmed),
        "excludedEvidenceCount": len(evidence) - len(confirmed),
    }


def _check_revision(current, expected):
    if (current["revision"] if current else 0) != expected:
        raise DeterminationFailure("revision_conflict")


def _context(snapshot, as_of):
    return {
        "as_of": as_of,
        "cohort": {key: value for key, value in snapshot.items() if key not in {"sources", "jobs"}},
        "jobs": [{key: job[key] for key in ("jobId", "title", "company", "sourceId")} for job in snapshot["jobs"]],
    }


def _source_ids(snapshot):
    postings = {job["sourceId"] for job in snapshot["jobs"]}
    return postings, {source["source_id"] for source in snapshot["sources"]} - postings


def _bound_fingerprint(cohort, envelope):
    # Reconstruct the shared determine() format, including its source-ID enum.
    # This is an integrity check, never a new semantic judgment.
    sources = cohort["snapshot"]["sources"]
    schema = CareerDemandComparison.model_json_schema()
    schema["$defs"]["Citation"]["properties"]["source_id"]["enum"] = [source["source_id"] for source in sources]
    identity = {
        key: getattr(envelope, key)
        for key in ("kind", "schema_version", "prompt_version", "provider", "model", "lane", "tenant_id", "entity_id")
    }
    identity.update(schema=schema, input={"sources": sources, "context": _context(cohort["snapshot"], cohort["asOf"])})
    return _hash(identity)


def _accepted(conn, tenant, cohort):
    envelope = SqliteDeterminationRepository(conn).find(tenant, cohort["determinationId"])
    if (
        envelope is None
        or envelope.entity_id != cohort["cohortId"]
        or envelope.kind != "career_demand_comparison"
        or envelope.schema_version != "1"
        or envelope.prompt_version != "career-demand-v1"
        or envelope.lane != "profile"
        or envelope.model_dump() != cohort["determination"]
    ):
        raise DeterminationFailure("cohort_binding_invalid")
    try:
        result = CareerDemandComparison.model_validate(envelope.result)
        sources = [Source(**source) for source in cohort["snapshot"]["sources"]]
        validate_citations(result, sources)
    except (ValidationError, KeyError, TypeError):
        raise DeterminationFailure("cohort_binding_invalid") from None
    if result.model_dump() != cohort["comparison"] or _hash(cohort["snapshot"]) != cohort["snapshotFingerprint"]:
        raise DeterminationFailure("cohort_binding_invalid")
    validate_career_comparison(result, *_source_ids(cohort["snapshot"]))
    if _bound_fingerprint(cohort, envelope) != envelope.input_fingerprint:
        raise DeterminationFailure("cohort_binding_invalid")
    return result


def _accepted_milestone(conn, tenant, milestone):
    origin = milestone["origin"]
    result = _accepted(conn, tenant, origin)
    proposal = next((row for row in result.proposals if row.proposal_id == milestone["proposal"]["proposal_id"]), None)
    if (
        milestone["cohortId"] != origin["cohortId"]
        or milestone["cohortRevision"] != origin["revision"]
        or milestone["determinationId"] != origin["determinationId"]
        or proposal is None
        or proposal.model_dump() != milestone["proposal"]
        or milestone["milestoneId"]
        != _hash([origin["cohortId"], origin["revision"], origin["determinationId"], proposal.proposal_id])
    ):
        raise DeterminationFailure("milestone_binding_invalid")


class CareerLearningService:
    def __init__(self, connection, *, tenant_id="local", dependencies=None):
        self.conn, self.tenant = connection, str(tenant_id)
        self.dependencies = dependencies

    def compare(self, command):
        if command.cohortId is None and command.expectedRevision != 0:
            raise DeterminationFailure("revision_conflict")
        try:
            if date.fromisoformat(command.asOf).isoformat() != command.asOf:
                raise ValueError()
            ids = [str(UUID(value)) for value in command.jobIds]
            if ids != command.jobIds or not command.title.strip():
                raise ValueError()
            cohort_id = str(UUID(command.cohortId)) if command.cohortId else str(uuid4())
            if command.cohortId and cohort_id != command.cohortId:
                raise ValueError()
        except ValueError:
            raise DeterminationFailure("invalid_cohort") from None
        current = _latest(self.conn, self.tenant, "cohort", cohort_id)
        _check_revision(current, command.expectedRevision)
        snapshot = _snapshot(self.conn, self.tenant, ids)
        if command.expectedSnapshotFingerprint is not None and command.expectedSnapshotFingerprint != _hash(snapshot):
            raise DeterminationFailure("sources_changed")
        if not snapshot["analyzedCount"]:
            raise DeterminationFailure("no_posting_descriptions")
        dependencies = self.dependencies or determination_dependencies(self.conn, tenant_id=self.tenant, lane="profile")
        try:
            result, envelope = compare_career_demand(
                cohort_id=cohort_id,
                sources=[Source(**source) for source in snapshot["sources"]],
                context=_context(snapshot, command.asOf),
                posting_ids=_source_ids(snapshot)[0],
                evidence_ids=_source_ids(snapshot)[1],
                **dependencies,
            )
        except DeterminationFailure as error:
            with self.conn:
                _record(
                    self.conn,
                    self.tenant,
                    "attempt",
                    cohort_id,
                    {"cohortId": cohort_id, "failureCode": error.code, "occurredAt": _now()},
                )
            raise
        # Writer acquisition precedes the revision/source recheck. A concurrent profile,
        # posting or cohort write cannot install this result against different inputs.
        with self.conn:
            self.conn.execute("BEGIN IMMEDIATE")
            _check_revision(_latest(self.conn, self.tenant, "cohort", cohort_id), command.expectedRevision)
            if _hash(_snapshot(self.conn, self.tenant, ids)) != _hash(snapshot):
                raise DeterminationFailure("sources_changed")
            value = {
                "cohortId": cohort_id,
                "revision": command.expectedRevision + 1,
                "title": command.title,
                "asOf": command.asOf,
                "aspirations": command.aspirations,
                "comparedAt": _now(),
                "jobIds": ids,
                "snapshot": snapshot,
                "snapshotFingerprint": _hash(snapshot),
                "determinationId": envelope.determination_id,
                "determination": envelope.model_dump(),
                "comparison": result.model_dump(),
            }
            _record(self.conn, self.tenant, "cohort", cohort_id, value)
            _record(
                self.conn,
                self.tenant,
                "attempt",
                cohort_id,
                {"cohortId": cohort_id, "failureCode": None, "occurredAt": value["comparedAt"]},
            )
        return value

    def choose(self, command):
        with self.conn:
            self.conn.execute("BEGIN IMMEDIATE")
            cohort = _latest(self.conn, self.tenant, "cohort", command.cohortId)
            _check_revision(cohort, command.expectedRevision)
            if not cohort or cohort["determinationId"] != command.determinationId:
                raise DeterminationFailure("cohort_binding_invalid")
            result = _accepted(self.conn, self.tenant, cohort)
            if self.stale_reasons(cohort):
                raise DeterminationFailure("sources_changed")
            proposal = next((row for row in result.proposals if row.proposal_id == command.proposalId), None)
            if proposal is None:
                raise DeterminationFailure("foreign_proposal_id")
            identity = _hash([command.cohortId, cohort["revision"], command.determinationId, command.proposalId])
            existing = _latest(self.conn, self.tenant, "milestone", identity)
            if existing:
                _accepted_milestone(self.conn, self.tenant, existing)
                return existing
            value = {
                "milestoneId": identity,
                "revision": 1,
                "cohortId": command.cohortId,
                "cohortRevision": cohort["revision"],
                "determinationId": command.determinationId,
                "proposal": proposal.model_dump(),
                "origin": cohort,
                "status": "planned",
                "completionEvidence": "",
                "selectedAt": _now(),
                "updatedAt": _now(),
            }
            _record(self.conn, self.tenant, "milestone", identity, value)
            return value

    def update(self, command):
        if command.status == "completed" and not command.completionEvidence.strip():
            raise DeterminationFailure("completion_evidence_required")
        with self.conn:
            self.conn.execute("BEGIN IMMEDIATE")
            current = _latest(self.conn, self.tenant, "milestone", command.milestoneId)
            _check_revision(current, command.expectedRevision)
            if not current:
                raise DeterminationFailure("milestone_not_found")
            _accepted_milestone(self.conn, self.tenant, current)
            value = {
                **current,
                "revision": current["revision"] + 1,
                "status": command.status,
                "completionEvidence": command.completionEvidence,
                "updatedAt": _now(),
            }
            _record(self.conn, self.tenant, "milestone", command.milestoneId, value)
            return value

    def stale_reasons(self, cohort):
        reasons = []
        try:
            snapshot = _snapshot(self.conn, self.tenant, cohort["jobIds"])
        except DeterminationFailure as error:
            return [error.code]
        if snapshot["profileVersion"] != cohort["snapshot"]["profileVersion"]:
            reasons.append("profile_changed")
        if snapshot["jobs"] != cohort["snapshot"]["jobs"]:
            reasons.append("postings_changed")
        return reasons

    def read(self):
        self._truncated = False
        cohorts, milestones = [], []
        for kind, target, limit in (("cohort", cohorts, 20), ("milestone", milestones, 100)):
            rows = self.conn.execute(
                "SELECT e.payload_json FROM job_events e WHERE e.tenant_id=? AND e.entity_kind=? "
                "AND e.event_id=(SELECT max(p.event_id) FROM job_events p WHERE p.tenant_id=e.tenant_id AND p.entity_kind=e.entity_kind AND p.entity_ref=e.entity_ref) "
                "ORDER BY e.event_id DESC LIMIT ?",
                (self.tenant, "career_" + kind, limit + 1),
            ).fetchall()
            for row in rows[:limit]:
                value = json.loads(row[0])
                origin = value if kind == "cohort" else value["origin"]
                if kind == "cohort":
                    _accepted(self.conn, self.tenant, origin)
                else:
                    _accepted_milestone(self.conn, self.tenant, value)
                reasons = self.stale_reasons(origin)
                if kind == "milestone":
                    latest = _latest(self.conn, self.tenant, "cohort", value["cohortId"])
                    if latest and latest["revision"] != value["cohortRevision"]:
                        reasons.append("cohort_changed")
                    history = self.conn.execute(
                        "SELECT payload_json FROM job_events WHERE tenant_id=? AND entity_kind='career_milestone' AND entity_ref=? ORDER BY event_id DESC LIMIT 50",
                        (self.tenant, value["milestoneId"]),
                    ).fetchall()
                    value["history"] = [
                        {
                            key: json.loads(entry[0])[key]
                            for key in ("revision", "status", "completionEvidence", "updatedAt")
                        }
                        for entry in history
                    ]
                else:
                    value["lastAttempt"] = _latest(self.conn, self.tenant, "attempt", value["cohortId"])
                target.append({**value, "staleReasons": reasons})
            if len(rows) > limit:
                # Older journal records remain retained; no false claim of a complete list.
                self._truncated = True
        return {
            "ok": True,
            "cohorts": cohorts,
            "milestones": milestones,
            "preview": None,
            "truncated": getattr(self, "_truncated", False),
        }

    def execute(self, raw=None):
        preview = None
        if raw is not None:
            try:
                command = Command.validate_python(raw)
            except ValidationError:
                raise DeterminationFailure("invalid_command") from None
            if command.action == "preview":
                try:
                    if any(str(UUID(value)) != value for value in command.jobIds):
                        raise ValueError()
                except ValueError:
                    raise DeterminationFailure("invalid_cohort") from None
                snapshot = _snapshot(self.conn, self.tenant, command.jobIds)
                preview = {**snapshot, "fingerprint": _hash(snapshot)}
            else:
                {"compare": self.compare, "choose": self.choose, "update": self.update}[command.action](command)
        self.conn.execute("SAVEPOINT career_read")
        try:
            return {**self.read(), "preview": preview}
        finally:
            self.conn.execute("RELEASE career_read")
