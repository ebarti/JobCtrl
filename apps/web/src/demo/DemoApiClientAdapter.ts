import { JobCtrlApiError } from "@jobctrl/api-client";
import {
  ActivityListQuerySchema,
  ArtifactListQuerySchema,
  ContactListQuerySchema,
  ContactResearchListQuerySchema,
  ENDPOINTS,
  JobListQuerySchema,
  ProfileSchema,
  WorkflowRunsListQuerySchema,
  compareJobs,
  compareValues,
  paginate,
  timestampAtOrAfter,
  timestampBefore,
  type ActivityEventSummary,
  type ArtifactSummary,
  type EndpointClientMethods,
  type JobCompensationSummary,
  type JobSummary,
  type PaginatedResponse,
  type ProfileShape,
  type RequiredBulletSuggestion,
  type RequiredBulletSuggestionRequest,
  type RequiredBulletSuggestionResponse,
  type TargetRoleSuggestionRequest,
  type TargetRoleSuggestionResponse,
  type WorkflowRunSummary,
} from "@jobctrl/contracts";

import type { ApiClientPort } from "../shared/ports/ApiClientPort.js";
import type { TelemetryPort } from "../shared/ports/TelemetryPort.js";
import { isDemoArtifactUrl } from "./artifacts.js";
import type { ApiClientResponse, DemoReadModel } from "./contracts.js";
import { filterDemoJob } from "./job-filter.js";
import {
  DemoLocalCommandExecutor,
  type DemoBrowserLocalCommand,
  type DemoLocalCommandExecutorOptions,
} from "./DemoLocalCommandExecutor.js";
import {
  DemoExternalRehearsalExecutor,
  type DemoExternalRehearsalExecutorOptions,
  type DemoInitialExternalRehearsalOperation,
} from "./DemoExternalRehearsalExecutor.js";
import { DemoCapabilityError } from "./ports.js";
import {
  DemoScenarioEngine,
  type DemoScenarioEngineOptions,
} from "./DemoScenarioEngine.js";
import type { DemoWorkspaceRepository } from "./workspace/DemoWorkspaceRepository.js";

type CacheKey = number | string | undefined;

const IN_MEMORY_JOB_SORT_FIELDS = new Set([
  "source",
  "compensation_min_eur",
  "compensation_max_eur",
  "compensation_posted",
  "compensation_market",
  "compensation_confidence",
  "compensation_warnings",
  "apply_status",
]);

