"""Pipeline Orchestration domain — state machine, aggregate, and ports."""

from jobctl.domain.pipeline.state_machine import (
    StageTransition,
    TransitionResult,
    TransitionRejected,
    transition,
)
from jobctl.domain.pipeline.aggregate import JobPipelineState, OptimisticLockError
from jobctl.domain.pipeline.repository import PipelineStateRepository

__all__ = [
    "StageTransition",
    "TransitionResult",
    "TransitionRejected",
    "transition",
    "JobPipelineState",
    "OptimisticLockError",
    "PipelineStateRepository",
]
