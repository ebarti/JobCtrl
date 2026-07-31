"""Phase 1: AnalyzeJobUseCase — cache short-circuit, persistence, publish.

Mocks the ensemble runner (no SDK calls) and uses an in-memory repository, so
this exercises the use-case orchestration: cache hit/miss (D-11/D-12),
generation versioning (D-13), grounding re-validation before persist, and the
``EmployerAnalyzed`` publish.
"""

from __future__ import annotations

import uuid

import pytest

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.analysis import (
    AnalysisAgreement,
    EmployerAnalysis,
    EnsembleOutcome,
    JobAnalysis,
    JobAnalysisDraft,
    ReasonedKeyword,
    Requirement,
)
from jobctrl.domain.materials.analyze_use_case import AnalyzeJobUseCase, build_jd_snapshot
from jobctrl.domain.tenant import LOCAL_TENANT

def _job_id_for(url: str) -> JobId:
    return canonical_job_id(str(uuid.uuid5(uuid.NAMESPACE_URL, url)))


_JOB_URL = "https://example.com/jobs/staff"
JOB = {
    "job_id": str(_job_id_for(_JOB_URL)),
    "url": _JOB_URL,
    "title": "Staff Engineer",
    "full_description": "Requires 8+ years in Go. Kafka is a plus.",
}


def _canonical(role: str = "Own the platform.") -> JobAnalysis:
    return JobAnalysis(
        role_framing=role,
        inferred_seniority="staff",
        ideal_candidate_narrative="A distributed-systems owner.",
        requirements=[
            Requirement(
                id="r1",
                text="8+ years in Go",
                tier="must_have",
                weight=0.95,
                evidence_span="8+ years in Go",
            )
        ],
        keywords=[ReasonedKeyword(keyword="Go", evidence_span="8+ years in Go", requirement_ref="r1")],
    )


class _InMemoryRepo:
    def __init__(self) -> None:
        self.saved: list[EmployerAnalysis] = []

    def load(self, tenant_id, job_id, *, generation=None):
        rows = [r for r in self.saved if str(r.job_id) == str(job_id)]
        if generation is not None:
            rows = [r for r in rows if r.generation == generation]
        return max(rows, key=lambda r: r.generation) if rows else None

    def get_by_cache_key(self, tenant_id, job_id, cache_key):
        rows = [r for r in self.saved if str(r.job_id) == str(job_id) and r.cache_key == cache_key]
        return max(rows, key=lambda r: r.generation) if rows else None

    def save(self, analysis: EmployerAnalysis) -> None:
        self.saved.append(analysis)

    def next_generation(self, tenant_id, job_id) -> int:
        rows = [r.generation for r in self.saved if str(r.job_id) == str(job_id)]
        return (max(rows) + 1) if rows else 1


class _RecordingPublisher:
    def __init__(self) -> None:
        self.events: list = []

    def publish(self, event) -> None:
        self.events.append(event)

    def subscribe(self, event_type, handler):  # pragma: no cover - protocol stub
        raise NotImplementedError


def _runner_returning(outcome: EnsembleOutcome):
    calls = {"count": 0}

    async def runner(system_prompt, jd_snapshot, *, adapters, synthesizer, synthesizer_system_prompt):
        calls["count"] += 1
        return outcome

    return runner, calls


def _outcome(role: str = "Own the platform.", *, drafts=1, attempted=2, failures=()) -> EnsembleOutcome:
    canonical = _canonical(role)
    return EnsembleOutcome(
        canonical=canonical,
        drafts=tuple(
            JobAnalysisDraft(model_id=f"m{i}", **canonical.model_dump()) for i in range(drafts)
        ),
        failures=failures,
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=attempted,
    )


def _use_case(*, repo, publisher=None, runner=None) -> AnalyzeJobUseCase:
    # A single stub adapter/synthesizer satisfies the constructor; the injected
    # runner is what actually produces the outcome, so the SDKs are never touched.
    class _StubAdapter:
        model_id = "stub"

        async def draft(self, system_prompt, jd_snapshot):  # pragma: no cover - unused
            raise AssertionError("runner is injected; adapter.draft must not be called")

    class _StubSynth:
        async def reconcile(self, system_prompt, *, drafts, jd_snapshot):  # pragma: no cover
            raise AssertionError("runner is injected; synthesizer must not be called")

    return AnalyzeJobUseCase(
        repository=repo,
        adapters=(_StubAdapter(),),
        synthesizer=_StubSynth(),
        publisher=publisher,
        system_prompt="sys",
        synthesizer_system_prompt="synth",
        ensemble_runner=runner,
    )


