"""Pure canonical JSON formatting shared by domain decisions and adapters."""

import json
from typing import Any


def encoded(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
