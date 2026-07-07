import pytest

from jobctl.domain.materials.use_cases import CoverLetterOutcome
from jobctl.scoring import cover_letter
from jobctl.scoring.cover_letter import _get_resume_text_for_job


def test_cover_generation_requires_tailored_resume():
    with pytest.raises(FileNotFoundError, match="requires a tailored resume"):
        _get_resume_text_for_job({"tailored_resume_path": None}, "base resume")


def test_cover_letter_by_url_filters_retry_to_requested_job(monkeypatch: pytest.MonkeyPatch, tmp_path):
    class FakeConnection:
        def commit(self) -> None:
            pass

    class FakeUseCase:
        def execute(self, *, job, profile_snapshot, cover_letter_dir, validation_mode, tenant_id):
            processed_urls.append(job["url"])
            return CoverLetterOutcome(materials=None, status="ok")

    processed_urls: list[str] = []
    selector_calls: list[dict[str, object]] = []

    def fake_get_jobs_by_stage(*, conn, stage, min_score, limit):
        selector_calls.append(
            {"conn": conn, "stage": stage, "min_score": min_score, "limit": limit}
        )
        return [
            {
                "url": "https://example.com/jobs/unrelated",
                "title": "Unrelated",
                "discovered_at": "2026-06-04T00:00:00Z",
            },
            {
                "url": "https://example.com/jobs/requested",
                "title": "Requested",
                "discovered_at": "2026-06-04T00:00:00Z",
            },
        ]

    monkeypatch.setattr(cover_letter, "COVER_LETTER_DIR", tmp_path)
    monkeypatch.setattr(cover_letter, "get_connection", lambda: FakeConnection())
    monkeypatch.setattr(cover_letter, "get_jobs_by_stage", fake_get_jobs_by_stage)
    monkeypatch.setattr(cover_letter, "_build_use_case", lambda **kwargs: FakeUseCase())
    monkeypatch.setattr(cover_letter, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(cover_letter, "_cover_stage_succeeded", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(cover_letter, "ensure_job_stage_rows", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_letter, "set_stage_state", lambda *args, **kwargs: None)
    monkeypatch.setattr(cover_letter, "record_job_event", lambda *args, **kwargs: None)

    result = cover_letter.cover_letter_by_url(
        "https://example.com/jobs/requested",
        snapshot=object(),
        repository=object(),
    )

    assert result["generated"] == 1
    assert result["errors"] == 0
    assert processed_urls == ["https://example.com/jobs/requested"]
    assert len(selector_calls) == 1
    assert selector_calls[0]["stage"] == "pending_cover"
    assert selector_calls[0]["min_score"] == 7
    assert selector_calls[0]["limit"] == 0


def test_cover_letter_by_url_commits_completed_job_before_later_crash(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    class FakeConnection:
        def __init__(self) -> None:
            self.commits = 0

        def commit(self) -> None:
            self.commits += 1

    class FakeUseCase:
        def execute(self, *, job, profile_snapshot, cover_letter_dir, validation_mode, tenant_id):
            if job["url"].endswith("crash"):
                raise RuntimeError("LLM outage")
            return CoverLetterOutcome(materials=None, status="ok")

    conn = FakeConnection()
    stage_writes: list[tuple[str, str, str]] = []

    def fake_get_jobs_by_stage(*, conn, stage, min_score, limit):
        return [
            {
                "url": "https://example.com/jobs/done",
                "title": "Done",
                "discovered_at": "2026-06-04T00:00:00Z",
            },
            {
                "url": "https://example.com/jobs/crash",
                "title": "Crash",
                "discovered_at": "2026-06-04T00:00:00Z",
            },
        ]

    monkeypatch.setattr(cover_letter, "COVER_LETTER_DIR", tmp_path)
    monkeypatch.setattr(cover_letter, "get_connection", lambda: conn)
    monkeypatch.setattr(cover_letter, "get_jobs_by_stage", fake_get_jobs_by_stage)
    monkeypatch.setattr(cover_letter, "_build_use_case", lambda **kwargs: FakeUseCase())
    monkeypatch.setattr(cover_letter, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(cover_letter, "_cover_stage_succeeded", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(cover_letter, "ensure_job_stage_rows", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        cover_letter,
        "set_stage_state",
        lambda _conn, url, stage, state, **_kwargs: stage_writes.append((url, stage, state)),
    )
    monkeypatch.setattr(cover_letter, "record_job_event", lambda *args, **kwargs: None)

    first = cover_letter.cover_letter_by_url(
        "https://example.com/jobs/done",
        snapshot=object(),
        repository=object(),
    )
    second = cover_letter.cover_letter_by_url(
        "https://example.com/jobs/crash",
        snapshot=object(),
        repository=object(),
    )

    assert first["status"] == "ok"
    assert second["status"] == "error"
    assert ("https://example.com/jobs/done", "cover", "succeeded") in stage_writes
    assert ("https://example.com/jobs/crash", "cover", "failed") in stage_writes
    assert conn.commits >= 4
