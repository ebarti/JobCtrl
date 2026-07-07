"""Employer-analysis infrastructure: agent-SDK adapters + ensemble (Phase 1).

The 3-SDK ensemble (Claude Agent SDK + Codex SDK + Google Antigravity/Gemini
SDK, D-03) lives behind the hexagonal ``AnalysisDraftPort`` /
``AnalysisSynthesizerPort`` ports. Each adapter lazy-imports its SDK so the
package stays importable when the optional CLIs are absent and so the test
suite can mock the SDK boundary without live auth (D-04 / no live calls in
tests).
"""

from __future__ import annotations

from jobctrl.infrastructure.analysis.antigravity_analysis_adapter import (
    AntigravityAnalysisAdapter,
)
from jobctrl.infrastructure.analysis.claude_analysis_adapter import (
    ClaudeAnalysisAdapter,
    ClaudeAnalysisSynthesizer,
)
from jobctrl.infrastructure.analysis.codex_analysis_adapter import CodexAnalysisAdapter
from jobctrl.infrastructure.analysis.ensemble import (
    compute_agreement,
    run_ensemble,
)
from jobctrl.infrastructure.analysis.prompts import (
    ANALYSIS_SYSTEM_PROMPT,
    SYNTHESIZER_SYSTEM_PROMPT,
)

__all__ = [
    "ANALYSIS_SYSTEM_PROMPT",
    "SYNTHESIZER_SYSTEM_PROMPT",
    "AntigravityAnalysisAdapter",
    "ClaudeAnalysisAdapter",
    "ClaudeAnalysisSynthesizer",
    "CodexAnalysisAdapter",
    "compute_agreement",
    "run_ensemble",
]
