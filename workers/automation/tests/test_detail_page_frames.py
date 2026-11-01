"""Captured frame boundaries and provenance, using owned structural sources."""

from types import SimpleNamespace

from jobctrl.infrastructure.enrichment import playwright_fetcher
from jobctrl.infrastructure.network import PublicUrlDecision


def install_capture(monkeypatch):
    calls = []
    monkeypatch.setattr(playwright_fetcher, "validate_public_http_url", lambda url: PublicUrlDecision(url.startswith("https://public.example/")))
    monkeypatch.setattr(playwright_fetcher, "_collect_main_content", lambda frame: calls.append(frame.url) or "<main>Captured child content</main>")
    monkeypatch.setattr(playwright_fetcher, "_collect_json_ld", lambda frame: [{"@type": "JobPosting", "title": "Explicit fixture role"}])
    monkeypatch.setattr(playwright_fetcher, "_collect_status_html", lambda *_args, **_kwargs: ("<body>Captured child controls</body>", True, "child-hash"))
    return calls


def frame(url, *, visible=True):
    return SimpleNamespace(
        url=url, title=lambda: "Explicit fixture role",
        frame_element=lambda: SimpleNamespace(is_visible=lambda: visible),
    )


def test_only_visible_public_child_documents_are_read(monkeypatch):
    calls = install_capture(monkeypatch)
    main = frame("https://public.example/parent")
    child = frame("https://public.example/posting")
    private = frame("http://127.0.0.1/private")
    hidden = frame("https://public.example/hidden", visible=False)
    local = frame("about:blank")
    captured, complete = playwright_fetcher._collect_embedded_pages(
        SimpleNamespace(main_frame=main, frames=[main, private, hidden, local, child]), fetched_at="synthetic-time",
    )
    assert calls == [child.url]
    assert not complete
    assert len(captured) == 1
    assert captured[0].url == child.url
    assert captured[0].raw_html_hash == "child-hash"
    assert captured[0].json_ld[0]["title"] == "Explicit fixture role"
    assert captured[0].embedded_pages == ()


def test_embedded_capture_limit_marks_evidence_incomplete(monkeypatch):
    calls = install_capture(monkeypatch)
    main = frame("https://public.example/parent")
    children = [frame(f"https://public.example/frame/{index}") for index in range(10)]
    captured, complete = playwright_fetcher._collect_embedded_pages(
        SimpleNamespace(main_frame=main, frames=[main, *children]), fetched_at="synthetic-time",
    )
    assert len(captured) == len(calls) == 8
    assert not complete


def test_detached_frame_cannot_claim_complete_evidence(monkeypatch):
    calls = install_capture(monkeypatch)
    child = frame("https://public.example/detached")

    def detached():
        raise RuntimeError("Owned detached-frame simulation")

    child.frame_element = detached
    captured, complete = playwright_fetcher._collect_embedded_pages(
        SimpleNamespace(main_frame=None, frames=[child]), fetched_at="synthetic-time",
    )
    assert captured == () and not complete
    assert calls == []
