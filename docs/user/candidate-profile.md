<script setup lang="ts">
import CandidateProfileFlow from "../.vitepress/theme/CandidateProfileFlow.vue";
</script>

# Candidate Profile

A Candidate Profile is JobCtrl's canonical, local record of facts about you:
your experience, education, skills, evidence, application answers, resume
baseline, and the preferences that control how those facts may be used. Scoring,
materials, and Apply consume versioned snapshots of this record; they do not
rewrite it to suit a job.

<CandidateProfileFlow />

## What You Can See And Control

Use the current web routes according to the kind of change you are making:

| Route | What it owns |
| --- | --- |
| `/profile` | Personal information, baseline resume content, experience, education, skills, achievement evidence, and voluntary EEO data. The same page renders the real editable baseline resume beside the editor. |
| `/profile/import/upload` | The start of the three-step PDF import flow. You choose whether to import profile data, resume style, or both before confirming. |
| `/preferences` | Application defaults, writing and tailoring controls, resume style, and resume-template selection and editing. |
| `/evidence-map` | A read-only map from canonical achievements and skills to their uses in scores, requirement fit, generated bullets, and coverage gaps. |
| `/discovery` | Target search and Discovery controls. These are composed near the workflow that uses them rather than treated as general profile editing. |

Profile keeps the canonical editor and the real baseline-resume preview side by
side only while both remain readable; at narrower working widths the preview
moves below the editor and the resize handle disappears. Evidence Map follows
the same rule: its entry list, selected evidence, and gaps/reusable-stories
inspector stack instead of compressing the three-pane desktop workspace.

Profile and preference forms validate before saving. Their autosave and explicit
Save buttons use the same mutation path; the exact delay and field contract are
owned by the [Profile & Settings API](../api/profile-and-settings.md), not by
this lifecycle overview.

Legal or screening attestations are never inferred. Leave an answer unknown if
you cannot attest to it; Apply fails closed on required missing profile data.
The current application-field contract and failure behavior live in
[Apply](apply.md#candidate-profile-application-fields).

## Source Of Truth And Ownership

The normalized Candidate Profile rows in `~/.jobctrl/jobctrl.db` are the sole
runtime authority. There is no second JSON-backed profile that can silently win.
The profile's main ownership boundaries are:

- **Candidate Profile owns candidate facts.** A saved experience bullet,
  declared skill, application answer, or achievement record is evidence only
  because it entered through this boundary.
- **Preferences own permission and presentation policy.** A tailoring toggle or
  writing style can constrain generation, but it cannot create a fact.
- **Settings own shared choices, not candidate evidence.** Provider/model
  policy, scoring guidance, and budget live under `/settings/**` in
  `config.json`. Credentials remain on the separate secret boundary described
  in [Configuration](configuration.md).
- **Discovery composes search and source operation.** Target roles and locations
  persist in Candidate Profile rows; source registry, runtime controls,
  schedules, quarantine, and capture state use Discovery-owned tables. Every
  value edited on `/discovery` is SQLite-backed. See [Discovery](discovery.md).
- **Materials own generated output.** A tailored resume, Apply Review draft, or
  rendered PDF does not back-write its wording into the profile. Promote a true
  new fact by editing the Profile itself.

The Evidence map is a projection over these canonical profile rows and their
downstream use. It does not create a second evidence store or infer evidence
from generated prose. Human-facing rows use evidence titles, source labels, and
bounded excerpts. Sparse storage keys remain available only from each row's
**Technical details** disclosure.

## Lifecycle

1. **Create or import.** First-run setup creates the local profile; the web
   import flow can extract a draft from a resume PDF for review.
2. **Validate and save.** The API normalizes the accepted data into profile and
   child rows, records the update, and refreshes profile reads.
3. **Snapshot for work.** A scoring, tailoring, or Apply run receives an
   immutable profile snapshot and records the relevant profile version in its
   own audit data.
4. **Generate without mutation.** Scoring writes a score; Materials writes a new
   artifact generation; Apply reads approved application fields. None changes
   the underlying profile as a side effect.
5. **Propagate deliberate edits.** A later profile save records a new version.
   For profile-content changes with eligible existing materials and a healthy
   worker, the API can start replacement tailoring in the background; the save
   still succeeds when that follow-up is not eligible or cannot be dispatched.
   Older generations remain available. A prior Apply approval becomes stale
   when its bound profile version no longer matches.

This separation is why profile correction, score correction, resume editing,
and application approval are different actions: each updates the record owned
by the context where the decision belongs.

## Implementation And API Pointers

| Layer | Pointer |
| --- | --- |
| User workflow | [Daily Workflow → Build The Candidate Profile](normal-flows.md) |
| HTTP contract | `GET/PATCH /v1/profile`, profile HTML/PDF preview routes, and `GET /v1/evidence-map`; see [Profile & Settings API](../api/profile-and-settings.md) and the [complete profile contract](../api/complete-contract.md#profile-and-preferences). |
| Web implementation | `apps/web/src/contexts/profile/`, the `/profile`, `/preferences`, and `/profile/import/*` route files, and `apps/web/src/views/evidence-map/`. |
| Domain and persistence | `workers/automation/src/jobctrl/domain/profile/` and `workers/automation/src/jobctrl/infrastructure/profile/`; normalized table ownership is summarized in [Storage](../architecture/storage.md#schema-at-a-glance). |
| Cross-context contract | `ProfileSnapshot` in the Profile domain; the aggregate and published-language boundary are documented in [Tactical Design](../architecture/domain-model/tactical.md). |
