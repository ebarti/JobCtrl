## Purpose
Define requirement-led resume tailoring around evidence-backed requirement
coverage, claim policy controls, score-gated revision, and safe audit metadata.

## Requirements

### Requirement: Requirement-achievement coverage graph
The system SHALL build a requirement-achievement coverage graph before
generating tailored resume text. The graph MUST support zero-or-more
achievement coverage per requirement and zero-or-more requirement coverage per
achievement.

#### Scenario: Requirement has multiple supporting achievements
- **WHEN** a job requirement is supported by several profile achievements
- **THEN** the coverage graph records one edge per requirement-achievement pair
- **AND** each edge records the requirement id, achievement evidence id,
  coverage kind, strength, required claim policy, target terms, and rationale

#### Scenario: Requirement is uncovered
- **WHEN** no valid profile achievement supports a job requirement
- **THEN** the coverage graph records the requirement as uncovered
- **AND** the writer is prohibited from claiming that requirement unless a later
  enhancement pass is allowed by claim policy and records a reviewable claim

#### Scenario: Achievement does not cover target requirements
- **WHEN** a profile achievement has no valid edge to any target requirement
- **THEN** the graph records it as unused for requirement coverage
- **AND** the achievement may still appear in the final resume only when it is
  pinned, valuable positioning evidence, or required by profile rules

#### Scenario: Planner proposes unknown identifiers
- **WHEN** a coverage planner output references an unknown requirement id or
  unknown achievement evidence id
- **THEN** deterministic validation rejects that edge before generation

### Requirement: Target profile adapter for writing and scoring
The system SHALL adapt JobCtrl's employer analysis, requirement fit report,
job text, and profile evidence into a target-profile-style contract consumed by
the writer and scorer prompts.

#### Scenario: Target profile is built from existing analysis
- **WHEN** employer analysis and requirement fit data exist for a job
- **THEN** the target profile includes target role, seniority, must-have
  requirements, nice-to-have requirements, hard skills, ATS keywords,
  requirement weights, and source spans where available

#### Scenario: Requirement fit seeds coverage
- **WHEN** a requirement fit assessment contains evidence IDs
- **THEN** those evidence IDs seed direct or transferable coverage edges before
  any model-planned edges are accepted

#### Scenario: Missing target profile inputs
- **WHEN** required target profile inputs are stale or unavailable
- **THEN** the system regenerates or reports the missing prerequisite instead of
  running tailoring against an incomplete target

### Requirement: Evidence-first profile-row generation
The system SHALL generate an evidence-first tailored resume by mapping the
coverage graph into the existing mutable profile-row edit contract. The writer
MUST NOT emit arbitrary full-resume structure.

#### Scenario: Writer returns mutable profile edits
- **WHEN** the writer generates the first tailored candidate
- **THEN** the response contains executive profile text, experience updates
  keyed by existing experience entry IDs, and skill category updates keyed by
  existing skill category IDs
- **AND** contact data, education, section order, rendering, and final artifact
  assembly remain code-owned

#### Scenario: Generated claim mapping is present
- **WHEN** a generated summary sentence or experience bullet claims target fit
- **THEN** the response maps that generated claim to one or more coverage graph
  edges or to an explicit non-requirement reason such as pinned, positioning, or
  structure

#### Scenario: Writer attempts unsupported structure
- **WHEN** the writer returns a new experience row, new education row, contact
  field, unsupported skill, or unrecognized section
- **THEN** deterministic validation rejects the candidate

### Requirement: Required content pins are authoritative
The system SHALL preserve user-pinned required experiences, required bullets,
and required skills according to the profile tailoring rules. Requirement
coverage optimization MUST NOT silently remove pinned content.

#### Scenario: Pinned bullet does not match the job
- **WHEN** a required profile bullet has no coverage edge to any target
  requirement
- **THEN** the final resume still includes the bullet unless the user changes
  the pin
- **AND** audit metadata labels the bullet as pinned rather than requirement
  coverage

