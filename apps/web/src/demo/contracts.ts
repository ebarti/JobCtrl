import type { ApiClientPort } from "../shared/ports/ApiClientPort.js";

export const APP_MODES = ["local", "demo"] as const;
export type AppMode = (typeof APP_MODES)[number];
export type DemoAppMode = Extract<AppMode, "demo">;

export const DEMO_CAPABILITY_CLASSES = [
  "browser_local",
  "simulated_async",
  "rehearsed_external",
  "unavailable",
] as const;
export type DemoCapabilityClass = (typeof DEMO_CAPABILITY_CLASSES)[number];

export interface DemoCapability {
  readonly class: DemoCapabilityClass;
  /** A short, user-facing explanation that prevents a misleading demo affordance. */
  readonly reason: string;
}

/** Compile-time parity contract for the later DemoApiClientAdapter. */
export type DemoCapabilityManifest = Readonly<Record<keyof ApiClientPort, DemoCapability>>;

export type ApiClientResponse<TMethod extends keyof ApiClientPort> = ApiClientPort[TMethod] extends (
  ...args: never[]
) => Promise<infer TResponse>
  ? TResponse
  : never;

export const DEMO_SIMULATED_ASYNC_OPERATIONS = [
  "renderResumeReviewDraft",
  "ensureCurrentResumeMaterials",
  "retryFailedJobs",
  "runPendingPreparation",
  "rescoreJob",
  "rescoreJobsNotOnCurrentScoringPolicy",
  "retailorJob",
  "tailorJob",
  "retailorCurrentPolicy",
  "runPipelineStages",
  "generateOutreachDraft",
  "reviseOutreachDraft",
  "retryStage",
  "runJobStage",
  "generateMaterials",
  "generateInterviewPrep",
] as const satisfies readonly (keyof ApiClientPort)[];
export type DemoSimulatedAsyncOperation = (typeof DEMO_SIMULATED_ASYNC_OPERATIONS)[number];

export const DEMO_EXTERNAL_REHEARSAL_OPERATIONS = [
  "openArtifact",
  "applyJob",
  "markApplied",
] as const satisfies readonly (keyof ApiClientPort)[];
export type DemoExternalRehearsalOperation = (typeof DEMO_EXTERNAL_REHEARSAL_OPERATIONS)[number];

export interface DemoRelativeTimestamp {
  /** Offset from the injected scenario clock, not a wall-clock timestamp. */
  readonly offsetMinutes: number;
}

export type DemoScenarioTerminal =
  | {
      readonly state: "succeeded";
      readonly summary: string;
    }
  | {
      readonly state: "failed";
      readonly errorCode: string;
      readonly retryable: true;
      readonly summary: string;
    }
  | {
      readonly state: "cancelled";
      readonly summary: string;
    };

export interface DemoQueuedScenarioStep {
  readonly state: "queued";
  readonly at: DemoRelativeTimestamp;
  readonly message: string;
}

export interface DemoRunningScenarioStep {
  readonly state: "running";
  readonly at: DemoRelativeTimestamp;
  readonly message: string;
}

/**
 * A scenario can only describe a valid queued -> running -> terminal sequence.
 * The scheduler is deliberately deferred to P1; this is immutable input data.
 */
export interface DemoScenario {
  readonly scenarioId: string;
  readonly capability: "simulated_async";
  readonly operation: DemoSimulatedAsyncOperation;
  readonly steps: readonly [DemoQueuedScenarioStep, DemoRunningScenarioStep];
  readonly terminal: DemoScenarioTerminal & { readonly at: DemoRelativeTimestamp };
}

export type DemoReceiptKind =
  | "application"
  | "outreach"
  | "discovery"
  | "compensation"
  | "contact_research"
  | "llm"
  | "os_open";

/**
 * `true` / `false` literals make an external side effect impossible to encode
 * as a successful demo receipt.
 */
export interface DemoReceipt {
  readonly receiptId: string;
  readonly kind: DemoReceiptKind;
  readonly simulated: true;
  readonly externalEffectOccurred: false;
  readonly recordedAt: DemoRelativeTimestamp;
  readonly wouldHaveDone: string;
  readonly didNotDo: string;
  /** Dynamic P3b receipts add bounded operation/entity identity only. */
  readonly operation?:
    | DemoExternalRehearsalOperation
    | DemoSimulatedAsyncOperation
    | "discoverySourcePreview";
  readonly scenarioId?: string;
  readonly runId?: string;
  readonly entityType?:
    | "artifact"
    | "contact"
    | "job"
    | "outreach_thread"
    | "source"
    | "workspace";
  readonly entityId?: string;
}

export interface DemoArtifactAsset {
  readonly assetId: string;
  readonly contentType: "text/html" | "application/pdf" | "text/plain";
  /** A same-origin public URL, resolved synchronously by Vite's static assets. */
  readonly url: `/demo/${string}`;
  readonly label: string;
}

export interface DemoArtifacts {
  readonly sourcePreview: DemoArtifactAsset;
  readonly applicationPreview: DemoArtifactAsset;
  readonly profileResumeHtml: DemoArtifactAsset;
  readonly profileResumePdf: DemoArtifactAsset;
  readonly tailoredResumeHtml: DemoArtifactAsset;
  readonly tailoredResumePdf: DemoArtifactAsset;
  readonly coverLetter: DemoArtifactAsset;
  readonly interviewNotes: DemoArtifactAsset;
}

