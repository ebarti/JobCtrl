# Feature Work and Stages

These responsibilities describe the accepted target and retained product
capabilities while implementation is in progress. State names and individual
routes must be checked against the integrated feature adapters before treating
them as a delivered wire contract.

## Discovery

Discovery owns optional source search, schedules, source policy, ingestion and
recovery. Jobs owns identity, manual capture and posting/source snapshots. A
job must remain usable without Discovery or Companies. New admissions and
source checkpoints must respect run ownership, limits, cancellation, retry and
provenance; a duplicate retry must not invent a second job.

In the complete application, composition binds the existing `discovery.search`
action to Preparation's `search` recipe. Acquisition and per-job initial
assessment share the public run identity. The source owner can finish acquisition
while the action remains active through enrichment, role analysis, requirements
and Fit. Its frozen cohort contains only newly committed job IDs; it never scans
unrelated pending jobs or automatically reassesses prior scores. Coverage,
wording and resume stages are excluded. Preparation's explicit `assess` recipe
uses the same prerequisites for selected saved IDs without acquisition.
Standalone Discovery retains its acquisition-only action and reports that
preparation is unavailable. Source and assessment failures remain separate
recorded outcomes; failed replacement work preserves accepted feature artifacts.
All-source failure after accepted new jobs does not abandon their initial
assessment: Preparation consumes the exact committed acquisition outcome and
reports composite partial status while retaining failed acquisition authority.
Terminal failed/blocked job stages are immutable on same-run worker replay;
explicit retries get a new admitted identity. Action finalization seals
interrupted preparation state transactionally without touching model accounting.

## Detail Enrichment

Job capture and refresh retain the selected posting snapshot, source identity,
application URL, provenance and uncertainty. Fetching or interpreting untrusted
content does not confer permission to take an external action. Requirements
owns qualified source-bound requirement meanings and occurrences derived from
that snapshot.

## Score

Fit owns person qualification, evidence support, eligibility, scores and user
corrections. It references recorded Profile and Requirements versions. A
requirement not represented in approved resume wording can be reported as a
document gap, but cannot lower the person's factual qualification. Failed or
stale evaluation preserves the previous accepted record and reports its state.

## Tailor

Resumes composes all roles and achievements from the approved Profile baseline,
selecting exactly one approved wording per achievement by deterministic weighted
requirement coverage, complementary depth and stable ties. Profile owns wording
and approval; Fit owns coverage relations. One advisory coherence review of the
assembled document is separate from mechanical validity and user acceptance.
Baseline-copy/off mode makes zero resume model calls. The
[tailoring contract](../tailoring.md) records the detailed boundaries.

## Rendering and export

Resumes owns editing, source-bound acceptance, rendering, PDFs and locale exports.
Exports must derive from the accepted source/version and remain retrievable
through owned artifact metadata. A failed refresh, render or export cannot
destroy the last accepted artifact.

## Apply

Applications owns screening answers, exact-payload approval, assisted
execution and outcomes. Resume content and acceptance remain owned by Resumes.
Approval becomes stale when a bound input changes. Before an owned external
effect, enforce current authority and persist intent; if the result is
ambiguous, park it for verification rather than retrying into a duplicate.
Untrusted page content and the model reading it do not own final browser-submit
authority. See [apply containment](../../developer/security.md#apply-path-containment).

## Contact Research (Supervised, Off-Pipeline)

Contacts owns contact facts, provenance, import and research. Outreach owns
reviewed drafts, threads, sends/receipts and follow-up controls. Research and
generation do not authorize a message; stale approval or changed inputs must
block a send. QA uses controlled external providers and sends no real message.

## Other retained work

Companies owns optional briefings; Interviews owns preparation and independent
notes; Learning owns plans and milestones without converting activity into
capability; Digest owns summaries and acknowledgements. Compensation and Offers
separately own market evidence and actual offer decisions. Feature-specific
work may run durably without being forced through a job preparation stage.
