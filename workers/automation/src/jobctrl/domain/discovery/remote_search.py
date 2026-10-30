"""Literal capability checks for the pinned broad-board adapters."""

from jobctrl.domain.errors import ConfigurationError


class RemoteSearchConfigurationError(ConfigurationError):
    """A requested board cannot preserve a selected Remote search scope."""

    code = "unsupported_remote_search"


def validate_remote_search_scope(
    sites: tuple[str, ...] | list[str], *, location: str, remote_only: bool, hours_old: int | None,
) -> None:
    """Reject combinations the pinned adapters cannot apply without broadening."""
    if not remote_only and not location:
        raise RemoteSearchConfigurationError(
            "A Hybrid or On-site search needs a location. Add a location or choose only Remote for that row."
        )
    if not remote_only:
        return
    selected = set(sites)
    if "indeed" in selected and hours_old:
        raise RemoteSearchConfigurationError(
            "Indeed cannot combine Remote with the selected lookback. "
            "Remove Indeed from this search or choose a non-Remote target."
        )
    if "glassdoor" in selected and location:
        raise RemoteSearchConfigurationError(
            "Glassdoor cannot combine Remote with a selected location. "
            "Remove Glassdoor from this search or use a location-free Remote target."
        )
    day_limited = sorted(selected & {"glassdoor", "zip_recruiter"})
    if day_limited and hours_old and hours_old % 24:
        raise RemoteSearchConfigurationError(
            f"{', '.join(day_limited)} can apply a Remote lookback only in whole days. "
            "Choose a lookback in multiples of 24 hours or remove the board from this search."
        )
    unsupported = sorted(selected & {"bayt", "bdjobs"})
    if unsupported:
        raise RemoteSearchConfigurationError(
            f"{', '.join(unsupported)} cannot apply a Remote filter. Remove the board from this search."
        )


def validate_target_row(
    sites: tuple[str, ...] | list[str], *, location: str, choices: tuple[str, ...], hours_old: int | None,
) -> None:
    """Validate every requested work-model flag without dropping row counterparts."""
    from jobctrl.domain.taxonomy import SEMANTIC_TAXONOMY

    work_model = SEMANTIC_TAXONOMY["workModel"]
    if not location and {"hybrid", work_model["hybrid"], "onsite", work_model["onsite"]}.intersection(choices):
        validate_remote_search_scope(sites, location="", remote_only=False, hours_old=hours_old)
    if {"remote", work_model["remote"]}.intersection(choices):
        validate_remote_search_scope(sites, location=location, remote_only=True, hours_old=hours_old)
