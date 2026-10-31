"""Turn arbitrary-site locators into source-bound postings before writing Jobs."""

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json

from jobctrl.domain.determinations import DeterminationEnvelope, DeterminationFailure
from jobctrl.domain.discovery.posting_qualification import ModelPostingQualifier
from jobctrl.domain.discovery.source_registry import ManualActionReason
from jobctrl.domain.enrichment.page_interpretation import ModelPageInterpreter, ModelPagePostingExtractor
from jobctrl.domain.enrichment.snapshot_services import ContentAcquisitionResult
from jobctrl.domain.enrichment.snapshot_value_objects import (
    ActiveState,
    QuarantineReason,
    SnapshotApplyUrl,
    SnapshotConfidence,
    SnapshotDescriptionHash,
)
from jobctrl.domain.enrichment.value_objects import ExtractionTier, FullDescription
from jobctrl.domain.errors import TransientNetworkError
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.determinations import determination_dependencies
from jobctrl.infrastructure.enrichment.playwright_fetcher import (
    DetailPageFetchBlocked,
    DetailPageFetchUnavailable,
    PlaywrightDetailPageFetcher,
)
from jobctrl.infrastructure.enrichment.posting_sources import (
    live_posting_page,
    posting_page_sources,
    rendered_page_text,
)
from jobctrl.infrastructure.network import validate_public_http_url


@dataclass(frozen=True)
class QualifiedPosting:
    url: str
    fields: dict[str, str]
    acquisition: ContentAcquisitionResult
    determinations: tuple[DeterminationEnvelope, ...]

    def acquire(self, **_kwargs):
        """Snapshot persistence consumes exactly the already-validated capture."""
        return self.acquisition


class LivePostingFetcher:
    def __init__(self, client):
        self.client = client

    def fetch(self, url):
        result = self.client.rendered_page(url)
        if result is None:
            raise DetailPageFetchBlocked("acquisition_denied")
        return live_posting_page(result, url)


