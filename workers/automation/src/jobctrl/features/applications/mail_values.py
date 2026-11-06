"""Pure literal mail address parsing shared by application and HTTP adapters."""

import re

from jobctrl.app.errors import AppError

_ADDRESS = re.compile(
    r"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@"
    r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+"
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$"
)


def validate_recipient(value: object) -> str:
    recipient = value.strip() if isinstance(value, str) else ""
    if len(recipient) > 254 or not _ADDRESS.fullmatch(recipient) or len(recipient.split("@", 1)[0]) > 64:
        raise AppError("invalid_recipient", "Supply one valid recipient email address.")
    return recipient
