"""Employer-analysis infrastructure: agent-SDK adapters + ensemble (Phase 1).

The 2-SDK ensemble (Claude Agent SDK + Codex SDK; a Google/Antigravity leg is
deferred per D-03) lives behind the hexagonal ``AnalysisDraftPort`` /
``AnalysisSynthesizerPort`` ports. Each adapter lazy-imports its SDK so the
package stays importable when the optional CLIs are absent and so the test
suite can mock the SDK boundary without live auth (D-04 / no live calls in
tests).
"""

from __future__ import annotations

from jobhunter.infrastructure.analysis.claude_analysis_adapter import (
    ClaudeAnalysisAdapter,
    ClaudeAnalysisSynthesizer,
)
from jobhunter.infrastructure.analysis.codex_analysis_adapter import CodexAnalysisAdapter
from jobhunter.infrastructure.analysis.ensemble import (
    compute_agreement,
    run_ensemble,
)
from jobhunter.infrastructure.analysis.prompts import (
    ANALYSIS_SYSTEM_PROMPT,
    SYNTHESIZER_SYSTEM_PROMPT,
)

__all__ = [
    "ANALYSIS_SYSTEM_PROMPT",
    "SYNTHESIZER_SYSTEM_PROMPT",
    "ClaudeAnalysisAdapter",
    "ClaudeAnalysisSynthesizer",
    "CodexAnalysisAdapter",
    "compute_agreement",
    "run_ensemble",
]
