"""Terminal failures through the real Claude kit, with synthetic SDK messages."""

from __future__ import annotations

import asyncio
from queue import Queue
from threading import Event, Thread, get_ident
from types import SimpleNamespace

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage
from opentelemetry.trace import StatusCode

import jobctrl.llm as accounting
from jobctrl.domain.materials.voice import VoiceRequest
from jobctrl.infrastructure.analysis import claude_analysis_adapter
from jobctrl.infrastructure.analysis.claude_analysis_adapter import ClaudeAnalysisAdapter
from jobctrl.infrastructure.llm.llm_client import ClaudeSdkBackend
from jobctrl.infrastructure.llm import llm_client
from jobctrl.infrastructure.llm.provider_availability import provider_route_available, record_provider_failure
from jobctrl.infrastructure.llm.provider_errors import ProviderCallError
from jobctrl.infrastructure.materials import voice_adapter
from jobctrl.infrastructure.materials.voice_adapter import ClaudeVoiceAdapter
from jobctrl.llm_lanes import bind_llm_lane


MODEL = "claude-synthetic"
CANARY = "synthetic-private-failed-output"
SCHEMA = {"type": "object", "properties": {"answer": {"type": "integer"}}, "required": ["answer"]}
_ROUTED_CHAT_JSON = llm_client.LlmAdapter.chat_json
_REAL_RECORD_LLM_SPEND = accounting.record_llm_spend


@pytest.fixture(autouse=True)
def isolated_sdk(monkeypatch):
    import jobctrl.infrastructure.setup_probes as setup_probes

    monkeypatch.setattr(setup_probes, "bundled_claude_sdk_options", lambda **_kwargs: {})
    monkeypatch.setattr(claude_analysis_adapter, "bundled_claude_sdk_options", lambda **_kwargs: {})
    monkeypatch.setattr(voice_adapter, "bundled_claude_sdk_options", lambda **_kwargs: {})
    monkeypatch.setattr(accounting, "enforce_spend_budget", lambda _lane=None: None)
    spend = []
    def record_spend(**values):
        spend.append({**values, "recording_thread": get_ident()})
    monkeypatch.setattr(accounting, "record_llm_spend", record_spend)
    return spend


def _result(*, subtype="error_max_turns", is_error=True, structured=None, status=None):
    return ResultMessage(
        subtype=subtype, duration_ms=1, duration_api_ms=1, is_error=is_error,
        num_turns=1, session_id="synthetic-session", result=CANARY,
        structured_output=structured, usage={"input_tokens": 11, "output_tokens": 7},
        api_error_status=status, errors=[CANARY] if is_error else None,
    )


def _query(*messages):
    def query(*, prompt, options):
        async def stream():
            for message in messages:
                yield message
        return stream()
    return query


def _query_with_post_terminal_error(message):
    def query(*, prompt, options):
        async def stream():
            yield message
            raise OSError(CANARY + "-cleanup")
        return stream()
    return query


def _query_blocked_after_terminal(message, observed, cleaning, release, *, cleanup_error=False):
    def query(*, prompt, options):
        async def stream():
            try:
                yield message
                observed.set()
                await asyncio.Event().wait()
            finally:
                cleaning.set()
                await asyncio.to_thread(release.wait, 5)
                if cleanup_error:
                    raise OSError(CANARY + "-cleanup")
        return stream()
    return query


def _options(**kwargs):
    return SimpleNamespace(**kwargs)


def _assert_failed_usage(in_memory_exporter, spend):
    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    attrs = dict(span.attributes or {})
    assert span.status.status_code == StatusCode.ERROR
    assert attrs["jobctrl.llm.success"] is False
    assert attrs["gen_ai.usage.input_tokens"] == 11
    assert attrs["gen_ai.usage.output_tokens"] == 7
    assert len(spend) == 1
    assert (spend[0]["input_tokens"], spend[0]["output_tokens"]) == (11, 7)
    assert CANARY not in repr(attrs) and CANARY not in str(span.status)


@pytest.mark.parametrize("structured", [False, True])
def test_failed_terminal_never_returns_plausible_chat_or_structured_output(
    structured, isolated_sdk, in_memory_exporter, monkeypatch,
):
    monkeypatch.setenv("JOBCTRL_TRACE_CONTENT", "1")
    backend = ClaudeSdkBackend(model=MODEL, query_fn=_query(_result(structured={"answer": 42})), options_factory=_options)
    with bind_llm_lane("tailoring"), pytest.raises(ProviderCallError) as raised:
        if structured:
            backend.chat_json([{"role": "user", "content": "synthetic"}], response_schema=SCHEMA)
        else:
            backend.chat([{"role": "user", "content": "synthetic"}])
    assert raised.value.code == "claude_max_turns"
    assert raised.value.retryable is False
    assert CANARY not in str(raised.value)
    assert not record_provider_failure("claude", MODEL, raised.value)
    assert provider_route_available("claude", MODEL)
    _assert_failed_usage(in_memory_exporter, isolated_sdk)


