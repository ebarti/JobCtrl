"""Pipeline Orchestration domain — state machine, aggregate, and ports."""

from jobctrl.domain.pipeline.state_machine import (
    StageTransition,
    TransitionResult,
    TransitionRejected,
    transition,
)
from jobctrl.domain.pipeline.aggregate import JobPipelineState, OptimisticLockError
from jobctrl.domain.pipeline.repository import PipelineStateRepository

__all__ = [
    "StageTransition",
    "TransitionResult",
    "TransitionRejected",
    "transition",
    "JobPipelineState",
    "OptimisticLockError",
    "PipelineStateRepository",
]