// Keep the browser-local synthetic profile inspection aligned with the production rule set.
const VAGUE_RELEVANCE = /\b(responsible for|worked on|helped(?: with)?|participated in|various|multiple tasks|duties included)\b/i;
const MAX_INSPECTED_REQUIRED_BULLETS = 512;
const MAX_REQUIRED_COACHING_ENTRIES = 256;
const MAX_REQUIRED_COACHING_SOURCE_ROWS = 4_096;
const RESULT_LANGUAGE = /\b(reduced|decreased|lowered|cut|improved|increased|raised|boosted|grew|accelerated|shortened|eliminated|prevented|faster|slower|fewer)\b/i;
const RESULT_TARGET = /\b(latency|response time|load time|uptime|downtime|error rate|errors?|defects?|incidents?|costs?|expenses?|spend|revenue|conversion|retention|throughput|processing time|cycle time|reliability|performance)\b/i;
const RESULT_DIRECTION = /\b(reduced|reduction|decreased|decrease|lowered|cut|improved|improvement|increased|increase|raised|boosted|grew|growth|accelerated|shortened|eliminated|prevented|faster|slower|fewer|saved|savings)\b/i;
const RESULT_QUANTITY = /(?:\b\d+(?:[.,]\d+)?\s*(?:%|percent\b|ms\b|milliseconds?\b|seconds?\b|minutes?\b|hours?\b|days?\b)|[$£€]\s*\d+(?:[.,]\d+)?)/i;
const BARE_RESULT_QUANTITY = /^(?:\d+(?:[.,]\d+)?\s*(?:%|percent|ms|milliseconds?|seconds?|minutes?|hours?|days?)|[$£€]\s*\d+(?:[.,]\d+)?)$/i;

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function claimSignature(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const CLAIM_CONNECTORS = new Set([
  "a", "an", "and", "at", "be", "been", "by", "for", "from", "in", "is", "of", "on", "role", "s", "the", "this", "to", "was", "were", "with",
]);

function claimFacts(value: string): string[] {
  return claimSignature(value.normalize("NFKC")
    .replace(/([\p{L}\p{N}])['’]s\b/gu, "$1")
    .replace(/%/g, " percent "))
    .split(" ")
    .filter((token) => (token.length > 1 || /^\d$/.test(token))
      && !CLAIM_CONNECTORS.has(token)
      && !RESULT_LANGUAGE.test(token))
    .map((token) => token.length > 5 && token.endsWith("sses")
      ? token.slice(0, -2)
      : token.length > 4 && token.endsWith("ies")
      ? `${token.slice(0, -3)}y`
      : token.length > 4 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("is")
        ? token.slice(0, -1)
        : token);
}

function addsOutcomeDetail(sourceText: string, outcome: string): boolean {
  if (!RESULT_LANGUAGE.test(outcome) || !RESULT_TARGET.test(outcome)) return false;
  // Context such as "during planning" or "across teams" does not add a
  // result. Compare only result targets and result measures, never arbitrary
  // lexical novelty in a restated outcome.
  const resultTargets = (value: string) => Array.from(
    value.matchAll(new RegExp(RESULT_TARGET.source, "gi")),
    ([target]) => claimFacts(target).join(" "),
  );
  const resultMeasures = (value: string) => Array.from(
    value.matchAll(new RegExp(RESULT_QUANTITY.source, "gi")),
    ([measure]) => measure.toLowerCase().replace(/\s+/g, "")
      .replace(/percent\b/g, "%")
      .replace(/milliseconds?\b/g, "ms"),
  );
  const sourceTargets = new Set(resultTargets(sourceText));
  const sourceMeasures = new Set(resultMeasures(sourceText));
  return resultTargets(outcome).some((target) => !sourceTargets.has(target))
    || resultMeasures(outcome).some((measure) => !sourceMeasures.has(measure));
}

function hasVerifiedResultMeasure(
  evidence: ProfileShape["resume"]["experience_entries"][number]["achievement_evidence"][number],
): boolean {
  if (evidence.evidence_strength !== "verified" || !evidence.user_confirmed) return false;
  const sourceDescribesResult = RESULT_LANGUAGE.test(evidence.source_text)
    && RESULT_TARGET.test(evidence.source_text);
  return evidence.metrics.some((metric) => RESULT_QUANTITY.test(metric)
    && ((BARE_RESULT_QUANTITY.test(metric.trim()) && sourceDescribesResult)
      || (RESULT_DIRECTION.test(metric) && RESULT_TARGET.test(metric))));
}

function boundedExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

function isSubstantiveEvidence(
  evidence: ProfileShape["resume"]["experience_entries"][number]["achievement_evidence"][number],
): boolean {
  // Saved wording is not independent proof, however novel it sounds. The
  // canonical evidence-strength field is the available verification signal;
  // user confirmation is checked separately before suppressing the question.
  return evidence.evidence_strength === "verified";
}

function truncatedResponse(
  profileVersion: number,
): RequiredBulletSuggestionResponse {
  return {
    ok: true,
    profileVersion,
    suggestions: [],
    strategy: "deterministic_rules_v1",
    modelUsed: false,
    truncated: true,
  };
}

function generateDemoRequiredBulletSuggestions(
  profile: ProfileShape,
  profileVersion: number,
  maximumSuggestions: number,
): RequiredBulletSuggestionResponse {
  const suggestions: RequiredBulletSuggestion[] = [];
  const entries = profile.resume.experience_entries;
  const requiredByExperience = profile.resume.tailoring_rules?.required_bullets_by_experience_id ?? {};
  // The limit is checked before reading bullet or evidence contents. A profile
  // beyond this budget cannot prove identity uniqueness, so fail closed instead
  // of producing an apparently applicable suggestion from a partial scan.
  if (entries.length > MAX_REQUIRED_COACHING_ENTRIES) return truncatedResponse(profileVersion);
  const entryIds = new Set(entries.map((entry) => entry.id));
  let sourceRows = 0;
  let orphanRequiredPins = false;
  for (const experienceId in requiredByExperience) {
    if (!Object.hasOwn(requiredByExperience, experienceId)) continue;
    const pins = requiredByExperience[experienceId]!;
    sourceRows += 1 + pins.length;
    if (sourceRows > MAX_REQUIRED_COACHING_SOURCE_ROWS) return truncatedResponse(profileVersion);
    if (pins.length > 0 && !entryIds.has(experienceId)) orphanRequiredPins = true;
  }
  for (const entry of entries) {
    sourceRows += 1 + entry.bullets.length + entry.achievement_evidence.length;
    if (sourceRows > MAX_REQUIRED_COACHING_SOURCE_ROWS) return truncatedResponse(profileVersion);
  }
  const entryIdCounts = new Map<string, number>();
  for (const entry of entries) entryIdCounts.set(entry.id, (entryIdCounts.get(entry.id) ?? 0) + 1);
  const achievementIdCounts = new Map<string, number>();
  for (const entry of entries) {
    for (const evidence of entry.achievement_evidence) {
      if (evidence.id.trim()) {
        achievementIdCounts.set(evidence.id, (achievementIdCounts.get(evidence.id) ?? 0) + 1);
      }
    }
  }
  let inspectedBullets = 0;
  let scanTruncated = orphanRequiredPins;

  scan: for (const [experienceIndex, entry] of entries.entries()) {
    if (suggestions.length > maximumSuggestions) break;
    // A save addresses Required pins by experience ID. Duplicate IDs cannot be
    // resolved to one owning entry, even when a positional path is available.
    if (entryIdCounts.get(entry.id) !== 1) continue;
    const requiredBullets = Object.hasOwn(requiredByExperience, entry.id)
      ? requiredByExperience[entry.id] ?? [] : [];
    const bulletIndexesByText = new Map<string, number[]>();
    for (const [index, bullet] of entry.bullets.entries()) {
      const indexes = bulletIndexesByText.get(bullet) ?? [];
      indexes.push(index);
      bulletIndexesByText.set(bullet, indexes);
    }
    const requiredCounts = new Map<string, number>();
    for (const bullet of requiredBullets) {
      requiredCounts.set(bullet, (requiredCounts.get(bullet) ?? 0) + 1);
    }
    const achievementsBySource = new Map<string, typeof entry.achievement_evidence>();
    for (const evidence of entry.achievement_evidence) {
      const source = normalizedText(evidence.source_text);
      const matches = achievementsBySource.get(source) ?? [];
      matches.push(evidence);
      achievementsBySource.set(source, matches);
    }
    for (const [requiredBulletIndex, requiredText] of requiredBullets.entries()) {
      if (suggestions.length > maximumSuggestions) break;
      if (inspectedBullets >= MAX_INSPECTED_REQUIRED_BULLETS) {
        scanTruncated = true;
        break scan;
      }
      inspectedBullets += 1;
      if (
        requiredText.length > 2_000
        || entry.id.length > 160
        || !entry.id.trim()
        || entry.title.length > 160
        || !entry.title.trim()
        || entry.company.length > 160
        || !entry.company.trim()
      ) {
        scanTruncated = true;
        continue;
      }
      // Required pins store text, not an occurrence ID. An identical bullet or
      // pin has no provable one-to-one mapping, so never guess which to edit.
      if (
        bulletIndexesByText.get(requiredText)?.length !== 1
        || requiredCounts.get(requiredText) !== 1
      ) continue;
      const bulletIndex = bulletIndexesByText.get(requiredText)![0]!;
      const originalText = entry.bullets[bulletIndex]!;
      const normalizedOriginal = normalizedText(originalText);
      if (!normalizedOriginal) continue;
      const proposedTextCollides = normalizedOriginal !== originalText
        && (bulletIndexesByText.has(normalizedOriginal) || requiredCounts.has(normalizedOriginal));
      const matchingAchievements = achievementsBySource.get(normalizedOriginal) ?? [];
      // Duplicate bullets can have distinct durable evidence identities. Do not
      // guess which one owns an occurrence when the snapshot cannot prove it.
      // Invalid IDs still count as matching rows; they cannot make another row
      // unique by disappearing from the identity check.
      const onlyMatch = matchingAchievements.length === 1 ? matchingAchievements[0] : undefined;
      const uniqueMatch = onlyMatch?.id.trim() && onlyMatch.id.length <= 240 ? onlyMatch : undefined;
      const ambiguousAchievement = matchingAchievements.length > 1
        || (onlyMatch !== undefined && uniqueMatch === undefined)
        || (uniqueMatch !== undefined && achievementIdCounts.get(uniqueMatch.id) !== 1);
      const achievement = ambiguousAchievement ? undefined : uniqueMatch;
      const hasSubstantiveEvidence = achievement ? isSubstantiveEvidence(achievement) : false;
      // An extracted number such as "10 projects" measures action scale, not
      // necessarily a result. Restated actions also need a result, not a new
      // punctuation mark or a different verb for the same activity.
      const hasOutcome = Boolean(achievement && (
        addsOutcomeDetail(achievement.source_text, achievement.outcome)
        || hasVerifiedResultMeasure(achievement)
      ));
      const needsEvidence = !hasSubstantiveEvidence
        || achievement?.evidence_strength === "inferred"
        || achievement?.evidence_strength === "draft"
        || achievement?.user_confirmed === false;
      const identityKind = achievement ? "canonical_achievement" as const : "snapshot_bullet" as const;
      const sourceId = achievement
        ? achievement.id
        : `profile:v${profileVersion}:experience[${experienceIndex}]:bullet[${bulletIndex}]`;
      const source = {
        sourceId,
        identityKind,
        excerpt: boundedExcerpt(originalText),
        fieldPath: `profile.resume.experience_entries[${experienceIndex}].bullets[${bulletIndex}]`,
        experienceId: entry.id,
        experienceTitle: entry.title,
        experienceCompany: entry.company,
        bulletIndex,
        requiredBulletIndex,
      };
      const idPrefix = `profile:v${profileVersion}:experience[${experienceIndex}]:bullet[${bulletIndex}]:required[${requiredBulletIndex}]`;

      if (normalizedOriginal !== originalText) {
        const blockedProfileInputKey = entry.id === "__proto__";
        const canApply = !ambiguousAchievement && !proposedTextCollides && !blockedProfileInputKey;
        suggestions.push({
          id: `${idPrefix}:grammar`,
          kind: "grammar",
          originalText,
          proposedText: canApply ? normalizedOriginal : null,
          canApply,
          guidance: blockedProfileInputKey
            ? "This saved experience ID prevents a safe profile save. Correct the experience identity before editing this Required bullet."
            : proposedTextCollides
            ? "Whitespace cleanup would duplicate another saved bullet or Required pin. Resolve the duplicate identity before editing this text."
            : ambiguousAchievement
              ? "The saved achievement identity is ambiguous. Resolve it and edit whitespace manually; this suggestion cannot choose one record."
            : "Trim leading or trailing space and collapse repeated whitespace without changing the words or facts.",
          source,
        });
      }
      if (VAGUE_RELEVANCE.test(normalizedOriginal)) {
        suggestions.push({
          id: `${idPrefix}:relevance`,
          kind: "relevance",
          originalText,
          proposedText: null,
          canApply: false,
          guidance: "Which specific responsibility or result makes this required bullet relevant? Add only details you can verify in the normal editor.",
          source,
        });
      }
      if (!hasOutcome) {
        suggestions.push({
          id: `${idPrefix}:achievement-framing`,
          kind: "achievement_framing",
          originalText,
          proposedText: null,
          canApply: false,
          guidance: "What truthful outcome, scale, frequency, or comparison followed from this action? Leave it unchanged if no supported result is available.",
          source,
        });
      }
      if (needsEvidence) {
        suggestions.push({
          id: `${idPrefix}:missing-evidence`,
          kind: "missing_evidence",
          originalText,
          proposedText: null,
          canApply: false,
          guidance: !achievement
            ? "No unambiguous canonical achievement record matches this bullet. Which saved source supports its claim? Add only evidence you can verify in the normal editor."
            : achievement.evidence_strength === "draft"
              || achievement.evidence_strength === "inferred"
              || !achievement.user_confirmed
              ? "This achievement is marked draft, inferred, or unconfirmed. Which source verifies its claim? Review and confirm it in the normal editor before strengthening the wording."
              : "The matching achievement is not marked verified. Which independent source confirms the claim or metric? Add only verified details in the normal editor.",
          source,
        });
      }
    }
  }

  return {
    ok: true,
    profileVersion,
    suggestions: suggestions.slice(0, maximumSuggestions),
    strategy: "deterministic_rules_v1",
    modelUsed: false,
    truncated: scanTruncated || suggestions.length > maximumSuggestions,
  };
}

export class DemoResourceNotFoundError extends JobCtrlApiError {
  readonly code: string;
  readonly resourceId: string;

  constructor(code: string, resourceId: string) {
    super(404, code);
    this.name = "DemoResourceNotFoundError";
    this.code = code;
    this.resourceId = resourceId;
  }
}

export interface DemoApiClientAdapterOptions extends DemoLocalCommandExecutorOptions {
  readonly scenario?: DemoScenarioEngineOptions;
  readonly external?: DemoExternalRehearsalExecutorOptions;
  readonly telemetry?: TelemetryPort;
}

/** Browser-local adapter for reads, local commands, and deterministic scenarios. */
export class DemoApiClientAdapter implements ApiClientPort {
  private readonly localCommands: DemoLocalCommandExecutor;
  private readonly scenarios: DemoScenarioEngine;
  private readonly externalRehearsals: DemoExternalRehearsalExecutor;
  private readonly telemetry: TelemetryPort | undefined;

  constructor(
    private readonly workspace: DemoWorkspaceRepository,
    options: DemoApiClientAdapterOptions = {},
  ) {
    this.localCommands = new DemoLocalCommandExecutor(workspace, options);
    this.telemetry = options.telemetry;
    this.scenarios = new DemoScenarioEngine(
      workspace,
      options.scenario ?? {
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.createId ? { createId: options.createId } : {}),
      },
    );
    this.externalRehearsals = new DemoExternalRehearsalExecutor(
      workspace,
      options.external ?? {
        opener: () => null,
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.createId ? { createId: options.createId } : {}),
      },
    );
    Object.assign(
      this,
      Object.fromEntries(
        Object.values(ENDPOINTS)
          .filter((endpoint) => endpoint.demo.class === "unavailable")
          .map((endpoint) => [endpoint.name, this.unsupported(endpoint.name)]),
      ),
    );
  }

  initialize(): Promise<void> {
    return this.scenarios.initialize();
  }

  dispose(): void {
    this.scenarios.dispose();
  }

  health() {
    return this.read((model) => model.dashboard.health);
  }

  dashboardSummary() {
    return this.read((model) => model.dashboard.summary);
  }

  pipelineOperations = this.unsupported("pipelineOperations");

  outcomeAnalytics() {
    return this.read((model) => model.analytics.summary);
  }

  learningRecommendationEvidence = this.unsupported("learningRecommendationEvidence");
  tailoringPolicyRevisions = this.unsupported("tailoringPolicyRevisions");

  digest() {
    return this.read((model) => model.dashboard.digest);
  }

  async activity(
    query: Parameters<ApiClientPort["activity"]>[0] = {},
  ): Promise<ApiClientResponse<"activity">> {
    const normalized = ActivityListQuerySchema.parse(query);
    const source = await this.read((model) => model.dashboard.activity.items);
    const q = normalized.q.toLowerCase();
    const items = source.filter((event) => {
      if (
        normalized.level &&
        event.level.toLowerCase() !== normalized.level.toLowerCase()
      )
        return false;
      if (
        normalized.stage &&
        event.stage.toLowerCase() !== normalized.stage.toLowerCase()
      )
        return false;
      if (
        normalized.eventType &&
        event.eventType.toLowerCase() !== normalized.eventType.toLowerCase()
      )
        return false;
      if (!q) return true;
      return [
        event.level,
        event.stage,
        event.eventType,
        event.message,
        event.title ?? "",
        event.company ?? "",
        event.workflowId ?? "",
        event.jobKey ?? "",
        event.eventId,
        event.at,
      ].some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(q),
      );
    });
    items.sort((left, right) =>
      compareActivity(left, right, normalized.sort, normalized.dir),
    );
    return paginate(
      items,
      normalized.page,
      normalized.pageSize,
      normalized.sort,
      normalized.dir,
      {
        q: normalized.q,
        level: normalized.level,
        stage: normalized.stage,
        eventType: normalized.eventType,
      },
    );
  }

  activityEvent(eventId: string) {
    return this.detail(
      (model) => model.dashboard.activityEvents,
      eventId,
      "activity_event_not_found",
    );
  }

  discoverySettings() {
    return this.read((model) => model.discovery.settings);
  }

  discoverySources() {
    return this.read((model) => model.discovery.sources);
  }

  discoverySourcePreview(sourceId: string) {
    return this.detail(
      (model) => model.discovery.sourcePreviews,
      sourceId,
      "discovery_source_not_found",
    );
  }

  compensationSources() {
    return this.read((model) => model.discovery.compensationSources);
  }

  discoveryLocatorCandidates() {
    return this.read((model) => model.discovery.locatorCandidates);
  }

  discoveryQuarantine() {
    return this.read((model) => model.discovery.quarantine);
  }

  manualCaptureQueue() {
    return this.read((model) => model.discovery.manualCapture);
  }

  roleMatchFeedbackSuggestions() {
    return this.read((model) => model.discovery.roleMatchFeedback);
  }

  applyReviewQueue() {
    return this.read((model) => model.apply.queue);
  }

  resumeReviewDraft(jobKey: string) {
    return this.detail(
      (model) => model.materials.resumeReviewDrafts,
      jobKey,
      "resume_review_draft_not_found",
    );
  }

  resumeReviewFeedback(jobKey: string) {
    return this.detail(
      (model) => model.materials.resumeReviewFeedback,
      jobKey,
      "job_not_found",
    );
  }

  resumeTemplates() {
    return this.read((model) => model.materials.resumeTemplates);
  }

  resumeTemplate(templateId: string) {
    return this.detail(
      (model) => model.materials.templateDetails,
      templateId,
      "resume_template_not_found",
    );
  }

  applicationOutcomes() {
    return this.read((model) => model.analytics.outcomes);
  }

  jobApplicationOutcomes(jobKey: string) {
    return this.detail(
      (model) => model.analytics.jobOutcomes,
      jobKey,
      "job_not_found",
    );
  }

  async jobs(
    query: Parameters<ApiClientPort["jobs"]>[0] = {},
  ): Promise<ApiClientResponse<"jobs">> {
    const normalized = JobListQuerySchema.parse(query);
    const source = await this.read((model) => model.jobs.list.items);
    const q = normalized.q.toLowerCase();
    const items = source.filter((job) => filterDemoJob(job, normalized, q));
    items.sort((left, right) =>
      compareJobs(left, right, normalized.sort, normalized.dir, {
        normalizeSqlText:
          !normalized.q && !IN_MEMORY_JOB_SORT_FIELDS.has(normalized.sort),
      }),
    );
    return paginate(
      items,
      normalized.page,
      normalized.pageSize,
      normalized.sort,
      normalized.dir,
      {
        q: normalized.q,
        stage: normalized.stage ?? "",
        state: normalized.state ?? "",
        source: normalized.source,
        company: normalized.company,
        applyStatus: normalized.applyStatus,
        minFitScore: normalized.minFitScore ?? null,
        maxFitScore: normalized.maxFitScore ?? null,
        discoveredSince: normalized.discoveredSince ?? null,
        scoredSince: normalized.scoredSince ?? null,
        deleted: normalized.deleted,
        jobStates: normalized.jobStates ?? null,
      },
    );
  }

  job(jobKey: string) {
    return this.detail((model) => model.jobs.details, jobKey, "job_not_found");
  }

  evidenceMap() {
    return this.read((model) => model.evidence);
  }

  async workflowRuns(
    query: Parameters<ApiClientPort["workflowRuns"]>[0] = {},
  ): Promise<ApiClientResponse<"workflowRuns">> {
    const normalized = WorkflowRunsListQuerySchema.parse(query);
    const source = await this.read((model) => model.runs.list.items);
    const items = source.filter((run) => filterWorkflowRun(run, normalized));
    items.sort((left, right) =>
      compareWorkflowRuns(left, right, normalized.sort, normalized.dir),
    );
    return paginate(
      items,
      normalized.page,
      normalized.pageSize,
      normalized.sort,
      normalized.dir,
      {
        status: normalized.status,
        workflowType: normalized.workflowType ?? null,
        startedSince: normalized.startedSince ?? null,
        startedBefore: normalized.startedBefore ?? null,
      },
    );
  }

  workflowRun(runId: string) {
    return this.detail(
      (model) => model.runs.details,
      runId,
      "workflow_run_not_found",
    );
  }

  async artifacts(
    query: Parameters<ApiClientPort["artifacts"]>[0] = {},
  ): Promise<ApiClientResponse<"artifacts">> {
    const normalized = ArtifactListQuerySchema.parse(query);
    const source = await this.read((model) => model.materials.list.items);
    const q = normalized.q.toLowerCase();
    const items = source.filter((artifact) => {
      if (!normalized.status && artifact.status.toLowerCase() === "suppressed")
        return false;
      if (normalized.status && artifact.status !== normalized.status)
        return false;
      if (normalized.type && artifact.type !== normalized.type) return false;
      if (!q) return true;
      return [
        artifact.title,
        artifact.company,
        artifact.type,
        artifact.status,
        artifact.localPath,
      ].some((value) => value.toLowerCase().includes(q));
    });
    items.sort((left, right) =>
      compareArtifacts(left, right, normalized.sort, normalized.dir),
    );
    return paginate(
      items,
      normalized.page,
      normalized.pageSize,
      normalized.sort,
      normalized.dir,
      {
        q: normalized.q,
        status: normalized.status,
        type: normalized.type,
      },
    );
  }

  artifact(artifactId: string) {
    return this.detail(
      (model) => model.materials.details,
      artifactId,
      "artifact_not_found",
    );
  }

  artifactPreviewPdfUrl(artifactId: string, cacheKey?: CacheKey): string {
    return artifactPreviewUrl(this.workspace, artifactId, "pdf", cacheKey);
  }

  artifactPreviewHtmlUrl(artifactId: string, cacheKey?: CacheKey): string {
    return artifactPreviewUrl(this.workspace, artifactId, "html", cacheKey);
  }

  profile() {
    return this.read((model) => model.profile.config);
  }

  async targetRoleSuggestions(
    body: TargetRoleSuggestionRequest,
  ): Promise<TargetRoleSuggestionResponse> {
    const profile = await this.read((model) => model.profile.config);
    if (profile.profileVersion !== body.expectedProfileVersion) {
      throw new JobCtrlApiError(
        409,
        "stale_profile_version",
        `stale_profile_version: expected ${body.expectedProfileVersion}, current ${profile.profileVersion ?? "none"}`,
      );
    }
    return {
      ok: true,
      profileVersion: body.expectedProfileVersion,
      suggestions: [
        {
          title: "Director of Platform Delivery",
          classification: "direct" as const,
          track: "Management",
          seniority: "Director",
          evidenceIds: ["experience:experience-platform-delivery"],
          rationale: "The saved synthetic profile contains a matching recent platform delivery role.",
        },
      ].slice(0, body.maximumSuggestions),
      preferenceSuggestions: [
        {
          location: "Madrid, Spain",
          workModel: "Hybrid" as const,
          evidenceIds: ["experience:experience-platform-delivery"],
        },
      ],
      strategy: "model_stub",
      warnings: ["stubbed_model_evidence"],
    };
  }

  async requiredBulletSuggestions(
    body: RequiredBulletSuggestionRequest,
  ): Promise<RequiredBulletSuggestionResponse> {
    const profile = await this.read((model) => model.profile.config);
    if (profile.profileVersion !== body.expectedProfileVersion) {
      throw new JobCtrlApiError(
        409,
        "stale_profile_version",
        `stale_profile_version: expected ${body.expectedProfileVersion}, current ${profile.profileVersion ?? "none"}`,
      );
    }
    const parsed = ProfileSchema.safeParse(profile.profile);
    if (!parsed.success) {
      throw new JobCtrlApiError(422, "invalid_saved_profile", "The saved synthetic profile is invalid.");
    }
    return generateDemoRequiredBulletSuggestions(
      parsed.data,
      body.expectedProfileVersion,
      body.maximumSuggestions,
    );
  }

  profilePreviewPdfUrl(cacheKey?: CacheKey): string {
    return profilePreviewUrl(this.workspace, "pdf", cacheKey);
  }

  profilePreviewHtmlUrl(cacheKey?: CacheKey): string {
    return profilePreviewUrl(this.workspace, "html", cacheKey);
  }

  settings() {
    return this.read((model) => model.settings);
  }

  credentials() {
    return this.read((model) => model.profile.credentials);
  }

  async browserCapabilities(): Promise<
    ApiClientResponse<"browserCapabilities">
  > {
    return {
      ok: true,
      detectedBrowsers: [],
      capabilities: [
        {
          id: "core-browser",
          status: "ready",
          detail: "Synthetic demo status; no host browser is inspected.",
          mutable: false,
          enabled: true,
          profileCopyReady: false,
        },
        {
          id: "auto-apply-browser",
          status: "disabled",
          detail: "Browser adoption is unavailable in the public demo.",
          mutable: true,
          enabled: false,
          profileCopyReady: false,
        },
        {
          id: "authenticated-linkedin-browser",
          status: "disabled",
          detail: "Profile copy is unavailable in the public demo.",
          mutable: true,
          enabled: false,
          profileCopyReady: false,
        },
      ],
    };
  }

  async providerModels(): Promise<ApiClientResponse<"providerModels">> {
    return {
      ok: true,
      providers: [
        {
          provider: "codex",
          configured: true,
          ready: true,
          source: "live",
          models: [
            { id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true },
            { id: "gpt-5.4", displayName: "GPT-5.4" },
          ],
          message: "Synthetic preview catalog; no Codex account is connected.",
        },
        {
          provider: "claude",
          configured: true,
          ready: true,
          source: "live",
          models: [
            { id: "claude-fable-5", displayName: "Fable 5" },
            { id: "claude-opus-4-8", displayName: "Opus 4.8", isDefault: true },
            { id: "claude-sonnet-5", displayName: "Sonnet 5" },
          ],
          message: "Synthetic preview catalog; no Claude account is connected.",
        },
        {
          provider: "google",
          configured: true,
          ready: true,
          source: "live",
          models: [
            {
              id: "gemini-2.5-pro",
              displayName: "Gemini 2.5 Pro",
              isDefault: true,
            },
            { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
          ],
          message: "Synthetic preview catalog; no Google account is connected.",
        },
      ],
    };
  }

  async providerStatus(): Promise<ApiClientResponse<"providerStatus">> {
    return {
      ok: true,
      providers: [
        { provider: "codex", configured: false, ready: false, mode: null },
        { provider: "claude", configured: false, ready: false, mode: null },
        { provider: "google", configured: false, ready: false, mode: null },
      ],
    };
  }

  async listContacts(
    query: Parameters<ApiClientPort["listContacts"]>[0] = {},
  ): Promise<ApiClientResponse<"listContacts">> {
    const normalized = ContactListQuerySchema.parse(query);
    const response = await this.read((model) => model.contacts.list);
    response.items = response.items.filter(
      (contact) =>
        (!normalized.jobId || contact.jobId === normalized.jobId) &&
        (!normalized.employer || contact.employer === normalized.employer),
    );
    response.items.sort((left, right) =>
      compareUpdatedAtThenId(
        left.updatedAt,
        right.updatedAt,
        left.contactId,
        right.contactId,
      ),
    );
    return response;
  }

  contact(contactId: string) {
    return this.detail(
      (model) => model.contacts.details,
      contactId,
      "contact_not_found",
    );
  }

  async researchTasks(
    query: Parameters<ApiClientPort["researchTasks"]>[0] = {},
  ): Promise<ApiClientResponse<"researchTasks">> {
    const normalized = ContactResearchListQuerySchema.parse(query);
    const response = await this.read((model) => model.contacts.researchTasks);
    response.items = response.items.filter(
      (task) =>
        (!normalized.jobId || task.jobId === normalized.jobId) &&
        (!normalized.employer || task.employer === normalized.employer),
    );
    response.items.sort((left, right) =>
      compareUpdatedAtThenId(
        left.updatedAt,
        right.updatedAt,
        left.taskId,
        right.taskId,
      ),
    );
    return response;
  }

  researchTask(taskId: string) {
    return this.detail(
      (model) => model.contacts.researchTaskDetails,
      taskId,
      "research_task_not_found",
    );
  }

  async outreachThread(
    contactId: string,
    query: { jobId?: string } = {},
  ): Promise<ApiClientResponse<"outreachThread">> {
    const response = await this.read((model) => model.outreach.thread);
    if (
      response.thread === null ||
      response.thread.contactId !== contactId ||
      (query.jobId !== undefined && response.thread.jobId !== query.jobId)
    ) {
      throw new DemoResourceNotFoundError(
        "outreach_thread_not_found",
        contactId,
      );
    }
    return response;
  }

  dueOutreachFollowUps() {
    return this.read((model) => model.outreach.dueFollowUps);
  }

  acknowledgeDigest = this.local("acknowledgeDigest");
  updateDiscoverySettings = this.local("updateDiscoverySettings");
  upsertDiscoverySource = this.local("upsertDiscoverySource");
  patchDiscoverySourceState = this.local("patchDiscoverySourceState");
  updateCompensationSourcePolicy = this.local("updateCompensationSourcePolicy");
  promoteSourceLocatorCandidate = this.local("promoteSourceLocatorCandidate");
  rejectSourceLocatorCandidate = this.local("rejectSourceLocatorCandidate");
  decideDiscoveryQuarantine = this.local("decideDiscoveryQuarantine");
  importManualCapture = this.local("importManualCapture");
  importJobUrl = this.unsupported("importJobUrl");
  dismissManualCapture = this.local("dismissManualCapture");
  recordDiscoveryFeedback = this.local("recordDiscoveryFeedback");
  decideRoleMatchFeedbackSuggestion = this.local(
    "decideRoleMatchFeedbackSuggestion",
  );
  decideApplyReview = this.local("decideApplyReview");
  confirmRepeatApplication = this.unsupported("confirmRepeatApplication");
  createResumeReviewDraft = this.local("createResumeReviewDraft");
  saveResumeReviewDraftRevision = this.local("saveResumeReviewDraftRevision");
  seedResumeReviewCommentThreads = this.local("seedResumeReviewCommentThreads");
  replyToResumeReviewComment = this.local("replyToResumeReviewComment");
  saveResumeTemplate = this.local("saveResumeTemplate");
  setDefaultResumeTemplate = this.local("setDefaultResumeTemplate");
  setJobResumeTemplate = this.local("setJobResumeTemplate");
  ensureCurrentResumeMaterials = this.unsupported(
    "ensureCurrentResumeMaterials",
  );
  recordManualApplicationOutcome = this.local("recordManualApplicationOutcome");
  decideOutcomeSuggestion = this.local("decideOutcomeSuggestion");
  deleteJob = this.local("deleteJob");
  deleteJobs = this.local("deleteJobs");
  permanentlyDeleteJob = this.local("permanentlyDeleteJob");
  permanentlyDeleteJobs = this.local("permanentlyDeleteJobs");
  restoreJob = this.local("restoreJob");
  restoreJobs = this.local("restoreJobs");
  hideJob = this.local("hideJob");
  hideJobs = this.local("hideJobs");
  unhideJob = this.local("unhideJob");
  unhideJobs = this.local("unhideJobs");
  retryFailedJobs = this.unsupported("retryFailedJobs");
  runPendingPreparation = this.unsupported("runPendingPreparation");
  correctScore = this.local("correctScore");
  resetStaleScoresForRescore = this.local("resetStaleScoresForRescore");
  rescoreJob = this.simulated("rescoreJob");
  refreshCompensation = this.unsupported("refreshCompensation");
  refreshAllCompensation = this.unsupported("refreshAllCompensation");
  rescoreJobsNotOnCurrentScoringPolicy = this.unsupported(
    "rescoreJobsNotOnCurrentScoringPolicy",
  );
  retailorJob = this.simulated("retailorJob");
  tailorJob = this.unsupported("tailorJob");
  retailorCurrentPolicy = this.unsupported("retailorCurrentPolicy");
  cancelWorkflowRun = this.local("cancelWorkflowRun");
  openArtifact = this.rehearsed("openArtifact");
  updateProfile = this.local("updateProfile");
  importResume = this.local("importResume");
  updateSettings = this.local("updateSettings");
  extensionCapabilityToken = this.unsupported("extensionCapabilityToken");
  discoveryBrowserBridgeStatus = this.unsupported(
    "discoveryBrowserBridgeStatus",
  );
  rotateExtensionCapabilityToken = this.unsupported(
    "rotateExtensionCapabilityToken",
  );
  runPipelineStages = this.unsupported("runPipelineStages");
  updateCredential = this.unsupported("updateCredential");
  deleteCredential = this.unsupported("deleteCredential");
  updateCredentialsBatch = this.unsupported("updateCredentialsBatch");
  enableBrowserCapability = this.unsupported("enableBrowserCapability");
  disableBrowserCapability = this.unsupported("disableBrowserCapability");
  copyLinkedInBrowserProfile = this.unsupported("copyLinkedInBrowserProfile");
  verifyCodexProvider = this.unsupported("verifyCodexProvider");
  createContact = this.local("createContact");
  updateContact = this.local("updateContact");
  deleteContact = this.local("deleteContact");
  importContacts = this.unsupported("importContacts");
  runContactResearch = this.unsupported("runContactResearch");
  confirmContactCandidate = this.local("confirmContactCandidate");
  generateOutreachDraft = this.unsupported("generateOutreachDraft");
  reviseOutreachDraft = this.unsupported("reviseOutreachDraft");
  approveOutreachDraft = this.local("approveOutreachDraft");
  rejectOutreachDraft = this.local("rejectOutreachDraft");
  logOutreachSend = this.unsupported("logOutreachSend");
  scheduleOutreachFollowUp = this.local("scheduleOutreachFollowUp");
  completeOutreachFollowUp = this.local("completeOutreachFollowUp");
  dismissOutreachFollowUp = this.local("dismissOutreachFollowUp");
  retryStage = this.simulated("retryStage");
  runJobStage = this.simulated("runJobStage");
  generateMaterials = this.unsupported("generateMaterials");
  generateInterviewPrep = this.unsupported("generateInterviewPrep");
  applyJob = this.rehearsed("applyJob");
  cancelJobAction = this.local("cancelJobAction");
  markApplied = this.rehearsed("markApplied");
  markSkipped = this.local("markSkipped");

  private async read<TValue>(
    select: (model: DemoReadModel) => TValue,
  ): Promise<TValue> {
    const snapshot = await this.workspace.snapshot();
    return structuredClone(select(snapshot.state.readModel));
  }

  private async detail<TValue>(
    select: (model: DemoReadModel) => Readonly<Record<string, TValue>>,
    id: string,
    code: string,
  ): Promise<TValue> {
    const values = await this.read(select);
    const value = values[id];
    if (value === undefined) {
      throw new DemoResourceNotFoundError(code, id);
    }
    return value;
  }

  private unsupported<TMethod extends keyof ApiClientPort>(
    method: TMethod,
  ): ApiClientPort[TMethod] {
    return ((..._args: unknown[]) =>
      Promise.reject(
        new DemoCapabilityError(method),
      )) as unknown as ApiClientPort[TMethod];
  }

  private local<TMethod extends DemoBrowserLocalCommand>(
    method: TMethod,
  ): ApiClientPort[TMethod] {
    return ((...args: Parameters<ApiClientPort[TMethod]>) =>
      this.localCommands.execute(method, args)) as ApiClientPort[TMethod];
  }

  private simulated<
    TMethod extends import("./contracts.js").DemoSimulatedAsyncOperation,
  >(method: TMethod): ApiClientPort[TMethod] {
    return ((...args: Parameters<ApiClientPort[TMethod]>) =>
      this.trackDemoAction(method, () =>
        this.scenarios.execute(method, args),
      )) as unknown as ApiClientPort[TMethod];
  }

  private rehearsed<TMethod extends DemoInitialExternalRehearsalOperation>(
    method: TMethod,
  ): ApiClientPort[TMethod] {
    return ((...args: Parameters<ApiClientPort[TMethod]>) =>
      this.trackDemoAction(method, () =>
        this.externalRehearsals.execute(method, args),
      )) as ApiClientPort[TMethod];
  }

  private async trackDemoAction<TResult>(
    method: string,
    execute: () => Promise<TResult>,
  ): Promise<TResult> {
    const metadata = DEMO_ACTION_TELEMETRY[method];
    if (!metadata || !this.telemetry) return execute();
    const startedAt = monotonicNow();
    this.emitTelemetry("demo_action_started", metadata);
    try {
      const result = await execute();
      const status = actionStatus(result);
      const durationBucket = telemetryDurationBucket(
        monotonicNow() - startedAt,
      );
      if (
        status === "queued" ||
        status === "starting" ||
        status === "in_progress"
      ) {
        return result;
      }
      if (status === "failed" || status === "blocked") {
        this.emitTelemetry("demo_action_failed", {
          ...metadata,
          result: "failed",
          errorCode:
            status === "blocked" ? "validation_rejected" : "scenario_failed",
          durationBucket,
        });
      } else if (status === "canceled" || status === "cancelled") {
        this.emitTelemetry("demo_action_cancelled", {
          ...metadata,
          result: "cancelled",
          durationBucket,
        });
      } else {
        this.emitTelemetry("demo_action_completed", {
          ...metadata,
          result: "succeeded",
          durationBucket,
        });
      }
      return result;
    } catch (error) {
      this.emitTelemetry("demo_action_failed", {
        ...metadata,
        result: "failed",
        errorCode: "client_unexpected",
        durationBucket: telemetryDurationBucket(monotonicNow() - startedAt),
      });
      throw error;
    }
  }

  private emitTelemetry(
    name: string,
    attributes: Record<string, string>,
  ): void {
    try {
      this.telemetry?.event(name, attributes);
    } catch {
      // Optional analytics never changes browser-local product behavior.
    }
  }
}

export interface DemoApiClientAdapter extends EndpointClientMethods {}

const DEMO_ACTION_TELEMETRY: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  rescoreJob: { feature: "scoring", action: "rescore", scenario: "success" },
  retailorJob: { feature: "materials", action: "retailor", scenario: "retry" },
  retryStage: { feature: "pipeline", action: "retry_stage", scenario: "retry" },
  runJobStage: {
    feature: "pipeline",
    action: "run_stage",
    scenario: "success",
  },
  openArtifact: {
    feature: "artifacts",
    action: "open_artifact",
    scenario: "success",
  },
  applyJob: { feature: "apply", action: "apply_dry_run", scenario: "success" },
  markApplied: {
    feature: "apply",
    action: "mark_applied",
    scenario: "success",
  },
};