@pytest.mark.asyncio
@pytest.mark.parametrize("owner", ["analysis", "voice"])
async def test_failed_terminal_never_becomes_an_analysis_or_voice_result(owner, isolated_sdk, in_memory_exporter):
    if owner == "analysis":
        structured = {"role_framing": "Synthetic", "inferred_seniority": "staff",
                      "ideal_candidate_narrative": "Synthetic", "requirements": [], "keywords": []}
        adapter = ClaudeAnalysisAdapter(model=MODEL, query_fn=_query(_result(structured=structured)), options_factory=_options)
        call = adapter.draft("synthetic", "synthetic posting")
    else:
        structured = {"executive_profile": "Synthetic", "executive_profile_sentences": ["Synthetic"],
                      "experience_updates": []}
        adapter = ClaudeVoiceAdapter(model=MODEL, query_fn=_query(_result(structured=structured)), options_factory=_options)
        call = adapter.rewrite("synthetic", VoiceRequest(executive_profile="Synthetic", experience_bullets=()))
    with pytest.raises(ProviderCallError) as raised:
        await call
    assert raised.value.code == "claude_max_turns"
    assert provider_route_available("claude", MODEL)
    _assert_failed_usage(in_memory_exporter, isolated_sdk)


@pytest.mark.asyncio
@pytest.mark.parametrize("owner", ["plain", "structured", "analysis", "voice"])
async def test_budget_terminal_survives_stream_cleanup_error_with_usage(owner, isolated_sdk, in_memory_exporter):
    structured = {"answer": 42}
    if owner == "analysis":
        structured = {"role_framing": "Synthetic", "inferred_seniority": "staff",
                      "ideal_candidate_narrative": "Synthetic", "requirements": [], "keywords": []}
    elif owner == "voice":
        structured = {"executive_profile": "Synthetic", "executive_profile_sentences": ["Synthetic"],
                      "experience_updates": []}
    query = _query_with_post_terminal_error(_result(subtype="error_max_budget_usd", structured=structured))
    with bind_llm_lane("tailoring"), pytest.raises(ProviderCallError) as raised:
        if owner in {"plain", "structured"}:
            backend = ClaudeSdkBackend(model=MODEL, query_fn=query, options_factory=_options)
            if owner == "plain":
                backend.chat([{"role": "user", "content": "synthetic"}])
            else:
                backend.chat_json([{"role": "user", "content": "synthetic"}], response_schema=SCHEMA)
        elif owner == "analysis":
            await ClaudeAnalysisAdapter(model=MODEL, query_fn=query, options_factory=_options).draft("synthetic", "posting")
        else:
            await ClaudeVoiceAdapter(model=MODEL, query_fn=query, options_factory=_options).rewrite(
                "synthetic", VoiceRequest(executive_profile="Synthetic", experience_bullets=()),
            )
    assert raised.value.code == "budget_denied"
    assert raised.value.envelope.post_terminal_failure is True
    assert not record_provider_failure("claude", MODEL, raised.value)
    assert provider_route_available("claude", MODEL)
    _assert_failed_usage(in_memory_exporter, isolated_sdk)
    span = in_memory_exporter.get_finished_spans()[0]
    assert span.attributes["jobctrl.llm.failure.post_terminal_failure"] is True
    assert CANARY not in str(raised.value) + repr(raised.value.envelope.to_dict())