@pytest.mark.asyncio
class TestAnalyzeJobUseCase:
    async def test_first_run_persists_generation_one_and_publishes(self) -> None:
        repo = _InMemoryRepo()
        publisher = _RecordingPublisher()
        runner, calls = _runner_returning(_outcome())
        use_case = _use_case(repo=repo, publisher=publisher, runner=runner)

        result = await use_case.execute_async(job=JOB, tenant_id=LOCAL_TENANT)

        assert result.cached is False
        assert result.analysis.generation == 1
        assert result.analysis.job_id == JobId(JOB["job_id"])
        assert result.analysis.job_id != JobId(JOB["url"])
        assert calls["count"] == 1
        assert len(repo.saved) == 1
        assert any(getattr(e, "event_type", "") == "EmployerAnalyzed" for e in publisher.events)

    async def test_url_shaped_job_id_is_rejected_before_analysis(self) -> None:
        runner, calls = _runner_returning(_outcome())
        use_case = _use_case(repo=_InMemoryRepo(), runner=runner)
        job = {**JOB, "job_id": JOB["url"]}

        with pytest.raises(ValueError, match="canonical UUID"):
            await use_case.execute_async(job=job, tenant_id=LOCAL_TENANT)

        assert calls["count"] == 0

    async def test_second_run_same_snapshot_hits_cache_and_skips_ensemble(self) -> None:
        repo = _InMemoryRepo()
        publisher = _RecordingPublisher()
        runner, calls = _runner_returning(_outcome())
        use_case = _use_case(repo=repo, publisher=publisher, runner=runner)

        await use_case.execute_async(job=JOB, tenant_id=LOCAL_TENANT)
        result2 = await use_case.execute_async(job=JOB, tenant_id=LOCAL_TENANT)

        assert result2.cached is True
        assert calls["count"] == 1  # ensemble NOT re-run on cache hit (D-11)
        assert len(repo.saved) == 1  # no new generation written

    async def test_force_recompute_bumps_generation_and_supersedes(self) -> None:
        repo = _InMemoryRepo()
        runner, calls = _runner_returning(_outcome("Own the platform v2."))
        use_case = _use_case(repo=repo, runner=runner)

        await use_case.execute_async(job=JOB, tenant_id=LOCAL_TENANT)
        forced = await use_case.execute_async(job=JOB, tenant_id=LOCAL_TENANT, force=True)

        assert forced.cached is False
        assert forced.analysis.generation == 2
        assert calls["count"] == 2
        # Prior generation retained as audit history (D-13).
        assert repo.load(LOCAL_TENANT, JobId(JOB["job_id"]), generation=1) is not None

    async def test_degraded_ensemble_is_persisted_with_completeness(self) -> None:
        from jobctrl.domain.materials.analysis import AnalysisFailure

        repo = _InMemoryRepo()
        runner, _ = _runner_returning(
            _outcome(drafts=1, attempted=2, failures=(AnalysisFailure(model_id="m1", error="boom"),))
        )
        use_case = _use_case(repo=repo, runner=runner)

        result = await use_case.execute_async(job=JOB, tenant_id=LOCAL_TENANT)

        assert result.analysis.is_degraded is True
        assert result.analysis.ensemble_completeness == "1/2"

    async def test_grounding_revalidation_blocks_fabricated_canonical(self) -> None:
        repo = _InMemoryRepo()
        # The runner returns a canonical whose evidence span is NOT in the JD —
        # the use case re-validates before persistence and must reject it.
        bad_canonical = JobAnalysis(
            role_framing="x",
            inferred_seniority="staff",
            ideal_candidate_narrative="y",
            requirements=[
                Requirement(
                    id="r1", text="Rust", tier="must_have", weight=0.5, evidence_span="ten years of Rust"
                )
            ],
            keywords=[],
        )
        outcome = EnsembleOutcome(
            canonical=bad_canonical,
            drafts=(JobAnalysisDraft(model_id="m0", **bad_canonical.model_dump()),),
            failures=(),
            agreement=AnalysisAgreement(score=1.0),
            legs_attempted=1,
        )
        runner, _ = _runner_returning(outcome)
        use_case = _use_case(repo=repo, runner=runner)

        from jobctrl.domain.materials.analysis_grounding import GroundingError

        with pytest.raises(GroundingError):
            await use_case.execute_async(job=JOB, tenant_id=LOCAL_TENANT)
        assert repo.saved == []  # nothing persisted on grounding failure

    async def test_persisted_canonical_spans_are_snapped_to_verbatim_jd(self) -> None:
        # The JD uses a U+2011 non-breaking hyphen; the runner returns a canonical
        # quoting the ASCII-hyphen form. The persistence boundary must ground
        # (formatting-tolerant) AND snap, so the saved record's spans are the JD's
        # verbatim text (D-15) even if a runner skipped snapping.
        repo = _InMemoryRepo()
        job_url = "https://example.com/jobs/soc"
        job = {
            "job_id": str(_job_id_for(job_url)),
            "url": job_url,
            "title": "Head of Security Operations",
            "full_description": "You will run a high‑availability SOC and own IR.",
        }
        ascii_canonical = JobAnalysis(
            role_framing="Run the SOC.",
            inferred_seniority="head",
            ideal_candidate_narrative="A SOC leader.",
            requirements=[
                Requirement(
                    id="r1",
                    text="HA",
                    tier="must_have",
                    weight=0.9,
                    evidence_span="high-availability SOC",  # ASCII hyphen
                )
            ],
            keywords=[
                ReasonedKeyword(
                    keyword="HA", evidence_span="high-availability", requirement_ref="r1"
                )
            ],
        )
        outcome = EnsembleOutcome(
            canonical=ascii_canonical,
            drafts=(JobAnalysisDraft(model_id="m0", **ascii_canonical.model_dump()),),
            failures=(),
            agreement=AnalysisAgreement(score=1.0),
            legs_attempted=1,
        )
        runner, _ = _runner_returning(outcome)
        use_case = _use_case(repo=repo, runner=runner)

        result = await use_case.execute_async(job=job, tenant_id=LOCAL_TENANT)

        saved = result.analysis.canonical
        assert saved.requirements[0].evidence_span == "high‑availability SOC"  # U+2011
        assert saved.keywords[0].evidence_span == "high‑availability"
        assert len(repo.saved) == 1

    async def test_eeo_red_flag_is_dropped_before_persist_and_recorded(self) -> None:
        # The runner returns a canonical that carries a protected-class
        # requirement whose evidence span IS grounded in the JD — so only the
        # EEO screen (not grounding) can stop it reaching the persisted record.
        job_url = "https://example.com/jobs/grad"
        job = {
            "job_id": str(_job_id_for(job_url)),
            "url": job_url,
            "title": "Engineer",
            "full_description": "Requires 8+ years in Go. Seeking a recent grad.",
        }
        canonical = JobAnalysis(
            role_framing="Own the platform.",
            inferred_seniority="staff",
            ideal_candidate_narrative="A distributed-systems owner.",
            requirements=[
                Requirement(
                    id="r1",
                    text="8+ years in Go",
                    tier="must_have",
                    weight=0.95,
                    evidence_span="8+ years in Go",
                ),
                Requirement(
                    id="r2",
                    text="Seeking a recent grad",
                    tier="nice_to_have",
                    weight=0.2,
                    evidence_span="Seeking a recent grad",
                ),
            ],
            keywords=[ReasonedKeyword(keyword="Go", evidence_span="8+ years in Go", requirement_ref="r1")],
        )
        outcome = EnsembleOutcome(
            canonical=canonical,
            drafts=(JobAnalysisDraft(model_id="m0", **canonical.model_dump()),),
            failures=(),
            agreement=AnalysisAgreement(score=1.0),
            legs_attempted=1,
        )
        repo = _InMemoryRepo()
        runner, _ = _runner_returning(outcome)
        use_case = _use_case(repo=repo, runner=runner)

        result = await use_case.execute_async(job=job, tenant_id=LOCAL_TENANT)

        # The protected-class requirement was dropped from the persisted canonical.
        persisted = result.analysis
        assert [req.id for req in persisted.canonical.requirements] == ["r1"]
        # ...and the drop is recorded as an audit note on the record.
        assert len(persisted.eeo_screen_hits) == 1
        hit = persisted.eeo_screen_hits[0]
        assert hit.kind == "requirement"
        assert hit.ref_id == "r2"
        assert hit.category == "age"
        # The same record is what the repository persisted.
        assert repo.saved[0].eeo_screen_hits == persisted.eeo_screen_hits


def test_build_jd_snapshot_is_title_plus_full_description() -> None:
    snapshot = build_jd_snapshot(JOB)
    assert snapshot.startswith("Staff Engineer")
    assert "8+ years in Go" in snapshot
