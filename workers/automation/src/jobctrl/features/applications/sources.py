"""Applications consumes immutable public Profile, Jobs and Resumes snapshots."""

from __future__ import annotations

import hashlib

from .domain import ApplicationFailure, autofill_fields, copied, require_destination


def public_resume(value: dict) -> dict:
    pdf = value.get("pdf") or {}
    return {
        "resumeId": value.get("resume_id"), "revisionId": value.get("revision_id"),
        "acceptanceId": value.get("acceptance_id"),
        "acceptedAt": value.get("accepted_at"), "profileId": value.get("profile_id", "default"),
        "profileRevision": value.get("profile_revision"), "jobId": value.get("job_id"),
        "reviewStatus": value.get("review_status"), "reviewOverride": value.get("review_override", False),
        "pdf": {"artifactId": pdf.get("artifact_id"), "sha256": pdf.get("sha256"), "sizeBytes": pdf.get("size_bytes")},
    }


class ApplicationSources:
    def __init__(self, *, profile, jobs, resumes):
        self.profile, self.jobs, self.resumes = profile, jobs, resumes

    def profile_snapshot(self, tenant="local", connection=None):
        return self.profile.snapshot(profile_id="default", tenant_id=tenant, connection=connection)

    def job_snapshot(self, job, connection=None):
        return self.jobs.get_posting_snapshot(job, connection=connection)

    def capture(self, job, tenant="local", connection=None):
        person = self.profile_snapshot(tenant, connection)
        posting = self.job_snapshot(job, connection)
        accepted = self.resumes.accepted_snapshot(job, connection=connection)
        if not accepted:
            raise ApplicationFailure("application_accepted_resume_required")
        resume = public_resume(accepted)
        revision = getattr(person, "profile_revision", getattr(person, "version", None))
        if resume["jobId"] != job or accepted.get("source_freshness", {}).get("status") == "invalid":
            raise ApplicationFailure("application_resume_sources_changed", conflict=True)
        if not resume["pdf"]["sha256"] or not resume["acceptanceId"]:
            raise ApplicationFailure("application_accepted_pdf_required")
        url = require_destination(posting.get("application_url") or posting.get("url") or "")
        binding = {
            "profile": {"profileId": "default", "revision": revision, "fingerprint": person.fingerprint},
            "job": {"jobId": job, "revision": posting["revision"], "sourceId": posting.get("source_id"),
                    "sourceRevision": posting.get("source_revision"), "sourceHash": posting["source_hash"],
                    "applicationUrl": url, "postingUrl": posting.get("url"), "activeState": posting.get("active_state")},
            "resume": resume,
        }
        return copied(binding), autofill_fields(person.document)

    def assert_current(self, job, binding, tenant="local", connection=None):
        current, _ = self.capture(job, tenant, connection)
        if current != binding:
            raise ApplicationFailure("application_sources_changed", conflict=True)
        if current["job"]["activeState"] in {"closed", "expired", "removed", "location_incompatible"}:
            raise ApplicationFailure("application_posting_closed")
        return current

    def pinned_attachment(self, job, binding, tenant="local", connection=None):
        self.assert_current(job, binding, tenant, connection)
        current = self.resumes.accepted_snapshot(job, connection=connection)
        content = self.resumes.validate_attachment(current, connection=connection)
        if (not isinstance(content, bytes) or not content
                or hashlib.sha256(content).hexdigest() != binding["resume"]["pdf"]["sha256"]):
            raise ApplicationFailure("application_attachment_changed", conflict=True)
        return content

    def screening_sources(self, tenant, job, selected_ids, sensitive_ids, connection=None):
        person = self.profile_snapshot(tenant, connection)
        posting = self.job_snapshot(job, connection)
        # Fact identities are literal JSON pointers over authored Profile sections.
        from .screening import facts_from_profile
        facts = facts_from_profile(person.document)
        by_id = {fact["id"]: fact for fact in facts}
        if len(set(selected_ids)) != len(selected_ids) or set(selected_ids) - by_id.keys():
            raise ApplicationFailure("screening_foreign_fact")
        selected = [by_id[ident] for ident in sorted(selected_ids)]
        if len(set(sensitive_ids)) != len(sensitive_ids) or set(sensitive_ids) != {f["id"] for f in selected if f["sensitive"]}:
            raise ApplicationFailure("screening_sensitive_consent_required")
        accepted = self.resumes.accepted_snapshot(job, connection=connection)
        binding = {
            "profileVersion": getattr(person, "profile_revision", getattr(person, "version", None)),
            "profileHash": person.fingerprint, "postingHash": posting["source_hash"],
            "postingRevision": posting["revision"], "destination": posting.get("application_url") or posting.get("url"),
            "posting": posting.get("text") or posting.get("description") or "",
            "resume": public_resume(accepted) if accepted else None,
            "facts": selected, "sensitiveFactIds": sorted(sensitive_ids),
        }
        return copied(binding), copied(facts)
