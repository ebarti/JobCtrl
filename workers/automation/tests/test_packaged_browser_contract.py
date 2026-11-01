"""Keep the shipped headless browser aligned with the locked Playwright driver."""

import json
from importlib.resources import files
from pathlib import Path


def test_distribution_browser_matches_installed_playwright_driver():
    root = Path(__file__).resolve().parents[3]
    registry = json.loads(files("playwright").joinpath("driver/package/browsers.json").read_text())
    browser = next(item for item in registry["browsers"] if item["name"] == "chromium-headless-shell")
    inventory = json.loads((root / "packaging/distribution/component-inventory.json").read_text())
    component = next(item for item in inventory["components"] if item["id"] == "chromium-core")
    locks = json.loads((root / "packaging/distribution/components.lock.json").read_text())
    archive = next(item for item in locks["inputs"] if item["id"] == "chromium-core-headless-archive")
    platform = json.loads((root / "packaging/distribution/platforms.json").read_text())["platforms"][0]
    evidence = next(item for item in platform["minimumOsEvidence"] if item["componentId"] == "chromium-core")

    assert component["version"] == browser["browserVersion"]
    assert archive["version"] == browser["browserVersion"]
    assert f'/{browser["browserVersion"]}/' in archive["url"]
    assert evidence["observedPath"].split("/")[0] == f'chromium_headless_shell-{browser["revision"]}'
