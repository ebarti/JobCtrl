import { JobCtrlApiError } from "@jobctrl/api-client";

import type { DemoApiClientPort } from "./DemoApi.js";
import type {
  HttpMethod,
  HttpPort,
  HttpRequestOptions,
} from "../shared/ports/HttpPort.js";
import { DemoApiClientAdapter } from "./DemoApiClientAdapter.js";
import { DemoFeatureHttpAdapter } from "./DemoFeatureHttpAdapter.js";
import { DemoCapabilityError } from "./ports.js";
import { demoWorkspaceIdentity } from "./identity.js";
import type { DemoWorkspaceRepository } from "./workspace/DemoWorkspaceRepository.js";

type ParametersByName = Readonly<Record<string, string>>;
type Route = {
  readonly method: HttpMethod;
  readonly segments: readonly string[];
  readonly operation: keyof DemoApiClientPort;
  readonly arguments: readonly string[];
};

/** Explicit public feature paths backed only by the synthetic browser workspace. */
const routes: readonly Route[] = [
  route("GET", "/v1/health", "health"),
  route("GET", "/v1/dashboard/summary", "dashboardSummary"),
  route("GET", "/v1/analytics/outcomes", "outcomeAnalytics"),
  route("GET", "/v1/debug/activity", "activity", "$query"),
  route("GET", "/v1/debug/activity/:eventId", "activityEvent", "eventId"),
  route("GET", "/v1/digest", "digest"),
  route("POST", "/v1/digest/acknowledge", "acknowledgeDigest", "$body"),
  route("GET", "/v1/discovery/settings", "discoverySettings"),
  route("PATCH", "/v1/discovery/settings", "updateDiscoverySettings", "$body"),
  route("GET", "/v1/discovery/sources", "discoverySources"),
  route("POST", "/v1/discovery/sources", "upsertDiscoverySource", "$body"),
  route(
    "PATCH",
    "/v1/discovery/sources/:sourceId/state",
    "patchDiscoverySourceState",
    "sourceId",
    "$body",
  ),
  route(
    "POST",
    "/v1/discovery/sources/:sourceId/preview",
    "discoverySourcePreview",
    "sourceId",
  ),
  route(
    "GET",
    "/v1/discovery/locator-candidates",
    "discoveryLocatorCandidates",
  ),
  route(
    "POST",
    "/v1/discovery/locator-candidates/:candidateId/promote",
    "promoteSourceLocatorCandidate",
    "candidateId",
    "$body",
  ),
  route(
    "POST",
    "/v1/discovery/locator-candidates/:candidateId/reject",
    "rejectSourceLocatorCandidate",
    "candidateId",
    "$body",
  ),
  route("GET", "/v1/discovery/quarantine", "discoveryQuarantine"),
  route(
    "POST",
    "/v1/discovery/quarantine/:jobId/decision",
    "decideDiscoveryQuarantine",
    "jobId",
    "$body",
  ),
  route("GET", "/v1/discovery/manual-capture", "manualCaptureQueue"),
  route(
    "POST",
    "/v1/discovery/manual-capture/:itemId/dismiss",
    "dismissManualCapture",
    "itemId",
    "$body",
  ),
  route(
    "POST",
    "/v1/discovery/manual-capture/:itemId/import",
    "importManualCapture",
    "itemId",
    "$body",
  ),
  route(
    "POST",
    "/v1/discovery/manual-capture/:itemId/prepare",
    "prepareManualCapture",
    "itemId",
    "$body",
  ),
  route("POST", "/v1/discovery/feedback", "recordDiscoveryFeedback", "$body"),
  route(
    "GET",
    "/v1/discovery/role-match-feedback",
    "roleMatchFeedbackSuggestions",
  ),
  route(
    "POST",
    "/v1/discovery/role-match-feedback/:suggestionId/decision",
    "decideRoleMatchFeedbackSuggestion",
    "suggestionId",
    "$body",
  ),
  route("GET", "/v1/compensation/sources", "compensationSources"),
  route(
    "PATCH",
    "/v1/compensation/sources",
    "updateCompensationSourcePolicy",
    "$body",
  ),
  route(
    "GET",
    "/v1/jobs/:jobId/compensation/posted",
    "postedCompensationFact",
    "jobId",
  ),
  route(
    "GET",
    "/v1/jobs/:jobId/compensation/market",
    "marketCompensationEstimate",
    "jobId",
  ),
  route("GET", "/v1/jobs/:jobId/offer", "jobOffer", "jobId"),
  route(
    "POST",
    "/v1/jobs/:jobId/offer/terms",
    "saveOfferTerms",
    "jobId",
    "$body",
  ),
  route(
    "POST",
    "/v1/jobs/:jobId/offer/decisions",
    "recordOfferDecision",
    "jobId",
    "$body",
  ),
  route("GET", "/v1/interviews/catalog", "interviewCatalog", "$query"),
  route(
    "GET",
    "/v1/interviews/questions/:questionId",
    "interviewQuestion",
    "questionId",
  ),
  route(
    "GET",
    "/v1/jobs/:jobId/interview-prep/history",
    "interviewPrepHistory",
    "jobId",
    "$query",
  ),
  route(
    "GET",
    "/v1/jobs/:jobId/interview-notes",
    "interviewNotes",
    "jobId",
    "$query",
  ),
  route(
    "POST",
    "/v1/jobs/:jobId/interview-notes",
    "saveInterviewNote",
    "jobId",
    "$body",
  ),
  route("GET", "/v1/evidence-map", "evidenceMap"),
  route("GET", "/v1/apply/review-queue", "applyReviewQueue"),
  route("GET", "/v1/jobs/:jobId/screening-answers", "screeningAnswers", "jobId"),
  route("POST", "/v1/jobs/:jobId/screening-answers", "writeScreeningAnswer", "jobId", "$body"),
  route(
    "POST",
    "/v1/jobs/:jobId/apply-review/decision",
    "decideApplyReview",
    "jobId",
    "$body",
  ),
  route(
    "GET",
    "/v1/jobs/:jobId/resume-review/draft",
    "resumeReviewDraft",
    "jobId",
  ),
  route(
    "POST",
    "/v1/jobs/:jobId/resume-review/draft",
    "createResumeReviewDraft",
    "jobId",
    "$body",
  ),
  route(
    "POST",
    "/v1/resume-review/drafts/:draftId/revisions",
    "saveResumeReviewDraftRevision",
    "draftId",
    "$body",
  ),
  route(
    "POST",
    "/v1/resume-review/drafts/:draftId/comment-threads",
    "seedResumeReviewCommentThreads",
    "draftId",
    "$body",
  ),
  route(
    "POST",
    "/v1/resume-review/comment-threads/:threadId/replies",
    "replyToResumeReviewComment",
    "threadId",
    "$body",
  ),
  route(
    "GET",
    "/v1/jobs/:jobId/resume-review/feedback",
    "resumeReviewFeedback",
    "jobId",
  ),
  route("GET", "/v1/resume-templates", "resumeTemplates"),
  route(
    "GET",
    "/v1/resume-templates/:templateId",
    "resumeTemplate",
    "templateId",
  ),
  route("POST", "/v1/resume-templates", "saveResumeTemplate", "$body"),
  route(
    "PATCH",
    "/v1/resume-templates/default",
    "setDefaultResumeTemplate",
    "$body",
  ),
  route(
    "PATCH",
    "/v1/jobs/:jobId/resume-template",
    "setJobResumeTemplate",
    "jobId",
    "$body",
  ),
  route("GET", "/v1/outcomes", "applicationOutcomes"),
  route("GET", "/v1/jobs/:jobId/outcomes", "jobApplicationOutcomes", "jobId"),
  route(
    "POST",
    "/v1/jobs/:jobId/outcomes",
    "recordManualApplicationOutcome",
    "jobId",
    "$body",
  ),
  route(
    "POST",
    "/v1/outcome-suggestions/:suggestionId/decision",
    "decideOutcomeSuggestion",
    "suggestionId",
    "$body",
  ),
  route("GET", "/v1/jobs/reviewable-list", "reviewableJobs", "$query"),
  route("DELETE", "/v1/jobs/:jobId", "deleteJob", "jobId", "$body"),
  route("POST", "/v1/jobs/bulk-delete", "deleteJobs", "$body"),
  route("DELETE", "/v1/jobs/:jobId/permanent", "permanentlyDeleteJob", "jobId"),
  route(
    "POST",
    "/v1/jobs/bulk-delete-permanent",
    "permanentlyDeleteJobs",
    "$body",
  ),
  route(
    "POST",
    "/v1/jobs/permanent-delete-selection",
    "preparePermanentDeleteSelection",
    "$body",
  ),
  route("POST", "/v1/jobs/:jobId/restore", "restoreJob", "jobId"),
  route("POST", "/v1/jobs/bulk-restore", "restoreJobs", "$body"),
  route("POST", "/v1/jobs/:jobId/hide", "hideJob", "jobId", "$body"),
  route("POST", "/v1/jobs/bulk-hide", "hideJobs", "$body"),
  route("POST", "/v1/jobs/:jobId/unhide", "unhideJob", "jobId"),
  route("POST", "/v1/jobs/bulk-unhide", "unhideJobs", "$body"),
  route(
    "POST",
    "/v1/jobs/:jobId/score-correction",
    "correctScore",
    "jobId",
    "$body",
  ),
  route(
    "POST",
    "/v1/scoring/stale-scores/actions/reset-for-rescore",
    "resetStaleScoresForRescore",
    "$body",
  ),
  route("GET", "/v1/workflow-runs", "workflowRuns", "$query"),
  route("GET", "/v1/workflow-runs/:runId", "workflowRun", "runId"),
  route(
    "POST",
    "/v1/workflow-runs/:runId/actions/cancel",
    "cancelWorkflowRun",
    "runId",
  ),
  route("GET", "/v1/artifacts", "artifacts", "$query"),
  route("GET", "/v1/artifacts/:artifactId", "artifact", "artifactId"),
  route("POST", "/v1/artifacts/:artifactId/open", "openArtifact", "artifactId"),
  route("GET", "/v1/profile", "profile"),
  route("PATCH", "/v1/profile", "updateProfile", "$body"),
  route("POST", "/v1/profile/import-resume", "importResume", "$body"),
  route(
    "POST",
    "/v1/profile/target-role-suggestions",
    "targetRoleSuggestions",
    "$body",
  ),
  route(
    "POST",
    "/v1/profile/required-bullet-suggestions",
    "requiredBulletSuggestions",
    "$body",
  ),
  route("GET", "/v1/credentials", "credentials"),
  route("PATCH", "/v1/credentials", "updateCredential", "$body"),
  route("GET", "/v1/browser-capabilities", "browserCapabilities"),
  route("POST", "/v1/browser-capabilities/:capabilityId/enable", "enableBrowserCapability", "capabilityId", "$body"),
  route("POST", "/v1/browser-capabilities/:capabilityId/disable", "disableBrowserCapability", "capabilityId"),
  route("POST", "/v1/browser-capabilities/authenticated-linkedin-browser/profile-copy", "copyLinkedInBrowserProfile", "$body"),
  route("GET", "/v1/extension/pairing-token", "extensionCapabilityToken"),
  route("POST", "/v1/extension/pairing-token/rotate", "rotateExtensionCapabilityToken"),
  route("GET", "/v1/discovery/browser-extension/status", "discoveryBrowserBridgeStatus"),
  route("GET", "/v1/providers/models", "providerModels"),
  route("GET", "/v1/providers/status", "providerStatus"),
  route("GET", "/v1/contacts", "listContacts", "$query"),
  route("POST", "/v1/contacts", "createContact", "$body"),
  route("POST", "/v1/contacts/import", "importContacts", "$body"),
  route("GET", "/v1/contacts/research", "researchTasks", "$query"),
  route("POST", "/v1/contacts/research", "runContactResearch", "$body"),
  route("GET", "/v1/contacts/research/:taskId", "researchTask", "taskId"),
  route(
    "POST",
    "/v1/contacts/research/:taskId/candidates/:candidateId/confirm",
    "confirmContactCandidate",
    "taskId",
    "candidateId",
    "$body",
  ),
  route("GET", "/v1/contacts/:contactId", "contact", "contactId"),
  route(
    "PATCH",
    "/v1/contacts/:contactId",
    "updateContact",
    "contactId",
    "$body",
  ),
  route(
    "DELETE",
    "/v1/contacts/:contactId",
    "deleteContact",
    "contactId",
    "$body",
  ),
  route(
    "GET",
    "/v1/contacts/:contactId/outreach",
    "outreachThread",
    "contactId",
    "$query",
  ),
  route(
    "POST",
    "/v1/contacts/:contactId/outreach/drafts",
    "generateOutreachDraft",
    "contactId",
    "$body",
  ),
  route(
    "POST",
    "/v1/outreach/threads/:threadId/drafts",
    "reviseOutreachDraft",
    "threadId",
    "$body",
  ),
  route(
    "POST",
    "/v1/outreach/threads/:threadId/drafts/:draftId/approve",
    "approveOutreachDraft",
    "threadId",
    "draftId",
    "$body",
  ),
  route(
    "POST",
    "/v1/outreach/threads/:threadId/drafts/:draftId/reject",
    "rejectOutreachDraft",
    "threadId",
    "draftId",
    "$body",
  ),
  route(
    "POST",
    "/v1/outreach/threads/:threadId/follow-up/schedule",
    "scheduleOutreachFollowUp",
    "threadId",
    "$body",
  ),
  route(
    "POST",
    "/v1/outreach/threads/:threadId/follow-up/complete",
    "completeOutreachFollowUp",
    "threadId",
    "$body",
  ),
  route(
    "POST",
    "/v1/outreach/threads/:threadId/follow-up/dismiss",
    "dismissOutreachFollowUp",
    "threadId",
    "$body",
  ),
  route("GET", "/v1/outreach/follow-ups/due", "dueOutreachFollowUps"),
  route(
    "POST",
    "/v1/jobs/:jobId/actions/cancel",
    "cancelJobAction",
    "jobId",
    "$body",
  ),
  route(
    "POST",
    "/v1/jobs/:jobId/actions/mark-applied",
    "markApplied",
    "jobId",
    "$body",
  ),
  route(
    "POST",
    "/v1/jobs/:jobId/actions/mark-skipped",
    "markSkipped",
    "jobId",
    "$body",
  ),
];

