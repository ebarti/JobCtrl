## ADDED Requirements

### Requirement: Drafts derive from approved materials
The system SHALL create a resume review draft from a selected materials generation without mutating that generation's approved artifacts in place. The draft MUST record the base job id, materials generation, resume text artifact id when present, resume PDF artifact id when present, renderer format, and current draft revision.

#### Scenario: Opening Apply Review for an editable HTML resume
- **WHEN** a user opens Apply Review for a job with an HTML/CSS rendered resume PDF
- **THEN** the system exposes an editable draft derived from the selected resume material and preserves the existing final PDF as the final-file link

#### Scenario: Draft source is versioned
- **WHEN** a draft is created from a selected materials generation
- **THEN** the draft records the base artifact ids and generation so later edits can be compared with the exact generated material the user reviewed

### Requirement: Plate editor supports live resume edits
The system SHALL allow the user to edit the resume through a Plate editor while preserving resume structure, semantic line anchors, source pins, and draft dirty state. The editor MUST keep JobHunter claim-risk and provenance labels visible for generated lines when the data exists.

#### Scenario: Editing a tailored line
- **WHEN** the user edits a tailored resume line in Apply Review
- **THEN** the system records the draft as dirty, preserves the line's available semantic anchor, and keeps the source or risk context visible for review

#### Scenario: Editing a structural line
- **WHEN** the user edits structure such as a section heading or contact line
- **THEN** the system records the edit as a draft change and distinguishes it from generated claim text that requires source provenance

### Requirement: Draft revisions persist structured edit deltas
The system SHALL persist each saved draft revision with structured edit deltas against the base material. Each delta MUST include enough safe metadata to classify the edit, including before text, after text, section or semantic id when known, line anchor when known, and draft revision id.

#### Scenario: Saving a draft revision
- **WHEN** the user saves or autosaves an edited draft
- **THEN** the system persists a new revision and stores edit deltas that can be inspected without reading unrelated local artifacts

#### Scenario: Reopening a draft
- **WHEN** the user returns to a job with an existing draft
- **THEN** the system restores the latest draft revision instead of silently discarding edits or recreating the draft from the generated material

### Requirement: Edited resumes promote through validation and rendering
The system SHALL promote an edited draft by validating the edited resume, rendering new HTML/PDF artifacts, regenerating layout boxes, and creating a new materials candidate or generation. Promotion MUST NOT hide or supersede the last accepted artifact until the replacement is approved.

#### Scenario: Promoting a valid draft
- **WHEN** a user requests approval of a valid edited resume draft
- **THEN** the system creates replacement resume artifacts with refreshed layout boxes and keeps audit history tied to both the base generation and the edited candidate

#### Scenario: Validation fails
- **WHEN** edited resume validation fails
- **THEN** the system keeps the last accepted materials visible, records the failed validation as draft history, and blocks submit approval for the edited draft

### Requirement: Apply approval respects draft state
The system SHALL prevent Apply Review approval for submit or dry run from treating an unsaved, invalid, or unrendered edited draft as approved materials.

#### Scenario: Unsaved draft blocks approval
- **WHEN** the selected Apply Review item has unsaved resume edits
- **THEN** approval controls communicate that the draft must be saved and validated before it can be used for apply approval

#### Scenario: Approved replacement is current
- **WHEN** an edited draft has been validated, rendered, and approved as replacement materials
- **THEN** Apply Review uses the replacement artifacts for readiness and final-file access
