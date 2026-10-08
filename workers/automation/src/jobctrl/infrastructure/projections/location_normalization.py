"""Source display only; model interpretations own geography and work model."""


def normalize_job_location(location: str | None) -> str:
    return str(location or "").strip()