class SmartPostingIntake:
    def __init__(
        self,
        conn,
        *,
        source_id,
        run_id,
        search_cfg,
        fetcher=None,
        dependencies=None,
        url_validator=None,
        cancel_event=None,
        tenant_id=LOCAL_TENANT,
    ):
        self.conn, self.source_id, self.run_id = conn, source_id, run_id
        self.tenant_id = tenant_id
        self.search_cfg = search_cfg
        self.fetcher = fetcher or PlaywrightDetailPageFetcher(raise_on_unavailable=True)
        self.dependencies = (
            dependencies
            if dependencies is not None
            else determination_dependencies(
                conn,
                tenant_id=str(tenant_id),
                lane="discovery",
            )
        )
        self.url_validator = url_validator or validate_public_http_url
        self.cancel_event = cancel_event

    def _check_canceled(self):
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise TransientNetworkError("smart-extract discovery canceled")

    def prepare(self, url, card):
        """No card field is authoritative for the canonical job."""
        self._check_canceled()
        if not self.url_validator(url).allowed:
            self.record(url, "held", "unsafe_posting_url")
            return None
        try:
            page = self.fetcher.fetch(url)
        except DetailPageFetchBlocked as error:
            self.record(url, "held", error.reason_code, card=card)
            return None
        except DetailPageFetchUnavailable as error:
            raise TransientNetworkError("smart-extract posting acquisition unavailable") from error
        self._check_canceled()
        final_url = str(page.final_url or url).strip()
        if not all(
            self.url_validator(value).allowed
            for value in (
                final_url,
                *(frame.final_url or frame.url for frame in page.embedded_pages),
            )
        ):
            self.record(url, "held", "unsafe_posting_redirect")
            return None
        if page.status in {401, 403, 429}:
            self.record(url, "held", f"posting_http_{page.status}", card=card)
            return None
        if page.status is None or page.status >= 500:
            raise TransientNetworkError("smart-extract posting acquisition unavailable")
        if page.status in {404, 410}:
            self.record(url, "filtered", f"posting_http_{page.status}")
            return None

        receipts = []
        try:
            sources, origins = posting_page_sources(page, entity_id=final_url)
            interpreted, page_receipt = ModelPageInterpreter(**self.dependencies).interpret(
                entity_id=final_url,
                text=rendered_page_text(page),
                metadata={
                    "url": url,
                    "final_url": final_url,
                    "http_status": page.status,
                    "status_evidence_complete": page.status_evidence_complete,
                    "visibility_verified": page.status_visibility_verified,
                },
                additional_sources=[source for source in sources if source.source_id != "rendered_page"],
            )
            receipts.append(page_receipt)
            self._check_canceled()
            if interpreted.availability.value in {"closed", "expired", "removed"}:
                self.record(url, "filtered", "posting_unavailable", receipts=receipts)
                return None
            if interpreted.page_kind.value != "posting" or interpreted.access_state.value != "clear":
                self.record(url, "held", "individual_posting_unverified", card=card, receipts=receipts)
                return None
            extracted, extraction_receipt = ModelPagePostingExtractor(**self.dependencies).extract(
                entity_id=final_url,
                sources=sources,
                source_urls=origins,
            )
            receipts.append(extraction_receipt)
            self._check_canceled()
            if not extracted.employer.value.strip():
                self.record(url, "held", "posting_employer_unknown", card=card, receipts=receipts)
                return None
            target = self.search_cfg.get("confirmed_targets") or {}
            rules = (
                {"locations": target.get("locations") or [], "work_models": target.get("work_models") or []}
                if target.get("locations") or target.get("work_models")
                else self.search_cfg.get("locations") or []
            )
            qualification, qualification_receipt = ModelPostingQualifier(**self.dependencies).qualify(
                entity_id=final_url,
                extraction=extracted,
                extraction_id=extraction_receipt.determination_id,
                locations=rules,
                captured_sources=sources,
                source_urls=origins,
            )
            receipts.append(qualification_receipt)
            self._check_canceled()
            if (
                qualification.role_title.value != "specific_role"
                or qualification.description_quality.confidence == "low"
            ):
                self.record(url, "held", "specific_complete_posting_unverified", card=card, receipts=receipts)
                return None
            if qualification.location_match.value != "match":
                mismatch = qualification.location_match.value == "mismatch"
                self.record(
                    url,
                    "filtered" if mismatch else "held",
                    "location_mismatch" if mismatch else "posting_location_unknown",
                    card=card if not mismatch else None,
                    receipts=receipts,
                )
                return None
            if extracted.application_url.value and not self.url_validator(extracted.application_url.value).allowed:
                self.record(url, "held", "unsafe_application_url", receipts=receipts)
                return None
        except DeterminationFailure as error:
            self.record(url, "failed", error.code, receipts=receipts)
            raise

        description = FullDescription(text=extracted.description.value)
        acquisition = ContentAcquisitionResult(
            ok=True,
            extraction_tier=ExtractionTier.LLM_ASSISTED.value,
            confidence=SnapshotConfidence(qualification.description_quality.confidence),
            quarantine_reason=QuarantineReason.NONE,
            active_state=ActiveState(interpreted.availability.value),
            verification_method="model_determination",
            http_status_code=page.status,
            description=description,
            description_hash=SnapshotDescriptionHash.from_text(description.text),
            apply_url=SnapshotApplyUrl(value=extracted.application_url.value)
            if extracted.application_url.value
            else None,
            raw_text_hash=page.raw_html_hash or hashlib.sha256((page.status_html or page.html).encode()).hexdigest(),
            evidence=tuple(f"{receipt.kind}_determination:{receipt.determination_id}" for receipt in receipts),
        )
        return QualifiedPosting(
            url=final_url,
            fields={name: getattr(extracted, name).value for name in type(extracted).model_fields},
            acquisition=acquisition,
            determinations=tuple(receipts),
        )

    def record(self, url, disposition, reason, *, card=None, receipts=(), job_id=None, commit=True):
        from jobctrl.infrastructure.discovery.production_wiring import _enqueue_manual_capture
        from jobctrl.state import record_job_event

        self._check_canceled()
        receipt_ids = {receipt.kind: receipt.determination_id for receipt in receipts}
        if disposition == "held" and card is not None:
            _enqueue_manual_capture(
                self.conn,
                originating_url=url,
                source_id=self.source_id,
                reason=ManualActionReason.AMBIGUOUS_CAREER_SYSTEM.value,
                retry_context={
                    "source": "smart_extract_posting",
                    "reason": reason,
                    "run_id": self.run_id,
                    "card": card,
                    "determination_ids": receipt_ids,
                },
                required_at=datetime.now(timezone.utc).isoformat(),
                tenant_id=self.tenant_id,
            )
        key = hashlib.sha256(
            json.dumps([self.run_id, self.source_id, url, disposition, reason, receipt_ids], sort_keys=True).encode()
        ).hexdigest()
        record_job_event(
            self.conn,
            job_id,
            "discover",
            "StageProgress",
            level="warning" if disposition in {"held", "failed"} else "info",
            message={
                "held": "A source link needs a verified individual posting before it can enter Jobs.",
                "filtered": "A source posting was excluded by its recorded posting or location evidence.",
                "failed": "A posting determination failed; no unverified job was stored.",
                "accepted": "A verified posting entered Jobs with its recorded source and location evidence.",
            }[disposition],
            payload={
                "sourceId": self.source_id,
                "runId": self.run_id,
                "disposition": disposition,
                "reason": reason,
                "determinationIds": receipt_ids,
            },
            entity_kind="discovery_capture",
            entity_ref=key,
            idempotency_key=f"smart-posting:{key}",
            tenant_id=self.tenant_id,
        )
        if commit:
            self.conn.commit()
