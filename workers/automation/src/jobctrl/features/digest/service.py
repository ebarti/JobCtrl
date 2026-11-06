"""Compose public summaries without changing their source records."""

from datetime import datetime, timezone

from jobctrl.app.errors import AppError
from jobctrl.features.digest.domain import links, parse_time
from jobctrl.features.digest.ports import DigestRepository, SettingsReader, SpendReader


class DigestService:
    def __init__(self, repository: DigestRepository, *, model: SpendReader, settings: SettingsReader,
                 jobs, fit=None, discovery=None, applications=None, resumes=None, companies=None):
        self.repository, self.model, self.settings = repository, model, settings
        self.jobs, self.fit, self.discovery = jobs, fit, discovery
        self.applications, self.resumes, self.companies = applications, resumes, companies

    def acknowledge(self, requested=None):
        return self.repository.acknowledge(requested)

    def build(self, min_fit_score=None):
        if min_fit_score is not None and (type(min_fit_score) is not int or not 0 <= min_fit_score <= 10):
            raise AppError("invalid_min_fit_score", "The minimum fit score must be an integer from 0 to 10.")
        now = datetime.now(timezone.utc)
        unavailable = []
        # These fields require a cross-owner aggregate; source failures are not
        # converted into an empty list or a successful zero.
        new_matches = {"count": None, "highFitCount": None}
        stale = None
        threshold = min_fit_score if min_fit_score is not None else 7
        with self.repository.read_scope() as scope:
            since, context = scope.since, scope.source_context
            if self.jobs is not None and self.fit is not None and hasattr(self.fit, "digest_summary"):
                jobs = self.jobs.list_job_snapshots(connection=context)
                job_ids = [job["job_id"] for job in jobs]
                if min_fit_score is None:
                    threshold = self.fit.minimum_fit_score(connection=context)
                fit_summary = self.fit.digest_summary(job_ids, since=since, threshold=threshold, connection=context)
                if since is None:
                    matched = set(job_ids)
                else:
                    # Existing Digest compares UTC instants at millisecond precision.
                    cutoff = parse_time(since)
                    cutoff = cutoff.replace(microsecond=(cutoff.microsecond // 1000) * 1000)
                    matched = set(fit_summary["newMatchJobIds"])
                    for job in jobs:
                        created = parse_time(job.get("created_at"))
                        if created is None:
                            raise AppError("digest_source_unavailable", "A job creation timestamp is unavailable.", status_code=503)
                        created = created.replace(microsecond=(created.microsecond // 1000) * 1000)
                        if created >= cutoff:
                            matched.add(job["job_id"])
                new_matches = {"count": len(matched), "highFitCount": len(matched & set(fit_summary["highFitJobIds"]))}
                stale = len(fit_summary["staleJobIds"])
            else:
                unavailable.extend(("newMatches", "staleScores"))
        if self.discovery is not None and hasattr(self.discovery, "digest_summary"):
            summary = self.discovery.digest_summary()
            blocked = []
            for source in summary["sources"]:
                state = source.get("recommendedState", source.get("state", "normal"))
                failures = source.get("consecutiveFailures", source.get("consecutive_failures", 0))
                if state in {"quarantined", "disabled"} or failures >= 3:
                    item = {"sourceId": source.get("sourceId", source.get("source_id")),
                            "recommendedState": state, "consecutiveFailures": failures}
                    display = source.get("displayName") or source.get("name")
                    if display:
                        item["displayName"] = display
                    blocked.append(item)
            blocked_sources = {"count": len(blocked), "sources": blocked}
        else:
            blocked_sources = {"count": None, "sources": []}
            unavailable.append("blockedSources")
        if self.applications is not None:
            app = self.applications.summary()
            approvals, followups = app.get("pendingApprovalCount"), app.get("followUpsDueCount")
        else:
            approvals = followups = None
        if approvals is None:
            unavailable.append("pendingApprovals")
        if followups is None:
            unavailable.append("followUpsDue")
        materials = self.resumes.digest_summary().get("reviewNeededMaterials") if self.resumes is not None and hasattr(self.resumes, "digest_summary") else None
        if materials is None:
            unavailable.append("reviewNeededMaterials")
        spending = self.model.spend()
        budget = self.settings.snapshot()["dailyBudgetUsd"]
        complete = spending["accountingComplete"]
        amount = spending["costUsd"] if complete else None
        budget_data = {"status": "incomplete" if not complete else "over_budget" if budget > 0 and amount >= budget else "ok",
                       "estimatedUsd": amount, "dailyBudgetUsd": float(budget),
                       "remainingUsd": max(0.0, budget - amount) if complete and budget > 0 else None, "unlimited": budget <= 0}
        result = {"ok": True, "generatedAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                  "since": since, "highFitThreshold": threshold, "newMatches": new_matches, "blockedSources": blocked_sources,
                  "reviewNeededMaterials": {"count": materials}, "staleScores": {"count": stale},
                  "pendingApprovals": {"count": approvals},
                  "followUpsDue": {"count": followups, "derived": True, "thresholdDays": 7, "dayBoundary": "UTC"},
                  "budget": budget_data, "deepLinks": links(since), "unavailable": unavailable}
        if self.companies is not None:
            result["companyBriefings"] = self.companies.summaries(now=now)
        return result