function actionStatus(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("status" in result))
    return undefined;
  return typeof result.status === "string" ? result.status : undefined;
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function telemetryDurationBucket(milliseconds: number): string {
  if (milliseconds < 100) return "under_100ms";
  if (milliseconds < 500) return "100ms_to_499ms";
  if (milliseconds < 1_000) return "500ms_to_999ms";
  if (milliseconds < 2_000) return "1s_to_2s";
  if (milliseconds < 5_000) return "2s_to_5s";
  if (milliseconds < 10_000) return "5s_to_10s";
  return "over_10s";
}

function artifactPreviewUrl(
  workspace: DemoWorkspaceRepository,
  artifactId: string,
  kind: "html" | "pdf",
  cacheKey?: CacheKey,
): string {
  const snapshot = workspace.snapshotNow();
  const selected =
    snapshot.state.readModel.materials.details[artifactId]?.artifact;
  if (!selected) {
    throw new DemoResourceNotFoundError("artifact_not_found", artifactId);
  }
  const contentType = kind === "pdf" ? "application/pdf" : "text/html";
  const assetUrls = new Set(
    Object.values(snapshot.state.artifacts)
      .filter(
        (asset) =>
          asset.contentType === contentType && isDemoArtifactUrl(asset.url),
      )
      .map((asset) => asset.url),
  );
  const selectedPath = selected.localPath.toLowerCase();
  const selectedKind = selectedPath.endsWith(".pdf")
    ? "pdf"
    : selectedPath.endsWith(".html")
      ? "html"
      : null;
  const selectedStem = selectedPath.replace(/\.(?:html|pdf)$/, "");
  const preview = Object.values(snapshot.state.readModel.materials.details)
    .map((detail) => detail.artifact)
    .find(
      (artifact) =>
        artifact.jobKey === selected.jobKey &&
        isDemoArtifactUrl(artifact.localPath) &&
        (selectedKind === kind
          ? artifact.artifactId === selected.artifactId
          : artifact.localPath.toLowerCase().replace(/\.(?:html|pdf)$/, "") ===
            selectedStem) &&
        assetUrls.has(artifact.localPath),
    );
  if (!preview || !isDemoArtifactUrl(preview.localPath)) {
    throw new DemoResourceNotFoundError(
      "artifact_preview_not_found",
      artifactId,
    );
  }
  return withCacheKey(preview.localPath, cacheKey);
}

