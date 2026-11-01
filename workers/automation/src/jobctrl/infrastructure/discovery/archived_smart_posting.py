"""Capture-owned Smart Extract publication receipts, without a second admission.

The prepared receipt joins the canonical insert transaction. It retains the
qualified bytes and determination envelopes so retry never substitutes a fresh
network page for an interrupted capture. Publication and its completion receipt
share a writer lock; an existing owner alone is never completion authority.
"""

import hashlib
import json
from datetime import datetime, timezone
from dataclasses import asdict, replace

from pydantic import BaseModel, ConfigDict, TypeAdapter

from jobctrl.domain.errors import ConfigurationError, TransientNetworkError
from jobctrl.domain.enrichment.snapshot_value_objects import SnapshotDescriptionHash
from jobctrl.domain.events.base import DomainEvent
from jobctrl.domain.discovery.use_cases import new_job_discovery_events
from jobctrl.domain.discovery.aggregate import Job
from jobctrl.domain.discovery.identity import CanonicalJobIdentity, JobSourceObservation
from jobctrl.domain.discovery.value_objects import Employer, JobMetadata, PostingUrl, SearchStrategy, Source
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.infrastructure.discovery.smart_postings import QualifiedPosting
from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository
from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher
from jobctrl.state import record_job_event


_QUALIFIED = TypeAdapter(QualifiedPosting)


class DiscoveryPublicationContext(BaseModel):
    """Original operational facts frozen in the canonical insert transaction."""

    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    identity: CanonicalJobIdentity
    observation: JobSourceObservation
    source: Source
    discovered_at: str


class OriginalCaptureUnavailable(ConfigurationError):
    code = "archived_posting_original_capture_unavailable"

    def __init__(self):
        super().__init__(
            "The original archived posting publication receipt is missing; capture retained for recovery. "
            "Use the existing Job's Enrich action for a deliberate current-page refresh, then retry Discovery."
        )


