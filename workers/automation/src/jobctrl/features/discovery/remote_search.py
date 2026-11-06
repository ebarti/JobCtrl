"""Literal capability checks for the pinned broad-board adapters."""

from jobctrl.app.errors import AppError


class RemoteSearchConfigurationError(AppError):
    """A requested board cannot preserve a selected Remote search scope."""

    code = "unsupported_remote_search"

    def __init__(self, message):
        super().__init__(self.code, message, 400)


def validate_remote_search_scope(
    sites: tuple[str, ...] | list[str],
    *,
    location: str,
    remote_only: bool,
    hours_old: int | None,
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
