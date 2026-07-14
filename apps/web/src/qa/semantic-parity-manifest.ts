import type { FileRoutesByFullPath } from "../routeTree.gen.js";

/**
 * The redesign may change composition, but these facts may not disappear. Keep
 * this inventory alongside the route tree so a new route or a removed semantic
 * category is a deliberate, reviewed change rather than a visual regression.
 */
type NonEmpty<T> = readonly [T, ...T[]];
type RouterRoutePath = keyof FileRoutesByFullPath;

export const NON_SURFACE_ROUTE_PATHS = [
  "/",
  "/spikes/table-filters",
] as const satisfies readonly RouterRoutePath[];

export type ProductionSurfaceRoutePath = Exclude<
  RouterRoutePath,
  (typeof NON_SURFACE_ROUTE_PATHS)[number]
>;

export const PRODUCTION_SURFACE_ROUTE_PATHS = [
  "/activity/$eventId",
  "/analytics",
  "/apply-review",
  "/artifacts",
  "/artifacts/",
  "/artifacts/$artifactId",
  "/dashboard",
  "/debug",
  "/discovery",
  "/evidence-map",
  "/jobs",
  "/jobs/",
  "/jobs/$jobId",
  "/jobs/$jobId/run/$runId",
  "/outreach",
  "/outreach/",
  "/outreach/$contactId",
  "/pipelines",
  "/preferences",
  "/profile",
  "/profile/",
  "/profile/import",
  "/profile/import/confirm",
  "/profile/import/preview",
  "/profile/import/upload",
  "/runs",
  "/runs/",
  "/runs/$runId",
  "/settings",
  "/settings/",
  "/settings/browser",
  "/settings/credentials",
  "/settings/models",
] as const satisfies readonly ProductionSurfaceRoutePath[];

type Exact<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
    ? true
    : false
  : false;
type Assert<T extends true> = T;

// `routeTree.gen.ts` is the source of truth. A new rendered route must be
// added to the manifest inventory before the web typecheck can pass.
export type ProductionSurfaceRoutesMatchRouter = Assert<
  Exact<ProductionSurfaceRoutePath, (typeof PRODUCTION_SURFACE_ROUTE_PATHS)[number]>
>;

export type SemanticCategory =
  | "visibleData"
  | "controls"
  | "unavailableStates"
  | "auditProvenance";

export type SemanticLocationKind =
  | "persistent-shell"
  | "primary-workspace"
  | "tool-row"
  | "tab"
  | "disclosure"
  | "inspector"
  | "detail-route"
  | "wizard-step";

export interface SemanticLocation {
  readonly kind: SemanticLocationKind;
  readonly label: string;
  readonly keyboardReachable: true;
}

export interface SemanticParityProof {
  /** The canonical production-shaped fixture used by a future rendered check. */
  readonly fixture: string;
  /** Concrete values from that fixture; never a generic "data is shown" claim. */
  readonly values: NonEmpty<string>;
  readonly roles: NonEmpty<string>;
  readonly labels: NonEmpty<string>;
  readonly statusDiscriminants: NonEmpty<string>;
}

interface SharedSurface {
  readonly id: string;
  readonly title: string;
  /** Existing route and component modules that own this surface today. */
  readonly owners: {
    readonly routeModules: NonEmpty<string>;
    readonly components: NonEmpty<string>;
  };
  readonly categories: Readonly<Record<SemanticCategory, NonEmpty<string>>>;
  readonly locations: NonEmpty<SemanticLocation>;
  readonly proof: SemanticParityProof;
}

export interface GlobalSemanticParitySurface extends SharedSurface {
  readonly kind: "global";
  readonly routes: readonly [];
}

export interface RouteSemanticParitySurface extends SharedSurface {
  readonly kind: "route";
  readonly routes: NonEmpty<ProductionSurfaceRoutePath>;
}

export type SemanticParitySurface =
  | GlobalSemanticParitySurface
  | RouteSemanticParitySurface;