@pytest.mark.asyncio
@pytest.mark.parametrize("owner", ["plain", "structured", "analysis", "voice"])
@pytest.mark.parametrize("cleanup_error", [False, True])
@pytest.mark.parametrize("terminal_failed", [False, True])
async def test_cancellation_after_terminal_keeps_usage_once(owner, cleanup_error, terminal_failed, isolated_sdk, in_memory_exporter, monkeypatch, caplog):
    monkeypatch.setenv("JOBCTRL_TRACE_CONTENT", "1")
    observed, cleaning, release = Event(), Event(), Event()
    structured = {"answer": 42}
    if owner == "analysis":
        structured = {"role_framing": "Synthetic", "inferred_seniority": "staff",
                      "ideal_candidate_narrative": "Synthetic", "requirements": [], "keywords": []}
    elif owner == "voice":
        structured = {"executive_profile": "Synthetic", "executive_profile_sentences": ["Synthetic"],
                      "experience_updates": []}
    message = _result(subtype="error_max_budget_usd" if terminal_failed else "success",
                      is_error=terminal_failed, structured=structured)
    query = _query_blocked_after_terminal(message,
                                          observed, cleaning, release, cleanup_error=cleanup_error)
    if owner in {"plain", "structured"}:
        backend = ClaudeSdkBackend(model=MODEL, query_fn=query, options_factory=_options)
        call = backend._call([{"role": "user", "content": "synthetic"}],
                             response_schema=SCHEMA if owner == "structured" else None,
                             temperature=None, max_tokens=None, thinking_budget=None)
    elif owner == "analysis":
        call = ClaudeAnalysisAdapter(model=MODEL, query_fn=query, options_factory=_options).draft("synthetic", "posting")
    else:
        call = ClaudeVoiceAdapter(model=MODEL, query_fn=query, options_factory=_options).rewrite(
            "synthetic", VoiceRequest(executive_profile="Synthetic", experience_bullets=()),
        )
    with bind_llm_lane("tailoring"):
        task = asyncio.create_task(call)
        try:
            assert await asyncio.to_thread(observed.wait, 5)
            task.cancel("synthetic-cancel")
            assert await asyncio.to_thread(cleaning.wait, 5)
            assert not task.done()
            task.cancel("repeat-cancel")
            release.set()
            with pytest.raises(asyncio.CancelledError) as raised:
                await task
            assert raised.value.args == ("synthetic-cancel",)
        finally:
            release.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    assert len(isolated_sdk) == 1
    assert (isolated_sdk[0]["input_tokens"], isolated_sdk[0]["output_tokens"]) == (11, 7)
    assert isolated_sdk[0]["lane"] == ("discovery" if owner == "analysis" else "tailoring")
    assert isolated_sdk[0]["recording_thread"] == get_ident()
    spans = in_memory_exporter.get_finished_spans()
    assert len(spans) == 1
    attrs = dict(spans[0].attributes or {})
    assert (attrs["gen_ai.usage.input_tokens"], attrs["gen_ai.usage.output_tokens"]) == (11, 7)
    assert attrs.get("jobctrl.llm.success") is not True
    assert "langfuse.observation.output" not in attrs and CANARY not in repr(attrs)
    assert ("Claude cleanup failed after a terminal receipt during cancellation" in caplog.text) is cleanup_error
    assert CANARY not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("cleanup_error", [False, True])
async def test_cancellation_during_kit_runtime_close_keeps_terminal_usage(monkeypatch, isolated_sdk, cleanup_error, caplog):
    from jobctrl.infrastructure.llm.agent_runtime_claude import ClaudeAgentRuntime

    cleaning, release = Event(), Event()

    async def blocked_close(_self):
        cleaning.set()
        await asyncio.to_thread(release.wait, 5)
        if cleanup_error:
            raise OSError(CANARY + "-runtime-close")

    monkeypatch.setattr(ClaudeAgentRuntime, "aclose", blocked_close)
    backend = ClaudeSdkBackend(model=MODEL, query_fn=_query(_result(subtype="error_max_budget_usd")),
                               options_factory=_options)
    with bind_llm_lane("tailoring"):
        task = asyncio.create_task(backend._call([{"role": "user", "content": "synthetic"}],
            response_schema=None, temperature=None, max_tokens=None, thinking_budget=None))
        try:
            assert await asyncio.to_thread(cleaning.wait, 5)
            task.cancel("synthetic-cancel")
            await asyncio.sleep(0)
            assert not task.done()
            release.set()
            with pytest.raises(asyncio.CancelledError) as raised:
                await task
            assert raised.value.args == ("synthetic-cancel",)
        finally:
            release.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    assert len(isolated_sdk) == 1
    assert (isolated_sdk[0]["input_tokens"], isolated_sdk[0]["output_tokens"]) == (11, 7)
    assert isolated_sdk[0]["recording_thread"] == get_ident()
    assert ("Claude cleanup failed after a terminal receipt during cancellation" in caplog.text) is cleanup_error
    assert CANARY not in caplog.text


@pytest.mark.asyncio
async def test_terminal_observed_during_cancelled_stream_cleanup_is_accounted(isolated_sdk):
    started, late = Event(), Event()

    def query(*, prompt, options):
        async def stream():
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                yield _result(subtype="error_max_budget_usd")
                late.set()
                raise
        return stream()

    backend = ClaudeSdkBackend(model=MODEL, query_fn=query, options_factory=_options)
    with bind_llm_lane("tailoring"):
        task = asyncio.create_task(backend._call([{"role": "user", "content": "synthetic"}],
            response_schema=None, temperature=None, max_tokens=None, thinking_budget=None))
        assert await asyncio.to_thread(started.wait, 5)
        task.cancel("synthetic-cancel")
        with pytest.raises(asyncio.CancelledError) as raised:
            await task
        assert raised.value.args == ("synthetic-cancel",)
    assert late.is_set()
    assert len(isolated_sdk) == 1
    assert (isolated_sdk[0]["input_tokens"], isolated_sdk[0]["output_tokens"]) == (11, 7)