class CapturePublication:
    def __init__(self, conn, *, tenant_id, capture_id, source_id, write_fence=None):
        self.conn, self.tenant_id = conn, tenant_id
        self.capture_id, self.source_id = capture_id, source_id
        self.write_fence = write_fence or (lambda: None)

    def _key(self, suffix):
        return f"{self.capture_id}:smart-posting:{suffix}"

    def prepared(self):
        row = self.conn.execute(
            "SELECT payload_json FROM job_events WHERE tenant_id=? AND idempotency_key=?",
            (str(self.tenant_id), self._key("prepared")),
        ).fetchone()
        if row is None:
            return None
        payload = json.loads(row[0])
        if payload["captureId"] != self.capture_id or payload["sourceId"] != self.source_id:
            raise RuntimeError("Archived posting publication receipt identity changed")
        try:
            qualified = _QUALIFIED.validate_json(json.dumps(payload["qualified"]))
        except ValueError:
            raise RuntimeError("Archived posting publication receipt is invalid") from None
        # Only the canonical, persisted determinations authorize a resumed
        # publication. The private receipt is not a replacement model verdict.
        for receipt in qualified.determinations:
            row = self.conn.execute(
                "SELECT envelope_json FROM semantic_determinations WHERE tenant_id=? AND determination_id=?",
                (str(self.tenant_id), receipt.determination_id),
            ).fetchone()
            if row is None or json.loads(row[0]) != receipt.model_dump(mode="json"):
                raise RuntimeError("Archived posting determination receipt is unavailable or changed")
        receipts = {receipt.kind: receipt for receipt in qualified.determinations}
        if set(receipts) != {"page_interpretation", "posting_extraction", "discovery_posting_qualification"} or any(
            receipt.tenant_id != str(self.tenant_id) or receipt.entity_id != qualified.url or receipt.lane != "discovery"
            for receipt in qualified.determinations
        ):
            raise RuntimeError("Archived posting determination receipt binding changed")
        fields = qualified.fields
        extraction = receipts["posting_extraction"].result
        page = receipts["page_interpretation"].result
        qualification = receipts["discovery_posting_qualification"].result
        acquisition = qualified.acquisition
        if (
            set(fields) != {"title", "employer", "description", "location", "salary", "application_url"}
            or any(fields[name] != extraction[name]["value"] for name in fields)
            or acquisition.description is None or acquisition.description.text != fields["description"]
            or acquisition.description_hash != SnapshotDescriptionHash.from_text(fields["description"])
            or (acquisition.apply_url.value if acquisition.apply_url else "") != fields["application_url"]
            or acquisition.active_state.value != page["availability"]["value"]
            or acquisition.confidence.value != qualification["description_quality"]["confidence"]
            or page["page_kind"]["value"] != "posting" or page["access_state"]["value"] != "clear"
            or qualification["role_title"]["value"] != "specific_role"
            or qualification["location_match"]["value"] != "match"
            or qualification["description_quality"]["confidence"] == "low"
            or acquisition.evidence != tuple(
                f"{receipt.kind}_determination:{receipt.determination_id}" for receipt in qualified.determinations
            )
        ):
            raise RuntimeError("Archived posting capture differs from its recorded determinations")
        return payload, qualified

    def prepare_insert(self, job, qualified, identity, observation):
        self.write_fence()
        # This is a private persistence receipt, like CompanyBriefingRecorded.
        # It has no Job binding, workflow stamp, log message or bus publication;
        # generic SSE explicitly excludes its typed event kind.
        payload = {"captureId": self.capture_id, "sourceId": self.source_id,
                   "ownerJobId": str(job.job_id), "qualified": _QUALIFIED.dump_python(qualified, mode="json"),
                   "discoveryContext": DiscoveryPublicationContext(
                       identity=identity, observation=observation, source=job.source, discovered_at=job.discovered_at,
                   ).model_dump(mode="json"),
                   "discoveryEvents": [asdict(replace(event, occurred_at=observation.observed_at))
                                       for event in new_job_discovery_events(job, identity, observation)]}
        self.conn.execute(
            "INSERT INTO job_events (tenant_id,identity_version,event_type,occurred_at,payload_json,"
            "entity_kind,entity_ref,idempotency_key) VALUES (?,1,'ArchivedSmartPostingPrepared',?,?,?,?,?) "
            "ON CONFLICT DO NOTHING",
            (str(self.tenant_id), datetime.now(timezone.utc).isoformat(), json.dumps(payload),
             "discovery_capture_publication", self.capture_id, self._key("prepared")),
        )

    def completed(self):
        return self.conn.execute(
            "SELECT 1 FROM job_events WHERE tenant_id=? AND idempotency_key=?",
            (str(self.tenant_id), self._key("completed")),
        ).fetchone() is not None

    def publish_original_discovery(self, payload):
        """Restore original insert events without observing or refreshing a Job."""
        self.write_fence()
        if self.conn.execute(
            "SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=?",
            (str(self.tenant_id), payload["ownerJobId"]),
        ).fetchone() is None:
            return  # A permanent owner deletion must never be recreated.
        try:
            context = DiscoveryPublicationContext.model_validate_json(json.dumps(payload["discoveryContext"]))
            events = [DomainEvent(**data) for data in payload["discoveryEvents"]]
        except (ValueError, TypeError, KeyError):
            raise OriginalCaptureUnavailable() from None
        observation, identity = context.observation, context.identity
        if (
            observation.source_observation_id != self.capture_id or observation.source_id != self.source_id
            or observation.source_native_id != identity.source_native_id or observation.observed_url != identity.canonical_url
            or identity.canonical_url != payload["qualified"]["url"] or observation.observed_at != context.discovered_at
        ):
            raise RuntimeError("Archived discovery context differs from its recorded capture")
        fields = payload["qualified"]["fields"]
        original_job = Job.discover(
            tenant_id=self.tenant_id, job_id=canonical_job_id(payload["ownerJobId"]),
            posting_url=PostingUrl(identity.canonical_url), source=context.source, employer=Employer(fields["employer"]),
            search_strategy=SearchStrategy.SMART_EXTRACT, discovered_at=context.discovered_at,
            metadata=JobMetadata(**{name: fields[name] for name in ("title", "salary", "description", "location")}),
        )
        expected = new_job_discovery_events(original_job, identity, observation)
        if len(events) != len(expected) or any(
            event.event_type != original.event_type or str(event.tenant_id) != str(self.tenant_id)
            or event.payload != original.payload or event.occurred_at != observation.observed_at
            for event, original in zip(events, expected)
        ):
            raise RuntimeError("Archived discovery events differ from their recorded identity or observation")
        # If the original observation still owns this source generation, join
        # its canonical rows as well. Later observations are not substituted
        # for the frozen original facts when completing historical events.
        repository = SqliteJobRepository(self.conn)
        current = [item for item in repository.list_observations(self.tenant_id, original_job.job_id)
                   if item.source_observation_id == self.capture_id]
        owner = repository.load(self.tenant_id, original_job.job_id)
        if current and (
            current != [observation] or repository.load_canonical_identity(self.tenant_id, original_job.job_id) != identity
            or owner is None or owner.source != context.source or owner.discovered_at != context.discovered_at
        ):
            raise RuntimeError("Archived discovery context differs from its canonical source records")
        publisher = PublicationPublisher(
            PublicationConnection(self.conn), stage="discover", idempotency_prefix=self.capture_id,
        )
        for event in events:
            publisher.publish(event)

    def requires_missing_receipt(self, owner_job_id=None):
        """Pre-upgrade partial inserts have no recoverable original page bytes."""
        return self.conn.execute(
            "SELECT 1 FROM job_source_observations o JOIN jobs j ON j.tenant_id=o.tenant_id AND j.job_id=o.job_id "
            "WHERE o.tenant_id=? AND o.source_id=? AND o.source_observation_id=? AND (? IS NULL OR o.job_id=?) "
            "AND (o.observed_at=j.discovered_at OR EXISTS (SELECT 1 FROM job_events e "
            "WHERE e.tenant_id=o.tenant_id AND e.job_id=o.job_id AND e.idempotency_key=?)) "
            "AND NOT EXISTS (SELECT 1 FROM posting_snapshot_sets s WHERE s.tenant_id=j.tenant_id AND s.job_id=j.job_id "
            "AND s.latest_snapshot_version>0) "
            "AND NOT EXISTS (SELECT 1 FROM job_enrichments n WHERE n.tenant_id=j.tenant_id AND n.job_id=j.job_id "
            "AND n.current_status='enriched') "
            "AND NOT EXISTS (SELECT 1 FROM jobctrl_deleted_jobs d WHERE d.tenant_id=j.tenant_id AND d.job_id=j.job_id "
            "AND (d.restored_at IS NULL OR julianday(d.restored_at)<=julianday(d.deleted_at)))",
            (str(self.tenant_id), self.source_id, self.capture_id,
             str(owner_job_id) if owner_job_id is not None else None,
             str(owner_job_id) if owner_job_id is not None else None, f"{self.capture_id}:JobDiscovered"),
        ).fetchone() is not None

    def finish(self, *, reason):
        self.write_fence()
        record_job_event(
            self.conn, None, "discover", "ArchivedSmartPostingCompleted", tenant_id=self.tenant_id,
            payload={"captureId": self.capture_id, "sourceId": self.source_id, "reason": reason},
            entity_kind="discovery_capture_publication", entity_ref=self.capture_id,
            idempotency_key=self._key("completed"),
        )

    def can_publish(self, payload, qualified):
        """Called under BEGIN IMMEDIATE, before any publication writes."""
        self.write_fence()
        owner = self.conn.execute(
            "SELECT j.url,j.title,j.company,j.salary,j.description,j.location FROM jobs j "
            "WHERE j.tenant_id=? AND j.job_id=? AND NOT EXISTS ("
            "SELECT 1 FROM jobctrl_deleted_jobs d WHERE d.tenant_id=j.tenant_id AND d.job_id=j.job_id "
            "AND (d.restored_at IS NULL OR julianday(d.restored_at)<=julianday(d.deleted_at)))",
            (str(self.tenant_id), payload["ownerJobId"]),
        ).fetchone()
        fields = qualified.fields
        expected = (qualified.url, *(fields[name] for name in ("title", "employer", "salary", "description", "location")))
        if owner is None or tuple(value or "" for value in owner) != expected:
            return False
        key = (str(self.tenant_id), payload["ownerJobId"])
        snapshot = self.conn.execute(
            "SELECT latest_snapshot_version FROM posting_snapshot_sets WHERE tenant_id=? AND job_id=?", key,
        ).fetchone()
        enrichment = self.conn.execute(
            "SELECT current_status FROM job_enrichments WHERE tenant_id=? AND job_id=?", key,
        ).fetchone()
        if (snapshot is not None and snapshot[0] > 0) or (enrichment is not None and enrichment[0] == "enriched"):
            return False
        stage_owner = self.conn.execute(
            "SELECT 1 FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='enrich' AND state<>'pending'", key,
        ).fetchone()
        if snapshot is not None or enrichment is not None or stage_owner is not None:
            raise TransientNetworkError("A newer enrichment attempt owns this Job; archived capture retained for retry")
        # A later observation, even with identical text, owns the current
        # source generation. Do not rewrite it while completing stale work.
        observation = self.conn.execute(
            "SELECT source_observation_id FROM job_source_observations "
            "WHERE tenant_id=? AND job_id=? AND source_id=?",
            (str(self.tenant_id), payload["ownerJobId"], self.source_id),
        ).fetchall()
        return bool(observation) and all(row[0] == self.capture_id for row in observation)


