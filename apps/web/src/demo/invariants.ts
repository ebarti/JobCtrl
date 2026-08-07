import { DEMO_CAPABILITY_MANIFEST } from "./capabilities.js";
import { isDemoArtifactUrl } from "./artifacts.js";
import { DEMO_ROUTE_NAMES, type DemoRouteName, type DemoSeed } from "./contracts.js";
import { scanDemoPrivacy } from "./privacy.js";
import { ProfileSchema, QA_DEMO_SHARED_LIFECYCLE_STATES } from "@jobctrl/contracts";

const CLOSED_ACTIVE_STATES: ReadonlySet<string> = new Set([
  "closed",
  "expired",
  "removed",
  "location_incompatible",
]);

function assertUnique(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`Demo ${label} identifiers must be unique.`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Demo ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertOkEnvelope(value: unknown, label: string): void {
  if (asRecord(value, label).ok !== true) {
    throw new TypeError(`Demo ${label} must be a successful server envelope.`);
  }
}

function assertListEnvelope(value: unknown, label: string): readonly unknown[] {
  const response = asRecord(value, label);
  assertOkEnvelope(response, label);
  if (!Array.isArray(response.items)) {
    throw new TypeError(`Demo ${label} must contain an items array.`);
  }
  const pagination = asRecord(response.pagination, `${label}.pagination`);
  if (typeof pagination.total !== "number" || pagination.total !== response.items.length) {
    throw new TypeError(`Demo ${label} pagination total must equal its item count.`);
  }
  return response.items;
}

function assertItemsEnvelope(value: unknown, label: string): readonly unknown[] {
  const response = asRecord(value, label);
  assertOkEnvelope(response, label);
  if (!Array.isArray(response.items)) {
    throw new TypeError(`Demo ${label} must contain an items array.`);
  }
  return response.items;
}

function requireDetail(
  details: unknown,
  id: string,
  label: string,
  { envelope = true }: { readonly envelope?: boolean } = {},
): void {
  const detail = asRecord(details, `${label} details`)[id];
  if (detail === undefined) {
    throw new TypeError(`Demo ${label} ${id} is missing its direct-link detail.`);
  }
  if (envelope) {
    assertOkEnvelope(detail, `${label} ${id}`);
  }
}

function readString(value: unknown, key: string, label: string): string {
  const result = asRecord(value, label)[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new TypeError(`Demo ${label}.${key} must be a non-empty string.`);
  }
  return result;
}

/**
 * The route-tour records are explanatory copy, not a second data source. This
 * verifies the actual ApiClientPort-shaped responses and their direct-link
 * graph so a P2 adapter can serve every seeded route without inventing data.
 */
function assertDemoReadModelInvariants(seed: DemoSeed): void {
  const model = seed.readModel;
  assertOkEnvelope(model.dashboard.health, "health");
  assertOkEnvelope(model.dashboard.summary, "dashboard summary");
  assertOkEnvelope(model.dashboard.digest, "digest");
  const dashboardTotals = asRecord(model.dashboard.summary, "dashboard summary").totals;
  if (typeof asRecord(dashboardTotals, "dashboard totals").jobs !== "number") {
    throw new TypeError("Demo dashboard totals must include a numeric job count.");
  }
  const activityItems = assertListEnvelope(model.dashboard.activity, "activity");
  for (const item of activityItems) {
    requireDetail(model.dashboard.activityEvents, readString(item, "eventId", "activity item"), "activity event");
  }
  for (const sourceHealth of model.dashboard.summary.sourceHealth) {
    if (sourceHealth.lastRunId !== null) {
      requireDetail(model.runs.details, sourceHealth.lastRunId, `source health ${sourceHealth.sourceId} workflow run`, {
        envelope: false,
      });
    }
  }

  const jobs = assertListEnvelope(model.jobs.list, "jobs list");
  const jobIds = jobs.map((item) => readString(item, "jobKey", "job list item"));
  assertUnique(jobIds, "job");
  if (asRecord(dashboardTotals, "dashboard totals").jobs !== jobIds.length) {
    throw new TypeError("Demo dashboard job total must match the jobs list.");
  }
  const activeJobs = model.jobs.list.items.filter(
    (item) =>
      item.deletedAt === null &&
      item.hiddenAt === null &&
      !CLOSED_ACTIVE_STATES.has(item.activeState),
  );
  const dashboardFailureTotal = asRecord(
    dashboardTotals,
    "dashboard totals",
  ).failures;
  if (typeof dashboardFailureTotal !== "number") {
    throw new TypeError(
      "Demo dashboard totals must include a numeric failure count.",
    );
  }
  const failedJobs = activeJobs.filter(
    (item) => item.currentState === "failed",
  );
  if (dashboardFailureTotal !== failedJobs.length) {
    throw new TypeError(
      "Demo dashboard failure total must match the failed jobs KPI query.",
    );
  }
  const artifactUrls: ReadonlySet<string> = new Set(
    Object.values(seed.artifacts).map((asset) => asset.url),
  );
  for (const item of jobs) {
    const jobId = readString(item, "jobKey", "job list item");
    requireDetail(model.jobs.details, jobId, "job");
    const job = model.jobs.list.items.find((candidate) => candidate.jobKey === jobId)!;
    const detailJob = model.jobs.details[jobId]!.job;
    for (const key of [
      "currentStage",
      "currentSubstage",
      "currentState",
      "errorCode",
      "errorMessage",
      "nextAction",
    ] as const) {
      if (detailJob[key] !== job[key]) {
        throw new TypeError(
          `Demo job ${jobId} has inconsistent list and detail ${key}.`,
        );
      }
    }
    for (const urlKey of ["postingSourceUrl", "applicationUrl"]) {
      const url = readString(item, urlKey, `job ${jobId}`) as (typeof artifactUrls extends Set<infer T> ? T : never);
      if (!artifactUrls.has(url)) {
        throw new TypeError(`Demo job ${jobId} references a missing bundled preview asset.`);
      }
    }
  }

  assertOkEnvelope(model.discovery.settings, "discovery settings");
  assertOkEnvelope(model.discovery.sources, "discovery sources");
  assertOkEnvelope(model.discovery.compensationSources, "compensation sources");
  assertOkEnvelope(model.discovery.locatorCandidates, "source locator candidates");
  assertOkEnvelope(model.discovery.quarantine, "discovery quarantine");
  assertOkEnvelope(model.discovery.manualCapture, "manual capture queue");
  assertOkEnvelope(model.discovery.roleMatchFeedback, "role-match feedback");
  const sourceIds = new Set(model.discovery.sources.sources.map((source) => source.sourceId));
  for (const source of model.discovery.sources.sources) {
    const preview = model.discovery.sourcePreviews[source.sourceId];
    if (preview === undefined) {
      throw new TypeError(`Demo source ${source.sourceId} is missing its direct-link preview.`);
    }
    assertOkEnvelope(preview, `source preview ${source.sourceId}`);
    if (source.lastRunId !== null) {
      requireDetail(model.runs.details, source.lastRunId, `source ${source.sourceId} workflow run`, {
        envelope: false,
      });
    }
  }
  for (const sourceId of Object.keys(model.discovery.sourcePreviews)) {
    if (!sourceIds.has(sourceId)) {
      throw new TypeError(`Demo source preview ${sourceId} has no source record.`);
    }
  }
  for (const item of model.discovery.quarantine.entries) {
    if (!sourceIds.has(item.sourceId)) {
      throw new TypeError(`Demo quarantine entry ${item.jobKey} references a missing source.`);
    }
  }
  for (const item of model.discovery.manualCapture.items) {
    if (item.sourceId === null || !sourceIds.has(item.sourceId)) {
      throw new TypeError(`Demo manual capture ${item.itemId} references a missing source.`);
    }
  }

  assertOkEnvelope(model.evidence, "evidence map");
  const artifacts = assertListEnvelope(model.materials.list, "artifacts list");
  const artifactIds = artifacts.map((item) => readString(item, "artifactId", "artifact list item"));
  assertUnique(artifactIds, "artifact");
  for (const item of artifacts) {
    const artifactId = readString(item, "artifactId", "artifact list item");
    const artifact = asRecord(item, `artifact ${artifactId}`);
    const jobId = readString(artifact, "jobKey", `artifact ${artifactId}`);
    if (!jobIds.includes(jobId)) {
      throw new TypeError(`Demo artifact ${artifactId} references a missing job.`);
    }
    const localPath = readString(artifact, "localPath", `artifact ${artifactId}`);
    if (!artifactUrls.has(localPath)) {
      throw new TypeError(`Demo artifact ${artifactId} references a missing bundled preview asset.`);
    }
    requireDetail(model.materials.details, artifactId, "artifact");
    const detailArtifact = asRecord(model.materials.details[artifactId]?.artifact, `artifact detail ${artifactId}`);
    for (const key of ["artifactId", "jobKey", "status", "localPath"] as const) {
      if (detailArtifact[key] !== artifact[key]) {
        throw new TypeError(`Demo artifact ${artifactId} has inconsistent list and detail ${key}.`);
      }
    }
  }
  for (const artifactId of Object.keys(model.materials.details)) {
    if (!artifactIds.includes(artifactId)) {
      throw new TypeError(`Demo artifact detail ${artifactId} has no list record.`);
    }
  }
  for (const jobId of jobIds) {
    const job = model.jobs.list.items.find((item) => item.jobKey === jobId);
    const detail = model.jobs.details[jobId];
    const ownedArtifactIds = artifacts
      .filter((item) => readString(item, "jobKey", `artifact for ${jobId}`) === jobId)
      .map((item) => readString(item, "artifactId", `artifact for ${jobId}`));
    if (job?.artifactCount !== ownedArtifactIds.length || detail?.job.artifactCount !== ownedArtifactIds.length) {
      throw new TypeError(`Demo job ${jobId} artifact count must match its material projections.`);
    }
    const detailArtifactIds = detail?.artifacts.map((item) => item.artifactId) ?? [];
    if (
      detailArtifactIds.length !== ownedArtifactIds.length ||
      !ownedArtifactIds.every((artifactId) => detailArtifactIds.includes(artifactId))
    ) {
      throw new TypeError(`Demo job ${jobId} detail artifacts must match its material projections.`);
    }
  }
  for (const [jobId, draft] of Object.entries(model.materials.resumeReviewDrafts)) {
    if (!jobIds.includes(jobId)) {
      throw new TypeError(`Demo resume review draft ${jobId} references a missing job.`);
    }
    assertOkEnvelope(draft, `resume review draft ${jobId}`);
  }
  for (const [jobId, feedback] of Object.entries(model.materials.resumeReviewFeedback)) {
    if (!jobIds.includes(jobId)) {
      throw new TypeError(`Demo resume review feedback ${jobId} references a missing job.`);
    }
    assertOkEnvelope(feedback, `resume review feedback ${jobId}`);
  }
  assertOkEnvelope(model.materials.resumeTemplates, "resume templates");
  for (const templateId of Object.keys(model.materials.templateDetails)) {
    assertOkEnvelope(model.materials.templateDetails[templateId], `resume template ${templateId}`);
  }

  assertOkEnvelope(model.apply.queue, "apply review queue");
  for (const item of model.apply.queue.items) {
    if (!jobIds.includes(item.jobKey)) {
      throw new TypeError(`Demo apply queue ${item.jobKey} references a missing job.`);
    }
    for (const artifactId of [item.materialsPreview.resumeTextArtifactId, item.materialsPreview.resumePdfArtifactId]) {
      if (artifactId !== null && !artifactIds.includes(artifactId)) {
        throw new TypeError(`Demo apply queue ${item.jobKey} references a missing artifact.`);
      }
    }
    if (item.latestApplyRun !== null && model.runs.details[item.latestApplyRun.runId] === undefined) {
      throw new TypeError(`Demo apply queue ${item.jobKey} references a missing workflow run.`);
    }
  }

  const runs = assertListEnvelope(model.runs.list, "workflow runs");
  const runIds = runs.map((item) => readString(item, "runId", "workflow run"));
  assertUnique(runIds, "workflow run");
  for (const run of runs) {
    const runId = readString(run, "runId", "workflow run");
    requireDetail(model.runs.details, runId, "workflow run", { envelope: false });
    if (!activityItems.some((item) => asRecord(item, "activity item").workflowId === runId)) {
      throw new TypeError(`Demo workflow run ${runId} is missing its reviewable activity.`);
    }
    const jobId = readString(run, "jobKey", `workflow run ${runId}`);
    if (jobId && !jobIds.includes(jobId)) {
      throw new TypeError(`Demo workflow run ${runId} references a missing job.`);
    }
  }

  assertOkEnvelope(model.analytics.summary, "outcome analytics");
  assertOkEnvelope(model.analytics.outcomes, "application outcomes");
  for (const outcome of model.analytics.outcomes.outcomes) {
    if (!jobIds.includes(outcome.jobKey)) {
      throw new TypeError(`Demo outcome ${outcome.outcomeId} references a missing job.`);
    }
  }
  for (const [jobId, outcomes] of Object.entries(model.analytics.jobOutcomes)) {
    if (!jobIds.includes(jobId)) {
      throw new TypeError(`Demo job outcomes ${jobId} references a missing job.`);
    }
    assertOkEnvelope(outcomes, `job outcomes ${jobId}`);
  }
  for (const jobId of jobIds) {
    if (model.analytics.jobOutcomes[jobId] === undefined) {
      throw new TypeError(`Demo job ${jobId} is missing its application-outcome detail.`);
    }
  }

  assertOkEnvelope(model.profile.config, "profile");
  assertOkEnvelope(model.profile.credentials, "credentials");
  assertOkEnvelope(model.settings, "settings");
  const contacts = assertItemsEnvelope(model.contacts.list, "contacts list");
  for (const contact of contacts) {
    const contactId = readString(contact, "contactId", "contact list item");
    requireDetail(model.contacts.details, contactId, "contact");
    const jobId = asRecord(contact, `contact ${contactId}`).jobId;
    if (typeof jobId === "string" && !jobIds.includes(jobId)) {
      throw new TypeError(`Demo contact ${contactId} references a missing job.`);
    }
  }
  const researchTasks = assertItemsEnvelope(model.contacts.researchTasks, "research task list");
  for (const task of researchTasks) {
    const taskId = readString(task, "taskId", "research task");
    requireDetail(model.contacts.researchTaskDetails, taskId, "research task");
  }

  assertOkEnvelope(model.outreach.thread, "outreach thread");
  assertOkEnvelope(model.outreach.dueFollowUps, "outreach follow-ups");
  const thread = model.outreach.thread.thread;
  if (thread === null || !model.contacts.details[thread.contactId] || !jobIds.includes(thread.jobId ?? "")) {
    throw new TypeError("Demo outreach thread must reference a seeded contact and job.");
  }
  for (const followUp of model.outreach.dueFollowUps.followUps) {
    if (followUp.threadId !== thread.threadId || followUp.contactId !== thread.contactId) {
      throw new TypeError("Demo follow-up must reference the seeded outreach thread and contact.");
    }
  }

  const runStates = new Set(model.runs.list.items.map((run) => run.status));
  for (const state of ["in_progress", "succeeded", "failed", "canceled"] as const) {
    if (!runStates.has(state)) {
      throw new TypeError(`Demo read model is missing workflow lifecycle state: ${state}.`);
    }
  }
  if (!model.runs.details["run-failed-quality-gate"]?.retryable) {
    throw new TypeError("Demo failed workflow must retain its retryable flag.");
  }
  if (!model.jobs.list.items.some((item) => item.currentState === "blocked")) {
    throw new TypeError("Demo read model is missing a blocked job.");
  }
  const sharedStates = new Set([
    ...model.runs.list.items.map((run) => run.status),
    ...model.jobs.list.items.map((item) => item.currentState),
  ]);
  for (const state of QA_DEMO_SHARED_LIFECYCLE_STATES) {
    if (!sharedStates.has(state)) {
      throw new TypeError(`Demo read model is missing shared QA lifecycle state: ${state}.`);
    }
  }
  if (!model.jobs.list.items.some((item) => item.scoreStaleness.isStale)) {
    throw new TypeError("Demo read model is missing a stale-policy job.");
  }
  if (!model.materials.list.items.some((item) => item.status === "accepted")) {
    throw new TypeError("Demo read model is missing an accepted artifact.");
  }
  if (!model.apply.queue.items.some((item) => item.review.state === "pending" && item.latestApplyRun?.dryRun)) {
    throw new TypeError("Demo read model is missing an approval-gated dry-run rehearsal.");
  }
  const outcomeKinds = new Set(model.analytics.outcomes.outcomes.map((outcome) => outcome.kind));
  for (const kind of ["interview", "rejection", "offer"] as const) {
    if (!outcomeKinds.has(kind)) {
      throw new TypeError(`Demo read model is missing outcome lifecycle: ${kind}.`);
    }
  }
  if (!model.contacts.list.items.some((contact) => contact.allConfirmed)) {
    throw new TypeError("Demo read model is missing a confirmed contact.");
  }
  if (!model.outreach.dueFollowUps.followUps.some((followUp) => followUp.state === "scheduled")) {
    throw new TypeError("Demo read model is missing a scheduled follow-up.");
  }
}

/** Focused release invariants until runtime response schemas exist. */
export function assertDemoSeedInvariants(seed: DemoSeed): void {
  const routeNames = Object.keys(seed.routeData) as DemoRouteName[];
  if (routeNames.length !== DEMO_ROUTE_NAMES.length || !DEMO_ROUTE_NAMES.every((route) => route in seed.routeData)) {
    throw new TypeError("Demo seed must cover every public demo route.");
  }
  for (const route of DEMO_ROUTE_NAMES) {
    if (seed.routeData[route].length === 0) {
      throw new TypeError(`Demo route ${route} must have synthetic data.`);
    }
  }

  assertUnique(seed.scenarios.map((scenario) => scenario.scenarioId), "scenario");
  assertUnique(seed.receipts.map((receipt) => receipt.receiptId), "receipt");

  for (const scenario of seed.scenarios) {
    const [queuedStep, runningStep] = scenario.steps;
    if (DEMO_CAPABILITY_MANIFEST[scenario.operation].class !== "simulated_async") {
      throw new TypeError(`Demo scenario ${scenario.scenarioId} must target simulated async capability.`);
    }
    if (queuedStep.state !== "queued" || runningStep.state !== "running") {
      throw new TypeError(`Demo scenario ${scenario.scenarioId} must start queued then running.`);
    }
    if (queuedStep.at.offsetMinutes > runningStep.at.offsetMinutes) {
      throw new TypeError(`Demo scenario ${scenario.scenarioId} has invalid step order.`);
    }
    if (runningStep.at.offsetMinutes > scenario.terminal.at.offsetMinutes) {
      throw new TypeError(`Demo scenario ${scenario.scenarioId} has invalid terminal order.`);
    }
  }

  for (const receipt of seed.receipts) {
    if (!receipt.simulated || receipt.externalEffectOccurred) {
      throw new TypeError(`Demo receipt ${receipt.receiptId} must never record an external effect.`);
    }
  }

  for (const asset of Object.values(seed.artifacts)) {
    if (!isDemoArtifactUrl(asset.url)) {
      throw new TypeError(`Demo artifact ${asset.assetId} must use a safe bundled URL.`);
    }
  }

  // `ProfileConfigResponse.profile` is explicitly `unknown` at the API
  // boundary, so `satisfies` cannot protect fixture authors. The canonical
  // schema is the only source of truth for this profile-shaped payload.
  ProfileSchema.parse(seed.readModel.profile.config.profile);

  assertDemoReadModelInvariants(seed);

  // Credential identifiers are safe display metadata, but the generic privacy
  // scanner deliberately treats the words "API key" as a secret warning. Keep
  // scanning every other credential field and independently require this
  // read-only response to expose no configured value.
  if (seed.readModel.profile.credentials.credentials.some((credential) => credential.configured !== null)) {
    throw new TypeError("Demo credential explanation must not report configured values.");
  }
  const privacyProjection = {
    ...seed,
    readModel: {
      ...seed.readModel,
      profile: {
        ...seed.readModel.profile,
        credentials: {
          ...seed.readModel.profile.credentials,
          credentials: seed.readModel.profile.credentials.credentials.map((credential) => ({
            ...credential,
            key: "credential_identifier",
            label: "Credential identifier",
          })),
        },
      },
    },
  };
  // `materials.resume` is a canonical API discriminant, not a hostname. The
  // general-domain policy intentionally treats arbitrary dotted words as
  // domain-shaped, so exclude this one structural token from the serialized
  // privacy projection rather than weakening domain detection.
  const privacyText = JSON.stringify(privacyProjection)
    .replaceAll('"kind":"materials.resume"', '"kind":"materials_resume"')
    // This exact reserved-domain URL exists only to satisfy the production
    // manual-capture input contract. The adapter never fetches it; browser
    // previews continue to use bundled same-origin `/demo/*` assets.
    .replaceAll("https://demo.invalid/source-preview.html", "demo_manual_capture_url");
  const findings = scanDemoPrivacy(privacyText);
  if (findings.length > 0) {
    throw new TypeError(`Demo seed contains privacy needles: ${findings.join(", ")}.`);
  }
}