@pytest.mark.asyncio
async def test_sdk_originated_cancellation_keeps_its_exception_and_observed_usage(isolated_sdk):
    cancellation = asyncio.CancelledError("synthetic-sdk-cancel")

    def query(*, prompt, options):
        async def stream():
            yield _result(subtype="error_max_budget_usd")
            raise cancellation
        return stream()

    backend = ClaudeSdkBackend(model=MODEL, query_fn=query, options_factory=_options)
    with bind_llm_lane("tailoring"), pytest.raises(asyncio.CancelledError) as raised:
        await backend._call([{"role": "user", "content": "synthetic"}], response_schema=None,
                            temperature=None, max_tokens=None, thinking_budget=None)
    assert raised.value is cancellation
    assert len(isolated_sdk) == 1
    assert (isolated_sdk[0]["input_tokens"], isolated_sdk[0]["output_tokens"]) == (11, 7)


@pytest.mark.asyncio
async def test_cancellation_before_terminal_does_not_invent_usage(isolated_sdk):
    started = Event()

    def query(*, prompt, options):
        async def stream():
            started.set()
            await asyncio.Event().wait()
            yield _result()  # pragma: no cover
        return stream()

    backend = ClaudeSdkBackend(model=MODEL, query_fn=query, options_factory=_options)
    with bind_llm_lane("tailoring"):
        task = asyncio.create_task(backend._call([{"role": "user", "content": "synthetic"}],
            response_schema=None, temperature=None, max_tokens=None, thinking_budget=None))
        assert await asyncio.to_thread(started.wait, 5)
        task.cancel("synthetic-cancel")
        with pytest.raises(asyncio.CancelledError) as raised:
            await task
        assert raised.value.args == ("synthetic-cancel",)
    assert isolated_sdk == []


@pytest.mark.asyncio
async def test_cancellation_survives_usage_ledger_failure(monkeypatch, caplog, isolated_sdk):
    observed, cleaning, release = Event(), Event(), Event()
    query = _query_blocked_after_terminal(_result(subtype="error_max_budget_usd"), observed, cleaning, release)
    def failed_ledger(**_values):
        raise OSError(CANARY + "-ledger")
    monkeypatch.setattr(accounting, "record_llm_spend", failed_ledger)
    backend = ClaudeSdkBackend(model=MODEL, query_fn=query, options_factory=_options)
    with bind_llm_lane("tailoring"):
        task = asyncio.create_task(backend._call([{"role": "user", "content": "synthetic"}],
            response_schema=None, temperature=None, max_tokens=None, thinking_budget=None))
        try:
            assert await asyncio.to_thread(observed.wait, 5)
            task.cancel("synthetic-cancel")
            assert await asyncio.to_thread(cleaning.wait, 5)
            release.set()
            with pytest.raises(asyncio.CancelledError) as raised:
                await task
            assert raised.value.args == ("synthetic-cancel",)
        finally:
            release.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    assert "Could not record observed Claude usage after cancellation" in caplog.text
    assert CANARY not in caplog.text


@pytest.mark.asyncio
async def test_cancelled_terminal_usage_commits_once_to_synthetic_spend_ledger(tmp_path, monkeypatch, isolated_sdk):
    from jobctrl import database

    db_path = tmp_path / "spend.sqlite"
    original_init, original_get = database.init_db, database.get_connection
    original_init(db_path)
    monkeypatch.setattr(database, "init_db", lambda: None)
    monkeypatch.setattr(database, "get_connection", lambda: original_get(db_path))
    monkeypatch.setattr(accounting, "record_llm_spend", _REAL_RECORD_LLM_SPEND)
    observed, cleaning, release = Event(), Event(), Event()
    query = _query_blocked_after_terminal(_result(subtype="error_max_budget_usd"), observed, cleaning, release)
    backend = ClaudeSdkBackend(model=MODEL, query_fn=query, options_factory=_options)
    try:
        with bind_llm_lane("tailoring"):
            task = asyncio.create_task(backend._call([{"role": "user", "content": "synthetic"}],
                response_schema=None, temperature=None, max_tokens=None, thinking_budget=None))
            try:
                assert await asyncio.to_thread(observed.wait, 5)
                task.cancel("synthetic-cancel")
                assert await asyncio.to_thread(cleaning.wait, 5)
                task.cancel("repeat-cancel")
                release.set()
                with pytest.raises(asyncio.CancelledError):
                    await task
            finally:
                release.set()
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        rows = original_get(db_path).execute("SELECT lane, input_tokens, output_tokens FROM llm_spend").fetchall()
        assert [(row[0], row[1], row[2]) for row in rows] == [("tailoring", 11, 7)]
    finally:
        database.close_connection(db_path)


