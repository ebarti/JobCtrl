from __future__ import annotations

import json

from typer.testing import CliRunner

from jobhunter import config
from jobhunter import database
from jobhunter.cli import app
from jobhunter.database import close_connection, init_db


def test_compensation_refresh_cli_updates_existing_job_without_pipeline(monkeypatch, tmp_path) -> None:
    db_path = tmp_path / "jobhunter.db"
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    conn = init_db(db_path)
    job_url = "https://example.com/jobs/platform"
    conn.execute(
        "INSERT INTO jobs (url, title, site, location, salary, description, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            job_url,
            "Senior Platform Engineer",
            "Acme AI",
            "Remote Europe",
            "€100,000-€130,000/year",
            "Synthetic job",
            "2026-06-19T10:00:00Z",
        ),
    )
    conn.commit()
    observations_path = tmp_path / "reported-comp.json"
    observations_path.write_text(
        json.dumps(
            [
                {
                    "sourceId": "levels.fyi",
                    "company": "Acme AI",
                    "role": "Senior Platform Engineer",
                    "totalCompensationMin": 118000,
                    "totalCompensationMax": 142000,
                    "companyTier": "tier_2",
                    "sampleCount": 4,
                },
                {
                    "sourceId": "glassdoor",
                    "company": "Acme AI",
                    "role": "Senior Platform Engineer",
                    "amount": 125000,
                    "companyTier": "tier_2",
                    "sampleCount": 3,
                },
            ]
        ),
        encoding="utf-8",
    )

    result = CliRunner().invoke(
        app,
        ["compensation-refresh", "--observations-json", str(observations_path), "--url", job_url],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["postedFactsRefreshed"] == 1
    assert payload["reportedObservationsLoaded"] == 2
    assert payload["estimatesRefreshed"] == 1
    row = conn.execute(
        "SELECT estimate_state, minimum_amount, maximum_amount, company_tier, match_scope "
        "FROM job_market_compensation_estimates WHERE job_url = ?",
        (job_url,),
    ).fetchone()
    posted = conn.execute(
        "SELECT parse_state FROM job_posted_compensation_facts WHERE job_url = ?",
        (job_url,),
    ).fetchone()
    assert row["estimate_state"] == "estimated_range"
    assert row["minimum_amount"] == 118_000
    assert row["maximum_amount"] == 142_000
    assert row["company_tier"] == "tier_2_ambitious"
    assert row["match_scope"] == "exact_company_role"
    assert posted["parse_state"] == "parsed_range"
    close_connection(db_path)
