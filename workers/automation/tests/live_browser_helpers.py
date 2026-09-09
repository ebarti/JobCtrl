"""Synthetic broker transport exercising the real worker-side browser client."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from pathlib import Path
from urllib.parse import unquote

from jobctrl.infrastructure.discovery.live_browser import LiveChromeDiscoveryClient


class FixtureBrowserBroker:
    def __init__(self, app_dir: Path, result_for: Callable[[str], dict]) -> None:
        self.app_dir = app_dir
        self.result_for = result_for
        self.tasks: dict[str, str] = {}
        self.visited: list[str] = []
        (app_dir / "extension-capability-token").write_text("fixture-token", encoding="utf-8")

    def client(self, execution, **kwargs) -> LiveChromeDiscoveryClient:
        return LiveChromeDiscoveryClient(execution, **kwargs, app_dir=self.app_dir, transport=self.transport)

    def transport(
        self, method: str, url: str, data: bytes | None, _headers: Mapping[str, str], _timeout: float
    ) -> tuple[int, bytes]:
        if url.endswith("/status"):
            return 200, b'{"connected":true}'
        if method == "POST":
            task = json.loads(data or b"{}")
            self.tasks[task["taskId"]] = task["request"]["url"]
            return 202, json.dumps({"taskId": task["taskId"]}).encode()
        task_id = unquote(url.rsplit("/", 1)[-1])
        if method == "DELETE":
            self.tasks.pop(task_id, None)
            return 204, b""
        target = self.tasks[task_id]
        self.visited.append(target)
        result = self.result_for(target)
        return 200, json.dumps({"taskId": task_id, "status": result["status"], "result": result}).encode()


def retryable_page_failure() -> dict:
    return {"status": "failed", "errorCode": "navigation_failed", "message": "fixture hydration timeout", "retryable": True}
