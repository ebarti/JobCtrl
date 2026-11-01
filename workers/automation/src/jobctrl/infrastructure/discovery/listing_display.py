"""Render a structured source remote flag; never infer it from location prose."""


def normalize_location_display(location: str | None, *, is_remote: bool | None = None) -> str:
    text = str(location or "").strip()
    if is_remote is True:
        return f"{text} | Remote" if text else "Remote"
    return text
