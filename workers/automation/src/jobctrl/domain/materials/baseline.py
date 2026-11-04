"""Prepare an exact, version-bound base resume without semantic/model work."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.materials.aggregate import MaterialsSetFactory
from jobctrl.domain.materials.entities import Artifact
from jobctrl.domain.materials.provenance import BulletProvenance, BulletProvenanceSet
from jobctrl.domain.materials.provenance_builder import rendered_lines
from jobctrl.domain.materials.resume_document import build_resume_document, contact_items_text
from jobctrl.domain.materials.use_cases import (
    MaterialsChangedDuringGeneration,
    TailorOutcome,
    _materials_write_boundary,
    _pdf_with_accepted_source,
)
from jobctrl.domain.materials.value_objects import ArtifactType, ControlRule, RenderFormat, TransformType
from jobctrl.domain.ports.artifact_review import ValidationResult
from jobctrl.domain.ports.materials import (
    ArtifactTextWriter,
    BulletProvenanceRepository,
    MaterialsRepository,
    PdfRendererPort,
    UnitOfWork,
)
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId


def baseline_resume_text(profile: dict) -> str:
    """Print the same complete document the baseline HTML/PDF renderer uses."""
    document = build_resume_document({}, profile, baseline=True)
    personal = document["personal"]
    lines = [
        personal["full_name"],
        personal["address"],
        contact_items_text(personal["contact_items"]),
        "",
        "EXECUTIVE PROFILE",
        document["summary"],
        "",
        "EXPERIENCE",
    ]
    for entry in document["experience"]:
        lines.extend([f"{entry['title']} | {entry['company']}", entry["subtitle"]])
        if entry["summary"]:
            lines.append(entry["summary"])
        lines.extend(f"- {bullet['text']}" for bullet in entry["bullets"])
        lines.append("")
    lines.append("EDUCATION")
    for entry in document["education"]:
        lines.extend([entry["subtitle"], entry["degree"]])
        if entry["details"]:
            lines.append(entry["details"])
        lines.append("")
    lines.append("SKILLS")
    lines.extend(f"{category['label']}: {', '.join(category['items'])}" for category in document["skills"])
    return "\n".join(lines)


def baseline_provenance(profile: dict) -> tuple[BulletProvenance, ...]:
    """Bind direct field copies by identity; make no support/fit determination."""
    rows = []
    personal = profile.get("personal", {})
    document = build_resume_document({}, profile, baseline=True)
    bullet_sources = {
        bullet["id"]: (f"experience:{entry['id']}:source:{index}",)
        for entry in document["experience"]
        for index, bullet in enumerate(entry["bullets"])
    }
    for ident, section, source_id, text in rendered_lines(profile, {}, baseline=True):
        if ident == "personal:address":
            sources = tuple(
                f"personal:{key}" for key in ("address", "city", "postal_code", "country") if personal.get(key)
            )
        elif ident == "personal:contact":
            sources = tuple(
                f"personal:{key}"
                for key in (
                    "phone",
                    "email",
                    "website_url" if personal.get("website_url") else "portfolio_url",
                    "linkedin_url",
                    "github_url",
                )
                if personal.get(key)
            )
        elif section == "executive_profile":
            sources = ("executive_profile:baseline",)
        elif ident in bullet_sources:
            sources = bullet_sources[ident]
        elif section == "experience" or section == "personal":
            sources = (ident,)
        else:
            sources = (f"{section}:{source_id}",)
        rows.append(
            BulletProvenance(
                bullet_id=ident,
                section=section,
                source_id=source_id,
                evidence_ids=sources,
                requirement_ids=(),
                matched_keywords=(),
                transform_type=TransformType.VERBATIM,
                control=ControlRule.BASE_PROFILE_COPY,
                rationale="Copied from the saved base profile; tailoring is disabled. No requirement coverage was assessed.",
                generated_text=text,
            )
        )
    return tuple(rows)


class PrepareBaselineResumeUseCase:
    """Publish a job-owned baseline through the normal atomic material boundary.

    No LLM or semantic-review port is accepted. The profile/template readers and
    owner guard are rechecked under the material writer before publication.
    """

    def __init__(
        self,
        *,
        repository: MaterialsRepository,
        provenance_repository: BulletProvenanceRepository,
        profile_reader: Callable[[TenantId], ProfileSnapshot],
        template_reader: Callable[[TenantId, JobId], dict],
        pdf_renderer: PdfRendererPort,
        artifact_writer: ArtifactTextWriter,
        unit_of_work: UnitOfWork,
    ) -> None:
        self._repository = repository
        self._provenance_repository = provenance_repository
        self._profile_reader = profile_reader
        self._template_reader = template_reader
        self._pdf_renderer = pdf_renderer
        self._artifact_writer = artifact_writer
        self._unit_of_work = unit_of_work

    def execute(
        self,
        *,
        job: dict,
        job_id: JobId,
        profile_snapshot: ProfileSnapshot,
        tailored_dir: Path,
        tenant_id: TenantId = LOCAL_TENANT,
        retailor: bool = False,
        commit_guard: Callable[[], None] | None = None,
        allow_low_fit_override: bool = False,
        **_unused,
    ) -> TailorOutcome:
        if profile_snapshot.tenant_id != tenant_id:
            raise ValueError("baseline_profile_tenant_mismatch")
        if commit_guard:
            commit_guard()
        previous = self._repository.load(tenant_id, job_id)
        accepted = self._repository.load_current_approved(tenant_id, job_id)
        if accepted is not None and not retailor:
            return TailorOutcome(
                materials=accepted,
                status="already_done",
                attempts=0,
                text_path=accepted.tailored_resume.path,
                pdf_path=accepted.resume_pdf.path if accepted.resume_pdf else None,
            )
        now = datetime.now(timezone.utc).isoformat()
        prior = None
        if previous is None:
            materials = MaterialsSetFactory.initial(tenant_id=tenant_id, job_id=job_id, created_at=now)
        else:
            prior, materials = MaterialsSetFactory.next_generation(previous, created_at=now)
        profile = profile_snapshot.as_dict()
        document = build_resume_document({}, profile, baseline=True)
        if not document["personal"]["full_name"] or not document["experience"]:
            raise ValueError("baseline_resume_incomplete")
        template = self._template_reader(tenant_id, job_id)
        provenance = baseline_provenance(profile)
        source_ids = list(dict.fromkeys(source for row in provenance for source in row.evidence_ids))
        origin = {
            "profile_id": profile_snapshot.profile_id,
            "profile_version": profile_snapshot.version,
            "source_ids": source_ids,
            "modified": False,
        }
        metadata = {
            "preparation_mode": "baseline_copy",
            "base_profile_copy": origin,
            "allow_low_fit_override": allow_low_fit_override is True,
            "resume_template": template.get("metadata"),
            "model_reviews": {"status": "not_applicable", "reason": "resume_tailoring_disabled"},
            "requirement_coverage": {"status": "not_assessed", "reason": "resume_tailoring_disabled"},
        }
        tailored_dir.mkdir(parents=True, exist_ok=True)
        text_path = tailored_dir / f"{job_id}_{uuid4().hex}_g{materials.generation}.txt"
        text = baseline_resume_text(profile)
        size = self._artifact_writer.write_text(text_path, text)
        metadata["source_sha256"] = sha256(text.encode("utf-8")).hexdigest()
        artifact = Artifact.create(
            type=ArtifactType.TAILORED_RESUME,
            path=str(text_path),
            created_at=now,
            render_format=RenderFormat.TEXT,
            size_bytes=size,
            metadata=metadata,
        )
        materials = materials.with_resume_attempt(
            artifact, validation=ValidationResult.success(), verdict=None, updated_at=now
        )
        materials = materials.with_metadata(metadata, updated_at=now)
        if commit_guard:
            commit_guard()
        pdf_path = text_path.with_suffix(".pdf")
        pdf = self._pdf_renderer.render_resume_to_pdf(
            tailored_payload={},
            profile_dict=profile,
            output_path=str(pdf_path),
            created_at=now,
            resume_theme=template.get("theme"),
            resume_template=template.get("metadata"),
            baseline=True,
        )
        if Path(pdf.path) != pdf_path:
            raise ValueError("baseline_pdf_output_path_changed")
        pdf = _pdf_with_accepted_source(pdf, materials.tailored_resume, materials.generation)
        materials = materials.with_resume_pdf(pdf, updated_at=now)
        # Render before the writer: every failure preserves the accepted set.
        # Retain files on uncertain commit acknowledgement, as other materials do.
        with _materials_write_boundary(self._repository, self._unit_of_work):
            if commit_guard:
                commit_guard()
            current_profile = self._profile_reader(tenant_id)
            if (
                current_profile.profile_id != profile_snapshot.profile_id
                or current_profile.version != profile_snapshot.version
                or current_profile.as_dict() != profile
            ):
                raise MaterialsChangedDuringGeneration("base_profile_changed_during_preparation")
            if self._repository.load(tenant_id, job_id) != previous:
                raise MaterialsChangedDuringGeneration("materials_changed_during_baseline_preparation")
            if self._template_reader(tenant_id, job_id) != template:
                raise MaterialsChangedDuringGeneration("resume_template_changed_during_preparation")
            if sha256(text_path.read_bytes()).hexdigest() != metadata["source_sha256"]:
                raise MaterialsChangedDuringGeneration("baseline_source_bytes_changed")
            if prior is not None:
                self._repository.save(prior)
            self._repository.save(materials)
            self._provenance_repository.save(
                BulletProvenanceSet(
                    tenant_id=tenant_id,
                    job_id=job_id,
                    generation=materials.generation,
                    artifact_id=artifact.artifact_id,
                    bullets=provenance,
                    created_at=now,
                )
            )
        return TailorOutcome(
            materials=materials,
            status="approved",
            attempts=1,
            text_path=str(text_path),
            pdf_path=str(pdf_path),
            report={"status": "approved", "preparation_mode": "baseline_copy", **metadata},
        )
