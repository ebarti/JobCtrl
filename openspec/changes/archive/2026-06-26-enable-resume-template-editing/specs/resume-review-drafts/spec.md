## MODIFIED Requirements

### Requirement: Drafts derive from approved materials
The system SHALL create a resume review draft from a selected materials generation without mutating that generation's approved artifacts in place. Before creating a new current draft, the system MUST resolve template-stale materials through the lazy template refresh flow when possible. The draft MUST record the base job id, materials generation, resume text artifact id when present, resume PDF artifact id when present, renderer format, effective template metadata when available, and current draft revision.

#### Scenario: Opening Apply Review for an editable HTML resume
- **WHEN** a user opens Apply Review for a job with an HTML/CSS rendered resume PDF that is current for the effective template
- **THEN** the system exposes an editable draft derived from the selected resume material and preserves the existing final PDF as the final-file link

#### Scenario: Draft source is versioned
- **WHEN** a draft is created from a selected materials generation
- **THEN** the draft records the base artifact ids, generation, renderer format, and effective template metadata so later edits can be compared with the exact generated material the user reviewed

#### Scenario: Template-stale material refreshes before draft creation
- **WHEN** a user opens Apply Review for a job whose latest accepted resume is stale relative to the effective template
- **THEN** the system starts or performs lazy template refresh before creating a new current draft
- **AND** the new draft is based on the refreshed materials generation after that generation succeeds

#### Scenario: Template refresh fails before draft creation
- **WHEN** lazy template refresh fails while opening Apply Review
- **THEN** the system keeps the previous accepted final PDF available, reports the refresh failure or stale state, and does not create a new draft that pretends the stale generation is current

#### Scenario: Existing draft remains tied to its base generation
- **WHEN** a job has an existing draft for an older generation and a template refresh creates a newer generation
- **THEN** the existing draft remains inspectable as history and the current Apply Review draft is created from, or explicitly carried forward to, the refreshed generation