function profilePreviewUrl(
  workspace: DemoWorkspaceRepository,
  kind: "html" | "pdf",
  cacheKey?: CacheKey,
): string {
  const artifacts = workspace.snapshotNow().state.artifacts;
  const asset =
    kind === "pdf" ? artifacts.profileResumePdf : artifacts.profileResumeHtml;
  const expectedType = kind === "pdf" ? "application/pdf" : "text/html";
  if (asset.contentType !== expectedType || !isDemoArtifactUrl(asset.url)) {
    throw new DemoResourceNotFoundError("profile_preview_not_found", "profile");
  }
  return withCacheKey(asset.url, cacheKey);
}

function withCacheKey(url: `/demo/${string}`, cacheKey?: CacheKey): string {
  if (cacheKey === undefined || cacheKey === "") return url;
  return `${url}?v=${encodeURIComponent(String(cacheKey))}`;
}

function filterWorkflowRun(
  run: WorkflowRunSummary,
  query: ReturnType<typeof WorkflowRunsListQuerySchema.parse>,
): boolean {
  if (query.status !== "all" && run.status !== query.status) return false;
  if (query.workflowType && run.workflowType !== query.workflowType)
    return false;
  if (
    query.startedSince &&
    !timestampAtOrAfter(run.startedAt, query.startedSince)
  )
    return false;
  if (
    query.startedBefore &&
    !timestampBefore(run.startedAt, query.startedBefore)
  )
    return false;
  return true;
}

