"""Downstream arithmetic over the persisted model's typed eligibility verdict."""

from jobctrl.domain.scoring.value_objects import EligibilityAssessment


def eligibility_blocks_downstream(eligibility: EligibilityAssessment) -> bool:
    return bool(eligibility.hard_blockers) or eligibility.status == "blocked"
