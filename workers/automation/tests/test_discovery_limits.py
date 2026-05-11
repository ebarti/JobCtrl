from __future__ import annotations

from types import SimpleNamespace

from jobhunter.discovery import jobspy


def test_jobspy_limit_runs_one_query_against_one_board(monkeypatch):
    calls: list[tuple[str, str, list[str], int, int]] = []

    def fake_run_one_search(
        search: dict,
        sites: list[str],
        results_per_site: int,
        *_args,
        limit: int = 0,
        **_kwargs,
    ) -> dict:
        calls.append((search["query"], search["location"], sites, results_per_site, limit))
        return {"new": 1, "existing": 0, "errors": 0}

    monkeypatch.setattr(jobspy, "init_db", lambda: None)
    monkeypatch.setattr(
        jobspy,
        "get_connection",
        lambda: SimpleNamespace(execute=lambda *_args, **_kwargs: SimpleNamespace(fetchone=lambda: [1])),
    )
    monkeypatch.setattr(jobspy, "_run_one_search", fake_run_one_search)

    result = jobspy._full_crawl(
        {
            "queries": [{"query": "platform engineer"}, {"query": "product engineer"}],
            "locations": [{"label": "remote", "location": "Remote"}],
            "defaults": {"results_per_site": 100},
        },
        sites=["indeed", "linkedin"],
        limit=1,
    )

    assert calls == [("platform engineer", "Remote", ["indeed"], 1, 1)]
    assert result["queries"] == 1
