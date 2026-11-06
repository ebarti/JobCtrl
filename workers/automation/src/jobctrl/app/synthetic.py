"""Capabilities for controlled external boundaries in owned E2E workspaces."""

from __future__ import annotations

import hmac
import json
import os
import stat
from pathlib import Path
from urllib.parse import urlsplit

from jobctrl.app.errors import AppError


def synthetic_boundary(workspace: Path, url: str | None = None) -> dict | None:
    enabled = os.environ.get("JOBCTRL_SYNTHETIC_BOUNDARIES")
    if enabled != "1":
        if enabled or os.environ.get("JOBCTRL_E2E_PROVIDER_URL") or os.environ.get("JOBCTRL_E2E_TOKEN"):
            raise AppError("synthetic_boundary_unowned", "Synthetic provider configuration is incomplete.", 503)
        return None
    token = os.environ.get("JOBCTRL_E2E_TOKEN", "")
    root = workspace.resolve(strict=True)
    marker_path = root / ".jobctrl-e2e-owned.json"
    try:
        info = marker_path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("marker")
        marker = json.loads(marker_path.read_text())
        if (marker.get("version") != 1 or marker.get("workspace") != str(root)
                or len(token) != 64 or any(character not in "0123456789abcdef" for character in token)
                or not isinstance(marker.get("token"), str) or not hmac.compare_digest(marker["token"], token)):
            raise ValueError("identity")
    except (OSError, ValueError, TypeError, AttributeError):
        raise AppError("synthetic_boundary_unowned", "Synthetic providers require an owned E2E workspace.", 503) from None
    if url is not None:
        try:
            parsed = urlsplit(url)
            if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"}
                    or not parsed.port or parsed.username or parsed.password or parsed.query or parsed.fragment):
                raise ValueError("url")
        except ValueError:
            raise AppError("synthetic_boundary_unowned", "The synthetic provider must be literal loopback HTTP.", 503) from None
    return {"workspace": str(root), "token": token}
