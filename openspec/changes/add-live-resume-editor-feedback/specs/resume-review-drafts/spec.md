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

#### Scenario: Typing remains stable
- **WHEN** the user types continuously inside an editable resume line
- **THEN** the editor keeps focus and selection across keystrokes, does not reparse the generated HTML or recreate the editor document after each character, and still updates draft dirty state from the live editor value

#### Scenario: Formatting controls are available
- **WHEN** an editable resume draft is loaded
- **THEN** the editor exposes accessible controls for bold, italic, underline, font family, font size, and left, center, and right alignment
- **AND** applying those controls updates the selected text or block without hiding source pins, risk labels, comment anchors, or final-file access

### Requirement: Editor preserves resume layout and undo history
The system SHALL preserve the resume's structural layout and native Plate undo history while the user edits and saves drafts. The editor MUST normalize imported and saved resume nodes so text-only edits do not corrupt experience-entry indentation, heading rows, bullet grouping, or page layout.

#### Scenario: Editing an experience heading preserves indentation
- **WHEN** the user edits text inside an experience entry heading such as a company or role name
- **THEN** the saved editor document preserves the entry heading layout and indentation instead of introducing extra spacer rows, malformed grid tracks, or detached heading fragments

#### Scenario: Undo restores recent editor changes
- **WHEN** the user presses Ctrl+Z or Cmd+Z after a text or formatting change in the resume editor
- **THEN** the editor restores the previous content or formatting from local history without requiring a server reload and without corrupting the surrounding resume structure

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

### Requirement: Profile baseline preview uses the current resume renderer
The system SHALL render the Profile page baseline resume preview with the same default HTML/CSS resume renderer used for generated resume materials. The legacy LaTeX renderer MAY remain available only through an explicit compatibility configuration and MUST NOT be the default profile preview path.

#### Scenario: Opening the Profile baseline preview
- **WHEN** the user opens the Profile page and the baseline resume preview loads with default configuration
- **THEN** the preview PDF is rendered through the HTML/CSS resume renderer and the toolbar identifies it as the baseline resume preview rather than an Apply Review draft

#### Scenario: Explicit legacy renderer override
- **WHEN** `JOBHUNTER_RESUME_RENDERER=latex_pdf` is configured
- **THEN** the Profile page preview may use the legacy LaTeX renderer as an explicit compatibility path while the default remains the HTML/CSS renderer
