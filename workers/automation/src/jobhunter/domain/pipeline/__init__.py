"""Pipeline Orchestration domain — state machine, aggregate, and ports."""

from jobhunter.domain.pipeline.state_machine import (
    StageTransition,
    TransitionResult,
    TransitionRejected,
    transition,
)
from jobhunter.domain.pipeline.aggregate import JobPipelineState, OptimisticLockError
from jobhunter.domain.pipeline.repository import PipelineStateRepository

__all__ = [
    "StageTransition",
    "TransitionResult",
    "TransitionRejected",
    "transition",
    "JobPipelineState",
    "OptimisticLockError",
    "PipelineStateRepository",
]
