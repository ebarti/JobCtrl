"""SQLite-backed ProfileRepository adapter.

The Candidate Profile aggregate is stored natively in relational SQLite rows:
one root row for scalar value objects and child tables for experience,
education, skills, tailoring requirements, and resume constraints. Profiles
must be created explicitly through the profile use cases, API, or PDF import
flow.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timezone
from typing import Any

from jobctrl.domain.events import (
    ProfileImportedPayload,
    ProfileUpdatedPayload,
    create_profile_imported,
    create_profile_updated,
)
from jobctrl.domain.ports.events import EventPublisher
from jobctrl.domain.profile.aggregate import DEFAULT_PROFILE_ID, InvalidProfileError, Profile
from jobctrl.domain.profile.ports import PdfParserPort, ProfileImportResult
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.materials.resume_style import (
    DEFAULT_RESUME_TEMPLATE_TEXT,
    normalize_resume_style,
)
from jobctrl.resume_profile import get_achievement_evidence

logger = logging.getLogger(__name__)

_CHILD_TABLES = (
    "candidate_profile_experience_bullets",
    "candidate_profile_achievement_evidence",
    "candidate_profile_experience_entries",
    "candidate_profile_education_entries",
    "candidate_profile_skill_items",
    "candidate_profile_skill_categories",
    "candidate_profile_required_experience_entries",
    "candidate_profile_required_education_entries",
    "candidate_profile_required_skill_categories",
    "candidate_profile_required_bullets",
    "candidate_profile_required_skills",
    "candidate_profile_resume_constraint_metrics",
)

_IGNORED_LEGACY_TOP_LEVEL_FIELDS = {"schema_version"}


class SqliteProfileRepository:
    """SQLite-backed implementation of ``ProfileRepository``."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        publisher: EventPublisher,
        pdf_parser: PdfParserPort | None = None,
        profile_id: str = DEFAULT_PROFILE_ID,
    ) -> None:
        self._conn = conn
        self._publisher = publisher
        self._pdf_parser = pdf_parser
        self._profile_id = profile_id or DEFAULT_PROFILE_ID

    # ------------------------------------------------------------------
    # Load / save
    # ------------------------------------------------------------------

    def load(self, tenant_id: TenantId) -> Profile | None:
        row = self._profile_row(tenant_id)
        if row is None:
            return None
        return Profile.from_dict(tenant_id, self._row_to_profile_dict(tenant_id, row), profile_id=self._profile_id)

    def save(self, tenant_id: TenantId, profile: Profile) -> ProfileSnapshot:
        previous = self.load(tenant_id)
        previous_dict = previous.to_dict() if previous is not None else {}

        row = self._profile_row(tenant_id)
        candidate = _profile_dict_with_reconciled_achievement_evidence(profile)
        if row is not None:
            candidate["resume_constraints"] = {
                "real_metrics": list(self._legacy_unassigned_metrics(tenant_id, row))
            }
        validated = Profile.from_dict(
            tenant_id,
            candidate,
            profile_id=profile.profile_id or self._profile_id,
        )
        _reject_unsupported_top_level_fields(validated)
        version = int(row["version"]) + 1 if row is not None else 1
        rendering = self.load_rendering_settings(tenant_id)
        self._replace_profile(tenant_id, validated, version=version, rendering=rendering)

        snapshot = ProfileSnapshot.from_profile(validated, version=version)
        changed_sections = _diff_top_level_sections(previous_dict, validated.to_dict())

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
        except Exception:  # noqa: BLE001
            logger.exception("Failed to publish ProfileUpdated event")

        return snapshot

    def _legacy_unassigned_metrics(
        self,
        tenant_id: TenantId,
        row: sqlite3.Row,
    ) -> tuple[str, ...]:
        """Return only old flat values that current achievements do not own."""

        stored_profile = self._row_to_profile_dict(tenant_id, row)
        stored_metrics = tuple(
            str(value)
            for value in _record(stored_profile.get("resume_constraints")).get(
                "real_metrics", ()
            )
            if str(value).strip()
        )
        stored_profile["resume_constraints"] = {"real_metrics": []}
        derived_metrics = Profile.from_dict(
            tenant_id,
            stored_profile,
            profile_id=self._profile_id,
        ).resume_constraints.real_metrics
        derived_keys = {metric.casefold() for metric in derived_metrics}
        return tuple(metric for metric in stored_metrics if metric.casefold() not in derived_keys)

    def load_snapshot(self, tenant_id: TenantId) -> ProfileSnapshot:
        profile = self.load(tenant_id)
        if profile is None:
            raise FileNotFoundError("Profile not found in candidate_profiles. Run `jobctrl init` first.")
        row = self._profile_row(tenant_id)
        version = int(row["version"]) if row is not None else 1
        return ProfileSnapshot.from_profile(profile, version=version)

    # ------------------------------------------------------------------
    # Rendering settings
    # ------------------------------------------------------------------

    def load_rendering_settings(self, tenant_id: TenantId) -> dict[str, Any]:
        row = self._profile_row(tenant_id)
        if row is None:
            return {
                "style": normalize_resume_style(),
                "template_text": DEFAULT_RESUME_TEMPLATE_TEXT,
            }
        return {
            "style": _style_from_row(row),
            "template_text": row["resume_template_text"] or DEFAULT_RESUME_TEMPLATE_TEXT,
        }

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
                "SqliteProfileRepository was constructed without a PdfParserPort; "
                "cannot import from PDF. Inject one via the factory."
            )

        existing = self.load(tenant_id)
        rendering = self.load_rendering_settings(tenant_id)
        draft = self._pdf_parser.parse(
            pdf_bytes,
            filename=filename,
            base_profile=existing.to_dict() if existing is not None else None,
            base_style=rendering["style"],
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
    # Internal helpers
    # ------------------------------------------------------------------

    def _profile_row(self, tenant_id: TenantId) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM candidate_profiles WHERE tenant_id = ? AND profile_id = ?",
            (str(tenant_id), self._profile_id),
        ).fetchone()

    def _replace_profile(
        self,
        tenant_id: TenantId,
        profile: Profile,
        *,
        version: int,
        rendering: dict[str, Any],
    ) -> None:
        profile_id = profile.profile_id or self._profile_id
        profile_dict = profile.to_dict()
        style = normalize_resume_style(rendering.get("style") if isinstance(rendering, dict) else None)
        template_text = str(rendering.get("template_text") or DEFAULT_RESUME_TEMPLATE_TEXT)
        now = datetime.now(timezone.utc).isoformat()

        with self._conn:
            for table in _CHILD_TABLES:
                self._conn.execute(
                    f"DELETE FROM {table} WHERE tenant_id = ? AND profile_id = ?",
                    (str(tenant_id), profile_id),
                )

            root_values = _root_values(str(tenant_id), profile_id, profile_dict, style, template_text, version, now)
            self._conn.execute(
                f"""
                INSERT INTO candidate_profiles (
                    tenant_id, profile_id,
                    personal_full_name, personal_preferred_name, personal_email,
                    personal_phone, personal_address, personal_city,
                    personal_province_state, personal_country, personal_postal_code,
                    personal_linkedin_url, personal_github_url, personal_portfolio_url,
                    personal_website_url, personal_password,
                    work_legally_authorized_to_work, work_require_sponsorship,
                    work_work_permit_type,
                    compensation_salary_expectation, compensation_salary_currency,
                    compensation_salary_range_min, compensation_salary_range_max,
                    compensation_currency_note,
                    experience_years_total, experience_education_level,
                    experience_current_job_title, experience_current_company,
                    experience_target_role, experience_target_track,
                    experience_target_seniority_floor, experience_target_functions,
                    experience_target_specializations, experience_target_locations,
                    experience_target_work_models,
                    availability_earliest_start_date, availability_full_time,
                    availability_contract,
                    eeo_gender, eeo_race_ethnicity, eeo_veteran_status,
                    eeo_disability_status,
                    resume_baseline_text,
                    tailoring_mode, tailoring_allow_title_reframing,
                    tailoring_allow_achievement_rewriting,
                    tailoring_allow_skill_reordering, tailoring_allow_summary_rewrite,
                    tailoring_allow_minor_inference,
                    tailoring_claim_mode, tailoring_auto_approvable_claim_modes_json,
                    tailoring_allow_adjacent_achievement_drafts,
                    writing_tone, writing_bullet_style, writing_verbosity,
                    writing_keyword_density, writing_avoid_first_person,
                    max_experience_bullets, custom_tailoring_prompt,
                    revision_min_fit_score, revision_must_have_coverage,
                    revision_max_attempts,
                    resume_style_document_font_size, resume_style_paper_size,
                    resume_style_font_family, resume_style_moderncv_style,
                    resume_style_moderncv_color, resume_style_page_scale,
                    resume_style_hints_column_width_cm, resume_style_body_alignment,
                    resume_template_text, version, updated_at
                ) VALUES ({", ".join("?" for _ in root_values)})
                ON CONFLICT(tenant_id, profile_id) DO UPDATE SET
                    personal_full_name = excluded.personal_full_name,
                    personal_preferred_name = excluded.personal_preferred_name,
                    personal_email = excluded.personal_email,
                    personal_phone = excluded.personal_phone,
                    personal_address = excluded.personal_address,
                    personal_city = excluded.personal_city,
                    personal_province_state = excluded.personal_province_state,
                    personal_country = excluded.personal_country,
                    personal_postal_code = excluded.personal_postal_code,
                    personal_linkedin_url = excluded.personal_linkedin_url,
                    personal_github_url = excluded.personal_github_url,
                    personal_portfolio_url = excluded.personal_portfolio_url,
                    personal_website_url = excluded.personal_website_url,
                    personal_password = excluded.personal_password,
                    work_legally_authorized_to_work = excluded.work_legally_authorized_to_work,
                    work_require_sponsorship = excluded.work_require_sponsorship,
                    work_work_permit_type = excluded.work_work_permit_type,
                    compensation_salary_expectation = excluded.compensation_salary_expectation,
                    compensation_salary_currency = excluded.compensation_salary_currency,
                    compensation_salary_range_min = excluded.compensation_salary_range_min,
                    compensation_salary_range_max = excluded.compensation_salary_range_max,
                    compensation_currency_note = excluded.compensation_currency_note,
                    experience_years_total = excluded.experience_years_total,
                    experience_education_level = excluded.experience_education_level,
                    experience_current_job_title = excluded.experience_current_job_title,
                    experience_current_company = excluded.experience_current_company,
                    experience_target_role = excluded.experience_target_role,
                    experience_target_track = excluded.experience_target_track,
                    experience_target_seniority_floor = excluded.experience_target_seniority_floor,
                    experience_target_functions = excluded.experience_target_functions,
                    experience_target_specializations = excluded.experience_target_specializations,
                    experience_target_locations = excluded.experience_target_locations,
                    experience_target_work_models = excluded.experience_target_work_models,
                    availability_earliest_start_date = excluded.availability_earliest_start_date,
                    availability_full_time = excluded.availability_full_time,
                    availability_contract = excluded.availability_contract,
                    eeo_gender = excluded.eeo_gender,
                    eeo_race_ethnicity = excluded.eeo_race_ethnicity,
                    eeo_veteran_status = excluded.eeo_veteran_status,
                    eeo_disability_status = excluded.eeo_disability_status,
                    resume_baseline_text = excluded.resume_baseline_text,
                    tailoring_mode = excluded.tailoring_mode,
                    tailoring_allow_title_reframing = excluded.tailoring_allow_title_reframing,
                    tailoring_allow_achievement_rewriting = excluded.tailoring_allow_achievement_rewriting,
                    tailoring_allow_skill_reordering = excluded.tailoring_allow_skill_reordering,
                    tailoring_allow_summary_rewrite = excluded.tailoring_allow_summary_rewrite,
                    tailoring_allow_minor_inference = excluded.tailoring_allow_minor_inference,
                    tailoring_claim_mode = excluded.tailoring_claim_mode,
                    tailoring_auto_approvable_claim_modes_json = excluded.tailoring_auto_approvable_claim_modes_json,
                    tailoring_allow_adjacent_achievement_drafts = excluded.tailoring_allow_adjacent_achievement_drafts,
                    writing_tone = excluded.writing_tone,
                    writing_bullet_style = excluded.writing_bullet_style,
                    writing_verbosity = excluded.writing_verbosity,
                    writing_keyword_density = excluded.writing_keyword_density,
                    writing_avoid_first_person = excluded.writing_avoid_first_person,
                    max_experience_bullets = excluded.max_experience_bullets,
                    custom_tailoring_prompt = excluded.custom_tailoring_prompt,
                    revision_min_fit_score = excluded.revision_min_fit_score,
                    revision_must_have_coverage = excluded.revision_must_have_coverage,
                    revision_max_attempts = excluded.revision_max_attempts,
                    resume_style_document_font_size = excluded.resume_style_document_font_size,
                    resume_style_paper_size = excluded.resume_style_paper_size,
                    resume_style_font_family = excluded.resume_style_font_family,
                    resume_style_moderncv_style = excluded.resume_style_moderncv_style,
                    resume_style_moderncv_color = excluded.resume_style_moderncv_color,
                    resume_style_page_scale = excluded.resume_style_page_scale,
                    resume_style_hints_column_width_cm = excluded.resume_style_hints_column_width_cm,
                    resume_style_body_alignment = excluded.resume_style_body_alignment,
                    resume_template_text = excluded.resume_template_text,
                    version = excluded.version,
                    updated_at = excluded.updated_at
                """,
                root_values,
            )

            self._insert_children(str(tenant_id), profile_id, profile)

    def _insert_children(self, tenant_id: str, profile_id: str, profile: Profile) -> None:
        achievement_evidence_by_entry = _achievement_evidence_by_entry(profile)
        for index, entry in enumerate(profile.experience_entries):
            self._conn.execute(
                """
                INSERT INTO candidate_profile_experience_entries (
                    tenant_id, profile_id, entry_id, position_index,
                    date_range, title, company, location, summary
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tenant_id,
                    profile_id,
                    entry.id,
                    index,
                    entry.date_range,
                    entry.title,
                    entry.company,
                    entry.location,
                    entry.summary,
                ),
            )
            for bullet_index, bullet in enumerate(entry.bullets):
                self._conn.execute(
                    """
                    INSERT INTO candidate_profile_experience_bullets (
                        tenant_id, profile_id, entry_id, bullet_index, bullet_text
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (tenant_id, profile_id, entry.id, bullet_index, bullet),
                )
            for evidence_index, evidence in enumerate(achievement_evidence_by_entry.get(entry.id, ())):
                self._conn.execute(
                    """
                    INSERT INTO candidate_profile_achievement_evidence (
                        tenant_id, profile_id, entry_id, evidence_index,
                        evidence_id, source_text, scope, action, tools_json,
                        metrics_json, outcome, seniority_signal, evidence_strength,
                        claim_confidence, user_confirmed, tags_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        tenant_id,
                        profile_id,
                        entry.id,
                        evidence_index,
                        str(evidence.get("id", "")),
                        str(evidence.get("source_text", "")),
                        str(evidence.get("scope", "")),
                        str(evidence.get("action", "")),
                        _json_array(_json_str_list(evidence.get("tools"))),
                        _json_array(_json_str_list(evidence.get("metrics"))),
                        str(evidence.get("outcome", "")),
                        str(evidence.get("seniority_signal", "")),
                        str(evidence.get("evidence_strength", "supported")),
                        _bounded_float(evidence.get("claim_confidence"), 0.0, 0.0, 1.0),
                        1 if bool(evidence.get("user_confirmed", False)) else 0,
                        _json_array(_json_str_list(evidence.get("tags"))),
                    ),
                )

        for index, entry in enumerate(profile.education_entries):
            self._conn.execute(
                """
                INSERT INTO candidate_profile_education_entries (
                    tenant_id, profile_id, entry_id, position_index,
                    date, degree, institution, location
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (tenant_id, profile_id, entry.id, index, entry.date, entry.degree, entry.institution, entry.location),
            )

        for index, category in enumerate(profile.skill_categories):
            self._conn.execute(
                """
                INSERT INTO candidate_profile_skill_categories (
                    tenant_id, profile_id, category_id, position_index, label
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (tenant_id, profile_id, category.id, index, category.label),
            )
            for item_index, item in enumerate(category.items):
                self._conn.execute(
                    """
                    INSERT INTO candidate_profile_skill_items (
                        tenant_id, profile_id, category_id, item_index, item_text
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (tenant_id, profile_id, category.id, item_index, item),
                )

        self._insert_required_ids(
            "candidate_profile_required_experience_entries",
            "entry_id",
            tenant_id,
            profile_id,
            profile.tailoring_rules.required_experience_entry_ids,
        )
        self._insert_required_ids(
            "candidate_profile_required_education_entries",
            "entry_id",
            tenant_id,
            profile_id,
            profile.tailoring_rules.required_education_entry_ids,
        )
        self._insert_required_ids(
            "candidate_profile_required_skill_categories",
            "category_id",
            tenant_id,
            profile_id,
            profile.tailoring_rules.required_skill_category_ids,
        )

        for entry_id, bullets in profile.tailoring_rules.required_bullets_by_experience_id.items():
            for index, bullet in enumerate(bullets):
                self._conn.execute(
                    """
                    INSERT INTO candidate_profile_required_bullets (
                        tenant_id, profile_id, entry_id, bullet_index, bullet_text
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (tenant_id, profile_id, entry_id, index, bullet),
                )
        for category_id, skills in profile.tailoring_rules.required_skills_by_category_id.items():
            for index, skill in enumerate(skills):
                self._conn.execute(
                    """
                    INSERT INTO candidate_profile_required_skills (
                        tenant_id, profile_id, category_id, skill_index, skill_text
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (tenant_id, profile_id, category_id, index, skill),
                )
        for index, metric in enumerate(profile.resume_constraints.real_metrics):
            self._conn.execute(
                """
                INSERT INTO candidate_profile_resume_constraint_metrics (
                    tenant_id, profile_id, metric_index, metric_text
                ) VALUES (?, ?, ?, ?)
                """,
                (tenant_id, profile_id, index, metric),
            )

    def _insert_required_ids(
        self,
        table: str,
        column: str,
        tenant_id: str,
        profile_id: str,
        values: tuple[str, ...],
    ) -> None:
        for index, value in enumerate(values):
            self._conn.execute(
                f"""
                INSERT INTO {table} (tenant_id, profile_id, position_index, {column})
                VALUES (?, ?, ?, ?)
                """,
                (tenant_id, profile_id, index, value),
            )

    def _row_to_profile_dict(self, tenant_id: TenantId, row: sqlite3.Row) -> dict[str, Any]:
        tenant = str(tenant_id)
        profile_id = str(row["profile_id"])
        return {
            "personal": {
                "full_name": row["personal_full_name"],
                "preferred_name": row["personal_preferred_name"],
                "email": row["personal_email"],
                "phone": row["personal_phone"],
                "address": row["personal_address"],
                "city": row["personal_city"],
                "province_state": row["personal_province_state"],
                "country": row["personal_country"],
                "postal_code": row["personal_postal_code"],
                "linkedin_url": row["personal_linkedin_url"],
                "github_url": row["personal_github_url"],
                "portfolio_url": row["personal_portfolio_url"],
                "website_url": row["personal_website_url"],
                "password": row["personal_password"],
            },
            "work_authorization": {
                "legally_authorized_to_work": row["work_legally_authorized_to_work"],
                "require_sponsorship": row["work_require_sponsorship"],
                "work_permit_type": row["work_work_permit_type"],
            },
            "availability": {
                "earliest_start_date": row["availability_earliest_start_date"],
                "available_for_full_time": row["availability_full_time"],
                "available_for_contract": row["availability_contract"],
            },
            "compensation": {
                "salary_expectation": row["compensation_salary_expectation"],
                "salary_currency": row["compensation_salary_currency"],
                "salary_range_min": row["compensation_salary_range_min"],
                "salary_range_max": row["compensation_salary_range_max"],
                "currency_conversion_note": row["compensation_currency_note"],
            },
            "experience": {
                "years_of_experience_total": row["experience_years_total"],
                "education_level": row["experience_education_level"],
                "current_job_title": row["experience_current_job_title"],
                "current_company": row["experience_current_company"],
                "target_role": row["experience_target_role"],
                "target_track": row["experience_target_track"],
                "target_seniority_floor": row["experience_target_seniority_floor"],
                "target_functions": row["experience_target_functions"],
                "target_specializations": row["experience_target_specializations"],
                "target_locations": row["experience_target_locations"],
                "target_work_models": row["experience_target_work_models"],
            },
            "eeo_voluntary": {
                "gender": row["eeo_gender"],
                "race_ethnicity": row["eeo_race_ethnicity"],
                "veteran_status": row["eeo_veteran_status"],
                "disability_status": row["eeo_disability_status"],
            },
            "resume": {
                "executive_profile": {"baseline_text": row["resume_baseline_text"]},
                "experience_entries": self._experience_entries(tenant, profile_id),
                "education_entries": self._education_entries(tenant, profile_id),
                "skill_categories": self._skill_categories(tenant, profile_id),
                "tailoring_rules": self._tailoring_rules(tenant, profile_id, row),
            },
            "resume_constraints": {
                "real_metrics": self._ordered_values(
                    "candidate_profile_resume_constraint_metrics",
                    "metric_text",
                    "metric_index",
                    tenant,
                    profile_id,
                )
            },
        }

    def _experience_entries(self, tenant_id: str, profile_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT entry_id, date_range, title, company, location, summary
            FROM candidate_profile_experience_entries
            WHERE tenant_id = ? AND profile_id = ?
            ORDER BY position_index, entry_id
            """,
            (tenant_id, profile_id),
        ).fetchall()
        entries: list[dict[str, Any]] = []
        for row in rows:
            entries.append(
                {
                    "id": row["entry_id"],
                    "date_range": row["date_range"],
                    "title": row["title"],
                    "company": row["company"],
                    "location": row["location"],
                    "summary": row["summary"],
                    "bullets": self._ordered_values(
                        "candidate_profile_experience_bullets",
                        "bullet_text",
                        "bullet_index",
                        tenant_id,
                        profile_id,
                        where="entry_id = ?",
                        params=(row["entry_id"],),
                    ),
                    "achievement_evidence": self._achievement_evidence(
                        tenant_id,
                        profile_id,
                        row["entry_id"],
                    ),
                }
            )
        return entries

    def _education_entries(self, tenant_id: str, profile_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT entry_id, date, degree, institution, location
            FROM candidate_profile_education_entries
            WHERE tenant_id = ? AND profile_id = ?
            ORDER BY position_index, entry_id
            """,
            (tenant_id, profile_id),
        ).fetchall()
        return [
            {
                "id": row["entry_id"],
                "date": row["date"],
                "degree": row["degree"],
                "institution": row["institution"],
                "location": row["location"],
            }
            for row in rows
        ]

    def _skill_categories(self, tenant_id: str, profile_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT category_id, label
            FROM candidate_profile_skill_categories
            WHERE tenant_id = ? AND profile_id = ?
            ORDER BY position_index, category_id
            """,
            (tenant_id, profile_id),
        ).fetchall()
        return [
            {
                "id": row["category_id"],
                "label": row["label"],
                "items": self._ordered_values(
                    "candidate_profile_skill_items",
                    "item_text",
                    "item_index",
                    tenant_id,
                    profile_id,
                    where="category_id = ?",
                    params=(row["category_id"],),
                ),
            }
            for row in rows
        ]

    def _tailoring_rules(self, tenant_id: str, profile_id: str, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "required_experience_entry_ids": self._ordered_values(
                "candidate_profile_required_experience_entries",
                "entry_id",
                "position_index",
                tenant_id,
                profile_id,
            ),
            "required_education_entry_ids": self._ordered_values(
                "candidate_profile_required_education_entries",
                "entry_id",
                "position_index",
                tenant_id,
                profile_id,
            ),
            "required_skill_category_ids": self._ordered_values(
                "candidate_profile_required_skill_categories",
                "category_id",
                "position_index",
                tenant_id,
                profile_id,
            ),
            "required_bullets_by_experience_id": self._grouped_required(
                "candidate_profile_required_bullets",
                "entry_id",
                "bullet_text",
                "bullet_index",
                tenant_id,
                profile_id,
            ),
            "required_skills_by_category_id": self._grouped_required(
                "candidate_profile_required_skills",
                "category_id",
                "skill_text",
                "skill_index",
                tenant_id,
                profile_id,
            ),
            "max_experience_bullets": int(row["max_experience_bullets"]),
            "custom_tailoring_prompt": row["custom_tailoring_prompt"],
            "tailoring_policy": {
                "mode": row["tailoring_mode"],
                "allow_title_reframing": _as_bool(row["tailoring_allow_title_reframing"]),
                "allow_achievement_rewriting": _as_bool(row["tailoring_allow_achievement_rewriting"]),
                "allow_skill_reordering": _as_bool(row["tailoring_allow_skill_reordering"]),
                "allow_summary_rewrite": _as_bool(row["tailoring_allow_summary_rewrite"]),
                "allow_minor_inference": _as_bool(row["tailoring_allow_minor_inference"]),
                "claim_mode": row["tailoring_claim_mode"],
                "auto_approvable_claim_modes": _json_str_list(
                    row["tailoring_auto_approvable_claim_modes_json"]
                ),
                "allow_adjacent_achievement_drafts": _as_bool(
                    row["tailoring_allow_adjacent_achievement_drafts"]
                ),
            },
            "writing_style": {
                "tone": row["writing_tone"],
                "bullet_style": row["writing_bullet_style"],
                "verbosity": row["writing_verbosity"],
                "keyword_density": row["writing_keyword_density"],
                "avoid_first_person": _as_bool(row["writing_avoid_first_person"]),
            },
            "revision_gates": {
                "min_fit_score": int(row["revision_min_fit_score"]),
                "must_have_coverage": float(row["revision_must_have_coverage"]),
                "max_revision_attempts": int(row["revision_max_attempts"]),
            },
        }

    def _achievement_evidence(
        self,
        tenant_id: str,
        profile_id: str,
        entry_id: str,
    ) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT evidence_id, source_text, scope, action, tools_json, metrics_json,
                   outcome, seniority_signal, evidence_strength, claim_confidence,
                   user_confirmed, tags_json
            FROM candidate_profile_achievement_evidence
            WHERE tenant_id = ? AND profile_id = ? AND entry_id = ?
            ORDER BY evidence_index
            """,
            (tenant_id, profile_id, entry_id),
        ).fetchall()
        return [
            {
                "id": row["evidence_id"],
                "source_text": row["source_text"],
                "scope": row["scope"],
                "action": row["action"],
                "tools": _json_str_list(row["tools_json"]),
                "metrics": _json_str_list(row["metrics_json"]),
                "outcome": row["outcome"],
                "seniority_signal": row["seniority_signal"],
                "evidence_strength": row["evidence_strength"],
                "claim_confidence": float(row["claim_confidence"] or 0.0),
                "user_confirmed": _as_bool(row["user_confirmed"]),
                "tags": _json_str_list(row["tags_json"]),
            }
            for row in rows
        ]

    def _ordered_values(
        self,
        table: str,
        value_column: str,
        order_column: str,
        tenant_id: str,
        profile_id: str,
        *,
        where: str = "",
        params: tuple[Any, ...] = (),
    ) -> list[str]:
        extra = f" AND {where}" if where else ""
        rows = self._conn.execute(
            f"""
            SELECT {value_column}
            FROM {table}
            WHERE tenant_id = ? AND profile_id = ?{extra}
            ORDER BY {order_column}
            """,
            (tenant_id, profile_id, *params),
        ).fetchall()
        return [str(row[value_column]) for row in rows]

    def _grouped_required(
        self,
        table: str,
        key_column: str,
        value_column: str,
        order_column: str,
        tenant_id: str,
        profile_id: str,
    ) -> dict[str, list[str]]:
        rows = self._conn.execute(
            f"""
            SELECT {key_column}, {value_column}
            FROM {table}
            WHERE tenant_id = ? AND profile_id = ?
            ORDER BY {key_column}, {order_column}
            """,
            (tenant_id, profile_id),
        ).fetchall()
        grouped: dict[str, list[str]] = {}
        for row in rows:
            grouped.setdefault(str(row[key_column]), []).append(str(row[value_column]))
        return grouped

def _root_values(
    tenant_id: str,
    profile_id: str,
    profile: dict[str, Any],
    style: dict[str, Any],
    template_text: str,
    version: int,
    updated_at: str,
) -> tuple[Any, ...]:
    personal = _record(profile.get("personal"))
    work = _record(profile.get("work_authorization"))
    compensation = _record(profile.get("compensation"))
    experience = _record(profile.get("experience"))
    availability = _record(profile.get("availability"))
    eeo = _record(profile.get("eeo_voluntary"))
    resume = _record(profile.get("resume"))
    executive = _record(resume.get("executive_profile"))
    rules = _record(resume.get("tailoring_rules"))
    policy = _record(rules.get("tailoring_policy"))
    writing = _record(rules.get("writing_style"))

    return (
        tenant_id,
        profile_id,
        _text(personal.get("full_name")),
        _text(personal.get("preferred_name")),
        _text(personal.get("email")),
        _text(personal.get("phone")),
        _text(personal.get("address")),
        _text(personal.get("city")),
        _text(personal.get("province_state")),
        _text(personal.get("country")),
        _text(personal.get("postal_code")),
        _text(personal.get("linkedin_url")),
        _text(personal.get("github_url")),
        _text(personal.get("portfolio_url")),
        _text(personal.get("website_url")),
        _text(personal.get("password")),
        _text(work.get("legally_authorized_to_work")),
        _text(work.get("require_sponsorship")),
        _text(work.get("work_permit_type")),
        _text(compensation.get("salary_expectation")),
        _text(compensation.get("salary_currency"), "USD"),
        _text(compensation.get("salary_range_min")),
        _text(compensation.get("salary_range_max")),
        _text(compensation.get("currency_conversion_note")),
        _text(experience.get("years_of_experience_total")),
        _text(experience.get("education_level")),
        _text(experience.get("current_job_title")),
        _text(experience.get("current_company")),
        _text(experience.get("target_role")),
        _text(experience.get("target_track")),
        _text(experience.get("target_seniority_floor")),
        _text(experience.get("target_functions")),
        _text(experience.get("target_specializations")),
        _text(experience.get("target_locations")),
        _text(experience.get("target_work_models")),
        _text(availability.get("earliest_start_date")),
        _text(availability.get("available_for_full_time")),
        _text(availability.get("available_for_contract")),
        _text(eeo.get("gender"), "Decline to self-identify"),
        _text(eeo.get("race_ethnicity"), "Decline to self-identify"),
        _text(eeo.get("veteran_status"), "Decline to self-identify"),
        _text(eeo.get("disability_status"), "Decline to self-identify"),
        _text(executive.get("baseline_text")),
        _text(policy.get("mode"), "balanced"),
        _bool_int(policy.get("allow_title_reframing"), False),
        _bool_int(policy.get("allow_achievement_rewriting"), True),
        _bool_int(policy.get("allow_skill_reordering"), True),
        _bool_int(policy.get("allow_summary_rewrite"), True),
        _bool_int(policy.get("allow_minor_inference"), False),
        _text(policy.get("claim_mode"), "evidence_reframing"),
        _json_array(_claim_modes(policy.get("auto_approvable_claim_modes"))),
        _bool_int(policy.get("allow_adjacent_achievement_drafts"), False),
        _text(writing.get("tone"), "direct"),
        _text(writing.get("bullet_style"), "balanced"),
        _text(writing.get("verbosity"), "balanced"),
        _text(writing.get("keyword_density"), "natural"),
        _bool_int(writing.get("avoid_first_person"), True),
        int(rules.get("max_experience_bullets") or 4),
        _text(rules.get("custom_tailoring_prompt")),
        _bounded_int(_record(rules.get("revision_gates")).get("min_fit_score"), 8, 1, 10),
        _bounded_float(
            _record(rules.get("revision_gates")).get("must_have_coverage"),
            0.85,
            0.0,
            1.0,
        ),
        _bounded_int(_record(rules.get("revision_gates")).get("max_revision_attempts"), 1, 0, 10),
        style["document_font_size"],
        style["paper_size"],
        style["font_family"],
        style["moderncv_style"],
        style["moderncv_color"],
        style["page_scale"],
        style["hints_column_width_cm"],
        style["body_alignment"],
        template_text,
        version,
        updated_at,
    )


def _reject_unsupported_top_level_fields(profile: Profile) -> None:
    unsupported = sorted(str(key) for key in profile.extra if key not in _IGNORED_LEGACY_TOP_LEVEL_FIELDS)
    if unsupported:
        raise InvalidProfileError(
            [
                "profile contains unsupported top-level profile field(s): "
                f"{', '.join(unsupported)}. SQLite profile storage only supports "
                "normalized Candidate Profile sections."
            ]
        )


def _style_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return normalize_resume_style(
        {
            "document_font_size": row["resume_style_document_font_size"],
            "paper_size": row["resume_style_paper_size"],
            "font_family": row["resume_style_font_family"],
            "moderncv_style": row["resume_style_moderncv_style"],
            "moderncv_color": row["resume_style_moderncv_color"],
            "page_scale": row["resume_style_page_scale"],
            "hints_column_width_cm": row["resume_style_hints_column_width_cm"],
            "body_alignment": row["resume_style_body_alignment"],
        }
    )


def _achievement_evidence_by_entry(profile: Profile) -> dict[str, list[dict[str, Any]]]:
    by_entry: dict[str, list[dict[str, Any]]] = {}
    for item in get_achievement_evidence(profile.to_dict()):
        entry_id = str(item.get("experience_entry_id", "")).strip()
        if not entry_id:
            continue
        by_entry.setdefault(entry_id, []).append(item)
    return by_entry


def _profile_dict_with_reconciled_achievement_evidence(profile: Profile) -> dict[str, Any]:
    """Materialize bullet-derived evidence before deriving compatibility metrics."""

    profile_dict = profile.to_dict()
    by_entry = _achievement_evidence_by_entry(profile)
    resume = _record(profile_dict.get("resume"))
    entries = resume.get("experience_entries")
    if not isinstance(entries, list):
        return profile_dict
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        entry_id = str(entry.get("id") or "")
        entry["achievement_evidence"] = [
            {
                key: value
                for key, value in evidence.items()
                if key != "experience_entry_id"
            }
            for evidence in by_entry.get(entry_id, ())
        ]
    return profile_dict


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def _bool_int(value: Any, default: bool) -> int:
    if value is None:
        return 1 if default else 0
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, str):
        return 1 if value.strip().lower() in {"true", "yes", "y", "1", "on"} else 0
    return 1 if bool(value) else 0


def _bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def _bounded_float(value: Any, default: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def _as_bool(value: Any) -> bool:
    return bool(int(value or 0))


def _json_array(values: tuple[str, ...] | list[str]) -> str:
    return json.dumps([str(value) for value in values if str(value)])


def _json_str_list(value: Any) -> list[str]:
    if isinstance(value, list):
        raw = value
    else:
        try:
            raw = json.loads(str(value or "[]"))
        except json.JSONDecodeError:
            raw = []
    if not isinstance(raw, list):
        return []
    return [str(item).strip() for item in raw if str(item).strip()]


def _claim_modes(value: Any) -> list[str]:
    modes = _json_str_list(value)
    return modes or ["verified_only", "evidence_reframing"]


def _diff_top_level_sections(previous: dict[str, Any], current: dict[str, Any]) -> tuple[str, ...]:
    keys = set(previous) | set(current)
    return tuple(sorted(key for key in keys if previous.get(key) != current.get(key)))