class CaptureJobRepository(SqliteJobRepository):
    """Bind the prepared capture and original owner in the insert transaction."""

    def __init__(self, *args, publication, **kwargs):
        super().__init__(*args, **kwargs)
        self.publication = publication
        self.qualified = None

    def claim_new_job(self, job, identity, observation):
        if self._conn.in_transaction:
            raise RuntimeError("Archived posting insert requires its own transaction")
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            self.publication.prepare_insert(job, self.qualified, identity, observation)
            owner = super().claim_new_job(job, identity, observation)
            if owner is not None:
                self._conn.rollback()
            else:
                self._conn.commit()
            return owner
        except BaseException:
            self._conn.rollback()
            raise


class PublicationConnection:
    """Existing adapters join the publication transaction without early commit."""

    def __init__(self, conn):
        self.conn = conn

    def __getattr__(self, name):
        return getattr(self.conn, name)

    def commit(self):
        pass


class PublicationPublisher(DurableJobEventPublisher):
    """A best-effort domain publisher cannot acknowledge an incomplete receipt."""

    failed = False

    def publish(self, event):
        prefix = self._idempotency_prefix
        try:
            if prefix is not None and event.event_type == "ContentDuplicateCandidateDetected":
                self._idempotency_prefix = f"{prefix}:candidate:{event.payload['candidate_job_id']}"
            super().publish(event)
        except Exception:
            self.failed = True
            raise
        finally:
            self._idempotency_prefix = prefix


