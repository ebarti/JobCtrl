## ADDED Requirements

### Requirement: JobCtl comments persist as review threads
The system SHALL represent JobCtl-authored line comments as persisted review threads when the underlying audit data exists. Each thread MUST be anchored to the draft, base artifact, line or semantic id when known, source pin, risk label, and lifecycle state.

#### Scenario: Opening a line with an audit comment
- **WHEN** Apply Review displays a generated resume line with a JobCtl comment
- **THEN** the system exposes that comment as an inspectable thread tied to the line's source and risk context

#### Scenario: Comment anchor survives draft revisions
- **WHEN** the user saves a draft revision that edits a commented line
- **THEN** the comment thread remains associated with the draft history and records whether the exact line anchor still resolves

### Requirement: Users can reply to line comments
The system SHALL allow the user to reply to JobCtl line comments. Replies MUST be persisted with author, timestamp, thread id, draft revision id when known, and a bounded reply body or structured decision.

#### Scenario: User explains a disputed comment
- **WHEN** the user replies to a JobCtl comment explaining why a claim is valid
- **THEN** the reply is saved on the thread without suppressing the original risk label or source pointer

#### Scenario: User accepts a comment
- **WHEN** the user responds that a JobCtl comment is correct
- **THEN** the reply is saved as feedback and the thread lifecycle records the user's decision without modifying the approved resume artifact directly

### Requirement: Comment lifecycle is auditable
The system SHALL track comment thread lifecycle states such as open, user-replied, resolved, and superseded-by-edit. The lifecycle MUST distinguish comments used to repair a candidate from residual comments that remain after acceptance.

#### Scenario: Edit resolves a comment
- **WHEN** the user edits a line in a way that addresses a JobCtl comment
- **THEN** the system records the thread as superseded or resolved by that draft revision while keeping the prior comment visible in audit history

#### Scenario: Residual comment remains after approval
- **WHEN** an edited resume candidate is approved while a non-blocking comment remains open
- **THEN** the system labels the comment as residual review history rather than implying it was used to repair the accepted candidate

### Requirement: Replies do not leak sensitive sources
The system SHALL store and project comment replies without exposing raw profile payloads, raw job text, local artifact paths, generated PDFs, browser data, or unbounded source excerpts in broad read models or event payloads.

#### Scenario: Reply event is recorded
- **WHEN** a comment reply is saved
- **THEN** any emitted event contains safe identifiers and bounded metadata, not raw resume/profile/job source payloads