@pytest.mark.asyncio
async def test_cancelled_voice_refresh_keeps_previously_accepted_material(tmp_path, isolated_sdk):
    from pathlib import Path

    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
    from tests.test_materials_use_cases import JOB_ID, ResumeModel, connection, request, resume_case

    observed, cleaning, release = Event(), Event(), Event()
    owner: Queue = Queue()
    result: Queue = Queue()
    message = _result(subtype="error_max_budget_usd", structured={
        "executive_profile": CANARY, "executive_profile_sentences": [CANARY], "experience_updates": [],
    })
    query = _query_blocked_after_terminal(message, observed, cleaning, release, cleanup_error=True)

    class CapturedVoice(ClaudeVoiceAdapter):
        async def rewrite(self, system_prompt, voice_request):
            owner.put((asyncio.get_running_loop(), asyncio.current_task()))
            return await super().rewrite(system_prompt, voice_request)

    def run_refresh():
        conn = connection()
        try:
            accepted = resume_case(conn, ResumeModel()).execute(**request(tmp_path))
            artifact = accepted.materials.tailored_resume
            before = Path(artifact.path).read_bytes()
            voice = CapturedVoice(model=MODEL, query_fn=query, options_factory=_options)
            try:
                resume_case(conn, ResumeModel(), voice=voice).execute(**request(tmp_path, retailor=True))
                result.put(AssertionError("cancelled voice refresh unexpectedly completed"))
                return
            except asyncio.CancelledError as error:
                current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
                result.put((error.args, artifact.artifact_id, current.tailored_resume.artifact_id,
                            before, Path(current.tailored_resume.path).read_bytes()))
        except BaseException as error:
            result.put(error)
        finally:
            conn.close()

    worker = Thread(target=run_refresh, name="synthetic-voice-refresh")
    worker.start()
    try:
        assert await asyncio.to_thread(observed.wait, 5)
        loop, task = await asyncio.to_thread(owner.get, True, 5)
        loop.call_soon_threadsafe(task.cancel, "synthetic-cancel")
        assert await asyncio.to_thread(cleaning.wait, 5)
        release.set()
        await asyncio.to_thread(worker.join, 10)
        assert not worker.is_alive()
        outcome = result.get_nowait()
        if isinstance(outcome, BaseException):
            raise outcome
        args, accepted_id, current_id, before, after = outcome
        assert args == ("synthetic-cancel",)
        assert current_id == accepted_id and before == after
        assert len(isolated_sdk) == 1
        assert (isolated_sdk[0]["input_tokens"], isolated_sdk[0]["output_tokens"]) == (11, 7)
    finally:
        release.set()
        await asyncio.to_thread(worker.join, 10)


def test_success_terminal_with_cleanup_error_is_not_accepted(isolated_sdk, in_memory_exporter):
    query = _query_with_post_terminal_error(_result(subtype="success", is_error=False, structured={"answer": 42}))
    backend = ClaudeSdkBackend(model=MODEL, query_fn=query, options_factory=_options)
    with bind_llm_lane("tailoring"), pytest.raises(ProviderCallError) as raised:
        backend.chat_json([{"role": "user", "content": "synthetic"}], response_schema=SCHEMA)
    assert raised.value.code == "claude_post_terminal_failure"
    assert raised.value.envelope.post_terminal_failure is True
    assert not record_provider_failure("claude", MODEL, raised.value)
    _assert_failed_usage(in_memory_exporter, isolated_sdk)


def test_before_terminal_transport_error_keeps_existing_provider_failure(isolated_sdk, in_memory_exporter):
    def query(*, prompt, options):
        async def stream():
            raise OSError(CANARY + "-transport")
            yield  # pragma: no cover
        return stream()
    backend = ClaudeSdkBackend(model=MODEL, query_fn=query, options_factory=_options)
    with bind_llm_lane("tailoring"), pytest.raises(ProviderCallError) as raised:
        backend.chat([{"role": "user", "content": "synthetic"}])
    assert raised.value.code == "provider_unavailable"
    assert raised.value.envelope.post_terminal_failure is False
    assert isolated_sdk == []
    assert record_provider_failure("claude", MODEL, raised.value)
    assert not provider_route_available("claude", MODEL)
    span = in_memory_exporter.get_finished_spans()[0]
    assert span.status.status_code == StatusCode.ERROR
    assert CANARY not in repr(dict(span.attributes or {}))