def claim_recovery_owner(conn, *, execution, family, attempt=None, owner_token=None, cancel_event=None):
    """Fence source activity retries, and cancellation, at each durable boundary."""
    def canceled():
        if cancel_event is not None and cancel_event.is_set():
            raise TransientNetworkError("smart-extract discovery canceled")

    if execution is None or attempt is None or owner_token is None:
        return canceled
    if type(attempt) is not int or attempt < 1 or not owner_token.strip():
        raise ValueError("Archived capture activity owner is invalid")
    scope = [execution.tenant_id, execution.workflow_id, execution.temporal_run_id, family]
    key = hashlib.sha256(json.dumps(scope).encode()).hexdigest()

    def current():
        return conn.execute(
            "SELECT json_extract(payload_json,'$.attempt'),json_extract(payload_json,'$.ownerToken') "
            "FROM job_events WHERE tenant_id=? AND entity_kind='discovery_capture_owner' AND entity_ref=? "
            "ORDER BY CAST(json_extract(payload_json,'$.attempt') AS INTEGER) DESC,event_id ASC LIMIT 1",
            (execution.tenant_id, key),
        ).fetchone()

    def fence():
        canceled()
        row = current()
        if row is None or tuple(row) != (attempt, owner_token):
            raise TransientNetworkError("Archived capture activity owner was superseded")

    canceled()
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = current()
        if row is not None and (row[0] > attempt or (row[0] == attempt and row[1] != owner_token)):
            raise TransientNetworkError("Archived capture activity owner was superseded")
        record_job_event(
            conn, None, "discover", "ArchivedCaptureOwnerClaimed", tenant_id=execution.tenant_id,
            payload={"execution": scope, "attempt": attempt, "ownerToken": owner_token},
            entity_kind="discovery_capture_owner", entity_ref=key,
            idempotency_key=f"capture-owner:{key}:{attempt}:{owner_token}",
        )
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return fence