export const DEMO_ROUTE_NAMES = [
  "dashboard",
  "jobs",
  "discovery",
  "evidence",
  "materials",
  "apply",
  "runs",
  "analytics",
  "profile",
  "settings",
  "contacts",
  "outreach",
] as const;
export type DemoRouteName = (typeof DEMO_ROUTE_NAMES)[number];

export interface DemoRouteRecord {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly at: DemoRelativeTimestamp;
  readonly detail: string;
}

export type DemoRouteData = Readonly<Record<DemoRouteName, readonly DemoRouteRecord[]>>;

/**
 * Typed response payloads P2 can serve directly from normalized seed data.
 * These remain current ApiClientPort return types; no demo-only response union
 * is introduced.
 */
export interface DemoReadModel {
  readonly dashboard: {
    readonly health: ApiClientResponse<"health">;
    readonly summary: ApiClientResponse<"dashboardSummary">;
    readonly digest: ApiClientResponse<"digest">;
    readonly activity: ApiClientResponse<"activity">;
    readonly activityEvents: Readonly<Record<string, ApiClientResponse<"activityEvent">>>;
  };
  readonly jobs: {
    readonly list: ApiClientResponse<"jobs">;
    readonly details: Readonly<Record<string, ApiClientResponse<"job">>>;
  };
  readonly discovery: {
    readonly settings: ApiClientResponse<"discoverySettings">;
    readonly sources: ApiClientResponse<"discoverySources">;
    readonly sourcePreviews: Readonly<Record<string, ApiClientResponse<"discoverySourcePreview">>>;
    readonly compensationSources: ApiClientResponse<"compensationSources">;
    readonly locatorCandidates: ApiClientResponse<"discoveryLocatorCandidates">;
    readonly quarantine: ApiClientResponse<"discoveryQuarantine">;
    readonly manualCapture: ApiClientResponse<"manualCaptureQueue">;
    readonly roleMatchFeedback: ApiClientResponse<"roleMatchFeedbackSuggestions">;
  };
  readonly evidence: ApiClientResponse<"evidenceMap">;
  readonly materials: {
    readonly list: ApiClientResponse<"artifacts">;
    readonly details: Readonly<Record<string, ApiClientResponse<"artifact">>>;
    readonly resumeReviewDrafts: Readonly<Record<string, ApiClientResponse<"resumeReviewDraft">>>;
    readonly resumeReviewFeedback: Readonly<Record<string, ApiClientResponse<"resumeReviewFeedback">>>;
    readonly resumeTemplates: ApiClientResponse<"resumeTemplates">;
    readonly templateDetails: Readonly<Record<string, ApiClientResponse<"resumeTemplate">>>;
  };
  readonly apply: {
    readonly queue: ApiClientResponse<"applyReviewQueue">;
  };
  readonly runs: {
    readonly list: ApiClientResponse<"workflowRuns">;
    readonly details: Readonly<Record<string, ApiClientResponse<"workflowRun">>>;
  };
  readonly analytics: {
    readonly summary: ApiClientResponse<"outcomeAnalytics">;
    readonly outcomes: ApiClientResponse<"applicationOutcomes">;
    readonly jobOutcomes: Readonly<Record<string, ApiClientResponse<"jobApplicationOutcomes">>>;
  };
  readonly profile: {
    readonly config: ApiClientResponse<"profile">;
    /** Values are never present; this supports the read-only explanation route. */
    readonly credentials: ApiClientResponse<"credentials">;
  };
  readonly settings: ApiClientResponse<"settings">;
  /**
   * Extension tokens are intentionally absent: their capability-manifest
   * entry is `unavailable`, so P2 must not manufacture a secret-shaped value.
   */
  readonly contacts: {
    readonly list: ApiClientResponse<"listContacts">;
    readonly details: Readonly<Record<string, ApiClientResponse<"contact">>>;
    readonly researchTasks: ApiClientResponse<"researchTasks">;
    readonly researchTaskDetails: Readonly<Record<string, ApiClientResponse<"researchTask">>>;
  };
  readonly outreach: {
    readonly thread: ApiClientResponse<"outreachThread">;
    readonly dueFollowUps: ApiClientResponse<"dueOutreachFollowUps">;
  };
}

export interface DemoSeedValue {
  readonly schemaVersion: 1;
  readonly seedVersion: "2026-07-12.1";
  readonly title: string;
  readonly artifacts: DemoArtifacts;
  readonly readModel: DemoReadModel;
  readonly routeData: DemoRouteData;
  readonly scenarios: readonly DemoScenario[];
  readonly receipts: readonly DemoReceipt[];
}

/** A recursively readonly public fixture that contains no user data. */
export type DemoSeed = ReadonlyDeep<DemoSeedValue>;

type ReadonlyDeep<TValue> = TValue extends (...args: never[]) => unknown
  ? TValue
  : TValue extends readonly [unknown, ...unknown[]]
    ? ReadonlyDeepTuple<TValue>
    : TValue extends readonly (infer TItem)[]
      ? readonly ReadonlyDeep<TItem>[]
      : TValue extends object
        ? { readonly [TKey in keyof TValue]: ReadonlyDeep<TValue[TKey]> }
        : TValue;

type ReadonlyDeepTuple<TTuple extends readonly unknown[]> = TTuple extends readonly [
  infer THead,
  ...infer TTail,
]
  ? readonly [ReadonlyDeep<THead>, ...ReadonlyDeepTuple<TTail>]
  : readonly [];
