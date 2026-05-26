"""JobHunter pipeline package.

The orchestrator implementation lives in ``runner.py``. This package re-exports
the historic public surface so existing callers (``cli``, ``actions``, tests)
continue to import from ``jobhunter.pipeline``. The package also hosts the
Temporal workflow definitions in ``workflow.py``.
"""

from jobhunter.pipeline.runner import (
    MAINTENANCE_STAGE_ORDER,
    PRIMARY_STAGE_ORDER,
    STAGE_META,
    STAGE_ORDER,
    SUPPORTED_STAGE_ORDER,
    _PENDING_SQL,
    _count_pending,
    _resolve_stages,
    _run_sequential,
    _run_streaming,
    _StageTracker,
    run_pipeline,
    run_single_job,
)

__all__ = [
    "MAINTENANCE_STAGE_ORDER",
    "PRIMARY_STAGE_ORDER",
    "STAGE_META",
    "STAGE_ORDER",
    "SUPPORTED_STAGE_ORDER",
    "_PENDING_SQL",
    "_count_pending",
    "_resolve_stages",
    "_run_sequential",
    "_run_streaming",
    "_StageTracker",
    "run_pipeline",
    "run_single_job",
]
