"""Phase 8 (S-29): AutonomousAgentPort contract — exercised via a fake."""

from jobhunter.domain.apply.value_objects import (
    Applied,
    ApplyPrompt,
    BrowserWorkerConfig,
    Failed,
    TokenUsage,
)
from jobhunter.domain.ports.apply import (
    AgentResult,
    AutonomousAgentPort,
    BrowserSession,
)


class _FakeAgentAdapter:
    def __init__(self, *, behaviour: str = "applied"):
        self.behaviour = behaviour
        self.calls: list[dict] = []

    def submit_application(
        self,
        *,
        prompt: ApplyPrompt,
        browser: BrowserSession,
        model: str,
        dry_run: bool = False,
        timeout_seconds: int | None = None,
    ) -> AgentResult:
        self.calls.append(
            {
                "prompt_chars": prompt.char_count,
                "model": model,
                "dry_run": dry_run,
                "timeout_seconds": timeout_seconds,
                "cdp_port": browser.cdp_port,
            }
        )
        if self.behaviour == "applied":
            return AgentResult(
                submission_result=Applied(
                    applied_at="t9", verification_confidence=1.0
                ),
                token_usage=TokenUsage(input=10, output=5, cost_usd=0.001),
                duration_ms=1234,
                events=(
                    {"event_type": "Started", "occurred_at": "t1"},
                    {"event_type": "Done", "occurred_at": "t2"},
                ),
            )
        return AgentResult(
            submission_result=Failed(error=self.behaviour, retryable=True),
        )


def test_fake_agent_records_prompt_and_session_metadata():
    adapter = _FakeAgentAdapter(behaviour="applied")
    config = BrowserWorkerConfig(worker_id=0, cdp_port=9222, headless=False)
    session = BrowserSession(config=config, pid=1)
    prompt = ApplyPrompt(text="hello agent", mcp_config={})
    result = adapter.submit_application(
        prompt=prompt,
        browser=session,
        model="opus",
        dry_run=True,
        timeout_seconds=60,
    )
    assert isinstance(result, AgentResult)
    assert result.submission_result.kind == "applied"
    assert result.token_usage is not None
    assert result.token_usage.cost_usd == 0.001
    assert adapter.calls[0] == {
        "prompt_chars": 11,
        "model": "opus",
        "dry_run": True,
        "timeout_seconds": 60,
        "cdp_port": 9222,
    }


def test_autonomous_agent_port_alias_imported():
    """Same protocol-import sanity check as the BrowserPort test."""
    assert AutonomousAgentPort.__name__ == "AutonomousAgentPort"
