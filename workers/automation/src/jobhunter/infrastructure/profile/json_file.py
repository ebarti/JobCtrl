"""JsonFileProfileRepository — local adapter for ``ProfileRepository``.

Reads/writes ``~/.jobhunter/profile.json``. Publishes ``ProfileUpdated`` /
``ProfileImported`` domain events through the injected ``EventPublisher``
(Phase 3 in-process bus by default). The path is overridable so tests run
against a tmp dir without monkeypatching the module.

See ddd-target.md §5.3 (Profile context ports / local adapter).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jobhunter.domain.events import (
    ProfileImportedPayload,
    ProfileUpdatedPayload,
    create_profile_imported,
    create_profile_updated,
)
from jobhunter.domain.ports.events import EventPublisher
from jobhunter.domain.profile.aggregate import (
    DEFAULT_PROFILE_ID,
    InvalidProfileError,
    Profile,
)
from jobhunter.domain.profile.ports import (
    PdfParserPort,
    ProfileImportResult,
)
from jobhunter.domain.profile.snapshot import ProfileSnapshot
from jobhunter.domain.tenant import TenantId

logger = logging.getLogger(__name__)


class JsonFileProfileRepository:
    """Filesystem-backed Profile repository.

    Writes pretty-printed JSON to ``profile_path`` (default
    ``~/.jobhunter/profile.json``). Each successful write bumps an in-memory
    version counter so consumers can detect snapshot freshness; the version
    is NOT persisted yet (it derives from the file's mtime in cloud mode).
    """

    def __init__(
        self,
        *,
        profile_path: Path,
        publisher: EventPublisher,
        pdf_parser: PdfParserPort | None = None,
        profile_id: str = DEFAULT_PROFILE_ID,
    ) -> None:
        self._profile_path = Path(profile_path)
        self._publisher = publisher
        self._pdf_parser = pdf_parser
        self._profile_id = profile_id
        # In-memory monotonic version. The first load returns version 1; the
        # first save bumps to 2, etc. Tests can monkey-patch via the
        # ``_version`` attribute.
        self._version: int = 0

    # ------------------------------------------------------------------
    # Load / save
    # ------------------------------------------------------------------

    def load(self, tenant_id: TenantId) -> Profile | None:
        if not self._profile_path.exists():
            return None
        raw = self._read_json()
        return Profile.from_dict(tenant_id, raw, profile_id=self._profile_id)

    def save(self, tenant_id: TenantId, profile: Profile) -> ProfileSnapshot:
        self._profile_path.parent.mkdir(parents=True, exist_ok=True)

        # Snapshot the previous on-disk shape BEFORE the write so we can diff
        # the actual changed sections for ``ProfileUpdated.changed_sections``
        # (per §4.3 the field semantics is "what changed in this update", not
        # "what's currently present"). A missing/corrupt previous file just
        # yields an empty mapping, which makes every section "added".
        previous_dict: dict[str, Any] = {}
        if self._profile_path.exists():
            try:
                previous_dict = self._read_json()
            except InvalidProfileError:
                previous_dict = {}

        # Re-parse via from_dict so any caller-supplied Profile is validated
        # one more time before persisting (defensive — also normalizes
        # extra-fields ordering).
        validated = Profile.from_dict(
            tenant_id,
            profile.to_dict(),
            profile_id=profile.profile_id or self._profile_id,
        )
        next_dict = validated.to_dict()
        text = json.dumps(next_dict, indent=2, ensure_ascii=False)
        self._profile_path.write_text(text, encoding="utf-8")

        self._version += 1
        snapshot = ProfileSnapshot.from_profile(validated, version=self._version)

        changed_sections = _diff_top_level_sections(previous_dict, next_dict)

        try:
            self._publisher.publish(
                create_profile_updated(
                    tenant_id,
                    ProfileUpdatedPayload(
                        changed_sections=changed_sections,
                        updated_at=datetime.now(timezone.utc).isoformat(),
                    ),
                )
            )
        except Exception:  # noqa: BLE001 — event publication never blocks save
            logger.exception("Failed to publish ProfileUpdated event")

        return snapshot

    def load_snapshot(self, tenant_id: TenantId) -> ProfileSnapshot:
        profile = self.load(tenant_id)
        if profile is None:
            raise FileNotFoundError(
                f"Profile not found at {self._profile_path}. Run `jobhunter init` first."
            )
        if self._version == 0:
            self._version = 1
        return ProfileSnapshot.from_profile(profile, version=self._version)

    # ------------------------------------------------------------------
    # PDF import
    # ------------------------------------------------------------------

    def import_from_pdf(
        self,
        tenant_id: TenantId,
        pdf_bytes: bytes,
        *,
        filename: str = "resume.pdf",
    ) -> ProfileImportResult:
        if self._pdf_parser is None:
            raise RuntimeError(
                "JsonFileProfileRepository was constructed without a PdfParserPort; "
                "cannot import from PDF. Inject one via the factory."
            )

        base_profile_dict: dict[str, Any] | None = None
        existing = self.load(tenant_id)
        if existing is not None:
            base_profile_dict = existing.to_dict()

        # Resume style lives next to the profile but is owned by the
        # Materials context — we just hand it to the parser as an
        # opaque base for diff/merge.
        base_style = self._read_style_alongside_profile()

        draft = self._pdf_parser.parse(
            pdf_bytes,
            filename=filename,
            base_profile=base_profile_dict,
            base_style=base_style,
        )

        result = ProfileImportResult(
            profile=draft.get("profile", {}) if isinstance(draft, dict) else {},
            style=draft.get("style", {}) if isinstance(draft, dict) else {},
            source=draft.get("source", {}) if isinstance(draft, dict) else {},
        )

        try:
            self._publisher.publish(
                create_profile_imported(
                    tenant_id,
                    ProfileImportedPayload(
                        source=filename or "resume.pdf",
                        imported_sections=tuple(sorted(result.profile.keys())),
                        imported_at=datetime.now(timezone.utc).isoformat(),
                    ),
                )
            )
        except Exception:  # noqa: BLE001
            logger.exception("Failed to publish ProfileImported event")

        return result

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _read_json(self) -> dict[str, Any]:
        try:
            data = json.loads(self._profile_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise InvalidProfileError(
                [f"profile.json at {self._profile_path} is not valid JSON: {exc}"]
            ) from exc
        if not isinstance(data, dict):
            raise InvalidProfileError(["profile.json must contain a top-level object."])
        return data

    def _read_style_alongside_profile(self) -> dict[str, Any] | None:
        """Read resume_style.json sibling for the parser's base_style merge.

        Optional — returns None when the file is absent. Style ownership is
        the Materials context's; we read but never write it from here.
        """
        style_path = self._profile_path.parent / "resume_style.json"
        if not style_path.exists():
            return None
        try:
            data = json.loads(style_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            logger.warning("resume_style.json at %s is not valid JSON; ignoring.", style_path)
            return None
        return data if isinstance(data, dict) else None


def _diff_top_level_sections(
    previous: dict[str, Any],
    current: dict[str, Any],
) -> tuple[str, ...]:
    """Return the sorted top-level keys whose values differ between two dicts.

    Used by ProfileUpdated.changed_sections so consumers can route on the
    actual delta (e.g. "only personal.email changed") instead of seeing every
    save claim that everything changed. Comparison is value-equality at the
    top level — for nested edits this still says e.g. "personal" but never
    says "work_authorization" if that section is byte-identical.
    """
    keys = set(previous) | set(current)
    return tuple(sorted(k for k in keys if previous.get(k) != current.get(k)))

