"""Structural defaults for the retained Profile editor, without inferred facts."""

from copy import deepcopy
from collections import Counter
from datetime import datetime
import math

from jobctrl.app.errors import AppError

DEFAULT_STYLE = {
    "document_font_size": "11pt", "paper_size": "a4paper", "font_family": "sans",
    "moderncv_style": "banking", "moderncv_color": "black", "page_scale": 0.85,
    "hints_column_width_cm": 3.0, "body_alignment": "justified",
}
DEFAULT_TEMPLATE = "{{ personal_data }}\n\n{{ resume_body }}\n"


_TEXT = {
    "personal": "full_name preferred_name email phone address city province_state country postal_code linkedin_url github_url portfolio_url website_url password",
    "work_authorization": "legally_authorized_to_work require_sponsorship work_permit_type",
    "availability": "earliest_start_date available_for_full_time available_for_contract",
    "compensation": "salary_expectation salary_currency salary_range_min salary_range_max currency_conversion_note",
    "experience": "years_of_experience_total education_level current_job_title current_company target_role target_track target_seniority_floor target_functions target_specializations target_locations target_work_models",
    "eeo_voluntary": "gender race_ethnicity veteran_status disability_status",
}
POLICY_DEFAULTS = {"mode": "balanced", "allow_title_reframing": False, "allow_achievement_rewriting": True,
                   "allow_skill_reordering": True, "allow_summary_rewrite": True, "allow_minor_inference": False,
                   "claim_mode": "evidence_reframing", "auto_approvable_claim_modes": ["verified_only", "evidence_reframing"],
                   "allow_adjacent_achievement_drafts": False}


def target_location_bindings(experience):
    """Validate selected provider places; a changed literal text loses its binding.

    This is a user-selected map identity, never a work-authorization or employer
    eligibility judgment. Old text-only locations remain valid and unverified.
    """
    bindings = experience.get("target_location_bindings")
    if bindings is None:
        return []
    if not isinstance(bindings, list) or len(bindings) > 100:
        raise AppError("invalid_profile", "Target location bindings must be a list of up to 100 places.")
    raw_locations = experience.get("target_locations", "")
    if not isinstance(raw_locations, str):
        raise AppError("invalid_profile", "Target locations must contain text.")
    locations = [text.strip() for text in raw_locations.replace(";", "\n").split("\n")]
    location_counts = Counter(locations)
    binding_counts = Counter(binding.get("text") for binding in bindings if isinstance(binding, dict) and isinstance(binding.get("text"), str))
    ambiguous_texts = {text for text, count in binding_counts.items() if count > location_counts[text]}
    accepted = []
    seen = set()
    expected = {"rowIndex", "text", "provider", "placeId", "displayName", "latitude", "longitude", "selectedAt", "provenance"}
    for binding in bindings:
        if not isinstance(binding, dict) or set(binding) != expected:
            raise AppError("invalid_profile", "A target location binding has an invalid structure.")
        row_index = binding["rowIndex"]
        if type(row_index) is not int or not 0 <= row_index < 100:
            raise AppError("invalid_profile", "A target location binding requires its row identity.")
        for field, maximum in (("text", 300), ("placeId", 200), ("displayName", 1000), ("selectedAt", 80)):
            if not isinstance(binding[field], str) or not binding[field].strip() or len(binding[field]) > maximum:
                raise AppError("invalid_profile", "A target location binding has an invalid value.")
        if binding["provider"] != "photon" or binding["provenance"] != "user_selected":
            raise AppError("invalid_profile", "A target location must retain its selected provider provenance.")
        for field, minimum, maximum in (("latitude", -90, 90), ("longitude", -180, 180)):
            number = binding[field]
            if type(number) not in (int, float) or not math.isfinite(number) or not minimum <= number <= maximum:
                raise AppError("invalid_profile", "A target location must have finite map coordinates.")
        try:
            selected_at = datetime.fromisoformat(binding["selectedAt"].replace("Z", "+00:00"))
            if selected_at.tzinfo is None:
                raise ValueError("missing timezone")
        except ValueError:
            raise AppError("invalid_profile", "A target location requires its selection time.") from None
        # Old clients can change target_locations without understanding bindings.
        # Drop those stale identities rather than attaching them to changed text.
        if row_index in seen:
            raise AppError("invalid_profile", "A target location row cannot have multiple place bindings.")
        seen.add(row_index)
        if binding["text"] in ambiguous_texts or row_index >= len(locations) or binding["text"] != locations[row_index]:
            continue
        accepted.append(deepcopy(binding))
    return accepted


def canonical_profile(value):
    """Add only empty/unknown form fields. Preserve authored values and extras."""
    result = deepcopy(value)
    for section, keys in _TEXT.items():
        result.setdefault(section, {})
        for key in keys.split():
            result[section].setdefault(key, "Decline to self-identify" if section == "eeo_voluntary" else "USD" if section == "compensation" and key == "salary_currency" else "")
    if "target_location_bindings" in result["experience"]:
        result["experience"]["target_location_bindings"] = target_location_bindings(result["experience"])
    result.setdefault("application_attestations", {})
    for key in ("age_18_plus", "background_check_consent", "felony_conviction", "previously_worked_at_employer"):
        result["application_attestations"].setdefault(key, None)
    result["application_attestations"].setdefault("additional", {})
    result.setdefault("application_preferences", {}).setdefault("how_heard", "")
    result.setdefault("resume_constraints", {}).setdefault("real_metrics", [])
    resume = result["resume"]
    resume.setdefault("executive_profile", {}).setdefault("baseline_text", "")
    for role in resume.get("experience_entries", []):
        for key in ("date_range", "location", "summary"):
            role.setdefault(key, "")
        role.setdefault("bullets", [])
        role.setdefault("achievement_evidence", [])
        for evidence in role["achievement_evidence"]:
            for key in ("source_text", "scope", "action", "outcome"):
                evidence.setdefault(key, "")
            for key in ("tools", "metrics", "tags"):
                evidence.setdefault(key, [])
            evidence.setdefault("evidence_strength", "draft")
            evidence.setdefault("claim_confidence", 0)
            evidence.setdefault("user_confirmed", False)
    for entry in resume.get("education_entries", []):
        for key in ("degree", "institution", "location", "date"):
            entry.setdefault(key, "")
    resume.setdefault("tailoring_rules", {})
    if "tailoring_rules" in resume:
        rules = resume["tailoring_rules"]
        for key in ("required_experience_entry_ids", "required_education_entry_ids", "required_skill_category_ids"):
            rules.setdefault(key, [])
        for key in ("required_bullets_by_experience_id", "required_skills_by_category_id"):
            rules.setdefault(key, {})
        rules.setdefault("max_experience_bullets", 4)
        rules.setdefault("custom_tailoring_prompt", "")
        rules.setdefault("tailoring_policy", {})
        for key, default in POLICY_DEFAULTS.items():
            rules["tailoring_policy"].setdefault(key, deepcopy(default))
        for key, defaults in (("writing_style", {"tone": "direct", "bullet_style": "balanced", "verbosity": "balanced", "keyword_density": "natural", "avoid_first_person": True}),
                              ("revision_gates", {"min_fit_score": 8, "must_have_coverage": .85, "max_revision_attempts": 1})):
            rules.setdefault(key, {})
            for field, default in defaults.items():
                rules[key].setdefault(field, default)
    return result


def empty_profile():
    return canonical_profile({"resume": {"experience_entries": [], "education_entries": [], "skill_categories": []}})
