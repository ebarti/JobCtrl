## ADDED Requirements

### Requirement: Templates are local versioned style records
The system SHALL store resume templates as local versioned records that contain style and layout data only. A template version MUST include a stable template id, version identifier, display name, structured theme data, constrained Plate layout data when present, status, timestamps, and a content hash suitable for material snapshot comparison.

#### Scenario: Saving a template creates a new version
- **WHEN** a user edits and saves an existing resume template
- **THEN** the system persists a new template version instead of mutating prior generated artifact metadata or prior template-version snapshots

#### Scenario: Template data excludes profile facts
- **WHEN** a template is previewed with the user's profile data and then saved
- **THEN** the persisted template version contains only normalized style/layout data and does not store profile facts, generated resume lines, local artifact paths, or raw job data

### Requirement: Template editing uses constrained Plate layout controls
The system SHALL provide a Plate-backed template editing surface for resume layout and styling. The editor MUST normalize saved output to a safe template schema and MUST NOT persist arbitrary executable HTML, CSS, JavaScript, or unbounded document content.

#### Scenario: Editing template style
- **WHEN** a user changes template controls such as font family, density, margins, section heading style, header layout, alignment, or section order
- **THEN** the system previews the change through the resume HTML/CSS renderer and saves only allowlisted template tokens or layout nodes

#### Scenario: Unsupported markup is rejected
- **WHEN** a template save payload contains executable markup, unsupported CSS, local filesystem references, or non-template resume content
- **THEN** the system rejects the save with validation errors and keeps the previous template version active

### Requirement: Users can choose default and per-job templates
The system SHALL let the user choose a default resume template and SHALL let the user assign a per-job template override. Effective template resolution MUST prefer the per-job override, then the default template, then the built-in default template.

#### Scenario: Default template is used
- **WHEN** a job has no per-job template override
- **THEN** material generation uses the user's current default resume template

#### Scenario: Per-job override wins
- **WHEN** a job has a per-job template override
- **THEN** material generation uses the override even if the user changes the default template

#### Scenario: Built-in default is available
- **WHEN** no user default template is configured
- **THEN** material generation uses a built-in default template that matches the current HTML/CSS renderer behavior

### Requirement: Materials snapshot effective template metadata
The system SHALL snapshot the effective template id, template version, template hash, and assignment source into each generated materials generation. The snapshot MUST be available to readiness, artifact, and Apply Review read models without reading raw template records.

#### Scenario: Generating new tailored materials
- **WHEN** the system generates a tailored resume and PDF
- **THEN** the resulting materials generation records the effective template metadata used to create the final PDF and sibling HTML

#### Scenario: Reading artifact details
- **WHEN** the user inspects a resume artifact generated from a template
- **THEN** the artifact detail can show which template version produced it and whether it still matches the current effective template

### Requirement: Template changes mark materials stale without eager regeneration
The system SHALL detect when active materials were produced from an older effective template than the job currently resolves to. The system MUST expose template-stale state without eagerly regenerating all affected jobs.

#### Scenario: Default template changes
- **WHEN** the user changes the default template
- **THEN** jobs that inherit the default template can be reported as template-stale without immediately regenerating their resume artifacts

#### Scenario: Per-job override changes
- **WHEN** the user changes or removes a per-job template override
- **THEN** that job's current resume materials can be reported as template-stale without hiding the last accepted materials

### Requirement: Stale materials lazily refresh when current materials are needed
The system SHALL lazily refresh template-stale materials when a workflow needs current resume materials. Lazy refresh MUST create a new auditable materials generation and MUST keep the previous accepted generation visible until the replacement succeeds.

#### Scenario: Opening Apply Review triggers refresh
- **WHEN** a user opens Apply Review for a job whose current accepted resume is template-stale
- **THEN** the system starts or performs a lazy refresh before creating a current review draft
- **AND** the previous accepted final file remains available while refresh is pending

#### Scenario: Apply readiness needs current materials
- **WHEN** apply readiness checks require a current resume artifact and the selected resume is template-stale
- **THEN** the system ensures the lazy refresh has succeeded before treating the resume as current for apply approval

#### Scenario: Lazy refresh fails
- **WHEN** lazy refresh validation or rendering fails
- **THEN** the system records the failed refresh attempt, reports the stale state, and preserves the previous accepted materials as the reviewable final artifact

### Requirement: Lazy refresh is render-only when possible
The system SHALL perform lazy template refresh as render-only regeneration when the last accepted resume content or document can be reused safely. Render-only refresh MUST NOT call the tailoring generator, change claim text, alter profile facts, or discard prior audit history.

#### Scenario: Reusing accepted resume content
- **WHEN** a template-stale job has a reusable accepted resume document or text source
- **THEN** lazy refresh applies the current effective template, regenerates HTML/PDF artifacts, recomputes layout boxes, and writes a new materials generation without re-tailoring the resume text

#### Scenario: Render-only refresh is unavailable
- **WHEN** the latest accepted materials cannot be safely rendered with the current template because required source data is missing or legacy-only
- **THEN** the system reports refresh as unavailable and presents an explicit migration or re-tailor action instead of silently changing content
