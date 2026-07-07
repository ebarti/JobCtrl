"""Phase 1: SDK adapters + ensemble orchestration — SDK boundary fully mocked.

These tests inject fake SDK shapes (no ``claude_agent_sdk`` / ``openai_codex``
live calls, no network, no auth — D-04 / "no live calls in tests"). They prove:

  * each adapter parses its SDK's structured output into a typed draft;
  * the ensemble runs legs in parallel and SURFACES partial failures instead of
    silently dropping them (failure mode #2);
  * a leg that fabricates an evidence span is retried then recorded as a
    failure (grounding gate + retry, AI-SPEC §4b);
  * the ensemble hard-fails only when ALL legs fail (EnsembleError);
  * the synthesizer reconciles drafts and its output is grounding-validated.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from jobctrl.domain.materials.analysis import (
    EnsembleError,
    JobAnalysis,
    JobAnalysisDraft,
)
from jobctrl.infrastructure.analysis.claude_analysis_adapter import (
    ClaudeAnalysisAdapter,
    ClaudeAnalysisSynthesizer,
)
from jobctrl.infrastructure.analysis.codex_analysis_adapter import CodexAnalysisAdapter
from jobctrl.infrastructure.analysis.ensemble import compute_agreement, run_ensemble

pytestmark = pytest.mark.asyncio

JD = (
    "Staff Backend Engineer. Requires 8+ years building distributed systems in "
    "Go. Kafka experience is a plus. You will own the payments platform."
)

_GROUNDED_ANALYSIS = {
    "role_framing": "Own the payments platform.",
    "inferred_seniority": "staff",
    "ideal_candidate_narrative": "A distributed-systems owner for payments.",
    "requirements": [
        {
            "id": "r1",
            "text": "8+ years building distributed systems in Go",
            "tier": "must_have",
            "weight": 0.95,
            "evidence_span": "8+ years building distributed systems in Go",
        },
        {
            "id": "r2",
            "text": "Kafka",
            "tier": "nice_to_have",
            "weight": 0.4,
            "evidence_span": "Kafka experience is a plus",
        },
    ],
    "keywords": [
        {
            "keyword": "Go",
            "evidence_span": "distributed systems in Go",
            "requirement_ref": "r1",
            "rationale": "core language",
        }
    ],
}


def _grounded_dict(model_tag: str | None = None) -> dict[str, Any]:
    data = json.loads(json.dumps(_GROUNDED_ANALYSIS))
    if model_tag:
        data["role_framing"] = f"{data['role_framing']} ({model_tag})"
    return data


# --------------------------------------------------------------------------- #
# Fake Claude Agent SDK
# --------------------------------------------------------------------------- #


class ResultMessage:
    """Named to match the real SDK class — the adapter keys on the class name."""

    def __init__(
        self,
        structured_output: Any,
        subtype: str = "success",
        usage: dict[str, int] | None = None,
    ) -> None:
        self.structured_output = structured_output
        self.subtype = subtype
        self.usage = usage


class _FakeClaudeOptions:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


def _fake_claude_query(
    structured: Any,
    *,
    captured: list[dict[str, Any]] | None = None,
    usage: dict[str, int] | None = None,
):
    """Return a fake ``query`` that yields one ResultMessage with ``structured``."""

    def query(*, prompt: str, options: Any):
        if captured is not None:
            captured.append({"prompt": prompt, "options": options})

        async def _gen():
            yield ResultMessage(structured, usage=usage)

        return _gen()

    return query


# --------------------------------------------------------------------------- #
# Fake Codex SDK
# --------------------------------------------------------------------------- #


class _FakeCodexThread:
    def __init__(self, final_response: str, status: str = "completed", usage: Any = None) -> None:
        self._final_response = final_response
        self._status = status
        self._usage = usage
        self.runs: list[dict[str, Any]] = []

    async def run(self, prompt: str, **kwargs: Any) -> Any:
        self.runs.append({"prompt": prompt, **kwargs})
        return SimpleNamespace(
            status=self._status,
            final_response=self._final_response,
            error=None,
            usage=self._usage,
        )


class _FakeAsyncCodex:
    def __init__(self, final_response: str, status: str = "completed", usage: Any = None) -> None:
        self._final_response = final_response
        self._status = status
        self.thread = _FakeCodexThread(final_response, status, usage)
        self.thread_start_calls: list[dict[str, Any]] = []

    async def __aenter__(self) -> _FakeAsyncCodex:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def thread_start(self, **kwargs: Any) -> _FakeCodexThread:
        self.thread_start_calls.append(kwargs)
        return self.thread


# --------------------------------------------------------------------------- #
# Adapter tests
# --------------------------------------------------------------------------- #


class TestClaudeAdapter:
    async def test_parses_structured_output_into_typed_draft(self) -> None:
        adapter = ClaudeAnalysisAdapter(
            model="claude-opus-4-8",
            query_fn=_fake_claude_query(_grounded_dict()),
            options_factory=_FakeClaudeOptions,
        )
        draft = await adapter.draft("system", JD)
        assert isinstance(draft, JobAnalysisDraft)
        assert draft.model_id == "claude-opus-4-8"
        assert draft.requirements[0].tier == "must_have"

    async def test_no_turn_cap_and_empty_tools_passed_to_options(self) -> None:
        captured: list[dict[str, Any]] = []
        adapter = ClaudeAnalysisAdapter(
            query_fn=_fake_claude_query(_grounded_dict(), captured=captured),
            options_factory=_FakeClaudeOptions,
        )
        await adapter.draft("system", JD)
        opts = captured[0]["options"].kwargs
        assert opts["max_turns"] is None  # D-19: unbounded
        assert opts["allowed_tools"] == []  # no agent file/shell tools
        assert opts["output_format"]["type"] == "json_schema"

    async def test_raises_on_structured_output_retry_exhaustion(self) -> None:
        def query(*, prompt: str, options: Any):
            async def _gen():
                yield ResultMessage(None, subtype="error_max_structured_output_retries")

            return _gen()

        adapter = ClaudeAnalysisAdapter(query_fn=query, options_factory=_FakeClaudeOptions)
        with pytest.raises(RuntimeError, match="retries exhausted"):
            await adapter.draft("system", JD)

    async def test_draft_opens_generation_span_with_model_and_tokens(self, in_memory_exporter) -> None:
        adapter = ClaudeAnalysisAdapter(
            model="claude-opus-4-8",
            query_fn=_fake_claude_query(
                _grounded_dict(),
                usage={"input_tokens": 1200, "output_tokens": 340, "cache_read_input_tokens": 50},
            ),
            options_factory=_FakeClaudeOptions,
        )
        await adapter.draft("system", JD)

        spans = in_memory_exporter.get_finished_spans()
        assert len(spans) == 1
        span = spans[0]
        assert span.name == "llm.claude-opus-4-8"
        assert span.instrumentation_scope.name == "jobctrl.analysis.claude"
        attrs = dict(span.attributes or {})
        assert attrs["langfuse.observation.type"] == "generation"
        assert attrs["langfuse.observation.model.name"] == "claude-opus-4-8"
        # input = 1200 fresh + 50 cache_read; cache tokens count toward input processed.
        assert attrs["gen_ai.usage.input_tokens"] == 1250
        assert attrs["gen_ai.usage.output_tokens"] == 340
        assert json.loads(attrs["langfuse.observation.usage_details"]) == {
            "input_tokens": 1250,
            "output_tokens": 340,
            "total_tokens": 1590,
        }

    async def test_draft_span_omits_tokens_when_sdk_reports_no_usage(self, in_memory_exporter) -> None:
        # Instrumentation must never break a leg: no SDK usage -> the draft still
        # succeeds and the span omits token counts rather than fabricating them.
        adapter = ClaudeAnalysisAdapter(
            query_fn=_fake_claude_query(_grounded_dict()),
            options_factory=_FakeClaudeOptions,
        )
        draft = await adapter.draft("system", JD)
        assert draft.model_id == "claude-opus-4-8"

        attrs = dict(in_memory_exporter.get_finished_spans()[0].attributes or {})
        assert attrs["langfuse.observation.model.name"] == "claude-opus-4-8"
        assert "gen_ai.usage.input_tokens" not in attrs
        assert "langfuse.observation.usage_details" not in attrs

    async def test_draft_span_records_sdk_error_and_reraises(self, in_memory_exporter) -> None:
        from opentelemetry.trace import StatusCode

        def query(*, prompt: str, options: Any):
            async def _gen():
                yield ResultMessage(None, subtype="error_max_structured_output_retries")

            return _gen()

        adapter = ClaudeAnalysisAdapter(query_fn=query, options_factory=_FakeClaudeOptions)
        with pytest.raises(RuntimeError, match="retries exhausted"):
            await adapter.draft("system", JD)

        spans = in_memory_exporter.get_finished_spans()
        assert len(spans) == 1
        assert spans[0].status.status_code == StatusCode.ERROR

    async def test_draft_span_survives_malformed_sdk_usage(self, in_memory_exporter) -> None:
        # A drifted / non-int usage field must NEVER fail the leg — token
        # extraction runs inside the re-raising span block, so it degrades the
        # unparseable count to omitted rather than raising.
        adapter = ClaudeAnalysisAdapter(
            query_fn=_fake_claude_query(
                _grounded_dict(),
                usage={"input_tokens": "n/a", "output_tokens": 10},
            ),
            options_factory=_FakeClaudeOptions,
        )
        draft = await adapter.draft("system", JD)  # must not raise
        assert draft.model_id == "claude-opus-4-8"

        attrs = dict(in_memory_exporter.get_finished_spans()[0].attributes or {})
        assert "gen_ai.usage.input_tokens" not in attrs
        assert "langfuse.observation.usage_details" not in attrs
        # A well-formed sibling field is still recorded.
        assert attrs["gen_ai.usage.output_tokens"] == 10


class TestClaudeSynthesizer:
    async def test_reconcile_opens_generation_span(self, in_memory_exporter) -> None:
        synth = ClaudeAnalysisSynthesizer(
            query_fn=_fake_claude_query(
                _grounded_dict(),
                usage={"input_tokens": 500, "output_tokens": 90},
            ),
            options_factory=_FakeClaudeOptions,
        )
        draft = JobAnalysisDraft(model_id="claude-opus-4-8", **_grounded_dict())
        await synth.reconcile("synth-sys", drafts=(draft,), jd_snapshot=JD)

        spans = in_memory_exporter.get_finished_spans()
        assert len(spans) == 1
        span = spans[0]
        assert span.name == "llm.claude-opus-4-8"
        # A distinct scope keeps the synthesizer separable from the Claude draft leg.
        assert span.instrumentation_scope.name == "jobctrl.analysis.synthesizer"
        attrs = dict(span.attributes or {})
        assert attrs["langfuse.observation.type"] == "generation"
        assert attrs["gen_ai.usage.input_tokens"] == 500
        assert attrs["gen_ai.usage.output_tokens"] == 90


class TestCodexAdapter:
    async def test_parses_final_response_into_typed_draft(self) -> None:
        adapter = CodexAnalysisAdapter(
            model="gpt-5.4",
            async_codex_factory=lambda: _FakeAsyncCodex(json.dumps(_grounded_dict())),
        )
        draft = await adapter.draft("system", JD)
        assert draft.model_id == "gpt-5.4"
        assert draft.requirements[1].tier == "nice_to_have"

    async def test_passes_output_schema_and_high_effort(self) -> None:
        fake = _FakeAsyncCodex(json.dumps(_grounded_dict()))
        adapter = CodexAnalysisAdapter(async_codex_factory=lambda: fake)
        await adapter.draft("system", JD)
        run_kwargs = fake.thread.runs[0]
        assert run_kwargs["effort"] == "high"
        assert run_kwargs["output_schema"]["type"] == "object"
        assert fake.thread_start_calls[0]["config"] == {"model_reasoning_effort": "high"}

    async def test_raises_on_failed_turn(self) -> None:
        adapter = CodexAnalysisAdapter(
            async_codex_factory=lambda: _FakeAsyncCodex("", status="failed"),
        )
        with pytest.raises(RuntimeError, match="Codex turn failed"):
            await adapter.draft("system", JD)

    async def test_draft_opens_generation_span_with_model_and_tokens(self, in_memory_exporter) -> None:
        usage = SimpleNamespace(total=SimpleNamespace(input_tokens=800, output_tokens=210))
        fake = _FakeAsyncCodex(json.dumps(_grounded_dict()), usage=usage)
        adapter = CodexAnalysisAdapter(model="gpt-5.5", async_codex_factory=lambda: fake)
        await adapter.draft("system", JD)

        spans = in_memory_exporter.get_finished_spans()
        assert len(spans) == 1
        span = spans[0]
        assert span.name == "llm.gpt-5.5"
        assert span.instrumentation_scope.name == "jobctrl.analysis.codex"
        attrs = dict(span.attributes or {})
        assert attrs["langfuse.observation.type"] == "generation"
        assert attrs["langfuse.observation.model.name"] == "gpt-5.5"
        assert attrs["gen_ai.usage.input_tokens"] == 800
        assert attrs["gen_ai.usage.output_tokens"] == 210


# --------------------------------------------------------------------------- #
# Stub ports for the ensemble (no SDK at all)
# --------------------------------------------------------------------------- #


class _StubDraftAdapter:
    def __init__(self, model_id: str, *, returns: dict | None = None, raises: Exception | None = None) -> None:
        self._model_id = model_id
        self._returns = returns
        self._raises = raises
        self.calls = 0

    @property
    def model_id(self) -> str:
        return self._model_id

    async def draft(self, system_prompt: str, jd_snapshot: str) -> JobAnalysisDraft:
        self.calls += 1
        if self._raises is not None:
            raise self._raises
        analysis = JobAnalysis.model_validate(self._returns)
        return JobAnalysisDraft(model_id=self._model_id, **analysis.model_dump())


class _StubSynthesizer:
    def __init__(self, *, returns: dict | None = None) -> None:
        self._returns = returns or _grounded_dict()
        self.received_drafts: tuple[JobAnalysisDraft, ...] = ()

    async def reconcile(self, system_prompt: str, *, drafts: tuple[JobAnalysisDraft, ...], jd_snapshot: str) -> JobAnalysis:
        self.received_drafts = drafts
        return JobAnalysis.model_validate(self._returns)


# --------------------------------------------------------------------------- #
# Ensemble tests
# --------------------------------------------------------------------------- #


class TestEnsemble:
    async def test_all_legs_succeed_produces_full_outcome(self) -> None:
        adapters = (
            _StubDraftAdapter("claude-opus-4-8", returns=_grounded_dict("claude")),
            _StubDraftAdapter("gpt-5.4", returns=_grounded_dict("codex")),
        )
        synth = _StubSynthesizer()
        outcome = await run_ensemble(
            "sys",
            JD,
            adapters=adapters,
            synthesizer=synth,
            synthesizer_system_prompt="synth-sys",
        )
        assert outcome.legs_attempted == 2
        assert len(outcome.drafts) == 2
        assert outcome.failures == ()
        # The synthesizer received the typed surviving drafts.
        assert len(synth.received_drafts) == 2

    async def test_partial_failure_is_surfaced_not_dropped(self) -> None:
        adapters = (
            _StubDraftAdapter("claude-opus-4-8", returns=_grounded_dict("claude")),
            _StubDraftAdapter("gpt-5.4", raises=RuntimeError("codex app-server down")),
        )
        outcome = await run_ensemble(
            "sys",
            JD,
            adapters=adapters,
            synthesizer=_StubSynthesizer(),
            synthesizer_system_prompt="synth-sys",
            max_leg_retries=0,
        )
        # One surviving draft + one PERSISTED failure (failure mode #2 guard).
        assert len(outcome.drafts) == 1
        assert len(outcome.failures) == 1
        assert outcome.failures[0].model_id == "gpt-5.4"
        assert "codex app-server down" in outcome.failures[0].error
        assert outcome.legs_attempted == 2  # degraded: 1/2

    async def test_fabricated_span_leg_is_retried_then_recorded_as_failure(self) -> None:
        fabricated = _grounded_dict()
        fabricated["requirements"][0]["evidence_span"] = "ten years of Rust"  # not in JD
        bad = _StubDraftAdapter("gpt-5.4", returns=fabricated)
        good = _StubDraftAdapter("claude-opus-4-8", returns=_grounded_dict())
        outcome = await run_ensemble(
            "sys",
            JD,
            adapters=(good, bad),
            synthesizer=_StubSynthesizer(),
            synthesizer_system_prompt="synth-sys",
            max_leg_retries=2,
        )
        assert bad.calls == 3  # initial + 2 retries before giving up
        assert len(outcome.drafts) == 1
        assert outcome.failures[0].model_id == "gpt-5.4"
        # The grounding violation is captured as raw audit output.
        assert "not found verbatim" in (outcome.failures[0].raw_output or "")

    async def test_all_legs_fail_raises_ensemble_error(self) -> None:
        adapters = (
            _StubDraftAdapter("claude-opus-4-8", raises=RuntimeError("boom")),
            _StubDraftAdapter("gpt-5.4", raises=RuntimeError("bang")),
        )
        with pytest.raises(EnsembleError) as exc:
            await run_ensemble(
                "sys",
                JD,
                adapters=adapters,
                synthesizer=_StubSynthesizer(),
                synthesizer_system_prompt="synth-sys",
                max_leg_retries=0,
            )
        assert len(exc.value.failures) == 2

    async def test_drafts_and_canonical_carry_snapped_spans(self) -> None:
        # JD has a U+2011 non-breaking hyphen; both the leg and the synthesizer
        # quote the ASCII-hyphen form. The ensemble must GROUND (formatting-
        # tolerant) AND snap every persisted span to the JD's verbatim text so the
        # drafts + canonical are content-exact / copy-paste-findable (D-15).
        jd = (
            "Head of Security Operations. You will run a high‑availability SOC "
            "and own incident response end to end."
        )
        ascii_hyphen = {
            "role_framing": "Run the SOC.",
            "inferred_seniority": "head",
            "ideal_candidate_narrative": "A hands-on SOC leader.",
            "requirements": [
                {
                    "id": "r1",
                    "text": "high availability",
                    "tier": "must_have",
                    "weight": 0.9,
                    "evidence_span": "high-availability SOC",  # ASCII hyphen
                }
            ],
            "keywords": [
                {
                    "keyword": "HA",
                    "evidence_span": "high-availability",  # ASCII hyphen
                    "requirement_ref": "r1",
                }
            ],
        }
        outcome = await run_ensemble(
            "sys",
            jd,
            adapters=(_StubDraftAdapter("claude-opus-4-8", returns=ascii_hyphen),),
            synthesizer=_StubSynthesizer(returns=ascii_hyphen),
            synthesizer_system_prompt="synth-sys",
            max_leg_retries=0,
        )
        # The surviving draft's spans are snapped to the JD's U+2011 text.
        assert outcome.drafts[0].requirements[0].evidence_span == "high‑availability SOC"
        assert outcome.drafts[0].keywords[0].evidence_span == "high‑availability"
        # The canonical (synthesizer output) is snapped too.
        assert outcome.canonical.requirements[0].evidence_span == "high‑availability SOC"
        assert outcome.canonical.keywords[0].evidence_span == "high‑availability"

    async def test_synthesizer_output_is_grounding_validated(self) -> None:
        # Synthesizer fabricates a span -> ensemble re-asks then propagates.
        fabricated = _grounded_dict()
        fabricated["keywords"][0]["evidence_span"] = "Rust async runtime"  # not in JD
        with pytest.raises(Exception):  # GroundingError after retries
            await run_ensemble(
                "sys",
                JD,
                adapters=(_StubDraftAdapter("claude-opus-4-8", returns=_grounded_dict()),),
                synthesizer=_StubSynthesizer(returns=fabricated),
                synthesizer_system_prompt="synth-sys",
                max_leg_retries=1,
            )


class TestAgreement:
    async def test_single_draft_agreement_is_one(self) -> None:
        draft = JobAnalysisDraft(model_id="claude-opus-4-8", **_grounded_dict())
        agreement = compute_agreement((draft,))
        assert agreement.score == 1.0

    async def test_divergent_drafts_flag_non_unanimous_items(self) -> None:
        a = _grounded_dict()
        b = _grounded_dict()
        # b drops Kafka and adds a unique keyword -> divergence flagged.
        b["requirements"] = [b["requirements"][0]]
        b["keywords"] = [
            {"keyword": "payments", "evidence_span": "own the payments platform", "requirement_ref": "r1"}
        ]
        draft_a = JobAnalysisDraft(model_id="claude-opus-4-8", **a)
        draft_b = JobAnalysisDraft(model_id="gpt-5.4", **b)
        agreement = compute_agreement((draft_a, draft_b))
        assert 0.0 <= agreement.score < 1.0
        assert "kafka" in agreement.flagged_requirements
        assert {"go", "payments"}.issubset(set(agreement.flagged_keywords))