def test_failed_terminal_survives_kit_runtime_close_error(monkeypatch, isolated_sdk, in_memory_exporter):
    from jobctrl.infrastructure.llm.agent_runtime_claude import ClaudeAgentRuntime

    async def failed_close(_self):
        raise OSError(CANARY + "-runtime-close")

    monkeypatch.setattr(ClaudeAgentRuntime, "aclose", failed_close)
    backend = ClaudeSdkBackend(model=MODEL, query_fn=_query(_result(subtype="error_max_budget_usd")),
                               options_factory=_options)
    with bind_llm_lane("tailoring"), pytest.raises(ProviderCallError) as raised:
        backend.chat([{"role": "user", "content": "synthetic"}])
    assert raised.value.code == "budget_denied"
    assert raised.value.envelope.post_terminal_failure is True
    assert not record_provider_failure("claude", MODEL, raised.value)
    _assert_failed_usage(in_memory_exporter, isolated_sdk)
    assert in_memory_exporter.get_finished_spans()[0].attributes["jobctrl.llm.failure.post_terminal_failure"] is True


@pytest.mark.parametrize(
    "subtype,code,available",
    [("error_during_execution", "provider_unavailable", False),
     ("error_max_structured_output_retries", "schema_validation_failed", True),
     ("error_max_turns", "claude_max_turns", True)],
)
def test_primary_terminal_classification_wins_over_cleanup_error(subtype, code, available, isolated_sdk, in_memory_exporter):
    backend = ClaudeSdkBackend(model=MODEL, query_fn=_query_with_post_terminal_error(_result(subtype=subtype)),
                               options_factory=_options)
    with bind_llm_lane("tailoring"), pytest.raises(ProviderCallError) as raised:
        backend.chat([{"role": "user", "content": "synthetic"}])
    assert raised.value.code == code
    assert raised.value.envelope.post_terminal_failure is True
    record_provider_failure("claude", MODEL, raised.value)
    assert provider_route_available("claude", MODEL) is available
    _assert_failed_usage(in_memory_exporter, isolated_sdk)


@pytest.mark.parametrize(
    "subtype,code,category,retryable,available",
    [
        ("error_during_execution", "provider_unavailable", "provider_turn", True, False),
        ("error_max_structured_output_retries", "schema_validation_failed", "provider_response", False, True),
        ("error_max_budget_usd", "budget_denied", "budget", False, True),
        (CANARY, "claude_result_failed", "provider_turn", False, True),
    ],
)
def test_terminal_failure_identity_preserves_usage_and_availability(
    subtype, code, category, retryable, available, isolated_sdk, in_memory_exporter,
):
    backend = ClaudeSdkBackend(model=MODEL, query_fn=_query(_result(subtype=subtype, structured={"answer": 42})), options_factory=_options)
    with bind_llm_lane("tailoring"), pytest.raises(ProviderCallError) as raised:
        backend.chat_json([{"role": "user", "content": "synthetic"}], response_schema=SCHEMA)
    assert (raised.value.code, raised.value.envelope.category, raised.value.retryable) == (code, category, retryable)
    record_provider_failure("claude", MODEL, raised.value)
    assert provider_route_available("claude", MODEL) is available
    _assert_failed_usage(in_memory_exporter, isolated_sdk)


def test_kit_rejects_invalid_structured_output_even_when_native_terminal_claims_success(isolated_sdk, in_memory_exporter):
    message = _result(subtype="success", is_error=False, structured={"answer": "wrong type"})
    backend = ClaudeSdkBackend(model=MODEL, query_fn=_query(message), options_factory=_options)
    with bind_llm_lane("tailoring"), pytest.raises(ProviderCallError) as raised:
        backend.chat_json([{"role": "user", "content": "synthetic"}], response_schema=SCHEMA)
    assert raised.value.code == "schema_validation_failed"
    assert provider_route_available("claude", MODEL)
    _assert_failed_usage(in_memory_exporter, isolated_sdk)


def test_kit_assistant_failure_is_not_masked_by_later_success_text(isolated_sdk, in_memory_exporter):
    assistant = AssistantMessage(content=[], model=MODEL, error="authentication_failed")
    terminal = _result(subtype="success", is_error=False)
    backend = ClaudeSdkBackend(model=MODEL, query_fn=_query(assistant, terminal), options_factory=_options)
    with bind_llm_lane("tailoring"), pytest.raises(ProviderCallError) as raised:
        backend.chat([{"role": "user", "content": "synthetic"}])
    assert raised.value.code == "unauthorized"
    _assert_failed_usage(in_memory_exporter, isolated_sdk)


