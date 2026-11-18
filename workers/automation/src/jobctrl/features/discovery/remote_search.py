"""Provider request adaptation and literal, conservative posting-date checks."""

from datetime import date, datetime, time, timedelta, timezone

from jobctrl.app.errors import AppError


class RemoteSearchConfigurationError(AppError):
    """One board cannot preserve the authored search scope."""

    code = "unsupported_remote_search"

    def __init__(self, message):
        super().__init__(self.code, message, 400)


def validate_remote_search_scope(sites, *, location, remote_only, hours_old):
    """Validate authored criteria; board limitations belong to execution."""
    if not remote_only and not location:
        raise RemoteSearchConfigurationError(
            "A Hybrid or On-site search needs a location. Add a location or choose only Remote for that row."
        )


def provider_scope(site, *, location, remote_only, hours_old):
    """Return supported acquisition filters without changing the user's criteria.

    The caller must apply ``posting_age_evidence`` before admitting observations
    when localAgeCheck is true. Location eligibility cannot be reconstructed from
    Glassdoor's Remote listing metadata, so that board fails explicitly.
    """
    if remote_only and site == "glassdoor" and location:
        raise RemoteSearchConfigurationError(
            "Glassdoor cannot verify a location together with Remote; other selected boards continue."
        )
    if remote_only and site in {"bayt", "bdjobs"}:
        raise RemoteSearchConfigurationError(f"{site} cannot apply Remote; other selected boards continue.")
    provider_hours = hours_old
    if remote_only and site == "indeed" and hours_old:
        provider_hours = None
    elif site in {"glassdoor", "zip_recruiter"} and hours_old:
        provider_hours = ((hours_old + 23) // 24) * 24
    return {
        "location": location,
        "remote_only": remote_only,
        "hours_old": provider_hours,
        "localAgeCheck": provider_hours != hours_old,
    }


def posting_age_evidence(site, posted, *, hours_old, reference):
    """Use only reported dates, never observation time as a posting date.

    The pinned SDK truncates Indeed UTC publication instants to dates. Its other
    date-only providers discard timezone/relative-day precision; conservatively
    retain an extra day and the maximum timezone offset in their lower bound.
    Ambiguous cutoff days and missing dates cannot authorize admission. Today's
    date is allowed when its oldest possible instant satisfies the cutoff.
    """
    anchor = datetime.fromisoformat(reference)
    if anchor.tzinfo is None:
        raise ValueError("The search reference must include its timezone")
    anchor = anchor.astimezone(timezone.utc)
    cutoff = anchor - timedelta(hours=hours_old)
    evidence = {
        "requestedHours": hours_old,
        "referenceAt": reference,
        "cutoffAt": cutoff.isoformat(),
        "reportedDate": posted.isoformat() if isinstance(posted, date) else posted,
        "precision": "date",
        "accepted": False,
        "reason": "posting_date_unknown",
    }
    try:
        day = posted if type(posted) is date else date.fromisoformat(posted)
    except (TypeError, ValueError):
        return evidence
    earliest = datetime.combine(day, time.min, tzinfo=timezone.utc)
    if site != "indeed":
        earliest -= timedelta(hours=38)
    evidence["earliestPossibleAt"] = earliest.isoformat()
    if day > anchor.date():
        evidence["reason"] = "posting_date_future"
    elif earliest < cutoff:
        evidence["reason"] = "posting_date_outside_or_ambiguous"
    else:
        evidence.update(accepted=True, reason="posting_date_within_cutoff")
    return evidence