#### Scenario: Pinned content competes with fit
- **WHEN** preserving pinned content lowers the post-tailoring fit score
- **THEN** the scorer reports the trade-off without authorizing removal of the
  pinned content

### Requirement: Covered achievements are mandatory
The system SHALL include every achievement that covers one or more job
requirements in the final tailored resume. The configured maximum bullet count
per experience entry MUST NOT cause covered achievements or user-pinned
achievements to be removed.

#### Scenario: Covered achievements exceed max bullets
- **WHEN** an experience entry has more requirement-covered achievements than
  the configured maximum bullet count
- **THEN** the final resume includes all requirement-covered achievements for
  that entry
- **AND** audit metadata records that the bullet limit was exceeded for
  requirement coverage

#### Scenario: Enhancement produces covered achievements
- **WHEN** a profile enhancement pass produces one or more achievements that
  cover previously unmet requirements
- **THEN** the final resume includes those enhancement-produced covered
  achievements
- **AND** the system does not remove already selected covered achievements to
  make room under the configured bullet limit
- **AND** audit metadata labels the added achievements with their enhancement
  claim status and coverage reason

#### Scenario: User-pinned achievement competes with covered achievements
- **WHEN** an experience entry contains user-pinned achievements and additional
  achievements that cover job requirements
- **THEN** the final resume includes the user-pinned achievements under all
  circumstances
- **AND** the final resume also includes all requirement-covered achievements
  even if the entry exceeds the configured bullet maximum

#### Scenario: Optional achievements exceed max bullets
- **WHEN** optional positioning achievements remain after all user-pinned and
  requirement-covered achievements have been selected
- **THEN** the configured maximum bullet count applies only to those optional
  achievements
- **AND** optional achievements may be omitted before any user-pinned or
  requirement-covered achievement is removed

### Requirement: Claim policy controls factual expansion
The system SHALL use explicit claim policy controls to decide which claim types
are allowed and which claim types block auto-approval.

#### Scenario: Verified-only policy
- **WHEN** claim policy is verified-only
- **THEN** generated claims must trace to verified or user-confirmed profile
  evidence
- **AND** adjacent translation and draft claims are rejected before acceptance

#### Scenario: Evidence reframing policy
- **WHEN** claim policy is evidence reframing
- **THEN** the writer may rewrite source evidence in target-role language
  without adding new factual content
- **AND** generated claims remain auto-approvable only when their claim labels
  are included in the auto-approval policy

#### Scenario: Adjacent translation policy
- **WHEN** claim policy allows adjacent translation
- **THEN** the writer may bridge from adjacent profile evidence to target
  vocabulary without inventing tools, metrics, titles, credentials, or direct
  experience
- **AND** adjacent claims are review-blocking unless an explicit advanced policy
  marks adjacent translation auto-approvable

#### Scenario: Draft confirmation policy
- **WHEN** claim policy allows draft claims requiring confirmation
- **THEN** generated draft claims must be labeled as requiring confirmation
- **AND** the system blocks auto-approval until the user confirms or edits those
  claims

### Requirement: Required control model replaces overlapping Preferences controls
The system SHALL define tailoring controls by behavioral authority and migrate
existing Preferences controls into that model. Controls that do not map to real
runtime behavior MUST be removed, remapped, disabled, or hidden behind explicit
advanced configuration.

#### Scenario: Tailoring mode migration
- **WHEN** an existing profile stores the top-level Tailoring mode
- **THEN** migration uses that value only to derive explicit claim, generation,
  writing, and gate controls
- **AND** Tailoring mode is not kept as an independent runtime authority after
  migration

#### Scenario: Minor inference and adjacent drafts migrate to claim policy
- **WHEN** an existing profile stores minor inference or adjacent draft flags
- **THEN** those values are remapped into claim policy and review-gate behavior
  instead of remaining independent factual-expansion checkboxes

#### Scenario: Title reframing has no runtime support
- **WHEN** an existing profile stores permission to reframe experience titles
- **THEN** the active control surface removes or disables that control unless
  the output schema and validators support title changes
- **AND** generated titles remain empty or exactly match the source title