@pytest.mark.parametrize(
    "subtype,status,code,availability",
    [
        ("success", 401, "claude_result_failed", False),
        ("success", 429, "claude_result_failed", True),
        ("error_max_budget_usd", 401, "budget_denied", True),
        ("error_max_structured_output_retries", 401, "schema_validation_failed", True),
    ],
)
def test_only_applicable_terminal_status_affects_provider_availability(subtype, status, code, availability, isolated_sdk):
    backend = ClaudeSdkBackend(model=MODEL, query_fn=_query(_result(subtype=subtype, status=status)), options_factory=_options)
    with bind_llm_lane("tailoring"), pytest.raises(ProviderCallError) as raised:
        backend.chat([{"role": "user", "content": "synthetic"}])
    assert raised.value.code == code
    record_provider_failure("claude", MODEL, raised.value)
    assert provider_route_available("claude", MODEL) is availability


@pytest.mark.parametrize(
    "subtype,determination_code",
    [
        ("error_during_execution", "provider_unavailable"),
        ("error_max_structured_output_retries", "schema_violation"),
        ("error_max_budget_usd", "budget_denied"),
        ("error_max_turns", "provider_non_retryable"),
    ],
)
def test_determination_owner_preserves_failure_category(subtype, determination_code, isolated_sdk):
    from jobctrl.domain.determinations import DeterminationFailure, call_model

    backend = ClaudeSdkBackend(model=MODEL, query_fn=_query(_result(subtype=subtype)), options_factory=_options)
    with pytest.raises(DeterminationFailure) as raised:
        call_model(llm=backend, messages=[{"role": "user", "content": "synthetic"}],
                   response_schema=SCHEMA, lane="tailoring", preflight=lambda: None)
    assert raised.value.code == determination_code


def test_execution_failure_rebinds_only_a_later_automatic_attempt(tmp_path, monkeypatch, isolated_sdk):
    from jobctrl.domain.ports.llm import LlmFailure, LlmMessage

    config = tmp_path / "config.json"
    config.write_text('{"preferred_models":{"claude":"model-a","codex":"model-b"}}')
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(config))
    monkeypatch.setattr("jobctrl.infrastructure.setup_probes.ready_llm_providers", lambda: ("claude", "codex"))
    calls = []

    def failing_query(*, prompt, options):
        calls.append("claude")
        return _query(_result(subtype="error_during_execution"))(prompt=prompt, options=options)

    class HealthyBackend:
        provider_id, model = "codex", "model-b"

        def chat_json(self, messages, **kwargs):
            calls.append("codex")
            return {"answer": 42}

    def make_backend(provider, model):
        if provider == "claude":
            return ClaudeSdkBackend(model=model, query_fn=failing_query, options_factory=_options)
        return HealthyBackend()

    monkeypatch.setattr(llm_client, "_make_backend", make_backend)
    monkeypatch.setattr(llm_client.LlmAdapter, "chat_json", _ROUTED_CHAT_JSON)
    llm_client.reset_llm_adapter()
    first = llm_client.get_llm_adapter()
    messages = [LlmMessage(role="user", content="synthetic")]
    with bind_llm_lane("tailoring"), pytest.raises(ProviderCallError) as raised:
        first.chat_json(messages, response_schema=SCHEMA)
    assert raised.value.code == "provider_unavailable"
    assert (first.provider_id, first.model) == ("claude", "model-a")
    second = llm_client.get_llm_adapter()
    assert (second.provider_id, second.model) == ("codex", "model-b")
    assert second.chat_json(messages, response_schema=SCHEMA) == {"answer": 42}
    with pytest.raises(LlmFailure, match="provider_unavailable"):
        second.chat_json(messages, model="claude:model-a", response_schema=SCHEMA)
    assert calls == ["claude", "codex"]


