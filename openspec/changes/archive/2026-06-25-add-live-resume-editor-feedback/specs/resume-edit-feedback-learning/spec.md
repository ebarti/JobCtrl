## ADDED Requirements

### Requirement: Edits produce feedback signals
The system SHALL derive append-only feedback signals from saved resume edit deltas. Each feedback signal MUST reference the job id, base materials generation, draft revision, affected resume section or anchor when known, and a classification such as style preference, factual correction, claim-policy correction, keyword strategy, or provenance dispute.

#### Scenario: Style edit is classified
- **WHEN** the user rewrites a generated bullet without changing its factual claim
- **THEN** the system records a style-oriented feedback signal that can inform future writing-style guidance

#### Scenario: Factual correction is classified
- **WHEN** the user changes a claim because the generated text was unsupported or inaccurate
- **THEN** the system records a factual or claim-policy feedback signal tied to the affected source pin or missing provenance state

### Requirement: Comment replies produce feedback signals
The system SHALL derive feedback signals from user replies to JobCtl comments. A reply signal MUST preserve whether the user accepted, rejected, clarified, or requested a rewrite of the comment while retaining the original comment and audit context.

#### Scenario: User rejects a warning
- **WHEN** the user replies that a warning is not valid for the selected resume line
- **THEN** the system records a feedback signal that preserves both the user response and the original warning context for later review

#### Scenario: User requests different wording
- **WHEN** the user replies to a comment with requested wording guidance
- **THEN** the system records the guidance as feedback without immediately altering future generated materials outside the selected draft workflow

### Requirement: Learning is reviewable before policy mutation
The system SHALL keep feedback signals append-only and reviewable before applying them to durable profile data, tailoring policy, or prompt controls. The system MUST NOT silently rewrite the user's profile or global tailoring policy from an edit or reply.

#### Scenario: Feedback awaits review
- **WHEN** feedback is extracted from edits or replies
- **THEN** the system stores it as a learning candidate or signal that can be reviewed before profile or policy mutation

#### Scenario: Future tailoring uses accepted learning
- **WHEN** a feedback signal has been accepted into writing-style or tailoring policy guidance
- **THEN** future tailoring can consume the accepted guidance while preserving the feedback source in audit history

### Requirement: Machine learning adaptation is deferred
The system SHALL treat feedback extraction as capture of reviewable structured signals only for this change. The system MUST NOT train models, fine-tune models, update model weights, change model routing, automatically mutate prompts, or automatically alter profile data or tailoring policy based on feedback signals.

#### Scenario: Feedback extraction does not trigger model adaptation
- **WHEN** feedback is extracted from saved edit deltas or comment replies
- **THEN** the system stores the feedback for review without triggering model training, fine-tuning, model-routing changes, automatic prompt updates, or automatic policy/profile mutation

#### Scenario: Feedback tags remain deterministic or manual
- **WHEN** the system assigns a feedback signal kind in this change
- **THEN** the assignment uses deterministic rules or explicit user/reviewer input rather than machine-learning inference

### Requirement: Feedback data is safe to project
The system SHALL expose feedback summaries using bounded excerpts and safe identifiers. Feedback projections MUST NOT include raw generator prompts, raw profile payloads, raw job text, local artifact paths, generated PDFs, browser profiles, logs, or SQLite database contents.

#### Scenario: Feedback appears in audit history
- **WHEN** a job audit timeline references resume-edit feedback
- **THEN** the timeline shows safe summary metadata and omits sensitive raw payloads
