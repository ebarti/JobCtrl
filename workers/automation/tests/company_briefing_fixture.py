"""Owned synthetic writer for API/browser integration tests; no recorded model output."""

import json
import sqlite3
import sys
from types import SimpleNamespace
from jobctrl.infrastructure.migrations.schema_v15 import create_exact_v15_schema
from jobctrl.infrastructure.materials.company_briefings import CompanyBriefingRepository, refresh_briefing
from jobctrl.infrastructure.determinations import determination_dependencies

conn = sqlite3.connect(sys.argv[1])
if not conn.execute("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").fetchone():
    create_exact_v15_schema(conn)
for job in ("90000000-0000-4000-8000-000000000021", "90000000-0000-4000-8000-000000000022"):
    conn.execute(
        "INSERT OR IGNORE INTO jobs(tenant_id,job_id,url,title,company) VALUES('local',?,?,?,?)",
        (job, "https://example.com/jobs/" + job, "Synthetic engineer", "Example Company"),
    )
conn.commit()
repo = CompanyBriefingRepository(conn)
for job in ("90000000-0000-4000-8000-000000000021", "90000000-0000-4000-8000-000000000022"):
    repo.configure(
        job, homepage_url="https://example.com/", source_urls=["https://example.com/about"], confirm_identity=True
    )


class Model:
    model = "synthetic"
    provider_id = "fake"

    def chat_json(self, messages, **kwargs):
        data = json.loads(messages[1].content)
        citation = dict(source_id=data["sources"][0]["source_id"], quote=data["sources"][0]["text"], exact_values=[])
        return dict(
            identity="confirmed",
            identity_reason="Synthetic model identity",
            identity_citations=[citation],
            claims=[
                dict(
                    kind="hypothesis",
                    text="Synthetic company hypothesis",
                    uncertainty="One public source; hypothesis only.",
                    event_date=None,
                    citations=[citation],
                )
            ],
        )


class Fetcher:
    def fetch(self, url):
        return SimpleNamespace(outcome="allowed", status=200, final_url=url, text="Example Company public source text.")


deps = determination_dependencies(conn, tenant_id="local", lane="enrichment", adapter=Model())
deps["preflight"] = lambda: None
refresh_briefing(
    repo,
    "90000000-0000-4000-8000-000000000021",
    allow_public_fetch=True,
    fetcher=Fetcher(),
    dependencies=deps,
    clock=lambda: "2026-01-01T12:00:00+00:00",
)
print(json.dumps(repo.read("90000000-0000-4000-8000-000000000021")))
conn.close()
