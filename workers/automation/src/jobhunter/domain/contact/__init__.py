"""Contact & Outreach bounded context — domain layer.

Phase 1: the ``Contact`` root. Phase 2: the supervised ``ContactResearchTask``
root, its source-access policy (INV-3), and the research/confirm use cases.
"""

from jobhunter.domain.contact.aggregate import Contact
from jobhunter.domain.contact.outreach import (
    OutreachDraft,
    OutreachDraftKind,
    OutreachThread,
)
from jobhunter.domain.contact.outreach_gates import (
    DraftGateResults,
    OutreachClaimProvenance,
    build_outreach_evidence_corpus,
    build_outreach_judge_prompt,
    compute_outreach_claim_provenance,
    parse_outreach_judge_response,
    scan_outreach_draft,
    validate_outreach_draft,
)
from jobhunter.domain.contact.outreach_use_cases import (
    ApproveOutreachDraftUseCase,
    GenerateOutreachDraftUseCase,
    OutreachDraftInputError,
    RejectOutreachDraftUseCase,
    ReviseOutreachDraftUseCase,
)
from jobhunter.domain.contact.research import (
    CandidateStatus,
    ContactCandidate,
    ContactResearchTask,
    ResearchSourceAttempt,
    ResearchSourceOutcome,
    ResearchTaskStatus,
)
from jobhunter.domain.contact.research_services import (
    CANDIDATE_EXTRACTION_SCHEMA,
    ContactResearchService,
    ResearchRunResult,
    ResearchSourceSpec,
)
from jobhunter.domain.contact.research_use_cases import (
    ConfirmContactCandidateResult,
    ConfirmContactCandidateUseCase,
    ContactResearchInputError,
    RunContactResearchUseCase,
)
from jobhunter.domain.contact.source_policy import (
    CONTACT_RESEARCH_MANUAL_CAPTURE_MODES,
    RESEARCH_SOURCE_CATEGORIES,
    ContactResearchSourcePolicy,
    ResearchSourceCategory,
    ResearchSourceDecision,
    contact_research_source_policy,
    looks_protected,
)
from jobhunter.domain.contact.use_cases import (
    AttributeInput,
    ContactInputError,
    CreateContactUseCase,
    DeleteContactUseCase,
    ImportContactsUseCase,
    ImportResult,
    UpdateContactUseCase,
)
from jobhunter.domain.contact.value_objects import (
    CONTACT_CAPTURE_METHODS,
    CONTACT_SOURCE_KINDS,
    ContactAttribute,
    ContactFactProvenance,
    ContactLink,
    ContactRole,
    WarmIntroSignal,
)

__all__ = [
    "CANDIDATE_EXTRACTION_SCHEMA",
    "CONTACT_CAPTURE_METHODS",
    "CONTACT_RESEARCH_MANUAL_CAPTURE_MODES",
    "CONTACT_SOURCE_KINDS",
    "RESEARCH_SOURCE_CATEGORIES",
    "ApproveOutreachDraftUseCase",
    "AttributeInput",
    "CandidateStatus",
    "ConfirmContactCandidateResult",
    "ConfirmContactCandidateUseCase",
    "Contact",
    "ContactAttribute",
    "ContactCandidate",
    "ContactFactProvenance",
    "ContactInputError",
    "ContactLink",
    "ContactResearchInputError",
    "ContactResearchService",
    "ContactResearchSourcePolicy",
    "ContactResearchTask",
    "ContactRole",
    "CreateContactUseCase",
    "DeleteContactUseCase",
    "DraftGateResults",
    "GenerateOutreachDraftUseCase",
    "ImportContactsUseCase",
    "ImportResult",
    "OutreachClaimProvenance",
    "OutreachDraft",
    "OutreachDraftInputError",
    "OutreachDraftKind",
    "OutreachThread",
    "RejectOutreachDraftUseCase",
    "ReviseOutreachDraftUseCase",
    "build_outreach_evidence_corpus",
    "build_outreach_judge_prompt",
    "compute_outreach_claim_provenance",
    "parse_outreach_judge_response",
    "scan_outreach_draft",
    "validate_outreach_draft",
    "ResearchRunResult",
    "ResearchSourceAttempt",
    "ResearchSourceCategory",
    "ResearchSourceDecision",
    "ResearchSourceOutcome",
    "ResearchSourceSpec",
    "ResearchTaskStatus",
    "RunContactResearchUseCase",
    "UpdateContactUseCase",
    "WarmIntroSignal",
    "contact_research_source_policy",
    "looks_protected",
]