#### Scenario: Keyword density becomes advisory
- **WHEN** an existing profile stores keyword density
- **THEN** migration maps it to keyword emphasis or equivalent writing guidance
- **AND** keyword emphasis does not create hard deterministic blockers based on
  loose keyword counts

### Requirement: Score-gated revision and enhancement
The system SHALL run post-generation fit scoring on the assembled tailored
resume and SHALL use versioned policy thresholds to decide whether revision or
enhancement is required.

#### Scenario: Evidence-first candidate passes thresholds
- **WHEN** the evidence-first tailored resume meets the minimum fit score and
  must-have coverage thresholds
- **THEN** the system accepts the candidate if deterministic validators and
  review-gate policy pass

#### Scenario: Evidence-first candidate fails thresholds
- **WHEN** the evidence-first tailored resume falls below the minimum fit score
  or must-have coverage threshold
- **THEN** the system uses scorer prioritized fixes and uncovered requirements
  to decide whether a revision pass is useful

#### Scenario: Enhancement is allowed
- **WHEN** thresholds fail and claim policy allows adjacent or draft enhancement
- **THEN** the system runs the minimum revision pass needed to address the
  scorer's prioritized gaps
- **AND** every adjacent or draft claim is labeled in the generated claim map and
  audit metadata

#### Scenario: Enhancement is not allowed
- **WHEN** thresholds fail but claim policy forbids adjacent or draft
  enhancement
- **THEN** the system records the uncovered requirements and score-gate failure
  instead of inventing unsupported claims

#### Scenario: Thresholds are policy defaults
- **WHEN** revision gates are evaluated
- **THEN** minimum fit score, must-have coverage threshold, and max revision
  attempts come from the versioned tailoring policy
- **AND** those thresholds are visible in audit metadata without requiring
  editable Preferences controls in the initial implementation

### Requirement: Deterministic validators remain hard gates
The system SHALL keep deterministic validators as hard safety gates before a
tailored resume can become an accepted artifact. LLM scoring or judging MUST NOT
override deterministic validation failures.

#### Scenario: Unsupported metric appears
- **WHEN** generated resume text contains a metric that is not in verified
  profile metrics, achievement evidence, or baseline bullets
- **THEN** deterministic validation rejects the candidate

#### Scenario: Mandatory achievement is missing
- **WHEN** the assembled tailored resume omits a user-pinned achievement or an
  achievement with one or more valid requirement coverage edges
- **THEN** deterministic validation rejects the candidate even if the omission
  keeps the experience entry within the configured bullet maximum

#### Scenario: Invalid claim map appears
- **WHEN** generated claim mapping references a missing coverage edge,
  unsupported claim label, missing requirement, or missing evidence item
- **THEN** deterministic validation rejects the candidate

#### Scenario: Low-quality phrase signal appears
- **WHEN** stock phrase markers or keyword-emphasis warnings appear without
  fabrication, invalid structure, or unsupported claims
- **THEN** the system records a non-blocking low-quality signal instead of
  failing the candidate solely on that signal

### Requirement: Audit data explains coverage and revisions safely
The system SHALL persist and expose safe audit metadata for requirement-led
tailoring without exposing raw prompts, full profile payloads, full job text,
local artifact paths, generated PDFs, browser data, logs, or SQLite databases.

#### Scenario: Apply Review shows coverage summary
- **WHEN** a tailored resume has requirement-led audit metadata
- **THEN** Apply Review can show covered requirements, uncovered requirements,
  evidence-backed generated claims, pinned content, adjacent or draft labels,
  bullet-limit overflow reasons, and review blockers using bounded safe excerpts

#### Scenario: Revision history is inspectable
- **WHEN** the tailoring loop runs scorer-gated revision
- **THEN** audit metadata records the score before revision, the triggered
  threshold, prioritized fixes used, revision attempt count, and final score

#### Scenario: Unused achievements are visible
- **WHEN** profile achievements are not used for target requirement coverage
- **THEN** audit metadata can distinguish unused achievements from missing
  evidence and from pinned content preserved for user reasons