@pytest.mark.parametrize("eventually_succeeds", [False, True])
def test_determination_schema_repair_stays_bounded_through_real_kit(eventually_succeeds, isolated_sdk):
    from jobctrl.domain.determinations import DeterminationFailure
    from tests.test_semantic_determinations import Repository, call, response

    calls = []

    class SyntheticPort:
        def chat_json(self, messages, *, response_schema, **kwargs):
            calls.append(messages)
            succeeded = eventually_succeeds and len(calls) == 3
            terminal = _result(subtype="success" if succeeded else "error_max_structured_output_retries",
                               is_error=not succeeded, structured=response())
            backend = ClaudeSdkBackend(model=MODEL, query_fn=_query(terminal), options_factory=_options)
            return backend.chat_json([{"role": item.role, "content": item.content} for item in messages],
                                     response_schema=response_schema)

    repository = Repository()
    if eventually_succeeds:
        decision, envelope = call(SyntheticPort(), repository)
        assert decision.verdict == "accept"
        assert repository.rows[("synthetic", envelope.determination_id)] == envelope
    else:
        with pytest.raises(DeterminationFailure) as raised:
            call(SyntheticPort(), repository)
        assert raised.value.code == "schema_violation"
        assert repository.rows == {}
    assert len(calls) == len(isolated_sdk) == 3
    for messages in calls[1:]:
        feedback = messages[-1].content
        assert "schema_violation" in feedback
        assert CANARY not in feedback


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "subtype,code,expected_calls",
    [
        ("error_during_execution", "provider_unavailable", 1),
        ("error_max_structured_output_retries", "schema_validation_failed", 3),
        ("error_max_budget_usd", "budget_denied", 1),
    ],
)
async def test_analysis_retry_distinguishes_availability_schema_and_budget(subtype, code, expected_calls, isolated_sdk):
    from jobctrl.infrastructure.analysis.ensemble import _draft_with_retry

    calls = []

    def query(*, prompt, options):
        calls.append(True)
        return _query(_result(subtype=subtype, structured={}))(prompt=prompt, options=options)

    adapter = ClaudeAnalysisAdapter(model=MODEL, query_fn=query, options_factory=_options)
    with pytest.raises(ProviderCallError) as raised:
        await _draft_with_retry(adapter, system_prompt="synthetic", jd_snapshot="synthetic posting",
                                max_retries=2, verify_prose=lambda _draft: None)
    assert raised.value.code == code
    assert len(calls) == expected_calls
    assert len(isolated_sdk) == expected_calls


@pytest.mark.parametrize("subtype,code", [("error_max_turns", "provider_non_retryable"),
                                          ("error_max_budget_usd", "budget_denied")])
@pytest.mark.parametrize("cleanup_error", [False, True])
def test_real_resume_refresh_preserves_accepted_artifact_on_failed_terminal(tmp_path, isolated_sdk, subtype, code, cleanup_error):
    from pathlib import Path

    from jobctrl.domain.determinations import DeterminationFailure
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
    from tests.test_materials_use_cases import JOB_ID, ResumeModel, connection, request, resume_case

    conn = connection()
    accepted = resume_case(conn, ResumeModel()).execute(**request(tmp_path))
    artifact = accepted.materials.tailored_resume
    before = Path(artifact.path).read_bytes()
    synthetic = ResumeModel(text="Changed synthetic draft")
    calls = []

    class ActualClaudeBoundary:
        def chat_json(self, messages, *, response_schema, **kwargs):
            payload = synthetic.chat_json(messages, response_schema=response_schema, **kwargs)
            if response_schema["title"] != "GeneratedResumeDraft":
                return payload
            calls.append(True)
            message = _result(subtype=subtype, structured=payload)
            query = _query_with_post_terminal_error(message) if cleanup_error else _query(message)
            backend = ClaudeSdkBackend(model=MODEL, query_fn=query, options_factory=_options)
            return backend.chat_json([{"role": item.role, "content": item.content} for item in messages],
                                     response_schema=response_schema)

    with pytest.raises(DeterminationFailure) as raised:
        resume_case(conn, ActualClaudeBoundary()).execute(**request(tmp_path, retailor=True))
    assert raised.value.code == code
    current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current.tailored_resume.artifact_id == artifact.artifact_id
    assert Path(current.tailored_resume.path).read_bytes() == before
    assert calls == [True]
    assert len(isolated_sdk) == 1


@pytest.mark.parametrize(
    "subtype,reason",
    [("error_during_execution", "voice_provider_unavailable"),
     ("error_max_structured_output_retries", "voice_schema_violation"),
     ("error_max_budget_usd", "voice_budget_denied"),
     ("error_max_turns", "voice_provider_non_retryable")],
)
@pytest.mark.parametrize("cleanup_error", [False, True])
def test_failed_voice_terminal_preserves_verified_resume_candidate(tmp_path, isolated_sdk, subtype, reason, cleanup_error):
    from pathlib import Path

    from tests.test_materials_use_cases import ResumeModel, connection, request, resume_case

    candidate = {"executive_profile": CANARY, "executive_profile_sentences": [CANARY],
                 "experience_updates": [{"id": "entry", "bullets": [CANARY]}]}
    message = _result(subtype=subtype, structured=candidate)
    query = _query_with_post_terminal_error(message) if cleanup_error else _query(message)
    voice = ClaudeVoiceAdapter(model=MODEL, query_fn=query, options_factory=_options)
    outcome = resume_case(connection(), ResumeModel(), voice=voice).execute(**request(tmp_path))
    assert outcome.materials.is_resume_approved
    artifact = outcome.materials.tailored_resume
    contents = Path(artifact.path).read_text()
    assert "Synthetic draft" in contents and CANARY not in contents
    assert artifact.metadata["voice_pass"]["ran"] is True
    assert artifact.metadata["voice_pass"]["accepted"] is False
    assert artifact.metadata["voice_pass"]["reason"] == reason
    assert len(isolated_sdk) == 1