export const SEMANTIC_PARITY_MANIFEST = [
  {
    id: "global-shell",
    kind: "global",
    title: "Global shell",
    routes: [],
    owners: {
      routeModules: ["src/routes/__root.tsx"],
      components: ["src/shared/layout/SideRail.tsx", "src/shared/layout/Topbar.tsx"],
    },
    categories: {
      visibleData: ["14 labelled destinations", "connection state", "local-mode privacy notice", "runtime and spend facts"],
      controls: ["global search", "density selector", "theme control", "demo guide and receipt controls"],
      unavailableStates: ["offline connection", "stale runtime", "absent demo notices"],
      auditProvenance: ["local-first mode", "runtime source", "LLM spend basis"],
    },
    locations: [
      { kind: "persistent-shell", label: "grouped side rail", keyboardReachable: true },
      { kind: "persistent-shell", label: "slim top bar", keyboardReachable: true },
    ],
    proof: {
      fixture: "shell-health fixture",
      values: ["Dashboard", "Jobs", "Preferences", "Local mode"],
      roles: ["navigation", "searchbox", "button"],
      labels: ["Primary navigation", "Filter jobs, errors, companies", "Theme"],
      statusDiscriminants: ["live", "stale", "offline"],
    },
  },
  {
    id: "dashboard",
    kind: "route",
    title: "Dashboard",
    routes: ["/dashboard"],
    owners: { routeModules: ["src/routes/dashboard.tsx"], components: ["src/views/dashboard/DashboardView.tsx"] },
    categories: {
      visibleData: ["KPI values", "funnel", "digest", "source health", "workflow and apply runs", "conversion and outcome facts"],
      controls: ["digest links", "run links", "source and workflow handoffs"],
      unavailableStates: ["summary loading", "digest unavailable", "empty activity", "source health error"],
      auditProvenance: ["outcome totals", "source health observations", "workflow run timestamps"],
    },
    locations: [{ kind: "primary-workspace", label: "operational ledger", keyboardReachable: true }],
    proof: {
      fixture: "dashboard operations fixture",
      values: ["8 discovered jobs", "6 replies", "1 offer", "Greenhouse"],
      roles: ["heading", "link", "list"],
      labels: ["Application funnel", "Active workflow runs", "Source health"],
      statusDiscriminants: ["loading", "empty", "error", "healthy"],
    },
  },
  {
    id: "analytics",
    kind: "route",
    title: "Analytics",
    routes: ["/analytics"],
    owners: { routeModules: ["src/routes/analytics.tsx"], components: ["src/views/analytics/AnalyticsView.tsx"] },
    categories: {
      visibleData: ["outcome counts", "rates", "confidence and sample warnings", "dimension group rows", "totals"],
      controls: ["date window", "outcome dimension selector"],
      unavailableStates: ["loading analytics", "no outcomes", "analytics request error"],
      auditProvenance: ["window basis", "sample size", "suppressed rate reason"],
    },
    locations: [{ kind: "primary-workspace", label: "comparative outcome table", keyboardReachable: true }],
    proof: {
      fixture: "outcome analytics fixture",
      values: ["Greenhouse", "LinkedIn", "6 replies", "3 interviews"],
      roles: ["combobox", "table", "columnheader"],
      labels: ["Outcome analytics dimension", "Application outcome rates"],
      statusDiscriminants: ["loading", "empty", "error", "suppressed"],
    },
  },
  {
    id: "jobs-list",
    kind: "route",
    title: "Jobs list",
    routes: ["/jobs", "/jobs/"],
    owners: { routeModules: ["src/routes/jobs.tsx", "src/routes/jobs.index.tsx"], components: ["src/views/jobs/JobsView.tsx", "src/views/jobs/JobsTable.tsx"] },
    categories: {
      visibleData: ["all job columns", "stage and state badges", "apply state", "totals", "saved views"],
      controls: ["query", "stage", "state", "apply status", "deleted scope", "sort", "direction", "page", "page size", "bulk actions"],
      unavailableStates: ["loading jobs", "no matching jobs", "list error", "empty selection"],
      auditProvenance: ["discovered timestamp", "source", "score and apply state basis"],
    },
    locations: [
      { kind: "tool-row", label: "URL-backed jobs filters", keyboardReachable: true },
      { kind: "primary-workspace", label: "filterable jobs data grid", keyboardReachable: true },
    ],
    proof: {
      fixture: "job list fixture",
      values: ["Staff Platform Engineer", "Northstar", "discovered", "85%"],
      roles: ["searchbox", "combobox", "table", "checkbox"],
      labels: ["Filter jobs", "Stage", "Apply status", "Select all rows"],
      statusDiscriminants: ["loading", "empty", "error", "selected", "deleted"],
    },
  },
  {
    id: "job-detail",
    kind: "route",
    title: "Job detail",
    routes: ["/jobs/$jobId"],
    owners: { routeModules: ["src/routes/jobs.$jobId.tsx"], components: ["src/views/jobs/JobDetailDrawer.tsx", "src/views/jobs/JobAuditTriage.tsx"] },
    categories: {
      visibleData: ["identity, employer, location, source, timestamps", "stage, score, apply and materials state", "compensation and description", "requirements, evidence, employer analysis", "materials and accepted-artifact history"],
      controls: ["stage actions", "material actions", "related run links", "audit triage actions"],
      unavailableStates: ["job loading", "job not found", "description unavailable", "blocked material actions"],
      auditProvenance: ["source and timestamp", "score rationale", "requirement evidence", "warnings and blockers", "accepted artifact history"],
    },
    locations: [
      { kind: "detail-route", label: "job header ledger", keyboardReachable: true },
      { kind: "tab", label: "job detail panels", keyboardReachable: true },
      { kind: "inspector", label: "audit triage", keyboardReachable: true },
    ],
    proof: {
      fixture: "job detail fixture",
      values: ["Staff Platform Engineer", "Barcelona", "EUR 105000", "Score rationale"],
      roles: ["heading", "tablist", "button", "link"],
      labels: ["Job summary", "Apply readiness", "Job audit triage"],
      statusDiscriminants: ["loading", "not-found", "scored", "blocked", "accepted"],
    },
  },
  {
    id: "job-run-timeline",
    kind: "route",
    title: "Job run timeline",
    routes: ["/jobs/$jobId/run/$runId"],
    owners: { routeModules: ["src/routes/jobs.$jobId.run.$runId.tsx"], components: ["src/contexts/apply/components/ApplyRunTimeline.tsx"] },
    categories: {
      visibleData: ["run identity", "job relationship", "stage events", "timestamps", "retries", "error details"],
      controls: ["back to job", "summary and timeline tabs"],
      unavailableStates: ["run loading", "run unavailable", "no stage events", "failed stage"],
      auditProvenance: ["workflow id", "run id", "event timestamps", "retry attempt"],
    },
    locations: [{ kind: "detail-route", label: "job run workspace", keyboardReachable: true }],
    proof: {
      fixture: "apply run timeline fixture",
      values: ["run-001", "score job", "attempt 2", "activity_error"],
      roles: ["heading", "tab", "link", "list"],
      labels: ["Run timeline", "Back to job", "Run status"],
      statusDiscriminants: ["queued", "running", "succeeded", "failed", "retrying"],
    },
  },
  {
    id: "apply-review",
    kind: "route",
    title: "Apply review",
    routes: ["/apply-review"],
    owners: { routeModules: ["src/routes/apply-review.tsx"], components: ["src/views/apply-review/ApplyReviewView.tsx"] },
    categories: {
      visibleData: ["queue and selected job", "compensation and score basis", "requirement evidence", "tailoring coverage", "accepted and current artifacts", "resume, cover letter and email", "judge and persona audit"],
      controls: ["approve", "defer", "decline", "stop", "reset", "artifact comparison", "resume comments"],
      unavailableStates: ["empty queue", "job post unavailable", "no accepted artifact", "cover letter unavailable", "approval blocked"],
      auditProvenance: ["grounding and fabrication results", "bullet provenance", "warning lifecycle", "revision and persona responses", "dry-run evidence"],
    },
    locations: [
      { kind: "primary-workspace", label: "review queue and workspace", keyboardReachable: true },
      { kind: "tab", label: "evidence and material panels", keyboardReachable: true },
      { kind: "inspector", label: "requirement-led tailoring audit", keyboardReachable: true },
    ],
    proof: {
      fixture: "apply review canonical fixture",
      values: ["Minimum score 8", "Evidence rules remain enforced", "accepted resume", "dry run"],
      roles: ["listbox", "button", "tablist", "textbox"],
      labels: ["Application review workspace", "Requirement-led tailoring audit", "Resume audit"],
      statusDiscriminants: ["empty", "blocked", "draft", "accepted", "approval-ready"],
    },
  },
  {
    id: "pipelines",
    kind: "route",
    title: "Pipelines",
    routes: ["/pipelines"],
    owners: { routeModules: ["src/routes/pipelines.tsx"], components: ["src/views/pipelines/PipelinesView.tsx"] },
    categories: {
      visibleData: ["pipeline and stage status", "progress", "worker capacity", "task queues", "current and historical outcomes"],
      controls: ["run stage", "retry", "stop", "concurrency", "source and dry-run controls"],
      unavailableStates: ["telemetry unavailable", "stale worker", "empty scoped outcomes", "unsupported queue observation"],
      auditProvenance: ["workflow and Temporal run ids", "observation time", "capacity reason", "activity attempt"],
    },
    locations: [
      { kind: "primary-workspace", label: "operational stage ledger", keyboardReachable: true },
      { kind: "disclosure", label: "execution and cohort diagnostics", keyboardReachable: true },
      { kind: "inspector", label: "execution inspector", keyboardReachable: true },
    ],
    proof: {
      fixture: "pipeline operations fixture",
      values: ["Current execution", "3/3", "9 total", "activity-opaque-17"],
      roles: ["tab", "table", "button", "checkbox"],
      labels: ["Pipeline actions", "Worker capacity", "Task queue telemetry"],
      statusDiscriminants: ["calibrating", "paused", "stale", "unavailable", "succeeded"],
    },
  },
  {
    id: "discovery",
    kind: "route",
    title: "Discovery",
    routes: ["/discovery"],
    owners: { routeModules: ["src/routes/discovery.tsx"], components: ["src/views/discovery/DiscoveryView.tsx"] },
    categories: {
      visibleData: ["target-search preferences", "sources and source health", "schedules", "crawl policy", "runtime diagnostics"],
      controls: ["manual capture", "source actions", "automation and runtime controls"],
      unavailableStates: ["source quarantined", "runtime unavailable", "manual capture error", "empty source list"],
      auditProvenance: ["source health observation", "schedule", "crawl-policy reason", "capture diagnostic"],
    },
    locations: [
      { kind: "primary-workspace", label: "target and source sections", keyboardReachable: true },
      { kind: "disclosure", label: "runtime diagnostics", keyboardReachable: true },
    ],
    proof: {
      fixture: "discovery source fixture",
      values: ["Northstar", "Orbit", "quarantined", "schedule"],
      roles: ["heading", "button", "switch", "table"],
      labels: ["Discovery sources", "Manual capture", "Discovery runtime"],
      statusDiscriminants: ["healthy", "quarantined", "unavailable", "error"],
    },
  },
  {
    id: "artifacts-list",
    kind: "route",
    title: "Artifacts list",
    routes: ["/artifacts", "/artifacts/"],
    owners: { routeModules: ["src/routes/artifacts.tsx", "src/routes/artifacts.index.tsx"], components: ["src/views/artifacts/ArtifactsView.tsx"] },
    categories: {
      visibleData: ["type", "version", "status", "job", "company", "created time", "local path", "size"],
      controls: ["search", "filter", "sort", "page controls", "open artifact", "related job"],
      unavailableStates: ["loading artifacts", "no matching artifacts", "list error", "unavailable file"],
      auditProvenance: ["artifact id", "generation time", "local path", "related job"],
    },
    locations: [
      { kind: "tool-row", label: "artifact filters", keyboardReachable: true },
      { kind: "primary-workspace", label: "artifact data grid", keyboardReachable: true },
    ],
    proof: {
      fixture: "artifact list fixture",
      values: ["resume", "v2", "accepted", "tailored-resume.pdf"],
      roles: ["searchbox", "combobox", "table", "link"],
      labels: ["Filter artifacts", "Artifact status", "Open artifact"],
      statusDiscriminants: ["loading", "empty", "error", "accepted", "unavailable"],
    },
  },
  {
    id: "artifact-detail",
    kind: "route",
    title: "Artifact detail",
    routes: ["/artifacts/$artifactId"],
    owners: { routeModules: ["src/routes/artifacts.$artifactId.tsx"], components: ["src/views/artifacts/ArtifactDetailPanel.tsx"] },
    categories: {
      visibleData: ["status and id", "job and local path", "size and created time", "preview", "tailoring explanation", "annotations and coverage", "comparison delta"],
      controls: ["open preview", "open related job", "comparison controls"],
      unavailableStates: ["artifact loading", "preview unavailable", "artifact not found", "missing comparison baseline"],
      auditProvenance: ["keyword and evidence coverage", "bullet provenance", "safety and warning lifecycle", "judge prompts and responses", "generation models"],
    },
    locations: [
      { kind: "detail-route", label: "artifact workspace", keyboardReachable: true },
      { kind: "inspector", label: "artifact audit inspector", keyboardReachable: true },
    ],
    proof: {
      fixture: "artifact detail fixture",
      values: ["artifact-001", "resume.pdf", "keyword coverage", "generation model"],
      roles: ["heading", "button", "tablist", "document"],
      labels: ["Artifact details", "Artifact preview", "Tailoring explanation"],
      statusDiscriminants: ["loading", "not-found", "preview-unavailable", "accepted", "warning"],
    },
  },
  {
    id: "evidence-map",
    kind: "route",
    title: "Evidence map",
    routes: ["/evidence-map"],
    owners: { routeModules: ["src/routes/evidence-map.tsx"], components: ["src/views/evidence-map/EvidenceMapView.tsx"] },
    categories: {
      visibleData: ["evidence entries", "canonical story", "source pin", "skills", "freshness", "requirement and artifact uses", "evidence gaps"],
      controls: ["search", "filters", "open linked artifact", "open linked job"],
      unavailableStates: ["loading evidence", "no entries", "search error", "no linked uses"],
      auditProvenance: ["source pin", "freshness", "artifact use", "requirement use"],
    },
    locations: [
      { kind: "primary-workspace", label: "career evidence workspace", keyboardReachable: true },
      { kind: "inspector", label: "evidence detail", keyboardReachable: true },
    ],
    proof: {
      fixture: "evidence map fixture",
      values: ["Reusable story", "Story metrics", "resume bullet", "requirement fit"],
      roles: ["searchbox", "list", "heading", "link"],
      labels: ["Career evidence workspace", "Evidence entries", "Evidence map search"],
      statusDiscriminants: ["loading", "empty", "error", "fresh", "stale"],
    },
  },
  {
    id: "contacts-list",
    kind: "route",
    title: "Contacts",
    routes: ["/outreach", "/outreach/"],
    owners: { routeModules: ["src/routes/outreach.tsx", "src/routes/outreach.index.tsx"], components: ["src/views/outreach/OutreachView.tsx"] },
    categories: {
      visibleData: ["contact, employer and role", "relationship", "follow-up state", "research tasks", "draft and send counts"],
      controls: ["search and filters", "import contact", "create contact", "due follow-up actions"],
      unavailableStates: ["loading contacts", "no matches", "list error", "no due follow-ups"],
      auditProvenance: ["contact source", "research provenance", "user-attested send summary"],
    },
    locations: [
      { kind: "tool-row", label: "contact filters and actions", keyboardReachable: true },
      { kind: "primary-workspace", label: "contacts data grid", keyboardReachable: true },
    ],
    proof: {
      fixture: "outreach contact fixture",
      values: ["Alex Morgan", "Q&A Systems", "follow-up due", "public web page"],
      roles: ["searchbox", "table", "button", "link"],
      labels: ["Contacts", "Import contacts", "Create contact"],
      statusDiscriminants: ["loading", "empty", "error", "due", "dismissed"],
    },
  },
  {
    id: "contact-detail",
    kind: "route",
    title: "Contact detail",
    routes: ["/outreach/$contactId"],
    owners: { routeModules: ["src/routes/outreach.$contactId.tsx"], components: ["src/views/outreach/OutreachDetailDrawer.tsx"] },
    categories: {
      visibleData: ["detail thread", "draft generations and revisions", "approval and rejection", "send log", "follow-up schedule", "research tasks"],
      controls: ["generate", "revise", "approve", "reject", "log send", "schedule and dismiss follow-up"],
      unavailableStates: ["loading contact", "not found", "no draft", "send log unavailable"],
      auditProvenance: ["contact attributes", "research source", "draft gate result", "user-attested send log"],
    },
    locations: [
      { kind: "detail-route", label: "contact workspace", keyboardReachable: true },
      { kind: "tab", label: "outreach and provenance panels", keyboardReachable: true },
    ],
    proof: {
      fixture: "outreach thread fixture",
      values: ["approved draft", "revision 2", "send log", "public_web_page"],
      roles: ["heading", "tab", "button", "form"],
      labels: ["Contact details", "Contact detail panels", "Facts and provenance"],
      statusDiscriminants: ["loading", "not-found", "draft", "approved", "rejected", "sent"],
    },
  },
  {
    id: "runs-list",
    kind: "route",
    title: "Runs",
    routes: ["/runs", "/runs/"],
    owners: { routeModules: ["src/routes/runs.tsx", "src/routes/runs.index.tsx"], components: ["src/views/runs/RunsView.tsx"] },
    categories: {
      visibleData: ["workflow and run identity", "type", "status", "start, update and end", "progress", "errors"],
      controls: ["filters", "pagination", "cancel", "open related record"],
      unavailableStates: ["loading runs", "no workflow runs", "list error", "cancel unavailable"],
      auditProvenance: ["workflow id", "run id", "timestamps", "error code"],
    },
    locations: [
      { kind: "tool-row", label: "run filters", keyboardReachable: true },
      { kind: "primary-workspace", label: "workflow run grid", keyboardReachable: true },
    ],
    proof: {
      fixture: "workflow run list fixture",
      values: ["discover", "run-001", "in progress", "activity_error"],
      roles: ["combobox", "table", "button", "link"],
      labels: ["Workflow runs", "Run status", "Cancel workflow run"],
      statusDiscriminants: ["loading", "empty", "error", "running", "failed", "cancelled"],
    },
  },
  {
    id: "run-detail",
    kind: "route",
    title: "Run detail",
    routes: ["/runs/$runId"],
    owners: { routeModules: ["src/routes/runs.$runId.tsx"], components: ["src/views/runs/WorkflowRunDrawer.tsx"] },
    categories: {
      visibleData: ["run identity", "workflow type", "status", "timeline", "progress", "diagnostics and errors", "related records"],
      controls: ["back to runs", "summary", "timeline", "diagnostics", "related links"],
      unavailableStates: ["loading run", "run unavailable", "no diagnostics", "missing related record"],
      auditProvenance: ["run id", "workflow id", "event timestamps", "error code and message"],
    },
    locations: [
      { kind: "detail-route", label: "workflow run workspace", keyboardReachable: true },
      { kind: "tab", label: "workflow run detail panels", keyboardReachable: true },
    ],
    proof: {
      fixture: "workflow run detail fixture",
      values: ["run-001", "activity_error", "Summary", "Diagnostics"],
      roles: ["heading", "tablist", "link", "list"],
      labels: ["Workflow run details", "Workflow run detail panels", "Back to workflow runs"],
      statusDiscriminants: ["loading", "not-found", "running", "failed", "succeeded"],
    },
  },
  {
    id: "debug",
    kind: "route",
    title: "Debug activity",
    routes: ["/debug"],
    owners: { routeModules: ["src/routes/debug.tsx"], components: ["src/views/debug/DebugView.tsx"] },
    categories: {
      visibleData: ["time", "event", "level", "stage", "job and run references", "payload summary"],
      controls: ["query", "level", "stage", "event type", "sort", "pagination", "open event"],
      unavailableStates: ["loading activity", "no matching events", "activity error"],
      auditProvenance: ["event id", "payload", "job handoff", "run reference"],
    },
    locations: [
      { kind: "tool-row", label: "debug filters", keyboardReachable: true },
      { kind: "primary-workspace", label: "debug activity grid", keyboardReachable: true },
    ],
    proof: {
      fixture: "debug activity fixture",
      values: ["error", "score_job", "job-001", "run-001"],
      roles: ["searchbox", "combobox", "table", "link"],
      labels: ["Activity search", "Activity stage", "Activity event type"],
      statusDiscriminants: ["loading", "empty", "error", "info", "warning"],
    },
  },
  {
    id: "activity-detail",
    kind: "route",
    title: "Activity detail",
    routes: ["/activity/$eventId"],
    owners: { routeModules: ["src/routes/activity.$eventId.tsx"], components: ["src/views/debug/ActivityDetailDrawer.tsx"] },
    categories: {
      visibleData: ["time", "event", "level", "stage", "job and run references", "payload", "timeline"],
      controls: ["back to debug", "payload and timeline tabs", "job handoff"],
      unavailableStates: ["loading event", "event unavailable", "payload absent", "direct detail disabled redirect"],
      auditProvenance: ["event id", "projected payload", "event timeline", "job and run links"],
    },
    locations: [
      { kind: "detail-route", label: "activity workspace", keyboardReachable: true },
      { kind: "tab", label: "activity detail panels", keyboardReachable: true },
    ],
    proof: {
      fixture: "activity detail fixture",
      values: ["activity-001", "score_job", "payload", "timeline"],
      roles: ["heading", "tablist", "link", "region"],
      labels: ["Activity event state", "Projected event payload", "Activity event timeline"],
      statusDiscriminants: ["loading", "not-found", "error", "redirected"],
    },
  },
  {
    id: "profile",
    kind: "route",
    title: "Profile",
    routes: ["/profile", "/profile/"],
    owners: { routeModules: ["src/routes/profile.tsx", "src/routes/profile.index.tsx"], components: ["src/contexts/profile/components/ProfileEditor.tsx"] },
    categories: {
      visibleData: ["personal, contact and address fields", "work authorization and attestations", "executive baseline", "experience, education, skills and verified metrics", "search targets, EEO and evidence pins"],
      controls: ["add, remove and reorder", "save", "discard", "import resume", "open evidence map", "preview resizer"],
      unavailableStates: ["profile loading", "empty evidence", "validation error", "resume preview unavailable"],
      auditProvenance: ["canonical candidate source", "verified metrics", "evidence and source pins", "import version"],
    },
    locations: [
      { kind: "primary-workspace", label: "structured profile editor", keyboardReachable: true },
      { kind: "inspector", label: "full-height editable resume preview", keyboardReachable: true },
    ],
    proof: {
      fixture: "canonical profile fixture",
      values: ["Alex Morgan", "EU citizen", "Platform Engineering", "verified metric"],
      roles: ["form", "textbox", "button", "region"],
      labels: ["Profile", "Import resume", "Open evidence map"],
      statusDiscriminants: ["loading", "dirty", "saved", "validation-error", "preview-unavailable"],
    },
  },
  {
    id: "resume-import",
    kind: "route",
    title: "Resume import",
    routes: ["/profile/import", "/profile/import/upload", "/profile/import/preview", "/profile/import/confirm"],
    owners: {
      routeModules: ["src/routes/profile.import.tsx", "src/routes/profile.import.upload.tsx", "src/routes/profile.import.preview.tsx", "src/routes/profile.import.confirm.tsx"],
      components: ["src/contexts/profile/components/ResumeImportWizard.tsx", "src/contexts/profile/forms/import-upload-form.tsx", "src/contexts/profile/forms/import-preview-form.tsx", "src/contexts/profile/forms/import-confirm-form.tsx"],
    },
    categories: {
      visibleData: ["upload source", "include and exclude choices", "parse diagnostics", "conflicts", "backup and version facts", "success summary"],
      controls: ["upload", "next", "back", "confirm", "cancel", "include profile", "include style"],
      unavailableStates: ["no file", "parse error", "conflict", "import failure"],
      auditProvenance: ["source filename", "parse diagnostic", "backup id", "import version"],
    },
    locations: [
      { kind: "wizard-step", label: "upload step", keyboardReachable: true },
      { kind: "wizard-step", label: "preview step", keyboardReachable: true },
      { kind: "wizard-step", label: "confirm step", keyboardReachable: true },
    ],
    proof: {
      fixture: "resume import fixture",
      values: ["synthetic-platform-resume.pdf", "Parse diagnostics", "backup", "version"],
      roles: ["form", "checkbox", "button", "alert"],
      labels: ["Upload resume", "Include profile", "Include style", "Confirm import"],
      statusDiscriminants: ["upload", "preview", "conflict", "error", "success"],
    },
  },
  {
    id: "preferences",
    kind: "route",
    title: "Preferences",
    routes: ["/preferences"],
    owners: { routeModules: ["src/routes/preferences.tsx"], components: ["src/contexts/profile/components/ProfileEditor.tsx"] },
    categories: {
      visibleData: ["generation permissions", "writing style", "revision policy", "additional guidance", "resume style", "template versions and defaults"],
      controls: ["autosave", "undo", "save", "discard", "template save and set default", "real resume editor"],
      unavailableStates: ["template preview unavailable", "save error", "undo unavailable", "no default template"],
      auditProvenance: ["evidence rules", "template version", "default template marker", "resume style origin"],
    },
    locations: [
      { kind: "disclosure", label: "tailoring controls", keyboardReachable: true },
      { kind: "tab", label: "writing and resume style controls", keyboardReachable: true },
      { kind: "primary-workspace", label: "full-width resume template preview", keyboardReachable: true },
    ],
    proof: {
      fixture: "preferences fixture",
      values: ["Rewrite executive summary", "Executive", "A4", "Modern editorial"],
      roles: ["checkbox", "combobox", "button", "tabpanel"],
      labels: ["Tailoring controls", "Resume style", "Resume template preview"],
      statusDiscriminants: ["autosaving", "saved", "dirty", "error", "default"],
    },
  },
  {
    id: "settings-general",
    kind: "route",
    title: "Settings — General",
    routes: ["/settings", "/settings/"],
    owners: { routeModules: ["src/routes/settings.tsx", "src/routes/settings.index.tsx"], components: ["src/contexts/profile/components/SettingsPanel.tsx", "src/contexts/apply/components/ApplyRuntimeSettingsPanel.tsx"] },
    categories: {
      visibleData: ["current settings", "apply runtime controls", "scoring guidance", "compensation source policy", "effective, default, override and source facts"],
      controls: ["autosave", "undo", "reset", "apply runtime controls"],
      unavailableStates: ["validation error", "save error", "default unavailable", "override unavailable"],
      auditProvenance: ["effective value", "default value", "override source", "compensation policy source"],
    },
    locations: [
      { kind: "tab", label: "settings sections", keyboardReachable: true },
      { kind: "disclosure", label: "general settings panels", keyboardReachable: true },
    ],
    proof: {
      fixture: "general settings fixture",
      values: ["Minimum score", "Compensation source", "effective", "override"],
      roles: ["tablist", "form", "button", "textbox"],
      labels: ["Settings sections", "General", "Apply runtime settings"],
      statusDiscriminants: ["default", "effective", "override", "invalid", "saved"],
    },
  },
  {
    id: "settings-credentials",
    kind: "route",
    title: "Settings — Credentials",
    routes: ["/settings/credentials"],
    owners: { routeModules: ["src/routes/settings.credentials.tsx"], components: ["src/contexts/profile/components/CredentialsPanel.tsx"] },
    categories: {
      visibleData: ["provider states", "supported auth modes", "secret-presence metadata", "readiness and errors"],
      controls: ["add", "update", "delete", "verify provider"],
      unavailableStates: ["provider unconfigured", "verification failure", "unsupported auth mode", "secret absent"],
      auditProvenance: ["local secret boundary", "provider readiness result", "verification timestamp"],
    },
    locations: [
      { kind: "tab", label: "Credentials settings section", keyboardReachable: true },
      { kind: "primary-workspace", label: "provider ledger and setup forms", keyboardReachable: true },
    ],
    proof: {
      fixture: "credentials fixture",
      values: ["OpenAI", "configured", "API key present", "verify"],
      roles: ["tab", "table", "button", "form"],
      labels: ["Credentials", "Provider status", "Verify provider"],
      statusDiscriminants: ["unconfigured", "configured", "ready", "invalid", "error"],
    },
  },
  {
    id: "settings-models",
    kind: "route",
    title: "Settings — Models",
    routes: ["/settings/models"],
    owners: { routeModules: ["src/routes/settings.models.tsx"], components: ["src/contexts/profile/components/ModelSelectionPanel.tsx", "src/contexts/materials/components/AiExecutionPolicyPanel.tsx"] },
    categories: {
      visibleData: ["provider and model catalogs", "generator and judge selections", "analysis legs", "execution policy", "cost and concurrency controls"],
      controls: ["select provider", "select model", "set generator and judge", "set policy and concurrency"],
      unavailableStates: ["provider unready", "model invalid", "catalog unavailable", "execution blocked"],
      auditProvenance: ["selected model", "provider readiness", "policy source", "cost limit"],
    },
    locations: [
      { kind: "tab", label: "Model selection settings section", keyboardReachable: true },
      { kind: "inspector", label: "model matrix and policy inspector", keyboardReachable: true },
    ],
    proof: {
      fixture: "model selection fixture",
      values: ["generator", "judge", "analysis leg", "concurrency 3"],
      roles: ["tab", "combobox", "button", "table"],
      labels: ["Model selection", "AI execution policy", "Generator model"],
      statusDiscriminants: ["ready", "unready", "invalid", "blocked"],
    },
  },
  {
    id: "settings-browser",
    kind: "route",
    title: "Settings — Browser",
    routes: ["/settings/browser"],
    owners: { routeModules: ["src/routes/settings.browser.tsx"], components: ["src/contexts/operations/components/BrowserCapabilitiesPanel.tsx", "src/contexts/operations/components/ExtensionPairingPanel.tsx"] },
    categories: {
      visibleData: ["browser capabilities", "pairing state", "expiry", "token metadata", "capability restrictions and reasons"],
      controls: ["create", "revoke", "rotate", "pair extension", "refresh capability state"],
      unavailableStates: ["unpaired", "expired", "capability restricted", "extension unavailable"],
      auditProvenance: ["pairing metadata", "capability reason", "expiry", "local browser boundary"],
    },
    locations: [
      { kind: "tab", label: "Browser and extension settings section", keyboardReachable: true },
      { kind: "primary-workspace", label: "capability ledger and pairing workbench", keyboardReachable: true },
    ],
    proof: {
      fixture: "browser pairing fixture",
      values: ["paired", "expired", "rotate token", "restriction reason"],
      roles: ["tab", "table", "button", "status"],
      labels: ["Browser and extension", "Browser capabilities", "Extension pairing"],
      statusDiscriminants: ["unpaired", "paired", "expired", "restricted", "unavailable"],
    },
  },
] as const satisfies readonly SemanticParitySurface[];

export function routeCoverageFromManifest(
  manifest: readonly SemanticParitySurface[] = SEMANTIC_PARITY_MANIFEST,
): readonly ProductionSurfaceRoutePath[] {
  return manifest.flatMap((surface) => surface.routes);
}
