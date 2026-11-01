"""Extra writing is opt-in; the ordinary review pipeline is unchanged."""
from types import SimpleNamespace

import pytest

from jobctrl import config
from jobctrl.domain.materials.use_cases import TailoringLlmPolicy
from jobctrl.scoring import tailor
from tests.test_artifact_determinations import Model, connection


@pytest.mark.parametrize("saved,enabled", [(None, False), (False, False), (True, True), ("true", False), ("false", False), (1, False), ({}, False)])
def test_only_an_explicit_boolean_opt_in_enables_extra_writing(monkeypatch, saved, enabled):
    monkeypatch.setattr(config, "_config_setting", lambda key: saved if key == "resume_voice_polish" else None)
    assert config.get_resume_voice_polish_enabled() is enabled


@pytest.mark.parametrize("enabled,available,injected", [(False, True, False), (True, True, False), (True, False, False), (False, True, True)])
def test_production_factory_owns_extra_polish_admission(monkeypatch, enabled, available, injected):
    conn = connection()
    port = SimpleNamespace(model_id="codex:synthetic-model")
    calls = []
    def build_voice():
        calls.append(True)
        return port if available else None
    monkeypatch.setattr(tailor, "get_connection", lambda: conn)
    monkeypatch.setattr(config, "get_resume_voice_polish_enabled", lambda: enabled)
    monkeypatch.setattr(tailor, "_build_voice_port", build_voice)
    case = tailor._build_use_case(
        llm_port=Model(), llm_policy=TailoringLlmPolicy(),
        analyze_use_case=SimpleNamespace(), pdf_renderer=SimpleNamespace(), job_interpreter=SimpleNamespace(),
        voice=port if injected else None,
    )
    assert len(calls) == int(enabled and not injected)
    assert case._voice is (port if injected or enabled and available else None)
    assert case._voice_skip_reason == ("optional_voice_polish_disabled" if not enabled and not injected else "no_voice_port")
    conn.close()