function compareArtifacts(
  left: ArtifactSummary,
  right: ArtifactSummary,
  field: string,
  direction: "asc" | "desc",
): number {
  const values: Record<string, [unknown, unknown]> = {
    created_at: [left.createdAt, right.createdAt],
    title: [left.title, right.title],
    company: [left.company, right.company],
    type: [left.type, right.type],
    status: [left.status, right.status],
    size_bytes: [left.sizeBytes ?? -1, right.sizeBytes ?? -1],
  };
  const [leftValue, rightValue] = values[field] ?? values.created_at!;
  return compareValues(leftValue, rightValue) * (direction === "asc" ? 1 : -1);
}

function compareActivity(
  left: ActivityEventSummary,
  right: ActivityEventSummary,
  field: string,
  direction: "asc" | "desc",
): number {
  const values: Record<string, [unknown, unknown]> = {
    occurred_at: [left.at, right.at],
    event_id: [left.eventId, right.eventId],
    stage: [left.stage.toLowerCase(), right.stage.toLowerCase()],
    level: [left.level.toLowerCase(), right.level.toLowerCase()],
    event_type: [left.eventType.toLowerCase(), right.eventType.toLowerCase()],
    message: [left.message.toLowerCase(), right.message.toLowerCase()],
  };
  const [leftValue, rightValue] = values[field] ?? values.occurred_at!;
  const multiplier = direction === "asc" ? 1 : -1;
  const compared = compareValues(leftValue, rightValue);
  return compared
    ? compared * multiplier
    : left.eventId.localeCompare(right.eventId) * multiplier;
}

function compareWorkflowRuns(
  left: WorkflowRunSummary,
  right: WorkflowRunSummary,
  field: string,
  direction: "asc" | "desc",
): number {
  const values: Record<string, [unknown, unknown]> = {
    started_at: [left.startedAt, right.startedAt],
    finished_at: [left.finishedAt, right.finishedAt],
    duration_ms: [left.durationMs ?? -1, right.durationMs ?? -1],
    title: [left.title, right.title],
    company: [left.company, right.company],
    status: [left.status, right.status],
    model: [left.model ?? "", right.model ?? ""],
    dry_run: [left.dryRun ? 1 : 0, right.dryRun ? 1 : 0],
  };
  const [leftValue, rightValue] = values[field] ?? values.started_at!;
  return compareValues(leftValue, rightValue) * (direction === "asc" ? 1 : -1);
}

function compareUpdatedAtThenId(
  leftUpdatedAt: string | null,
  rightUpdatedAt: string | null,
  leftId: string,
  rightId: string,
): number {
  const updated = compareValues(leftUpdatedAt, rightUpdatedAt);
  return updated ? updated * -1 : leftId.localeCompare(rightId);
}
