import { DEMO_ARTIFACTS } from "./artifacts.js";
import type { DemoSeed, DemoSeedValue } from "./contracts.js";
import { DEMO_READ_MODEL } from "./read-model.js";

const minutes = (offsetMinutes: number) => ({ offsetMinutes }) as const;

const demoSeed = {
  schemaVersion: 1,
  seedVersion: "2026-07-31.1",
  title: "JobCtrl product tour",
  artifacts: DEMO_ARTIFACTS,
  readModel: DEMO_READ_MODEL,
  routeData: {
    dashboard: [
      {
        id: "dashboard-active-run",
        title: "Role preparation is in progress",
        state: "running",
        at: minutes(-18),
        detail: "A deterministic preparation run exposes progress and a linked audit timeline.",
      },
      {
        id: "dashboard-recent-run",
        title: "Review-ready materials",
        state: "succeeded",
        at: minutes(-95),
        detail: "A completed run contributes to the populated funnel and recent-run list.",
      },
    ],
    jobs: [
      {
        id: "job-northwind-platform",
        title: "Platform systems lead",
        state: "accepted",
        at: minutes(-1440),
        detail: "A strong match with grounded evidence and reviewable materials.",
      },
      {
        id: "job-contoso-reliability",
        title: "Reliability engineering manager",
        state: "blocked",
        at: minutes(-730),
        detail: "A hard requirement is missing, so tailoring may not invent the claim.",
      },
      {
        id: "job-fabrikam-systems",
        title: "Systems delivery director",
        state: "stale_policy",
        at: minutes(-310),
        detail: "A scoring-policy change makes the existing score visibly stale.",
      },
    ],
    discovery: [
      {
        id: "discovery-preview",
        title: "Bundled source preview",
        state: "preview_ready",
        at: minutes(-45),
        detail: "The preview is synthetic and makes no request to a job board.",
      },
      {
        id: "discovery-quarantine",
        title: "Uncertain source evidence",
        state: "quarantined",
        at: minutes(-180),
        detail: "The review queue demonstrates an explicit accept-or-reject decision.",
      },
    ],
    evidence: [
      {
        id: "evidence-delivery-improvement",
        title: "Delivery improvement evidence",
        state: "grounded",
        at: minutes(-360),
        detail: "A reusable proof point is linked to a requirement and resume bullet.",
      },
      {
        id: "evidence-risk-management-gap",
        title: "Risk-management requirement",
        state: "gap",
        at: minutes(-360),
        detail: "An explicit gap remains visible instead of being claimed as covered.",
      },
    ],
    materials: [
      {
        id: "artifact-accepted-resume",
        title: "Accepted tailored resume",
        state: "accepted_preserved",
        at: minutes(-110),
        detail: "The last accepted artifact remains reviewable while a refresh is attempted.",
      },
      {
        id: "artifact-refresh-warning",
        title: "Refresh warning",
        state: "residual_warning",
        at: minutes(-22),
        detail: "A post-generation warning is labeled as not changing the accepted artifact.",
      },
    ],
    apply: [
      {
        id: "apply-approval-gate",
        title: "Approval required",
        state: "approval_required",
        at: minutes(-72),
        detail: "The review decision is explicit before the dry-run application rehearsal.",
      },
      {
        id: "apply-dry-run",
        title: "Dry-run application",
        state: "dry_run",
        at: minutes(-15),
        detail: "The receipt states that no application was submitted.",
      },
    ],
    runs: [
      {
        id: "run-queued",
        title: "Preparation queued",
        state: "queued",
        at: minutes(-4),
        detail: "A newly queued deterministic run.",
      },
      {
        id: "run-running",
        title: "Materials rendering",
        state: "running",
        at: minutes(-9),
        detail: "A running scenario with progress events.",
      },
      {
        id: "run-succeeded",
        title: "Score refresh",
        state: "succeeded",
        at: minutes(-60),
        detail: "A terminal success state.",
      },
      {
        id: "run-failed-retryable",
        title: "Tailoring quality gate",
        state: "failed_retryable",
        at: minutes(-120),
        detail: "A controlled failure includes a retry path and saved audit evidence.",
      },
      {
        id: "run-cancelled",
        title: "Discovery rehearsal",
        state: "cancelled",
        at: minutes(-30),
        detail: "A cancellation is recorded without a live discovery request.",
      },
    ],
    analytics: [
      {
        id: "outcome-interview",
        title: "Interview outcome",
        state: "interview",
        at: minutes(-2880),
        detail: "Synthetic conversion data includes an interview event.",
      },
      {
        id: "outcome-rejection",
        title: "Rejection outcome",
        state: "rejection",
        at: minutes(-4320),
        detail: "Synthetic conversion data includes a rejection event.",
      },
      {
        id: "outcome-offer",
        title: "Offer outcome",
        state: "offer",
        at: minutes(-5760),
        detail: "Synthetic conversion data includes an offer event.",
      },
    ],
    profile: [
      {
        id: "profile-synthetic",
        title: "Synthetic professional profile",
        state: "editable_local",
        at: minutes(-1440),
        detail: "Profile edits stay in this browser and can be reset.",
      },
      {
        id: "profile-bundled-import",
        title: "Bundled sample resume",
        state: "bundled_import",
        at: minutes(-1440),
        detail: "The demo accepts the bundled sample only, not an arbitrary upload.",
      },
    ],
    settings: [
      {
        id: "settings-local-preferences",
        title: "Synthetic preferences",
        state: "editable_local",
        at: minutes(-1440),
        detail: "Settings changes are browser-local and resettable.",
      },
      {
        id: "settings-credentials",
        title: "Credential explanation",
        state: "unavailable",
        at: minutes(-1440),
        detail: "The public demo neither accepts nor checks credentials.",
      },
    ],
    contacts: [
      {
        id: "contact-synthetic-hiring-partner",
        title: "Synthetic hiring partner",
        state: "confirmed",
        at: minutes(-840),
        detail: "A contact record supports the outreach workflow without a real address.",
      },
      {
        id: "contact-research-review",
        title: "Research candidate",
        state: "needs_review",
        at: minutes(-50),
        detail: "A candidate requires a local confirmation decision.",
      },
    ],
    outreach: [
      {
        id: "outreach-approved-draft",
        title: "Approved outreach draft",
        state: "approved",
        at: minutes(-360),
        detail: "The draft is grounded and approved but is never transmitted by the demo.",
      },
      {
        id: "outreach-follow-up",
        title: "Follow-up reminder",
        state: "scheduled_follow_up",
        at: minutes(-10),
        detail: "The reminder is a local plan, not an automated message.",
      },
    ],
  },
  scenarios: [
    {
      scenarioId: "scenario-score-success",
      capability: "simulated_async",
      operation: "rescoreJob",
      steps: [
        { state: "queued", at: minutes(0), message: "Score refresh queued." },
        { state: "running", at: minutes(1), message: "Evaluating grounded evidence." },
      ],
      terminal: { state: "succeeded", at: minutes(2), summary: "Synthetic score refresh completed." },
    },
    {
      scenarioId: "scenario-tailoring-retry",
      capability: "simulated_async",
      operation: "retailorJob",
      steps: [
        { state: "queued", at: minutes(0), message: "Tailoring rehearsal queued." },
        { state: "running", at: minutes(1), message: "Checking artifact grounding." },
      ],
      terminal: {
        state: "failed",
        at: minutes(2),
        errorCode: "demo_grounding_gate",
        retryable: true,
        summary: "The synthetic quality gate stopped this attempt; the accepted artifact remains." ,
      },
    },
    {
      scenarioId: "scenario-stage-cancelled",
      capability: "simulated_async",
      operation: "runJobStage",
      steps: [
        { state: "queued", at: minutes(0), message: "Stage rehearsal queued." },
        { state: "running", at: minutes(1), message: "Running the selected stage." },
      ],
      terminal: { state: "cancelled", at: minutes(2), summary: "Synthetic stage rehearsal cancelled." },
    },
    {
      scenarioId: "scenario-stage-retry",
      capability: "simulated_async",
      operation: "retryStage",
      steps: [
        { state: "queued", at: minutes(0), message: "Stage retry queued." },
        { state: "running", at: minutes(1), message: "Retrying the selected stage." },
      ],
      terminal: { state: "succeeded", at: minutes(2), summary: "Synthetic stage retry completed." },
    },
  ],
  receipts: [
    {
      receiptId: "receipt-application-dry-run",
      kind: "application",
      simulated: true,
      externalEffectOccurred: false,
      recordedAt: minutes(-15),
      wouldHaveDone: "Prepared an application for review.",
      didNotDo: "No application was submitted.",
    },
    {
      receiptId: "receipt-outreach-dry-run",
      kind: "outreach",
      simulated: true,
      externalEffectOccurred: false,
      recordedAt: minutes(-8),
      wouldHaveDone: "Recorded a draft send rehearsal.",
      didNotDo: "No message was sent.",
    },
    {
      receiptId: "receipt-artifact-preview",
      kind: "os_open",
      simulated: true,
      externalEffectOccurred: false,
      recordedAt: minutes(-4),
      wouldHaveDone: "Opened the bundled artifact in an in-browser preview.",
      didNotDo: "No host operating-system opener was used.",
    },
    {
      receiptId: "receipt-llm-draft",
      kind: "llm",
      simulated: true,
      externalEffectOccurred: false,
      recordedAt: minutes(-6),
      wouldHaveDone: "Generated a reviewable outreach draft.",
      didNotDo: "No model provider was called.",
    },
    {
      receiptId: "receipt-discovery-preview",
      kind: "discovery",
      simulated: true,
      externalEffectOccurred: false,
      recordedAt: minutes(-12),
      wouldHaveDone: "Previewed a discovered role from a bundled fixture.",
      didNotDo: "No site was crawled or fetched.",
    },
  ],
} as const satisfies DemoSeedValue;

export const DEMO_SEED: DemoSeed = demoSeed;
