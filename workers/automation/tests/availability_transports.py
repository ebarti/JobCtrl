"""External-transport-only synthetic employer for owned production-path QA.

In a private worker bootstrap, install ``transport.get`` as availability.public_get.
Production workflow registry/admission, claims, classifier and persistence stay
real. The caller owns the control file and workspace; this adds no runtime flag.
"""
from pathlib import Path
import json

from jobctrl.enrichment.availability import Response

POSTING_URL = "https://careers.example.org/jobs/role-123"


class SyntheticAvailabilityTransport:
    def __init__(self, control_path: Path) -> None:
        self.control_path = control_path

    def get(self, url: str) -> Response:
        if url != POSTING_URL:
            raise AssertionError("synthetic employer refuses unrelated acquisition")
        state = json.loads(self.control_path.read_text())["state"]
        if state == "unknown":
            return Response(url, url, 429, b"Synthetic employer rate limit", retry_after=1)
        if state not in {"active", "closed"}:
            raise AssertionError("unsupported synthetic employer state")
        description = "Build synthetic reliable systems. Our historical launch applications are closed."
        metadata = json.dumps({"@type": "JobPosting", "url": url, "title": "Synthetic role", "description": description})
        banner = '<div role="alert">Applications are closed</div>' if state == "closed" else ""
        html = ('<html><head><title>Synthetic role</title><script type="application/ld+json">'
                + metadata + '</script></head><body>' + banner + '<main><div class="job-description">'
                + description + '</div></main></body></html>')
        return Response(url, url, 200, html.encode())