const threadWrites = new Set<keyof DemoApiClientPort>([
  "approveOutreachDraft",
  "rejectOutreachDraft",
  "scheduleOutreachFollowUp",
  "completeOutreachFollowUp",
  "dismissOutreachFollowUp",
]);

/** Feature transport with no API origin, token, browser bridge or network fallback. */
export class DemoHttpAdapter implements HttpPort {
  private readonly features: DemoFeatureHttpAdapter;

  constructor(
    private readonly api: DemoApiClientAdapter,
    private readonly workspace: DemoWorkspaceRepository,
  ) {
    this.features = new DemoFeatureHttpAdapter(api, workspace);
  }

  async json<T>(
    method: HttpMethod,
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<T> {
    const segments = parsePath(path);
    if (options.expectedDatabaseInstanceId !== undefined) {
      const snapshot = await this.workspace.snapshot();
      const identity = await demoWorkspaceIdentity(snapshot);
      const changed = () => new JobCtrlApiError(409, "Workspace Changed", "The browser demo workspace changed. Review the current workspace before retrying.", { error: { code: "workspace_changed" } });
      if (identity.databaseInstanceId !== options.expectedDatabaseInstanceId) throw changed();
      const workspace = new Proxy(this.workspace, {
        get: (target, property) => {
          if (property === "mutate") return ((mutation, settings = {}) => target.mutate((draft, context) => {
            if (draft.workspaceId !== snapshot.workspaceId || draft.resetEpoch !== snapshot.resetEpoch) throw changed();
            mutation(draft, context);
          }, { ...settings, expectedResetEpoch: snapshot.resetEpoch })) satisfies DemoWorkspaceRepository["mutate"];
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const api = this.api.forRequest(workspace);
      try {
        const result = await this.dispatch<T>(api, new DemoFeatureHttpAdapter(api, workspace), method, segments, options);
        const current = await this.workspace.snapshot();
        if (current.workspaceId !== snapshot.workspaceId || current.resetEpoch !== snapshot.resetEpoch) throw changed();
        return result;
      } finally { api.dispose(); }
    }
    return this.dispatch<T>(this.api, this.features, method, segments, options);
  }

  private async dispatch<T>(api: DemoApiClientAdapter, features: DemoFeatureHttpAdapter, method: HttpMethod, segments: readonly string[], options: HttpRequestOptions): Promise<T> {
    const feature = await features.json(method, segments, options);
    if (feature.handled) return feature.value as T;
    for (const candidate of routes) {
      if (candidate.method !== method) continue;
      const parameters = matchPath(candidate.segments, segments);
      if (!parameters) continue;
      const args = candidate.arguments.map((argument) =>
        argument === "$body"
          ? options.body
          : argument === "$query"
            ? (options.query ?? {})
            : parameters[argument],
      );
      if (threadWrites.has(candidate.operation)) {
        return (await api.executeHttpOutreachCommand(
          candidate.operation,
          args,
          options.body,
        )) as T;
      }
      const invoke = api[candidate.operation] as (
        ...values: unknown[]
      ) => Promise<unknown>;
      return (await invoke.apply(api, args)) as T;
    }
    if (method === "POST" && segments[1] === "actions") {
      throw new DemoCapabilityError(segments[2] ?? "action");
    }
    throw new JobCtrlApiError(
      404,
      "Not Found",
      "This browser demo route does not exist.",
    );
  }

  blob(
    method: "GET",
    path: string,
    options: Pick<HttpRequestOptions, "query"> = {},
  ): Promise<Blob> {
    return this.features.blob(method, parsePath(path), options);
  }

  text(
    method: "GET",
    path: string,
    options: Pick<HttpRequestOptions, "query"> = {},
  ): Promise<string> {
    return this.features.text(method, parsePath(path), options);
  }
}

function route(
  method: HttpMethod,
  path: string,
  operation: keyof DemoApiClientPort,
  ...args: string[]
): Route {
  return {
    method,
    segments: path.slice(1).split("/"),
    operation,
    arguments: args,
  };
}

function parsePath(path: string): readonly string[] {
  if (
    !path.startsWith("/v1/") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\")
  ) {
    throw new JobCtrlApiError(
      400,
      "Bad Request",
      "Demo feature requests require a /v1/ path.",
    );
  }
  let segments: string[];
  try {
    segments = path.slice(1).split("/").map(decodeURIComponent);
  } catch {
    throw new JobCtrlApiError(
      400,
      "Bad Request",
      "The demo request path is malformed.",
    );
  }
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    throw new JobCtrlApiError(
      400,
      "Bad Request",
      "The demo request path is malformed.",
    );
  }
  return segments;
}

function matchPath(
  pattern: readonly string[],
  segments: readonly string[],
): ParametersByName | null {
  if (pattern.length !== segments.length) return null;
  const parameters: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]!;
    const actual = segments[index]!;
    if (expected.startsWith(":")) parameters[expected.slice(1)] = actual;
    else if (expected !== actual) return null;
  }
  return parameters;
}
