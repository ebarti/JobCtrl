"""Explicit compensation source permissions; reading a policy never fetches."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, model_validator
from typing import Literal


LEVELS_MODES = ("public_markdown", "licensed_api", "licensed_data_feed", "enterprise_mcp")
GLASSDOOR_MODES = ("partner_api", "written_permission")


class PolicyInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sourceId: Literal["levels_fyi", "glassdoor"]
    expectedRevision: StrictInt = Field(ge=0)
    enabled: StrictBool
    accessMode: Literal["public_markdown", "licensed_api", "licensed_data_feed", "enterprise_mcp", "partner_api", "written_permission"] | None
    europeCoverageConfirmed: StrictBool | None = None

    @model_validator(mode="after")
    def permitted(self):
        allowed = LEVELS_MODES if self.sourceId == "levels_fyi" else GLASSDOOR_MODES
        if self.accessMode is not None and self.accessMode not in allowed:
            raise ValueError("invalid access mode")
        if self.sourceId == "levels_fyi" and self.europeCoverageConfirmed is None:
            raise ValueError("Europe coverage confirmation is required")
        if self.sourceId == "glassdoor" and self.europeCoverageConfirmed is not None:
            raise ValueError("Europe coverage is not a Glassdoor setting")
        if self.enabled and self.accessMode is None:
            raise ValueError("select a permitted access mode")
        if self.sourceId == "levels_fyi" and self.enabled and self.accessMode != "public_markdown" and not self.europeCoverageConfirmed:
            raise ValueError("confirm Europe coverage")
        return self


def registry(preferences: dict) -> dict:
    def fixed(source_id, display, source_type, access, fields, geography, regions, note, url=None, terms=None):
        return {"sourceId": source_id, "displayName": display, "sourceType": source_type, "accessMode": access,
                "availability": "available", "licenseStatus": "not_required", "termsUrl": terms, "sourceUrl": url,
                "freshnessPolicy": note, "attributionRequirement": note, "supportedFields": fields,
                "disabledReason": None, "configured": True, "control": {"kind": "fixed", "enabled": True},
                "coverage": {"geography": geography, "regions": regions, "notes": note}, "notes": [note]}

    def controlled(source_id, name, modes, terms, url):
        preference = preferences.get(source_id, {})
        enabled = preference.get("enabled", False)
        mode = preference.get("accessMode") or ("public_markdown" if source_id == "levels_fyi" else None)
        confirmed = preference.get("europeCoverageConfirmed", False)
        public = source_id == "levels_fyi" and mode == "public_markdown"
        available = enabled and mode in modes and (source_id != "levels_fyi" or public or confirmed)
        reason = None if available else ("Disabled in Compensation sources settings." if not enabled else "Access mode or coverage is not permitted.")
        return {"sourceId": source_id, "displayName": name, "sourceType": "reported_compensation",
                "accessMode": mode or "unavailable_until_permitted", "availability": "available" if available else "unavailable",
                "licenseStatus": "permitted" if mode in modes else ("requires_license" if source_id == "levels_fyi" else "requires_permission"),
                "termsUrl": terms, "sourceUrl": url,
                "freshnessPolicy": "Read only during an explicitly permitted refresh." if available else "Unavailable until enabled with permitted access.",
                "attributionRequirement": "Preserve the provider attribution and source date." if available else "Do not display newly imported source data.",
                "supportedFields": ["market_range", "total_compensation", "sample_count", "freshness", "attribution"] if available else [],
                "disabledReason": reason, "configured": available,
                "control": {"kind": "user_preference", "enabled": enabled, "accessMode": mode,
                            "allowedAccessModes": list(modes), "europeCoverageRequired": source_id == "levels_fyi" and not public,
                            "europeCoverageConfirmed": confirmed},
                "coverage": {"geography": "job_matched_public_pages" if public else "licensed_provider_configured",
                             "regions": ["job-matched locations"] if available and public else ["configured agreement scope"] if available else [],
                             "notes": "Coverage follows the permitted provider source."}, "notes": []}
    fields = ["base_salary", "market_range", "total_compensation", "sample_count", "freshness", "attribution"]
    return {"ok": True, "sources": [
        fixed("posted_salary_text", "Job posting salary text", "posted_salary", "local_posting_text", ["posted_range", "freshness", "attribution"], "posting", ["Europe"], "Captured from the employer posting."),
        controlled("levels_fyi", "Levels.fyi", LEVELS_MODES, "https://www.levels.fyi/about/terms.html", "https://www.levels.fyi/llms.txt"),
        controlled("glassdoor", "Glassdoor", GLASSDOOR_MODES, "https://www.glassdoor.com/about/terms/", "https://www.glassdoor.com/"),
        fixed("manual_reported_compensation", "Manual reported compensation import", "reported_compensation", "manual_import", fields, "import_file", ["configured import scope"], "Explicit local import; preserve its source and date."),
        fixed("euro_top_tech", "Euro Top Tech", "reported_compensation", "public_dataset", ["total_compensation", "sample_count", "freshness", "attribution"], "public_dataset", ["Europe"], "Public crowdsourced rows at refresh time.", "https://www.eurotoptech.com/data", "https://www.eurotoptech.com/terms"),
    ]}
