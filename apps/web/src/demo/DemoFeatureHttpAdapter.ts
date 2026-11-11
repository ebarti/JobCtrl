import { DEMO_APPLICATION_SETTINGS_SCHEMA as settingsSchema } from "./settings.js";
import { JobCtrlApiError } from "@jobctrl/api-client";
import {
  ProfileSchema,
  ManualApplicationOutcomeRequestSchema,
  DiscoverySettingsResponseSchema,
  type ApplicationOutcome,
} from "@jobctrl/contracts";
import { z } from "zod";

import type {
  HttpMethod,
  HttpRequestOptions,
} from "../shared/ports/HttpPort.js";
import { DemoApiClientAdapter } from "./DemoApiClientAdapter.js";
import { isDemoArtifactUrl } from "./artifacts.js";
import { DemoCapabilityError } from "./ports.js";
import { stableDemoStringify } from "./digest.js";
import { demoEventEnvelope, createResumeComposed, createResumeRendered, createPreparationUpdated } from "./events.js";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { documentHtml, documentText, renderDemoResume } from "./DemoResumeRenderer.js";
import { evaluateDemoJobQuery, type DemoJobQueryRow } from "./DemoJobQueries.js";
import { demoWorkspaceIdentity } from "./identity.js";
import {
  demoWordingLibrary, demoProfileRecovery, restoreDemoProfile, exactDemoRefs,
  type DemoProfileVersion, type DemoProfileSourceVersion,
  type DemoWordingLibrary as WordingLibrary, type DemoWordingVariant as WordingVariant,
} from "./profile-library.js";
import { demoCanonicalRequirements, demoRequirementLibrary, demoRequirementAssociations, demoAssociationView,
  createDemoAssociation, reviseDemoAssociation, changeDemoAssociation, type DemoRequirementAssociations } from "./requirement-library.js";
import type {
  DemoWorkspaceRepository,
  DemoWorkspaceMutationContext,
} from "./workspace/DemoWorkspaceRepository.js";
import type { DemoWorkspaceSnapshot } from "./workspace/contracts.js";

type Data = Record<string, unknown>;
interface SourceRef {
  source_id: string;
  revision: number;
}
interface ProfileSource extends Data {
  source_id: string;
  revision: number;
  text: string;
  kind: string;
  confirmation: string;
  origin: string;
}
interface Posting {
  job_id: string;
  revision: number;
  source_id: string;
  source_revision: number;
  source_hash: string;
  title: string;
  company: string | null;
  description: string;
  location: string | null;
  url: string;
  application_url: string | null;
  active_state: string;
  observed_at: string;
  provenance: Data;
  hidden: boolean;
  deleted: boolean;
  state_revision: number;
}
interface ResumeRevision {
  revision_id: string;
  number: number;
  profile_revision: number;
  mode: "baseline_copy";
  document: Data;
  selected_variants: WordingVariant[];
  coverage_manifest: Data;
  mechanical: Data;
  review: Data;
  renders: Data[];
  render_attempts: Data[];
  edit_draft: Data | null;
  created_at: string;
  profile_snapshot: Data;
  requirements_snapshot: Data | null;
  fit_snapshot: Data | null;
  review_attempts: Data[];
  template: Data | null;
  theme: Data;
}
interface Resume {
  resume_id: string;
  job_id: string;
  profile_id: string;
  version: number;
  current_revision: string;
  accepted_revision_id: string | null;
  revisions: ResumeRevision[];
  acceptances: Data[];
  locales: Data[];
  comments: Data[];
  created_at: string;
  updated_at: string;
}
interface DemoPreparationRun {
  runId: string;
  status: "succeeded";
  recipe: "prepare";
  parentRunId: null;
  jobIds: string[];
  createdAt: string;
  updatedAt: string;
  steps: { jobId: string; stage: string; status: string; result: Data; errorCode: null; updatedAt: string }[];
  synthetic: true;
  transport: "browser_local";
  externalEffectOccurred: false;
}

/** Optional additions are reset atomically with the existing browser aggregate. */
export interface DemoFeatureState {
  outreachSourceBinding?: string;
  fitProfileSourceSignature?: string;
  profileSourcesChanged?: boolean;
  postings?: Record<string, Posting>;
  wording?: WordingLibrary;
  wordingHistory?: Record<string, WordingVariant[]>;
  profileVersions?: DemoProfileVersion[];
  profileSourceVersions?: Record<string, DemoProfileSourceVersion>;
  requirementAssociations?: DemoRequirementAssociations;
  preparationRuns?: Record<string, DemoPreparationRun>;
  preparationCommands?: Record<string, { request: string; runId: string }>;
  resumes?: Record<string, Resume>;
  compensationRevision?: number;
  profileSources?: ProfileSource[];
  applications?: Record<string, Data>;
  applicationCommands?: Record<string, { request: string; response: Data }>;
  manualOutcomes?: ApplicationOutcome[];
  manualOutcomeCommands?: Record<
    string,
    { request: string; outcomeId: string }
  >;
  suggestionVersions?: Record<string, number>;
  runCancellationCommands?: Record<string, { runId: string; request: string }>;
  sourceRevisions?: Record<string, number>;
  locatorStates?: Record<
    string,
    {
      revision: number;
      decision: "pending" | "promote" | "reject" | "reset";
      decidedAt: string | null;
    }
  >;
  locatorExamples?: Record<string, Data>;
  templatePreferenceRevision?: number;
  deleteSelections?: Record<
    string,
    {
      ids: string[];
      revisions: Record<string, number>;
      states: Record<string, number>;
      expiresAt: string;
      consumed: boolean;
    }
  >;
}

type Result = { handled: false } | { handled: true; value: unknown };
const handled = (value: unknown): Result => ({ handled: true, value });
const notHandled: Result = { handled: false };

// Authored production-tour examples. These are saved synthetic sources, never
// inferred from a visitor's prose or presented as a live model determination.
const postingExamples: Readonly<
  Record<
    string,
    {
      description: string;
      requirement: string;
      kind: "matched" | "missing";
      requirementId: string;
    }
  >
> = {
  "6e2f4a10-20be-4d5f-98a4-a4bb9a877a35": {
    description:
      "Guide reliable platform delivery. Coordinate incident response with the engineering team.",
    requirement: "Guide reliable platform delivery.",
    kind: "matched",
    requirementId: "requirement-platform",
  },
  "job-contoso-reliability": {
    description:
      "Lead in a regulated domain. Guide a reliability engineering team.",
    requirement: "Lead in a regulated domain.",
    kind: "missing",
    requirementId: "requirement-regulated-domain",
  },
  "job-fabrikam-systems": {
    description:
      "Lead systems delivery. Coordinate platform reliability improvements.",
    requirement: "Lead systems delivery.",
    kind: "matched",
    requirementId: "requirement-systems",
  },
};

/** Feature DTOs retain one browser-local persistence authority and revision fence. */
export class DemoFeatureHttpAdapter {
  constructor(
    private readonly api: DemoApiClientAdapter,
    private readonly workspace: DemoWorkspaceRepository,
  ) {}

  async json(
    method: HttpMethod,
    path: readonly string[],
    options: HttpRequestOptions,
  ): Promise<Result> {
    const [, owner, id, action, detail] = path;
    const body = data(options.body);
    if (owner === "actions" && id === "preparation.run" && method === "POST") return handled(await this.prepareBaseline(body, options));
    if (owner === "actions" && id === "preparation.retry" && method === "POST") throw new JobCtrlApiError(422, "Demo Action Unavailable",
      "Browser-local baseline preparation commits only after composition and rendering succeed. There is no unfinished worker run to continue; prepare the baseline again.",
      { error: { code: "demo_preparation_unavailable" } });
    if (owner === "preparation" && id === "runs" && method === "GET") {
      const snapshot = await this.workspace.snapshot();
      const runs = Object.values(snapshot.state.features?.preparationRuns ?? {}).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      if (path.length === 3) return handled({ runs, synthetic: true, transport: "browser_local" });
      const run = runs.find((item) => item.runId === action);
      if (!run || path.length !== 4) throw notFound();
      return handled(run);
    }
    if (owner === "requirements") {
      if (method === "POST" && id === "index" && action === "rebuild") throw new DemoCapabilityError("rebuildRequirementIndex",
        "The browser-local demo searches its bundled catalog directly; it has no separate retrieval index to rebuild.");
      if (method !== "GET") throw new DemoCapabilityError("rescoreJob", "Requirement extraction and meaning corrections require a configured model in the local app. The synthetic catalog is unchanged.");
      const snapshot = await this.workspace.snapshot();
      const catalog = demoCanonicalRequirements(snapshot);
      const limit = integer(options.query?.limit ?? 50, 1, 200);
      const offset = integer(options.query?.offset ?? 0, 0);
      if (path.length === 2) {
        const query = String(options.query?.q ?? "").toLocaleLowerCase();
        if (query.length > 2500) throw badRequest("The literal catalog query is too long.");
        const matches = catalog.filter((row) => [row.definition, row.scope, ...row.qualifiers.map((qualifier) => `${qualifier.dimension} ${qualifier.value}`)]
          .some((value) => value.toLocaleLowerCase().includes(query)));
        return handled({ catalog_revision: 1, total: matches.length, requirements: matches.slice(offset, offset + limit), synthetic: true });
      }
      if (id === "index" && path.length === 3) return handled({ catalog_revision: 1, indexed_revision: 1, meaning_count: catalog.length,
        indexed_count: catalog.length, fresh: true, synthetic: true });
      const requirement = catalog.find((row) => row.requirement_id === id);
      if (!requirement) throw notFound();
      if (options.query?.revision !== undefined && integer(options.query.revision, 1) !== requirement.revision) throw notFound("This synthetic requirement revision is unavailable.");
      const occurrences = await this.requirementOccurrences(snapshot, requirement.requirement_id);
      if (action === "history") {
        const kind = options.query?.kind ?? "revisions";
        if (kind !== "revisions" && kind !== "occurrences") throw badRequest("Choose revisions or occurrences.");
        const rows = kind === "revisions" ? [{ ...requirement, current: true, stale_reasons: [] }] : occurrences.map((row) => ({
          ...row, accepted: true, snapshot_revision: 1, current: true, stale_reasons: [],
        }));
        return handled({ requirement_id: requirement.requirement_id, current_revision: requirement.revision, kind, total: rows.length,
          limit, offset, rows: rows.slice(offset, offset + limit), synthetic: true });
      }
      if (path.length === 3) return handled({ ...requirement, current_revision: requirement.revision, occurrences: occurrences.slice(offset, offset + limit) });
    }
    if (owner === "fit" && id === "requirement-library" && method === "GET") {
      if (options.query?.profile_id && options.query.profile_id !== "default") throw notFound();
      return handled(demoRequirementLibrary(await this.workspace.snapshot()));
    }
    if (owner === "fit" && id === "associations") {
      if (method === "POST") {
        let result: unknown;
        await this.commit((draft) => { result = path.length === 3 ? createDemoAssociation(draft, body) :
          path.length === 5 && detail === "state" ? changeDemoAssociation(draft, action!, body) :
          path.length === 5 && detail === "revisions" ? reviseDemoAssociation(draft, action!, body) : undefined;
          if (result === undefined) throw notFound(); });
        return handled(result);
      }
      if (method === "GET" && path.length === 5 && detail === "history") {
        if (options.query?.profile_id && options.query.profile_id !== "default") throw notFound();
        const snapshot = await this.workspace.snapshot();
        const associations = demoRequirementAssociations(snapshot);
        const record = associations.rows.find((row) => row.association_id === action);
        if (!record) throw notFound();
        const limit = integer(options.query?.limit ?? 50, 1, 200), offset = integer(options.query?.offset ?? 0, 0);
        const rows = [...(associations.history[action!] ?? []), record].reverse().map((row) => demoAssociationView(snapshot, row));
        return handled({ association_id: record.association_id, profile_id: "default", current_revision: record.revision,
          total: rows.length, limit, offset, rows: rows.slice(offset, offset + limit) });
      }
    }
    if (owner === "fit" && id === "current-wordings") {
      if (method === "GET") throw notFound("No assessed current-wording assignments are recorded in this synthetic demo.");
      throw new DemoCapabilityError("updateAffectedMatches", "Choosing a current wording for a requirement needs exact approved coverage in the local app. Browser-local manual links remain unassessed.");
    }
    if (owner === "profile" && id === "recovery") {
      if (method === "GET" && path.length === 3) return handled(demoProfileRecovery(await this.workspace.snapshot()));
      if (method === "POST" && action === "restore" && path.length === 4) {
        const snapshot = await this.workspace.snapshot();
        const profile = restoreDemoProfile(snapshot, body);
        return handled(await this.api.executeHttpLocalCommand("updateProfile", [{ profile, expectedProfileVersion: body.expectedProfileVersion }],
          (draft) => { restoreDemoProfile(draft, body); }));
      }
    }
    if (owner === "fit" && id === "evidence-map" && method === "GET") {
      const snapshot = await this.workspace.snapshot();
      const sources = this.sources(snapshot).sources.map((source) => ({ source_id: source.source_id, usages: [] }));
      const gaps: Data[] = [];
      for (const jobId of Object.keys(postingExamples)) {
        if (!snapshot.state.readModel.jobs.details[jobId]) continue;
        const fit = data(await this.fit(snapshot, jobId)); const score = data(fit.score);
        for (const assessment of records(score.assessments ?? [])) if (["missing", "blocked"].includes(String(assessment.kind))) {
          gaps.push({ job_id: jobId, current: fit.current, score_revision: score.revision,
            requirement_id: assessment.requirement_id, requirement_revision: assessment.requirement_revision, text: assessment.text,
            kind: assessment.kind, tier: assessment.tier, weight: assessment.weight, rationale: assessment.rationale,
            determination_id: assessment.determination_id, synthetic: true });
        }
      }
      return handled({ profile_id: "default", sources, gaps, coverage: [], wording_gaps: [], synthetic: true });
    }
    if (owner === "jobs" && id && action === "analysis") {
      if (method === "POST") throw new DemoCapabilityError("runJobStage");
      if (method === "GET") {
        const posting = await this.posting(await this.workspace.snapshot(), id);
        return handled({ job_id: id, current: false, revision: 0, posting_revision: posting.revision, accepted: null, synthetic: true });
      }
    }
    if (owner === "resume-templates" && path.length === 2 && method === "GET") {
      const snapshot = await this.workspace.snapshot();
      return handled({ ...structuredClone(snapshot.state.readModel.materials.resumeTemplates), preferenceRevision: snapshot.state.features?.templatePreferenceRevision ?? 0 });
    }
    if (owner === "resume-templates" && id === "default" && method === "PATCH") {
      const expected = integer(body.expectedRevision, 0); const { expectedRevision: _expected, ...patch } = body;
      const result = await this.api.executeHttpLocalCommand("setDefaultResumeTemplate", [patch], (draft) => {
        const state = features(draft);
        if ((state.templatePreferenceRevision ?? 0) !== expected) throw conflict("The default template selection changed. Review it before saving.");
        state.templatePreferenceRevision = expected + 1;
      });
      return handled({ ...data(result), preferenceRevision: expected + 1 });
    }
    if (owner === "jobs" && id === "query" && path.length === 3 && method === "GET") {
      const snapshot = await this.workspace.snapshot();
      const ids = [...new Set([...snapshot.state.readModel.jobs.list.items.map((job) => job.jobKey), ...Object.keys(snapshot.state.features?.postings ?? {})])];
      const rows: DemoJobQueryRow[] = await Promise.all(ids.map(async (jobId) => {
        const posting = await this.posting(snapshot, jobId); const legacy = snapshot.state.readModel.jobs.details[jobId];
        const fit = data(await this.fit(snapshot, jobId)); const score = data(fit.score);
        const savedResume = Object.values(snapshot.state.features?.resumes ?? {}).filter((resume) => resume.job_id === jobId).sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
        const nativeApplication = snapshot.state.features?.applications?.[jobId];
        const localPreparation = Object.values(snapshot.state.features?.preparationRuns ?? {}).filter((run) => run.jobIds.includes(jobId))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        return { job: { ...posting, created_at: legacy?.job.discoveredAt ?? posting.observed_at },
          fit: { ...fit, score: fit.score === null ? null : { ...score, created_at: legacy?.job.scoredAt ?? null }, normalized_keywords: legacy?.job.scoreKeywords ?? [] },
          preparation: localPreparation ? { stage: "render", state: localPreparation.status, updated_at: localPreparation.updatedAt } : legacy ? { stage: legacy.job.currentStage ?? null, state: legacy.job.currentState ?? null, updated_at: [...legacy.stages].map((stage) => stage.updatedAt).filter((value): value is string => typeof value === "string").sort().at(-1) ?? legacy.job.scoredAt ?? legacy.job.discoveredAt } : null,
          compensation: { summary: legacy?.job.compensationSummary ?? null, audit: legacy?.compensationAudit ?? null, refresh: null },
          application: nativeApplication ? { stage: "apply", state: nativeApplication.status ?? null, apply_status: nativeApplication.status ?? null, updated_at: nativeApplication.updatedAt } : legacy?.job.applyStatus ? { apply_status: legacy.job.applyStatus } : null,
          resume: savedResume ? { template: revisionOf(savedResume).template, revision: savedResume.version, resume_id: savedResume.resume_id } : null,
        };
      }));
      return handled(await evaluateDemoJobQuery(rows, options.query));
    }
    if (owner === "action-runs" && id === "by-idempotency-key" && method === "GET") {
      const snapshot = await this.workspace.snapshot();
      const command = options.query?.action === "preparation.run" && options.idempotencyKey ? snapshot.state.features?.preparationCommands?.[options.idempotencyKey] : undefined;
      const run = command ? this.actionRuns(snapshot).find((item) => item.runId === command.runId) : undefined;
      if (run) return handled(run);
      throw notFound("No durable provider action was admitted in this browser demo workspace.");
    }
    if (owner === "discovery" && id === "target-search" && method === "GET") {
      const snapshot = await this.workspace.snapshot();
      return handled({
        ok: true,
        current: null,
        accepted: null,
        targets: [],
        profileRevision: snapshot.state.readModel.profile.config.profileVersion,
      });
    }
    if (
      owner === "discovery" &&
      id === "sources" &&
      method === "GET" &&
      path.length === 3
    ) {
      const snapshot = await this.workspace.snapshot();
      const response = snapshot.state.readModel.discovery.sources;
      return handled({
        ...structuredClone(response),
        sources: response.sources.map((source) => ({
          ...source,
          revision:
            snapshot.state.features?.sourceRevisions?.[source.sourceId] ?? 1,
        })),
      });
    }
    if (
      owner === "discovery" &&
      id === "sources" &&
      ((method === "POST" && path.length === 3) ||
        (method === "PATCH" && action && detail === "state"))
    ) {
      const snapshot = await this.workspace.snapshot();
      const sourceId = method === "POST" ? text(body.sourceId) : action!;
      const exists = snapshot.state.readModel.discovery.sources.sources.some(
        (source) => source.sourceId === sourceId,
      );
      const { createOnly, expectedRevision, ...patch } = body;
      if (method === "POST" && createOnly === true && exists)
        throw conflict(
          "This source already exists. Review its current state before editing.",
        );
      const expected = exists ? integer(expectedRevision, 1) : 0;
      const result = await this.api.executeHttpLocalCommand(
        method === "POST"
          ? "upsertDiscoverySource"
          : "patchDiscoverySourceState",
        method === "POST" ? [patch] : [sourceId, patch],
        (draft) => {
          if (draft.resetEpoch !== snapshot.resetEpoch)
            throw conflict(
              "The synthetic workspace was reset before the source change.",
            );
          const current = draft.state.readModel.discovery.sources.sources.some(
            (source) => source.sourceId === sourceId,
          );
          const revisions = (features(draft).sourceRevisions ??= {});
          if (
            current !== exists ||
            (current && (revisions[sourceId] ?? 1) !== expected)
          )
            throw conflict(
              "The source revision changed. Review it before saving.",
            );
          revisions[sourceId] = current ? expected + 1 : 1;
        },
      );
      return handled({
        ...data(result),
        source: {
          ...data(data(result).source),
          revision: exists ? expected + 1 : 1,
        },
      });
    }
    if (
      owner === "discovery" &&
      id === "sources" &&
      action &&
      detail === "preview" &&
      (method === "GET" || method === "POST")
    ) {
      return handled(await this.api.discoverySourcePreview(action));
    }
    if (owner === "discovery" && id === "locator-candidates") {
      const snapshot = await this.workspace.snapshot();
      const response = snapshot.state.readModel.discovery.locatorCandidates;
      const candidates = new Map<string, Data>(
        response.candidates.map((candidate) => [
          candidate.candidateId,
          data(candidate),
        ]),
      );
      for (const [candidateId, candidate] of Object.entries(
        snapshot.state.features?.locatorExamples ?? {},
      ))
        candidates.set(candidateId, candidate);
      if (method === "GET" && path.length === 3)
        return handled({
          ...structuredClone(response),
          candidates: [...candidates].map(([candidateId, candidate]) => ({
            ...structuredClone(candidate),
            ...(snapshot.state.features?.locatorStates?.[candidateId] ?? {
              revision: 1,
              decision: "pending",
              decidedAt: null,
            }),
          })),
        });
      if (
        method === "POST" &&
        action &&
        ["promote", "reject", "reset"].includes(detail ?? "")
      ) {
        const candidate = candidates.get(action);
        if (!candidate) throw notFound();
        const expected = integer(body.expectedRevision, 1);
        const decidedAt = new Date().toISOString();
        const guard = (draft: DemoWorkspaceSnapshot) => {
          if (draft.resetEpoch !== snapshot.resetEpoch)
            throw conflict(
              "The synthetic workspace was reset before the proposal decision.",
            );
          const state = features(draft);
          const current = state.locatorStates?.[action]?.revision ?? 1;
          if (current !== expected)
            throw conflict(
              "The locator proposal changed. Review its current revision before deciding.",
            );
          (state.locatorExamples ??= {})[action] = structuredClone(candidate);
          (state.locatorStates ??= {})[action] = {
            revision: current + 1,
            decision: detail as "promote" | "reject" | "reset",
            decidedAt,
          };
        };
        if (detail === "promote") {
          const result = await this.api.executeHttpLocalCommand(
            "promoteSourceLocatorCandidate",
            [action, body],
            guard,
          );
          return handled({ ...data(result), revision: expected + 1 });
        }
        await this.commit(guard, snapshot.resetEpoch);
        return handled({
          ok: true,
          candidateId: action,
          decision: detail,
          source: null,
          decidedAt,
          revision: expected + 1,
        });
      }
    }
    if (owner === "discovery" && id === "settings") {
      if (method === "GET")
        return handled(this.discoverySettings(await this.workspace.snapshot()));
      if (method === "PATCH") {
        const expected = integer(body.expectedRevision, 0);
        const {
          expectedRevision: _expected,
          expectedPolicyRevision,
          ...patch
        } = body;
        if (patch.applyApprovalRequired === false)
          throw conflict("Exact application approval cannot be disabled.");
        const response = await this.api.executeHttpLocalCommand(
          "updateDiscoverySettings",
          [patch],
          (draft) => {
            const previous = this.discoverySettings(draft);
            const policy = this.settings(draft);
            if (previous.revision !== expected)
              throw conflict(
                "Discovery settings changed. Reload them before saving.",
              );
            const parsed =
              DiscoverySettingsResponseSchema.shape.settings.safeParse({
                ...previous.settings,
                ...patch,
              });
            if (!parsed.success)
              throw badRequest("The Discovery settings request is invalid.");
            const policyChanges =
              (patch.minFitScore !== undefined &&
                patch.minFitScore !== policy.minFitScore) ||
              (patch.autoApply !== undefined &&
                patch.autoApply !== policy.applyAutomationEnabled);
            if (policyChanges) {
              if (expectedPolicyRevision !== policy.revision)
                throw conflict(
                  "The application policy changed. Review it before changing Discovery controls.",
                );
              Object.assign(draft.state.readModel.settings, {
                ...policy,
                minFitScore: Number(patch.minFitScore ?? policy.minFitScore),
                applyAutomationEnabled:
                  typeof patch.autoApply === "boolean"
                    ? patch.autoApply
                    : policy.applyAutomationEnabled,
                revision: policy.revision + 1,
              });
            }
            draft.state.readModel.discovery.settings.revision = expected + 1;
            draft.state.readModel.discovery.settings.policyRevision =
              policyChanges ? policy.revision + 1 : policy.revision;
          },
        );
        return handled({
          ...data(response),
          ...this.discoverySettings(await this.workspace.snapshot()),
        });
      }
    }
    if (owner === "action-runs") {
      const snapshot = await this.workspace.snapshot();
      const runs = this.actionRuns(snapshot);
      if (method === "GET" && id === "summary") {
        const counts: Record<string, number> = {};
        for (const run of runs)
          counts[run.status] = (counts[run.status] ?? 0) + 1;
        return handled({
          counts,
          total: runs.length,
          active: runs.filter((run) =>
            ["queued", "pending", "running"].includes(run.status),
          ).length,
          pendingCancellation: runs.filter(
            (run) =>
              run.cancellationRequested &&
              ["queued", "pending", "running"].includes(run.status),
          ).length,
          synthetic: true,
        });
      }
      if (method === "GET" && id && path.length === 3) {
        const run = runs.find((item) => item.runId === id);
        if (!run) throw notFound();
        return handled(run);
      }
      if (method === "GET" && path.length === 2) {
        const query = options.query ?? {};
        const limit = integer(query.limit ?? 50, 1, 250);
        for (const bound of [query.since, query.until])
          if (bound && !Number.isFinite(Date.parse(String(bound))))
            throw badRequest("The run time filter is invalid.");
        const filtered = runs.filter(
          (run) =>
            (!query.status || query.status === run.status) &&
            (!query.action || query.action === run.action) &&
            (!query.since ||
              Date.parse(run.createdAt) >= Date.parse(String(query.since))) &&
            (!query.until ||
              Date.parse(run.createdAt) <= Date.parse(String(query.until))),
        );
        const cursor = query.before
          ? filtered.findIndex((run) => run.runId === query.before)
          : -1;
        if (query.before && cursor < 0)
          throw badRequest(
            "The synthetic run cursor is no longer available. Reload the list.",
          );
        const page = filtered.slice(cursor + 1, cursor + limit + 1);
        const hasMore = cursor + 1 + page.length < filtered.length;
        return handled({
          runs: page,
          nextCursor: hasMore ? (page.at(-1)?.runId ?? null) : null,
          hasMore,
        });
      }
      if (method === "POST" && id && action === "cancel" && path.length === 4) {
        const original = runs.find((run) => run.runId === id);
        if (!original) throw notFound();
        if (snapshot.state.features?.preparationRuns?.[id]) throw conflict("This browser-local baseline is already ready for review. There is no running worker action to cancel.");
        const key = options.idempotencyKey ?? `demo:cancel:${id}`;
        const request = stableDemoStringify({ runId: id, body });
        const prior = snapshot.state.features?.runCancellationCommands?.[key];
        if (prior && (prior.runId !== id || prior.request !== request))
          throw conflict(
            "This run cancellation identity was already used for different content.",
          );
        if (original.status === "canceled") return handled(original);
        await this.api.executeHttpLocalCommand(
          "cancelWorkflowRun",
          [id],
          (draft) => {
            if (draft.resetEpoch !== snapshot.resetEpoch)
              throw conflict(
                "The synthetic workspace was reset before cancellation.",
              );
            const commands = (features(draft).runCancellationCommands ??= {});
            const receipt = commands[key];
            if (
              receipt &&
              (receipt.runId !== id || receipt.request !== request)
            )
              throw conflict(
                "This cancellation request identity conflicts with a saved command.",
              );
            commands[key] = { runId: id, request };
          },
        );
        const canceled = this.actionRuns(await this.workspace.snapshot()).find(
          (run) => run.runId === id,
        );
        if (!canceled) throw notFound();
        return handled(canceled);
      }
      return notHandled;
    }
    if (owner === "applications" && id === "summary" && method === "GET") {
      const snapshot = await this.workspace.snapshot();
      const applications = Object.values(
        snapshot.state.features?.applications ?? {},
      );
      const count = (statuses: readonly string[]) =>
        applications.filter((application) =>
          statuses.includes(String(application.status)),
        ).length;
      const outcomes = [
        ...snapshot.state.readModel.analytics.outcomes.outcomes,
        ...(snapshot.state.features?.manualOutcomes ?? []),
      ];
      const available = new Set([
        ...Object.keys(snapshot.state.readModel.jobs.details),
        ...Object.keys(snapshot.state.features?.postings ?? {}),
      ]);
      const lifecycle = new Map<
        string,
        { appliedAt: number | null; lastActivityAt: number; stopped: boolean }
      >();
      const stops = new Set([
        "recruiter_reply",
        "interview",
        "assessment",
        "offer",
        "rejection",
        "withdrawn",
        "bounced",
      ]);
      for (const outcome of [...outcomes]
        .filter((item) => available.has(item.jobKey))
        .sort(
          (left, right) =>
            left.jobKey.localeCompare(right.jobKey) ||
            Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
            Date.parse(left.recordedAt) - Date.parse(right.recordedAt) ||
            left.kind.localeCompare(right.kind),
        )) {
        const at = Date.parse(outcome.occurredAt);
        if (!Number.isFinite(at))
          throw conflict(
            "A saved outcome has an invalid timestamp; the application summary cannot be computed.",
          );
        const state = lifecycle.get(outcome.jobKey) ?? {
          appliedAt: null,
          lastActivityAt: at,
          stopped: false,
        };
        state.lastActivityAt = Math.max(state.lastActivityAt, at);
        if (
          outcome.kind === "applied_confirmation" &&
          (state.appliedAt === null || at > state.appliedAt)
        ) {
          state.appliedAt = at;
          state.stopped = false;
        } else if (
          state.appliedAt !== null &&
          at > state.appliedAt &&
          stops.has(outcome.kind)
        )
          state.stopped = true;
        lifecycle.set(outcome.jobKey, state);
      }
      const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
      const followUpJobIds = [...lifecycle]
        .filter(
          ([, state]) =>
            state.appliedAt !== null &&
            !state.stopped &&
            state.lastActivityAt <= cutoff,
        )
        .map(([jobId]) => jobId)
        .sort();
      const running = new Set(
        applications
          .filter(
            (application) =>
              ["running", "sending"].includes(String(application.status)) &&
              typeof application.runId === "string",
          )
          .map((application) => application.runId),
      );
      return handled({
        pendingApprovalCount: count([
          "awaiting_approval",
          "awaiting_rehearsal",
        ]),
        queuedCount: count(["queued"]),
        queueCountComplete: true,
        runningCount: running.size,
        needsVerificationCount: applications.filter(
          (application) => application.intent && !application.receipt,
        ).length,
        failedCount: count(["failed"]),
        appliedCount: [...lifecycle.values()].filter(
          (state) => state.appliedAt !== null,
        ).length,
        followUpsDueCount: followUpJobIds.length,
        followUpJobIds,
        jobs: applications.map(
          ({ jobId, status, payloadId, latestDecision, updatedAt }) => ({
            jobId,
            status,
            payloadId,
            latestDecision,
            updatedAt,
          }),
        ),
        synthetic: true,
      });
    }
    if (owner === "activity" && method === "GET") {
      const snapshot = await this.workspace.snapshot();
      const seedEvents = snapshot.state.readModel.dashboard.activity.items.map(
        (event) => ({
          eventId: event.eventId,
          type: event.eventType,
          feature:
            (
              {
                discover: "discovery",
                score: "fit",
                tailor: "resumes",
                apply: "applications",
              } as Record<string, string>
            )[event.stage] ?? "runtime",
          aggregateId: event.jobKey ?? null,
          tenantId: "local",
          occurredAt: event.at,
          level: event.level === "warning" ? "warn" : event.level,
          stage: event.stage,
          payload: {
            message: event.message,
            stage: event.stage,
            level: event.level === "warning" ? "warn" : event.level,
            jobId: event.jobKey,
            workflowId: event.workflowId,
            synthetic: true,
          },
        }),
      );
      const committedEvents = [...snapshot.eventLog].reverse().map((record) => {
        const event = demoEventEnvelope(record.event);
        return {
          eventId: `demo:event:${snapshot.workspaceId}:${record.sequence}`,
          type: record.event.type,
          feature: event.feature ?? "runtime",
          aggregateId: event.aggregateId ?? null,
          tenantId: event.tenantId,
          occurredAt: event.occurredAt ?? snapshot.updatedAt,
          level:
            typeof data(event.payload).level === "string"
              ? String(data(event.payload).level)
              : "info",
          stage:
            typeof data(event.payload).stage === "string"
              ? String(data(event.payload).stage)
              : null,
          payload: event.payload,
        };
      });
      const allEvents = [...committedEvents, ...seedEvents].sort(
        (left, right) =>
          (right.occurredAt ?? "").localeCompare(left.occurredAt ?? ""),
      );
      if (id && path.length === 3) {
        const event = allEvents.find((item) => item.eventId === id);
        if (!event) throw notFound();
        return handled(event);
      }
      if (path.length !== 2) return notHandled;
      const query = options.query ?? {};
      const q = String(query.q ?? "").toLocaleLowerCase();
      for (const bound of [query.since, query.until])
        if (bound && !Number.isFinite(Date.parse(String(bound))))
          throw badRequest("The activity time filter is invalid.");
      const events = allEvents.filter(
        (event) =>
          ["feature", "type", "level", "stage", "aggregateId"].every(
            (key) =>
              query[key] === undefined ||
              query[key] === null ||
              query[key] === "" ||
              data(event)[key] === query[key],
          ) &&
          (!query.since ||
            (event.occurredAt !== null &&
              Date.parse(event.occurredAt) >=
                Date.parse(String(query.since)))) &&
          (!query.until ||
            (event.occurredAt !== null &&
              Date.parse(event.occurredAt) <=
                Date.parse(String(query.until)))) &&
          (!q ||
            [
              event.type,
              event.feature,
              event.aggregateId ?? "",
              event.level,
              event.stage ?? "",
              JSON.stringify(event.payload),
            ].some((value) => value.toLocaleLowerCase().includes(q))),
      );
      const limit = integer(options.query?.limit ?? 50, 1, 250);
      const before = options.query?.before;
      const cursor = before
        ? events.findIndex((event) => event.eventId === before)
        : -1;
      if (before && cursor < 0)
        throw badRequest(
          "The activity cursor is no longer available. Reload the activity list.",
        );
      const page = events.slice(cursor + 1, cursor + 1 + limit);
      const hasMore = cursor + 1 + page.length < events.length;
      return handled({
        events: page,
        nextCursor: hasMore ? (page.at(-1)?.eventId ?? null) : null,
        hasMore,
      });
    }
    if (
      (owner === "outcomes" && path.length === 2 && method === "GET") ||
      (owner === "jobs" &&
        id &&
        action === "outcomes" &&
        path.length === 4 &&
        method === "GET")
    ) {
      const snapshot = await this.workspace.snapshot();
      if (owner === "jobs") await this.posting(snapshot, id!);
      const original =
        owner === "jobs"
          ? (snapshot.state.readModel.analytics.jobOutcomes[id!] ?? {
              ok: true,
              jobKey: id!,
              outcomes: [],
              suggestions: [],
            })
          : snapshot.state.readModel.analytics.outcomes;
      return handled({
        ...structuredClone(original),
        outcomes: [
          ...original.outcomes,
          ...(snapshot.state.features?.manualOutcomes ?? []).filter(
            (outcome) => owner !== "jobs" || outcome.jobKey === id,
          ),
        ].map((outcome) => ({ ...outcome, recordedBy: "user" })),
        suggestions: original.suggestions.map((suggestion) => ({
          ...structuredClone(suggestion),
          version:
            snapshot.state.features?.suggestionVersions?.[
              suggestion.suggestionId
            ] ?? 1,
        })),
        interpretationStatus: { status: "not_requested", failureCode: null },
      });
    }
    if (
      owner === "jobs" &&
      id &&
      action === "outcomes" &&
      path.length === 4 &&
      method === "POST"
    ) {
      const parsed = ManualApplicationOutcomeRequestSchema.safeParse(body);
      if (!parsed.success)
        throw badRequest("The manual outcome request is invalid.");
      const snapshot = await this.workspace.snapshot();
      await this.posting(snapshot, id);
      if (snapshot.state.readModel.jobs.details[id]) {
        const result = await this.api.recordManualApplicationOutcome(id, parsed.data);
        return handled({ ...result, outcome: { ...result.outcome, recordedBy: "user" } });
      }
      const request = stableDemoStringify(parsed.data);
      const key = JSON.stringify([id, parsed.data.requestId]);
      let outcome: ApplicationOutcome | undefined;
      let disposition = "applied";
      await this.commit((draft) => {
        const state = features(draft);
        const prior = state.manualOutcomeCommands?.[key];
        if (prior) {
          if (prior.request !== request)
            throw conflict(
              "This outcome request identity was already used for different facts.",
            );
          outcome = state.manualOutcomes?.find(
            (item) => item.outcomeId === prior.outcomeId,
          );
          if (!outcome)
            throw conflict("The saved outcome receipt is unavailable.");
          disposition = "replayed";
          return;
        }
        if (!state.postings?.[id]) throw notFound();
        const now = new Date().toISOString();
        outcome = {
          outcomeId: crypto.randomUUID(),
          jobKey: id,
          kind: parsed.data.kind,
          source: "manual",
          note: parsed.data.note ?? null,
          occurredAt: parsed.data.occurredAt ?? now,
          recordedAt: now,
          suggestionId: null,
          evidenceId: null,
          interviewPrepGeneration: parsed.data.interviewPrepGeneration ?? null,
        };
        (state.manualOutcomes ??= []).push(outcome);
        (state.manualOutcomeCommands ??= {})[key] = {
          request,
          outcomeId: outcome.outcomeId,
        };
      }, snapshot.resetEpoch);
      return handled({ ok: true, disposition, outcome: { ...outcome, recordedBy: "user" } });
    }
    if (
      owner === "outcomes" &&
      id === "suggestions" &&
      action &&
      detail === "audit" &&
      method === "GET"
    ) {
      throw new DemoCapabilityError(
        "outcomeSuggestionAudit",
        "The synthetic tour has no private recorded provider receipts for this audit.",
      );
    }
    if (
      owner === "outcomes" &&
      id === "suggestions" &&
      action &&
      detail === "decision" &&
      method === "POST"
    ) {
      const expected = integer(body.expectedVersion, 1);
      const { expectedVersion: _expected, ...decision } = body;
      const result = await this.api.executeHttpLocalCommand(
        "decideOutcomeSuggestion",
        [action, decision],
        (draft) => {
          const suggestion =
            draft.state.readModel.analytics.outcomes.suggestions.find(
              (item) => item.suggestionId === action,
            );
          if (!suggestion) throw notFound();
          const versions = (features(draft).suggestionVersions ??= {});
          const revision = versions[action] ?? 1;
          if (suggestion.status === "pending") {
            if (revision !== expected)
              throw conflict("The suggestion changed before review.");
            versions[action] = revision + 1;
          } else if (revision !== expected + 1)
            throw conflict("The suggestion review revision changed.");
        },
      );
      const response = data(result);
      const suggestion = data(response.suggestion);
      const snapshot = await this.workspace.snapshot();
      return handled({
        ...response,
        suggestion: {
          ...suggestion,
          version: snapshot.state.features?.suggestionVersions?.[action] ?? 1,
        },
      });
    }
    if (
      (owner === "apply" && id === "review") ||
      (owner === "jobs" &&
        id &&
        (action === "application" ||
          action === "apply-review" ||
          action === "repeat-application"))
    ) {
      return this.application(method, path, options);
    }
    if (
      method === "GET" &&
      owner === "outreach" &&
      id === "threads" &&
      path[3] &&
      path[4] === "drafts" &&
      path[5] &&
      path[6] === "determinations"
    ) {
      const snapshot = await this.workspace.snapshot();
      const thread = snapshot.state.readModel.outreach.thread.thread;
      const draft =
        thread?.threadId === path[3]
          ? thread.drafts.find((item) => item.draftId === path[5])
          : undefined;
      if (!draft) throw notFound();
      const ids = Array.isArray(draft.gateResults.determinationIds)
        ? draft.gateResults.determinationIds
        : [];
      return handled({
        ok: true,
        threadId: thread!.threadId,
        draftId: draft.draftId,
        complete: false,
        authorityVerified: false,
        records: [...new Set(ids)].map((determinationId) => ({
          determinationId,
          available: false,
          verified: false,
          verificationFailure: "synthetic_example_has_no_provider_receipt",
        })),
      });
    }
    if (
      method === "GET" &&
      owner === "contacts" &&
      id === "research" &&
      action &&
      detail === "determinations"
    ) {
      const task = (await this.workspace.snapshot()).state.readModel.contacts
        .researchTaskDetails[action];
      if (!task) throw notFound();
      const ids = [
        ...new Set(
          task.task.sourceAttempts
            .map((attempt) => data(attempt).determinationId)
            .filter((value): value is string => typeof value === "string"),
        ),
      ];
      return handled({
        ok: true,
        taskId: action,
        complete: false,
        authorityVerified: false,
        records: ids.map((determinationId) => ({
          determinationId,
          available: false,
          verified: false,
          verificationFailure: "synthetic_example_has_no_provider_receipt",
        })),
      });
    }
    if (owner === "health" && path.length === 2 && method === "GET")
      {
      const identity = await demoWorkspaceIdentity(await this.workspace.snapshot());
      return handled({
        ok: true,
        ...identity,
        application: "jobctrl-python",
        schemaVersion: 1,
        mode: "demo",
        transport: "browser_local",
        features: [
          "profile",
          "jobs",
          "requirements",
          "fit",
          "resumes",
          "preparation",
          "discovery",
          "companies",
          "contacts",
          "outreach",
          "applications",
          "interviews",
          "digest",
          "compensation",
        ],
        worker: {
          status: "unavailable",
          healthy: false,
          reason:
            "The browser demo has no local worker or external provider connection.",
        },
        llmSpend: {
          costUsd: 0,
          accountingComplete: true,
          costAuthority: "reported",
        },
      });
      }
    if (owner === "settings" && path.length === 2) {
      if (method === "GET")
        return handled(this.settings(await this.workspace.snapshot()));
      if (method === "PATCH") {
        const expected = integer(body.expectedRevision, 1);
        const { expectedRevision: _expected, ...patch } = body;
        let saved: z.infer<typeof settingsSchema> | undefined;
        await this.commit((draft) => {
          const previous = this.settings(draft);
          if (previous.revision !== expected)
            throw conflict(
              "The demo settings changed. Reload them before saving.",
            );
          const parsed = settingsSchema.safeParse({
            ...previous,
            ...patch,
            revision: expected + 1,
          });
          if (!parsed.success)
            throw badRequest("The settings request is invalid.");
          saved = parsed.data;
          Object.assign(draft.state.readModel.settings, saved);
          const spend = draft.state.readModel.dashboard.health.llmSpend;
          spend.dailyBudgetUsd = saved.dailyBudgetUsd;
          spend.remainingUsd = Math.max(0, saved.dailyBudgetUsd - (spend.estimatedUsd ?? 0));
          const budget = draft.state.readModel.dashboard.digest.budget;
          budget.dailyBudgetUsd = saved.dailyBudgetUsd; budget.unlimited = saved.dailyBudgetUsd === 0;
          budget.remainingUsd = budget.unlimited ? null : Math.max(0, saved.dailyBudgetUsd - (budget.estimatedUsd ?? 0));
        });
        return handled(saved);
      }
    }
    if (
      owner === "outreach" &&
      id === "threads" &&
      path[3] &&
      path[4] === "drafts" &&
      path[5] &&
      path[6] === "copy" &&
      method === "POST"
    ) {
      return handled(
        await this.api.copyHttpOutreachDraft(
          path[3],
          path[5],
          body.expectedFingerprint,
        ),
      );
    }
    if (owner === "jobs" && path.length === 2 && method === "GET") {
      const snapshot = await this.workspace.snapshot();
      const ids = [
        ...new Set([
          ...snapshot.state.readModel.jobs.list.items.map((job) => job.jobKey),
          ...Object.keys(snapshot.state.features?.postings ?? {}),
        ]),
      ];
      const postings = await Promise.all(
        ids.map((jobId) => this.posting(snapshot, jobId)),
      );
      const query = String(options.query?.q ?? "").toLocaleLowerCase();
      // This is the visitor's literal substring filter, never a semantic match.
      const status = String(options.query?.status ?? "active");
      if (!["active", "hidden", "deleted", "all"].includes(status))
        throw badRequest("The job visibility filter is invalid.");
      const filtered = postings.filter(
        (posting) =>
          (status === "all" || status === "deleted"
            ? status === "all" || posting.deleted
            : status === "hidden"
              ? posting.hidden && !posting.deleted
              : !posting.hidden && !posting.deleted) &&
          (!query ||
            [posting.title, posting.company ?? "", posting.description].some(
              (value) => value.toLocaleLowerCase().includes(query),
            )),
      );
      const sort = String(options.query?.sort ?? "created_at");
      const direction = String(options.query?.direction ?? "desc");
      if (
        ![
          "created_at",
          "updated_at",
          "observed_at",
          "title",
          "company",
          "source",
        ].includes(sort) ||
        !["asc", "desc"].includes(direction)
      )
        throw badRequest("The job sort order is invalid.");
      const value = (posting: Posting) =>
        sort === "title"
          ? posting.title
          : sort === "company"
            ? (posting.company ?? "")
            : sort === "source"
              ? posting.source_id
              : posting.observed_at;
      filtered.sort(
        (left, right) =>
          (value(left).localeCompare(value(right)) ||
            left.job_id.localeCompare(right.job_id)) *
          (direction === "asc" ? 1 : -1),
      );
      const offset = integer(options.query?.offset ?? 0, 0);
      const limit = integer(options.query?.limit ?? 50, 1, 250);
      return handled({
        jobs: filtered.slice(offset, offset + limit),
        total: filtered.length,
        offset,
        limit,
      });
    }
    if (
      owner === "jobs" &&
      id === "capture" &&
      method === "POST" &&
      path.length === 3
    ) {
      const requestSnapshot = await this.workspace.snapshot();
      const title = text(body.title);
      const description = text(body.description);
      const url = text(body.url);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw badRequest("Enter a complete http or https posting URL.");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
        throw badRequest("Enter an http or https posting URL.");
      const posting: Posting = {
        job_id: crypto.randomUUID(),
        revision: 1,
        source_id: `demo:posting:${crypto.randomUUID()}`,
        source_revision: 1,
        source_hash: await hash(description),
        title,
        company: optionalText(body.company),
        description,
        location: optionalText(body.location),
        url,
        application_url: null,
        active_state: "active",
        observed_at: new Date().toISOString(),
        hidden: false,
        deleted: false,
        state_revision: 0,
        provenance: {
          kind: "user_authored_browser_demo",
          synthetic: true,
          network_acquired: false,
        },
      };
      await this.commit((draft) => {
        (features(draft).postings ??= {})[posting.job_id] = posting;
      }, requestSnapshot.resetEpoch);
      return handled(posting);
    }
    if (owner === "jobs" && id === "import-url" && method === "POST")
      throw new DemoCapabilityError("importJobUrl");
    if (
      owner === "jobs" &&
      id === "permanent-delete-selection" &&
      method === "POST" &&
      body.jobIds !== undefined
    ) {
      const ids = jobIds(body.jobIds);
      const snapshot = await this.workspace.snapshot();
      const jobs = await Promise.all(
        ids.map((jobId) => this.posting(snapshot, jobId)),
      );
      if (jobs.some((job) => !job.deleted))
        throw conflict(
          "Move every selected job to deleted items before reviewing permanent removal.",
        );
      const selectionId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const revisions = Object.fromEntries(
        jobs.map((job) => [job.job_id, job.revision]),
      );
      const states = Object.fromEntries(
        jobs.map((job) => [job.job_id, job.state_revision]),
      );
      await this.commit((draft) => {
        this.requireJobRevisions(draft, ids, revisions, states);
        (features(draft).deleteSelections ??= {})[selectionId] = {
          ids,
          revisions,
          states,
          expiresAt,
          consumed: false,
        };
      }, snapshot.resetEpoch);
      return handled({
        ok: true,
        selectionId,
        jobIds: ids,
        count: ids.length,
        jobs: jobs.map(
          ({ job_id, title, company, revision, state_revision }) => ({
            job_id,
            title,
            company,
            revision,
            state_revision,
          }),
        ),
        retentionNotice: "This removes only the selected synthetic jobs and their job-owned browser records. Independent source-review history and browser demo preferences remain.",
        retainedIndependentData: ["source_review_history", "browser_demo_preferences"],
        expiresAt,
      });
    }
    if (
      owner === "jobs" &&
      id?.startsWith("bulk-") &&
      method === "POST" &&
      body.jobIds !== undefined
    ) {
      const operations = {
        "bulk-hide": "hideJobs",
        "bulk-unhide": "unhideJobs",
        "bulk-delete": "deleteJobs",
        "bulk-restore": "restoreJobs",
        "bulk-delete-permanent": "permanentlyDeleteJobs",
      } as const;
      const operation = operations[id as keyof typeof operations];
      if (!operation) return notHandled;
      const ids = jobIds(body.jobIds);
      const snapshot = await this.workspace.snapshot();
      const localIds = ids.filter(
        (jobId) => snapshot.state.readModel.jobs.details[jobId],
      );
      await this.api.executeHttpLocalCommand(
        operation,
        [{ jobKeys: localIds }],
        (draft, context) => {
          if (draft.resetEpoch !== snapshot.resetEpoch)
            throw conflict(
              "The synthetic workspace was reset. Review the current jobs before trying again.",
            );
          const state = features(draft);
          if (operation === "permanentlyDeleteJobs") {
            const selection =
              typeof body.selectionId === "string"
                ? state.deleteSelections?.[body.selectionId]
                : undefined;
            if (
              !selection ||
              selection.consumed ||
              Date.parse(selection.expiresAt) <= Date.now() ||
              ids.length !== selection.ids.length ||
              ids.some((jobId) => !selection.ids.includes(jobId))
            )
              throw conflict(
                "The reviewed deletion selection expired or changed. Review it again.",
              );
            this.requireJobRevisions(
              draft,
              ids,
              selection.revisions,
              selection.states,
            );
            if (ids.some((jobId) => !this.jobState(draft, jobId).deleted))
              throw conflict(
                "A selected job was restored after deletion review.",
              );
            selection.consumed = true;
          } else
            this.requireJobRevisions(
              draft,
              ids,
              data(body.expectedRevisions),
              data(body.expectedStateRevisions),
            );
          for (const jobId of ids) {
            const posting = state.postings?.[jobId];
            if (operation === "permanentlyDeleteJobs") {
              if (state.postings) delete state.postings[jobId];
              for (const resume of Object.values(state.resumes ?? {})) {
                if (resume.job_id !== jobId) continue;
                for (const revision of resume.revisions)
                  for (const render of revision.renders)
                    if (typeof render.blob_id === "string")
                      context.deleteBlob(render.blob_id);
                delete state.resumes![resume.resume_id];
              }
            } else if (posting) {
              if (operation === "hideJobs" || operation === "unhideJobs")
                posting.hidden = operation === "hideJobs";
              else posting.deleted = operation === "deleteJobs";
              posting.state_revision += 1;
            }
          }
        },
      );
      return handled({ ok: true, jobIds: ids, affected: ids.length });
    }
    if (owner === "fit" && id === "summaries" && method === "POST") {
      const ids = jobIds(body.job_ids, true);
      const snapshot = await this.workspace.snapshot();
      return handled({
        summaries: Object.fromEntries(
          await Promise.all(
            ids.map(async (jobId) => [jobId, await this.fit(snapshot, jobId)]),
          ),
        ),
      });
    }
    if (
      owner === "jobs" &&
      id &&
      path.length === 3 &&
      method === "GET" &&
      id !== "reviewable-list"
    ) {
      return handled(await this.posting(await this.workspace.snapshot(), id));
    }
    if (owner === "jobs" && id && action === "refresh" && method === "POST")
      throw new DemoCapabilityError("checkPostingAvailability");
    if (
      owner === "jobs" &&
      id &&
      action === "company-briefing" &&
      method === "GET"
    ) {
      await this.posting(await this.workspace.snapshot(), id);
      return handled(null);
    }
    if (
      owner === "jobs" &&
      id &&
      action === "compensation" &&
      path.length === 4 &&
      method === "GET"
    ) {
      const snapshot = await this.workspace.snapshot();
      await this.posting(snapshot, id);
      const job = snapshot.state.readModel.jobs.details[id];
      return handled({
        summary: job?.job.compensationSummary ?? null,
        audit: job?.compensationAudit ?? null,
        refresh: null,
      });
    }
    if (owner === "compensation" && id === "sources" && method === "GET") {
      const snapshot = await this.workspace.snapshot();
      return handled({
        ...structuredClone(
          snapshot.state.readModel.discovery.compensationSources,
        ),
        revision: snapshot.state.features?.compensationRevision ?? 0,
      });
    }
    if (owner === "compensation" && id === "sources" && method === "PATCH") {
      const expected = integer(body.expectedRevision, 0);
      const response = await this.api.executeHttpLocalCommand(
        "updateCompensationSourcePolicy",
        [body],
        (draft) => {
          const state = features(draft);
          if ((state.compensationRevision ?? 0) !== expected)
            throw conflict(
              "The compensation source policy changed. Reload it before saving.",
            );
          state.compensationRevision = expected + 1;
        },
      );
      return handled({ ...data(response), revision: expected + 1 });
    }
    if (owner === "profile" && id === "sources") {
      if (method === "GET" && path.length === 3)
        return handled(this.sources(await this.workspace.snapshot()));
      if (method === "POST") {
        let saved: ReturnType<DemoFeatureHttpAdapter["sources"]> | undefined;
        await this.commit((draft) => {
          const library = this.library(draft);
          if (library.profileVersion !== body.expectedProfileVersion)
            throw conflict(
              "The Profile changed. Review its current sources before saving.",
            );
          const sources = (features(draft).profileSources ??= []);
          if (path.length === 3) {
            const source = data(body.source);
            sources.push({
              source_id: `source:${crypto.randomUUID()}`,
              revision: 1,
              text: text(source.text),
              kind: optionalText(source.kind) ?? "attachment",
              confirmation: "unconfirmed",
              origin: "attached",
              synthetic: true,
            });
          } else if (path.length === 5 && detail === "confirmation") {
            const source = this.sources(draft).sources.find(
              (item) => item.source_id === action,
            );
            if (!source) throw notFound();
            if (
              source.revision !== body.expectedSourceRevision ||
              source.text !== body.exactText
            )
              throw conflict("The exact source text or revision changed.");
            if (source.kind === "authored_achievement")
              throw badRequest(
                "Edit authored achievement facts through Profile.",
              );
            const decision = text(body.decision);
            if (!["confirm", "reject", "defer"].includes(decision))
              throw badRequest("Choose confirm, reject or defer.");
            const updated = {
              ...source,
              revision: source.revision + 1,
              confirmation:
                decision === "confirm"
                  ? "confirmed"
                  : decision === "reject"
                    ? "rejected"
                    : "deferred",
            };
            const index = sources.findIndex(
              (item) => item.source_id === source.source_id,
            );
            if (index < 0) sources.push(updated);
            else sources[index] = updated;
          } else throw notFound();
          library.profileVersion += 1;
          draft.state.readModel.profile.config.profileVersion =
            library.profileVersion;
          features(draft).wording = library;
          features(draft).profileSourcesChanged = true;
          saved = this.sources(draft);
        });
        return handled(saved);
      }
    }
    if (owner === "profile" && id === "wording") {
      if (method === "GET" && path.length === 3)
        return handled(this.library(await this.workspace.snapshot()));
      if (method === "GET" && path.length === 5 && detail === "history") {
        const snapshot = await this.workspace.snapshot();
        const current = this.library(snapshot).variants.find((variant) => variant.variant_id === action);
        if (!current) throw notFound();
        return handled({ ok: true, revisions: [...structuredClone(snapshot.state.features?.wordingHistory?.[action!] ?? []), current] });
      }
      if (method === "POST" || method === "PATCH") {
        let accepted: WordingLibrary | undefined;
        await this.commit((draft) => {
          const library = this.library(draft);
          if (library.profileVersion !== body.expectedProfileVersion)
            throw conflict(
              "The Profile changed. Review its current version before saving wording.",
            );
          if (method === "POST" && path.length === 3) {
            const achievement = library.roles
              .flatMap((role) => role.achievements)
              .find((item) => item.achievement_id === body.achievementId);
            if (!achievement)
              throw conflict("This authored achievement is no longer current.");
            const refs = refsFrom(body.sourceRefs);
            if (
              !refs.length ||
              !exactDemoRefs(refs, achievement.source_refs)
            ) {
              throw conflict(
                "The wording sources changed. Review the current source revisions.",
              );
            }
            let parent: WordingVariant | undefined;
            if (body.replacesVariantId !== undefined || body.replacesVariantRevision !== undefined) {
              parent = library.variants.find((variant) => variant.variant_id === body.replacesVariantId);
              if (!parent || parent.achievement_id !== achievement.achievement_id || parent.revision !== body.replacesVariantRevision || parent.status === "stale")
                throw conflict("The wording being revised changed. Review its current text before proposing a revision.");
            }
            const intendedRequirementIds = body.intendedRequirementIds === undefined ? undefined : jobIds(body.intendedRequirementIds, true);
            library.variants.push({
              variant_id: `wording:${crypto.randomUUID()}`,
              revision: 1,
              achievement_id: achievement.achievement_id,
              text: text(body.text),
              source_refs: refs,
              status: "pending",
              approval_id: null,
              origin_key: null,
              provenance: {
                kind: parent ? "proposed_revision" : "user_authored_browser_demo",
                synthetic: true,
                assessment_status: "unassessed",
                ...(parent ? { replaces_variant_id: parent.variant_id, replaces_variant_revision: parent.revision } : {}),
                ...(intendedRequirementIds ? { intended_requirement_ids: intendedRequirementIds } : {}),
              },
            });
          } else if (method === "PATCH" && path.length === 4) {
            const variant = library.variants.find((item) => item.variant_id === action);
            if (!variant) throw notFound();
            if (variant.revision !== body.expectedVariantRevision || variant.text !== body.exactText)
              throw conflict("The wording draft changed. Review its current text.");
            if (variant.status !== "pending") throw conflict("Create a separate draft to edit reviewed wording.");
            const nextText = text(body.text);
            if (nextText === variant.text) { accepted = library; return; }
            ((features(draft).wordingHistory ??= {})[variant.variant_id] ??= []).push(structuredClone(variant));
            variant.text = nextText;
            variant.revision += 1;
            variant.provenance = { kind: "user_edited", original_provenance: variant.provenance, synthetic: true, assessment_status: "unassessed" };
          } else if (method === "POST" && path.length === 5 && detail === "decision") {
            const variant = library.variants.find(
              (item) => item.variant_id === action,
            );
            if (!variant) throw notFound();
            if (
              variant.revision !== body.expectedVariantRevision ||
              variant.text !== body.exactText ||
              variant.status === "stale"
            )
              throw conflict(
                "The exact wording or its source revision changed.",
              );
            const decision = text(body.decision);
            if (!["approve", "reject", "defer"].includes(decision))
              throw badRequest("Choose approve, reject or defer.");
            variant.status =
              decision === "approve"
                ? "approved"
                : decision === "reject"
                  ? "rejected"
                  : "deferred";
            variant.approval_id =
              decision === "approve" ? `approval:${crypto.randomUUID()}` : null;
          } else throw notFound();
          library.profileVersion += 1;
          library.wordingRevision += 1;
          draft.state.readModel.profile.config.profileVersion =
            library.profileVersion;
          features(draft).wording = library;
          accepted = library;
        });
        return handled(accepted);
      }
    }
    if (owner === "jobs" && id && action === "requirements") {
      if (method === "GET")
        return handled(
          await this.requirements(await this.workspace.snapshot(), id),
        );
      if (method === "POST") throw new DemoCapabilityError("rescoreJob");
    }
    if (owner === "jobs" && id && action === "fit") {
      if (method === "GET")
        return handled(await this.fit(await this.workspace.snapshot(), id));
      if (method === "POST" && detail === "assess")
        throw new DemoCapabilityError("rescoreJob");
      if (method === "POST" && detail === "correct") {
        const score = integer(body.score, 1, 10);
        const reason = text(body.rationale);
        await this.api.executeHttpLocalCommand(
          "correctScore",
          [id, { correctedScore: score, reason }],
          (draft) => {
            const job = draft.state.readModel.jobs.details[id]?.job;
            if (!job || job.scoreVersion !== body.expected_revision)
              throw conflict(
                "The fit assessment changed. Review it before correcting the score.",
              );
          },
        );
        return handled(await this.fit(await this.workspace.snapshot(), id));
      }
    }
    if (owner === "resumes") return this.resume(method, path, options);
    if (owner === "evidence-map" && id === "learning") {
      throw new DemoCapabilityError(
        method === "GET" ? "careerLearning" : "writeCareerLearning",
      );
    }
    return notHandled;
  }

  private async posting(
    snapshot: DemoWorkspaceSnapshot,
    id: string,
  ): Promise<Posting> {
    const saved = snapshot.state.features?.postings?.[id];
    if (saved) return structuredClone(saved);
    const detail = snapshot.state.readModel.jobs.details[id];
    if (!detail) throw notFound();
    const job = detail.job;
    const description =
      postingExamples[id]?.description ?? job.descriptionPreview ?? "";
    return {
      job_id: id,
      revision: 1,
      source_id: `demo:posting:${id}`,
      source_revision: 1,
      source_hash: await hash(description),
      title: job.title ?? "",
      company: job.company ?? null,
      description,
      location: job.location ?? null,
      url: job.url,
      application_url: job.applicationUrl ?? null,
      active_state: job.deletedAt ? "deleted" : job.activeState,
      observed_at: job.discoveredAt ?? snapshot.createdAt,
      provenance: {
        kind: "bundled_synthetic_example",
        synthetic: true,
        network_acquired: false,
      },
      hidden: Boolean(job.hiddenAt),
      deleted: Boolean(job.deletedAt),
      state_revision: snapshot.jobLifecycleRevisions?.[id] ?? 0,
    };
  }

  private settings(snapshot: DemoWorkspaceSnapshot): z.infer<typeof settingsSchema> {
    return structuredClone(snapshot.state.readModel.settings);
  }

  private discoverySettings(snapshot: DemoWorkspaceSnapshot) {
    const saved = structuredClone(snapshot.state.readModel.discovery.settings);
    const policy = this.settings(snapshot);
    return {
      ...saved,
      policyRevision: policy.revision,
      settings: {
        ...saved.settings,
        minFitScore: policy.minFitScore,
        autoApply: policy.applyAutomationEnabled,
        applyApprovalRequired: true as const,
      },
      effectiveSettings: {
        ...saved.effectiveSettings,
        minFitScore: {
          ...saved.effectiveSettings.minFitScore,
          value: policy.minFitScore,
        },
        autoApply: {
          ...saved.effectiveSettings.autoApply,
          value: policy.applyAutomationEnabled,
        },
        applyApprovalRequired: {
          ...saved.effectiveSettings.applyApprovalRequired,
          value: true as const,
          editable: false as const,
          locked: true as const,
        },
      },
    };
  }

  private sources(snapshot: DemoWorkspaceSnapshot): {
    ok: true;
    profileVersion: number;
    sources: ProfileSource[];
  } {
    const library = this.library(snapshot);
    const sources: ProfileSource[] = library.variants
      .filter(
        (variant) =>
          variant.variant_id.startsWith("baseline:") &&
          variant.status !== "stale",
      )
      .flatMap((variant) =>
        variant.source_refs.map((ref) => ({
          ...ref,
          text: variant.text,
          kind: "authored_achievement",
          confirmation: "authored",
          origin: "profile",
          achievement_id: variant.achievement_id,
          synthetic: true,
        })),
      );
    const profile = ProfileSchema.parse(
      snapshot.state.readModel.profile.config.profile,
    );
    sources.push(
      ...profile.resume.experience_entries.flatMap((role) =>
        role.achievement_evidence.map((record) => ({
          source_id: `demo:evidence:${encodeURIComponent(JSON.stringify(["default", role.id, record.id]))}`,
          revision: library.profileVersion,
          text: JSON.stringify(record),
          kind: "evidence",
          confirmation: record.confirmation_review_required
            ? "review_required"
            : "unconfirmed",
          origin: "profile",
          role_id: role.id,
          evidence_id: record.id,
          record,
          synthetic: true,
        })),
      ),
    );
    const saved = (snapshot.state.features?.profileSources ?? []).filter(
      (source) =>
        source.origin !== "profile" ||
        sources.some(
          (current) =>
            current.source_id === source.source_id &&
            current.text === source.text,
        ),
    );
    return {
      ok: true,
      profileVersion: library.profileVersion,
      sources: [
        ...sources.filter(
          (source) =>
            !saved.some((item) => item.source_id === source.source_id),
        ),
        ...structuredClone(saved),
      ],
    };
  }

  private jobState(snapshot: DemoWorkspaceSnapshot, id: string) {
    const saved = snapshot.state.features?.postings?.[id];
    if (saved) return saved;
    const job = snapshot.state.readModel.jobs.details[id]?.job;
    if (!job) throw notFound();
    return {
      revision: 1,
      state_revision: snapshot.jobLifecycleRevisions?.[id] ?? 0,
      deleted: Boolean(job.deletedAt),
    };
  }

  private actionRuns(snapshot: DemoWorkspaceSnapshot) {
    const legacy = snapshot.state.readModel.runs.list.items
      .map((run) => {
        if (!run.startedAt)
          throw conflict("A saved synthetic run has no recorded start time.");
        const detail = snapshot.state.readModel.runs.details[run.runId];
        const timestamps = [
          run.startedAt,
          run.finishedAt,
          ...(detail?.events.map((event) => event.occurredAt) ?? []),
        ]
          .filter((value): value is string => typeof value === "string")
          .sort();
        return {
          runId: run.runId,
          action: `demo.${run.workflowType}`,
          status:
            run.status === "starting"
              ? "queued"
              : run.status === "in_progress"
                ? "running"
                : run.status,
          workflowId: run.workflowId,
          temporalRunId: null,
          result: run.result ?? null,
          errorCode: detail?.errorCode ?? null,
          createdAt: run.startedAt,
          updatedAt: timestamps.at(-1)!,
          cancellationRequested: false,
          synthetic: true,
          externalEffectOccurred: false,
        };
      });
    const local = Object.values(snapshot.state.features?.preparationRuns ?? {}).map((run) => ({
      runId: run.runId, action: "preparation.run", status: run.status,
      workflowId: `demo-browser:${run.runId}`, temporalRunId: null,
      result: { resume_id: run.steps.find((step) => step.stage === "compose")?.result.resume_id ?? null },
      errorCode: null, createdAt: run.createdAt, updatedAt: run.updatedAt, cancellationRequested: false,
      synthetic: true, externalEffectOccurred: false, transport: "browser_local",
    }));
    return [...legacy, ...local].sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          left.runId.localeCompare(right.runId),
      );
  }

  private requireJobRevisions(
    snapshot: DemoWorkspaceSnapshot,
    ids: readonly string[],
    revisions: Data,
    states: Data,
  ) {
    for (const id of ids) {
      const current = this.jobState(snapshot, id);
      if (
        current.revision !== revisions[id] ||
        current.state_revision !== states[id]
      )
        throw conflict(
          "A selected posting or its visibility changed. Review the current jobs before trying again.",
        );
    }
  }

  private library(snapshot: DemoWorkspaceSnapshot): WordingLibrary {
    return demoWordingLibrary(snapshot);
  }

  private async requirements(snapshot: DemoWorkspaceSnapshot, id: string) {
    const posting = await this.posting(snapshot, id);
    const example = postingExamples[id];
    if (!example) return null;
    const start = posting.description.indexOf(example.requirement);
    if (start < 0)
      throw conflict(
        "The saved synthetic requirement does not belong to this posting revision.",
      );
    const catalog = demoCanonicalRequirements(snapshot);
    const sourceExamples = [{ text: example.requirement, requirementId: example.requirementId }];
    if (id === "6e2f4a10-20be-4d5f-98a4-a4bb9a877a35") sourceExamples.push({
      text: "Coordinate incident response with the engineering team.", requirementId: "requirement-incident-response",
    });
    return {
      job_id: id,
      revision: 1,
      posting_revision: posting.revision,
      posting_hash: posting.source_hash,
      catalog_revision: 1,
      requirements: sourceExamples.map((sourceExample, index) => {
        const canonical = catalog.find((requirement) => requirement.requirement_id === sourceExample.requirementId)!;
        const spanStart = posting.description.indexOf(sourceExample.text);
        if (spanStart < 0) throw conflict("The saved synthetic occurrence does not belong to this posting revision.");
        return {
          occurrence_id: `demo:occurrence:${id}${index ? `:${index}` : ""}`,
          requirement_id: canonical.requirement_id,
          requirement_revision: 1,
          job_id: id,
          posting_revision: posting.revision,
          text: sourceExample.text,
          definition: canonical.definition,
          scope: canonical.scope,
          tier: "must_have",
          weight: 1,
          qualifiers: canonical.qualifiers,
          source_id: posting.source_id,
          source_revision: posting.source_revision,
          source_hash: posting.source_hash,
          spans: [
            {
              start: spanStart,
              end: spanStart + sourceExample.text.length,
              quote: sourceExample.text,
            },
          ],
          extraction_determination_id: `demo:bundled-synthetic:${id}`,
          equivalence_determination_ids: [],
          provenance: { kind: "bundled_synthetic_occurrence", synthetic: true, model_called: false },
          synthetic: true,
        };
      }),
      stale: false,
      latest_attempt: null,
      synthetic: true,
    };
  }

  private async requirementOccurrences(snapshot: DemoWorkspaceSnapshot, requirementId: string) {
    const occurrences: Data[] = [];
    for (const jobId of Object.keys(postingExamples)) {
      const job = snapshot.state.readModel.jobs.details[jobId]?.job;
      if (!job || job.deletedAt) continue;
      const requirements = await this.requirements(snapshot, jobId);
      if (requirements) occurrences.push(...requirements.requirements.filter((row) => row.requirement_id === requirementId));
    }
    return occurrences;
  }

  private async fit(snapshot: DemoWorkspaceSnapshot, id: string) {
    await this.posting(snapshot, id);
    const job = snapshot.state.readModel.jobs.details[id]?.job;
    const example = postingExamples[id];
    if (!job || !example)
      return {
        job_id: id,
        current: false,
        stale_reasons: [],
        score: null,
        coverage: null,
      };
    const factsCurrent =
      !snapshot.state.features?.profileSourcesChanged &&
      snapshot.state.features?.fitProfileSourceSignature ===
        stableDemoStringify(snapshot.state.readModel.profile.config.profile);
    const current = factsCurrent && !job.scoreStaleness.isStale;
    return {
      job_id: id,
      current,
      stale_reasons: current
        ? []
        : [
            !factsCurrent
              ? "profile_facts_changed"
              : "saved_synthetic_assessment_stale",
          ],
      score: {
        revision: job.scoreVersion ?? 1,
        score: job.fitScore ?? 0,
        computed_score: job.scoreCorrection?.originalScore ?? job.fitScore ?? 0,
        fit_band: job.scoreBreakdown?.fitBand ?? "unassessed",
        confidence: job.scoreBreakdown?.confidence ?? "low",
        eligibility: {
          status: job.scoreBreakdown?.eligibility?.status ?? "unknown",
          blockers: (job.scoreBreakdown?.eligibility?.hardBlockers ?? []).map((rationale) => ({ requirement_id: example.requirementId, rationale, evidence_refs: [] })),
          warnings: (job.scoreBreakdown?.eligibility?.warnings ?? []).map((rationale) => ({ requirement_id: example.requirementId, rationale, evidence_refs: [] })),
        },
        assessments: [
          {
            assessment_id: `demo:assessment:${id}`,
            requirement_id: example.requirementId,
            requirement_revision: 1,
            text: example.requirement,
            definition: example.requirement,
            scope: "resume",
            tier: "must_have",
            weight: 1,
            kind: example.kind,
            strength: example.kind === "matched" ? "supported" : null,
            confidence: "high",
            rationale: job.scoreReasoning ?? "Saved synthetic tour example.",
            evidence_refs: [],
            achievement_ids: [],
            determination_id: `demo:bundled-synthetic:${id}`,
            origin: "bundled_synthetic_example",
            eligibility: job.scoreBreakdown?.eligibility?.status ?? "unknown",
            blocker_category: job.scoreBreakdown?.eligibility?.status === "blocked" ? "qualification" : null,
            warning_category: null,
            contribution: {
              max_points: 10,
              awarded_points: example.kind === "matched" ? 10 : 0,
            },
            synthetic: true,
          },
        ],
        source_binding: {
          profile_revision: 1,
          fact_semantics_version: 1,
          requirements_revision: 1,
          posting_revision: 1,
        },
      },
      coverage: {
        status: current ? "not_assessed" : "stale",
        relations: [],
        wording_gaps:
          example.kind === "missing"
            ? [
                {
                  requirement_id: example.requirementId,
                  status: "unsupported",
                  proposal_id: null,
                  proposal_status: null,
                },
              ]
            : [],
        synthetic: true,
      },
      synthetic: true,
    };
  }

  private async applicationState(
    snapshot: DemoWorkspaceSnapshot,
    id: string,
  ): Promise<Data> {
    const posting = await this.posting(snapshot, id);
    const saved = structuredClone(
      snapshot.state.features?.applications?.[id] ?? {},
    );
    const confirmed = [
      ...snapshot.state.readModel.analytics.outcomes.outcomes,
      ...(snapshot.state.features?.manualOutcomes ?? []),
    ].some(
      (outcome) =>
        outcome.jobKey === id && outcome.kind === "applied_confirmation",
    );
    return {
      jobId: id,
      version: 0,
      status: "unprepared",
      payloadId: null,
      runId: null,
      latestDecision: null,
      stopped: false,
      updatedAt: null,
      payload: null,
      decisions: [],
      rehearsals: [],
      runs: [],
      intent: null,
      receipt: null,
      attemptCount: 0,
      ...saved,
      job: {
        jobId: id,
        title: posting.title,
        employer: posting.company,
        source: posting.source_id,
        applicationUrl: posting.application_url,
        postingUrl: posting.url,
        activeState: posting.active_state,
      },
      approvalCurrent: false,
      approvalBlockReason:
        "The browser demo cannot perform provider-backed application inspection or rehearsal.",
      confirmedApplication: confirmed,
      canExecute: false,
      synthetic: true,
      externalEffectOccurred: false,
    };
  }

  private async application(
    method: HttpMethod,
    path: readonly string[],
    options: HttpRequestOptions,
  ): Promise<Result> {
    const snapshot = await this.workspace.snapshot();
    const body = data(options.body);
    if (
      path[1] === "apply" &&
      path[2] === "review" &&
      path.length === 3 &&
      method === "GET"
    ) {
      const ids = [
        ...new Set([
          ...snapshot.state.readModel.apply.queue.items.map(
            (item) => item.jobKey,
          ),
          ...Object.keys(snapshot.state.features?.applications ?? {}),
        ]),
      ];
      return handled({
        ok: true,
        items: await Promise.all(
          ids.map((id) => this.applicationState(snapshot, id)),
        ),
      });
    }
    const id = path[2];
    if (!id) return notHandled;
    if (path[3] === "repeat-application") {
      if (method === "POST")
        throw new DemoCapabilityError("confirmRepeatApplication");
      if (method === "GET" && path.length === 4) {
        await this.posting(snapshot, id);
        const matches = snapshot.state.readModel.analytics.outcomes.outcomes
          .filter(
            (outcome) =>
              outcome.jobKey === id && outcome.kind === "applied_confirmation",
          )
          .map((outcome) => outcome.outcomeId);
        return handled({
          ok: true,
          jobId: id,
          status: matches.length ? "same_opening" : "check_required",
          evidenceSha256: await hash(stableDemoStringify(matches)),
          checkId: null,
          matchedApplications: matches,
          blockReason: matches.length
            ? "A manual application confirmation is already recorded in this synthetic workspace."
            : "Role equivalence requires the configured local model.",
          override: null,
          determinationIds: [],
        });
      }
      return notHandled;
    }
    if (method === "GET" && path[3] === "application" && path.length === 4)
      return handled({
        ok: true,
        application: await this.applicationState(snapshot, id),
      });
    if (method !== "POST") return notHandled;
    const operation =
      path[3] === "apply-review" && path.length === 4
        ? "review"
        : path[3] === "application" && path.length === 5
          ? path[4]
          : undefined;
    if (!["review", "preparation", "control"].includes(operation ?? ""))
      return notHandled;
    const key = text(body.idempotencyKey ?? options.idempotencyKey);
    if (
      options.idempotencyKey !== undefined &&
      body.idempotencyKey !== undefined &&
      options.idempotencyKey !== body.idempotencyKey
    )
      throw badRequest("The application request identities disagree.");
    const request = stableDemoStringify({ path, body });
    const receiptKey = JSON.stringify([id, key]);
    const replay = snapshot.state.features?.applicationCommands?.[receiptKey];
    if (replay) {
      if (replay.request !== request)
        throw conflict(
          "This application request identity was already used for different content.",
        );
      return handled(replay.response);
    }
    const original = await this.applicationState(snapshot, id);
    const expectedVersion = integer(body.expectedVersion, 0);
    if (original.version !== expectedVersion)
      throw conflict(
        "The saved application changed. Review its current version before continuing.",
      );
    const next = structuredClone(original);
    let preparedResume: Resume | undefined;
    if (operation === "preparation") {
      if (body.mode !== "browser" && body.mode !== "email")
        throw badRequest("Choose browser or email preparation.");
      if (original.stopped || original.confirmedApplication)
        throw conflict("This application is stopped or already confirmed.");
      preparedResume = Object.values(
        snapshot.state.features?.resumes ?? {},
      ).find(
        (resume) =>
          resume.job_id === id && resume.accepted_revision_id !== null,
      );
      if (!preparedResume)
        throw conflict(
          "Accept and render a source-bound baseline resume before preparing the synthetic application.",
        );
      const revision = preparedResume.revisions.find(
        (row) => row.revision_id === preparedResume!.accepted_revision_id,
      );
      if (
        !revision ||
        revision.profile_revision !== this.library(snapshot).profileVersion
      )
        throw conflict(
          "The accepted resume sources changed. Accept a current baseline before preparing.",
        );
      const render = revision.renders.at(-1);
      const blobId = render?.blob_id;
      const blob =
        typeof blobId === "string" ? await this.workspace.blob(blobId) : null;
      if (!blob)
        throw conflict(
          "The accepted resume PDF is unavailable. The accepted document remains saved.",
        );
      const pdfSha256 = await hashBytes(await blob.arrayBuffer());
      const posting = await this.posting(snapshot, id);
      const profile = ProfileSchema.parse(
        snapshot.state.readModel.profile.config.profile,
      );
      const acceptance = preparedResume.acceptances.find(
        (item) => item.revision_id === revision.revision_id,
      );
      const payload: Data = {
        payloadId: crypto.randomUUID(),
        jobId: id,
        mode: body.mode,
        applicationUrl: posting.application_url ?? posting.url,
        createdAt: new Date().toISOString(),
        attachmentName: "resume.pdf",
        recipient: body.mode === "email" ? text(body.recipient) : null,
        subject: body.mode === "email" ? text(body.subject) : null,
        body: body.mode === "email" ? text(body.body) : null,
        fields: ["full_name", "email", "phone"].flatMap((field) => {
          const value = data(profile.personal)[field];
          return typeof value === "string" && value
            ? [
                {
                  path: `personal.${field}`,
                  label: field,
                  value,
                  source: { profileRevision: revision.profile_revision, field },
                },
              ]
            : [];
        }),
        screeningAnswers: [],
        sources: {
          profile: {
            profileId: "default",
            revision: revision.profile_revision,
            fingerprint: await hash(stableDemoStringify(profile)),
          },
          job: {
            jobId: id,
            revision: posting.revision,
            applicationUrl: posting.application_url ?? posting.url,
            sourceHash: posting.source_hash,
          },
          resume: {
            resumeId: preparedResume.resume_id,
            revisionId: revision.revision_id,
            acceptanceId: text(acceptance?.acceptance_id),
            profileRevision: revision.profile_revision,
            reviewStatus: "not_applicable",
            reviewOverride: false,
            pdf: {
              artifactId: blobId,
              sha256: pdfSha256,
              sizeBytes: blob.size,
            },
          },
        },
        synthetic: true,
        externalEffectOccurred: false,
      };
      payload.payloadSha256 = await hash(stableDemoStringify(payload));
      next.payload = payload;
      next.payloadId = payload.payloadId;
      next.status = "awaiting_rehearsal";
    } else if (operation === "review") {
      if (body.decision === "approve_submit")
        throw new DemoCapabilityError("applyJob");
      if (!["defer", "decline", "reset"].includes(String(body.decision)))
        throw badRequest("Choose defer, decline or reset.");
      const decision = {
        decisionId: crypto.randomUUID(),
        jobId: id,
        decision: body.decision,
        decidedAt: new Date().toISOString(),
        reason: optionalText(body.reason),
        payloadId: next.payloadId,
        payloadSha256: data(next.payload).payloadSha256 ?? null,
        rehearsalId: null,
        partialOverrideRunId: null,
        synthetic: true,
      };
      next.decisions = [...records(next.decisions), decision];
      next.latestDecision = decision;
      next.status =
        body.decision === "reset"
          ? next.payloadId
            ? "prepared"
            : "unprepared"
          : body.decision === "decline"
            ? "declined"
            : "deferred";
    } else {
      if (
        !["skip", "cancel", "reset", "mark_failed"].includes(
          String(body.action),
        )
      )
        throw badRequest("Choose a supported application control.");
      next.stopped = body.action !== "reset";
      next.status =
        body.action === "reset"
          ? next.payloadId
            ? "prepared"
            : "unprepared"
          : body.action === "skip"
            ? "skipped"
            : body.action === "cancel"
              ? "canceled"
              : "failed";
      next.runId = null;
    }
    next.version = expectedVersion + 1;
    next.updatedAt = new Date().toISOString();
    let response: Data = { ok: true, application: next };
    await this.commit((draft) => {
      const state = features(draft);
      const prior = state.applicationCommands?.[receiptKey];
      if (prior) {
        if (prior.request !== request)
          throw conflict(
            "This request identity was used for different content.",
          );
        response = prior.response;
        return;
      }
      if ((state.applications?.[id]?.version ?? 0) !== expectedVersion)
        throw conflict(
          "The application changed while this command was being prepared.",
        );
      if (preparedResume) {
        const current = state.resumes?.[preparedResume.resume_id];
        if (
          !current ||
          current.version !== preparedResume.version ||
          this.library(draft).profileVersion !==
            this.library(snapshot).profileVersion
        )
          throw conflict(
            "Application sources changed during preparation. The prior payload remains saved.",
          );
      }
      (state.applications ??= {})[id] = next;
      (state.applicationCommands ??= {})[receiptKey] = {
        request,
        response: structuredClone(response),
      };
    }, snapshot.resetEpoch);
    return handled(response);
  }

  /** Compose and verify real bytes before one atomic browser-local publication. */
  private async prepareBaseline(body: Data, options: HttpRequestOptions) {
    const unavailable = (message: string) => new JobCtrlApiError(422, "Demo Action Unavailable", message,
      { error: { code: "demo_preparation_unavailable" } });
    if (body.recipe !== "prepare" || body.resume_mode !== "baseline") throw unavailable(
      "The public demo can prepare a full baseline in this browser. Tailoring, assessment and other preparation recipes need the local worker and a configured model.");
    const parsed = z.object({ recipe: z.literal("prepare"), resume_mode: z.literal("baseline"),
      job_ids: z.array(z.string().min(1).max(120)).length(1), scope: z.literal("selected").optional(),
      limit: z.number().int().min(1).max(1000).optional(), force: z.boolean().optional(),
      allow_below_threshold: z.boolean().optional(), min_fit_score: z.number().int().min(1).max(10).optional(),
    }).strict().safeParse(body);
    if (!parsed.success || !options.idempotencyKey || options.idempotencyKey.length > 200) throw new JobCtrlApiError(400, "Bad Request",
      "Choose one synthetic job and use a stable request identity for browser-local baseline preparation.");
    const key = options.idempotencyKey;
    const request = stableDemoStringify({ action: "preparation.run", body });
    const snapshot = await this.workspace.snapshot();
    const receipt = (runId: string) => ({ runId, workflowId: `demo-browser:${runId}`, status: "succeeded" as const,
      synthetic: true, transport: "browser_local", externalEffectOccurred: false, temporalRunId: null });
    const existing = snapshot.state.features?.preparationCommands?.[key];
    if (existing) {
      if (existing.request !== request) throw conflict("This preparation identity already records different inputs.");
      return receipt(existing.runId);
    }
    const jobId = parsed.data.job_ids[0]!;
    const posting = await this.posting(snapshot, jobId);
    if (posting.deleted) throw conflict("Restore this synthetic job before preparing its baseline.");
    const library = this.library(snapshot);
    const document = this.baselineDocument(snapshot, library);
    const revision = this.newRevision(snapshot, library, document, 1);
    let rendered: Awaited<ReturnType<typeof renderDemoResume>>;
    try { rendered = await renderDemoResume(document, undefined, revision.theme, data(revision.template?.layout).plateDocument); }
    catch { throw unavailable("The browser could not verify the baseline PDF. No preparation result was published; earlier documents and accepted PDFs remain available."); }
    const now = new Date().toISOString();
    const runId = `demo-preparation:${crypto.randomUUID()}`;
    const resumeId = crypto.randomUUID(), artifactId = crypto.randomUUID();
    const blobId = `resume:${resumeId}:${revision.revision_id}:${artifactId}`;
    revision.renders.push({ artifact_id: artifactId, resume_id: resumeId, revision_id: revision.revision_id, filename: "resume.pdf", format: "pdf",
      sha256: rendered.sha256, size_bytes: rendered.blob.size, page_count: rendered.pageCount, layout_boxes: rendered.layoutBoxes,
      layout_conflicts: rendered.layoutConflicts, layout_metadata: rendered.layoutMetadata, text_verified: rendered.textVerified,
      blob_id: blobId, content_type: "application/pdf", byte_count: rendered.blob.size, synthetic: true });
    revision.render_attempts.push({ status: "succeeded", created_at: now, artifact_id: artifactId });
    const resume: Resume = { resume_id: resumeId, job_id: jobId, profile_id: "default", version: 2,
      current_revision: revision.revision_id, accepted_revision_id: null, revisions: [revision], acceptances: [], locales: [], comments: [], created_at: now, updated_at: now };
    const step = (stage: string, status: string, result: Data): DemoPreparationRun["steps"][number] => ({
      jobId, stage, status, result, errorCode: null, updatedAt: now,
    });
    const run: DemoPreparationRun = { runId, status: "succeeded", recipe: "prepare", parentRunId: null, jobIds: [jobId], createdAt: now, updatedAt: now,
      steps: [step("requirements", "skipped", { skip: "browser_local_baseline_no_model" }), step("fit", "skipped", { skip: "browser_local_baseline_no_model" }),
        step("compose", "succeeded", { resume_id: resumeId, revision_id: revision.revision_id, version: resume.version, mode: "baseline_copy" }),
        step("review", "skipped", { skip: "baseline_copy", review_status: "not_applicable" }),
        step("render", "succeeded", { resume_id: resumeId, version: resume.version, artifact_id: artifactId })],
      synthetic: true, transport: "browser_local", externalEffectOccurred: false };
    let acceptedRunId = runId;
    await this.commit((draft, context) => {
      const state = features(draft);
      const prior = state.preparationCommands?.[key];
      if (prior) {
        if (prior.request !== request) throw conflict("This preparation identity already records different inputs.");
        acceptedRunId = prior.runId;
        return;
      }
      const currentJob = this.jobState(draft, jobId);
      if (this.library(draft).profileVersion !== library.profileVersion || currentJob.revision !== posting.revision || currentJob.deleted)
        throw conflict("The saved Profile or posting changed while the browser rendered this baseline. Earlier documents remain available.");
      (state.resumes ??= {})[resumeId] = resume;
      (state.preparationRuns ??= {})[runId] = run;
      (state.preparationCommands ??= {})[key] = { request, runId };
      context.putBlob(blobId, rendered.blob);
      context.appendDomainEvent(createResumeComposed(LOCAL_TENANT, { jobId, resumeId, revisionId: revision.revision_id, synthetic: true }));
      context.appendDomainEvent(createResumeRendered(LOCAL_TENANT, { jobId, resumeId, revisionId: revision.revision_id, artifactId, synthetic: true }));
      context.appendDomainEvent(createPreparationUpdated(LOCAL_TENANT, { jobId, runId, status: "succeeded", transport: "browser_local", synthetic: true }));
    }, snapshot.resetEpoch);
    return receipt(acceptedRunId);
  }

  private async resume(
    method: HttpMethod,
    path: readonly string[],
    options: HttpRequestOptions,
  ): Promise<Result> {
    const [, , id, action] = path;
    const body = data(options.body);
    if (method === "GET") {
      const snapshot = await this.workspace.snapshot();
      const resumes = snapshot.state.features?.resumes ?? {};
      if (!id)
        return handled({
          ok: true,
          resumes: Object.values(resumes).filter(
            (resume) =>
              !options.query?.jobId || resume.job_id === options.query.jobId,
          ),
        });
      const resume = resumes[id];
      if (!resume) throw notFound();
      if (path.length === 3) return handled({ ok: true, resume });
      return notHandled;
    }
    if (method !== "POST") return notHandled;
    if (!id) {
      if (body.mode !== "baseline_copy")
        throw new DemoCapabilityError("tailorJob");
      const snapshot = await this.workspace.snapshot();
      const library = this.library(snapshot);
      await this.posting(snapshot, text(body.job_id));
      if (body.expected_profile_revision !== library.profileVersion)
        throw conflict(
          "The Profile changed. Review the current baseline before composing.",
        );
      const document = this.baselineDocument(snapshot, library);
      let saved: Resume | undefined;
      await this.commit((draft) => {
        if (this.library(draft).profileVersion !== library.profileVersion)
          throw conflict("The Profile changed while composing this baseline.");
        const now = new Date().toISOString();
        const revision = this.newRevision(draft, library, document, 1);
        saved = {
          resume_id: crypto.randomUUID(),
          job_id: text(body.job_id),
          profile_id: "default",
          version: 1,
          current_revision: revision.revision_id,
          accepted_revision_id: null,
          revisions: [revision],
          acceptances: [],
          locales: [],
          comments: [],
          created_at: now,
          updated_at: now,
        };
        (features(draft).resumes ??= {})[saved.resume_id] = saved;
      }, snapshot.resetEpoch);
      return handled({ ok: true, resume: saved });
    }
    if (action === "review") {
      const state = (await this.workspace.snapshot()).state.features?.resumes?.[
        id
      ];
      if (!state) throw notFound();
      if (state.version !== body.expected_version)
        throw conflict("This resume changed. Review the current version.");
      // Baseline-copy has no model review and never invents a passing verdict.
      return handled({ ok: true, resume: state });
    }
    if (action === "render")
      return handled({ ok: true, resume: await this.render(id, body) });
    if (action === "locales") throw new DemoCapabilityError("materialLocaleVariants");
    if (action === "artifacts" && path[5] === "open") throw new DemoCapabilityError("openArtifact");
    const sourceSnapshot = await this.workspace.snapshot();
    const sourceResume = sourceSnapshot.state.features?.resumes?.[id];
    if (!sourceResume) throw notFound();
    const documentHash = action === "accept" ? await hash(stableDemoStringify(revisionOf(sourceResume).document)) : null;
    let saved: Resume | undefined;
    await this.commit((draft) => {
      const resume = features(draft).resumes?.[id];
      if (!resume) throw notFound();
      if (resume.version !== body.expected_version)
        throw conflict(
          "This resume changed. Review its current version before saving.",
        );
      const library = this.library(draft);
      const previous = revisionOf(resume);
      if (previous.profile_revision !== library.profileVersion)
        throw conflict(
          "The Profile sources changed. The previously accepted resume is preserved.",
        );
      if (action === "edit") {
        const document = data(body.document);
        if (Object.keys(document).length === 0)
          throw badRequest("A resume document is required.");
        const revision = this.newRevision(
          draft,
          library,
          document,
          previous.number + 1,
        );
        revision.selected_variants = structuredClone(
          previous.selected_variants,
        );
        revision.theme = structuredClone(previous.theme);
        revision.template = structuredClone(previous.template);
        const valid =
          stableDemoStringify(document) ===
          stableDemoStringify(
            this.approvedDocument(draft, library, revision.selected_variants),
          );
        revision.mechanical = {
          status: valid ? "valid" : "invalid",
          failures: valid
            ? []
            : ["wording_requires_exact_current_profile_approval"],
        };
        revision.edit_draft = {
          plate_document: body.plate_document ?? null,
          user_authored: true,
        };
        resume.revisions.push(revision);
        resume.current_revision = revision.revision_id;
      } else if (action === "approve-edits") {
        if (body.user_confirmed !== true)
          throw badRequest(
            "Explicit approval of this exact authored wording is required.",
          );
        const baseline = this.baselineDocument(draft, library);
        const edited = structuredClone(previous.document);
        const baseRoles = records(baseline.experience);
        const editedRoles = records(edited.experience);
        if (baseRoles.length !== editedRoles.length)
          throw conflict(
            "Keep every authored role and achievement before approving wording edits.",
          );
        const changes: { achievementId: string; text: string }[] = [];
        const structural = structuredClone(edited);
        const structuralRoles = records(structural.experience);
        for (let index = 0; index < baseRoles.length; index += 1) {
          const baseRole = baseRoles[index]!;
          const editedRole = editedRoles[index]!;
          const structuralRole = structuralRoles[index]!;
          const baseBullets = records(baseRole.bullets);
          const editedBullets = records(editedRole.bullets);
          if (
            baseRole.id !== editedRole.id ||
            baseBullets.length !== editedBullets.length
          )
            throw conflict(
              "Keep the exact role and achievement inventory before approving wording edits.",
            );
          for (
            let bulletIndex = 0;
            bulletIndex < baseBullets.length;
            bulletIndex += 1
          ) {
            const original = baseBullets[bulletIndex]!;
            const changed = editedBullets[bulletIndex]!;
            if (original.id !== changed.id)
              throw conflict(
                "The authored achievement order changed. Restore it before approving wording edits.",
              );
            const authored = text(changed.text);
            if (authored !== original.text)
              changes.push({
                achievementId: text(original.id),
                text: authored,
              });
          }
          structuralRole.bullets = editedBullets.map((bullet, bulletIndex) => ({
            ...bullet,
            text: baseBullets[bulletIndex]!.text,
          }));
        }
        if (stableDemoStringify(structural) !== stableDemoStringify(baseline))
          throw conflict(
            "Only achievement wording can be approved here. Edit other facts in Profile first.",
          );
        const selected = previous.selected_variants.map((variant) => {
          const changed = changes.find(
            (change) => change.achievementId === variant.achievement_id,
          );
          if (!changed) return variant;
          const approved: WordingVariant = {
            ...structuredClone(variant),
            variant_id: `wording:${crypto.randomUUID()}`,
            revision: 1,
            text: changed.text,
            approval_id: `approval:${crypto.randomUUID()}`,
            status: "approved",
            provenance: { kind: "explicit_authored_edit", synthetic: true },
          };
          library.variants.push(approved);
          return approved;
        });
        if (changes.length) {
          library.profileVersion += 1;
          library.wordingRevision += 1;
          draft.state.readModel.profile.config.profileVersion =
            library.profileVersion;
          features(draft).wording = library;
        }
        const revision = this.newRevision(draft, library, edited, previous.number + 1);
        revision.selected_variants = structuredClone(selected);
        revision.theme = structuredClone(previous.theme);
        revision.template = structuredClone(previous.template);
        revision.mechanical = { status: "valid", failures: [] };
        revision.edit_draft = structuredClone(previous.edit_draft);
        resume.revisions.push(revision);
        resume.current_revision = revision.revision_id;
      } else if (action === "template") {
        const choice = this.templateChoice(draft, text(body.template_id), text(body.template_version));
        const revision = this.newRevision(draft, library, previous.document, previous.number + 1);
        revision.selected_variants = structuredClone(previous.selected_variants);
        revision.mechanical = structuredClone(previous.mechanical);
        revision.template = choice.snapshot;
        revision.theme = choice.theme;
        resume.revisions.push(revision); resume.current_revision = revision.revision_id;
      } else if (action === "accept") {
        const render = previous.renders.at(-1);
        if (
          previous.mechanical.status !== "valid" ||
          !render || render.text_verified !== true || !Array.isArray(render.layout_conflicts) || render.layout_conflicts.length > 0
        )
          throw conflict(
            "Accept requires valid current wording and its rendered PDF.",
          );
        resume.accepted_revision_id = previous.revision_id;
        resume.acceptances.push({
          acceptance_id: crypto.randomUUID(),
          revision_id: previous.revision_id,
          document_sha256: documentHash,
          profile_revision: previous.profile_revision,
          pdf: structuredClone(render),
          review_status: "not_applicable",
          review_override: false,
          accepted_at: new Date().toISOString(),
          mechanical: structuredClone(previous.mechanical),
          synthetic: true,
        });
      } else throw notFound();
      resume.version += 1;
      resume.updated_at = new Date().toISOString();
      saved = structuredClone(resume);
    }, sourceSnapshot.resetEpoch);
    return handled({ ok: true, resume: saved });
  }

  private newRevision(
    snapshot: DemoWorkspaceSnapshot,
    library: WordingLibrary,
    document: Data,
    number: number,
  ): ResumeRevision {
    const defaultTemplate = snapshot.state.readModel.materials.resumeTemplates.defaultTemplate;
    const choice = defaultTemplate ? this.templateChoice(snapshot, defaultTemplate.templateId, defaultTemplate.templateVersionId) : null;
    const selected = library.roles.flatMap((role) =>
      role.achievements.map((achievement) =>
        library.variants.find(
          (variant) => variant.variant_id === achievement.baseline_variant_id,
        )!,
      ),
    );
    if (selected.some((variant) => !variant || variant.status !== "approved"))
      throw conflict(
        "Every baseline achievement requires exact current approval.",
      );
    return {
      revision_id: crypto.randomUUID(),
      number,
      created_at: new Date().toISOString(),
      profile_revision: library.profileVersion,
      mode: "baseline_copy",
      profile_snapshot: { profile_id: "default", profile_revision: library.profileVersion, document: structuredClone(snapshot.state.readModel.profile.config.profile), roles: structuredClone(library.roles), approved_variants: structuredClone(library.variants.filter((variant) => variant.status === "approved")), evidence_sources: this.sources(snapshot).sources },
      requirements_snapshot: null, fit_snapshot: null, review_attempts: [], template: choice?.snapshot ?? null, theme: choice?.theme ?? {},
      document: structuredClone(document),
      selected_variants: structuredClone(selected),
      coverage_manifest: {
        status: "not_assessed",
        reason: "resume_tailoring_disabled",
        requirements: [],
        selected_relations: [],
        objective: null,
      },
      mechanical: { status: "valid", failures: [] },
      review: {
        status: "not_applicable",
        reason: "resume_tailoring_disabled",
        findings: [],
      },
      renders: [],
      render_attempts: [],
      edit_draft: null,
    };
  }

  private templateChoice(snapshot: DemoWorkspaceSnapshot, templateId: string, versionId: string) {
    const template = snapshot.state.readModel.materials.templateDetails[templateId]?.template;
    if (!template) throw notFound("This saved template does not exist.");
    const current = data(template.activeVersion);
    const version = current.versionId === versionId ? current : records(data(template).versions ?? []).find((item) => item.versionId === versionId);
    if (!version) throw conflict("The saved template version changed. Review the current template library.");
    return { snapshot: { templateId, versionId, templateName: template.displayName, layout: structuredClone(version) }, theme: structuredClone(data(version.theme)) };
  }

  private baselineDocument(
    snapshot: DemoWorkspaceSnapshot,
    library: WordingLibrary,
  ): Data {
    const profile = ProfileSchema.parse(
      snapshot.state.readModel.profile.config.profile,
    );
    const personal = profile.personal;
    const resume = profile.resume;
    const raw = data(profile);
    const authoredResume = data(raw.resume);
    return {
      personal: {
        full_name: personal.full_name,
        address: [
          personal.address,
          personal.city,
          personal.postal_code,
          personal.country,
        ]
          .filter(Boolean)
          .join(", "),
        contact_items: [
          "phone",
          "email",
          "website_url",
          "portfolio_url",
          "linkedin_url",
          "github_url",
        ].flatMap((field) => {
          const value = data(personal)[field];
          return typeof value === "string" && value
            ? [
                {
                  kind: field,
                  label: value,
                  href:
                    field === "email"
                      ? `mailto:${value}`
                      : field === "phone"
                        ? `tel:${value}`
                        : value,
                },
              ]
            : [];
        }),
      },
      summary:
        typeof authoredResume.executive_profile === "string"
          ? authoredResume.executive_profile
          : String(data(authoredResume.executive_profile).baseline_text ?? ""),
      experience: resume.experience_entries.map((role) => ({
        id: role.id,
        title: role.title,
        company: role.company,
        location: role.location ?? "",
        date_range: role.date_range ?? "",
        summary: role.summary ?? "",
        bullets: role.bullets.map((bullet, index) => ({
          id: library.roles.find((item) => item.role_id === role.id)!
            .achievements[index]!.achievement_id,
          text: bullet,
        })),
      })),
      education: resume.education_entries.map((entry, index) => ({
        id: entry.id || `education:${index}`,
        degree: entry.degree ?? "",
        institution: entry.institution ?? "",
        location: entry.location ?? "",
        date: entry.date ?? "",
        details: String(data(entry).details ?? ""),
      })),
      skills: structuredClone(resume.skill_categories),
    };
  }

  private approvedDocument(
    snapshot: DemoWorkspaceSnapshot,
    library: WordingLibrary,
    selected: WordingVariant[],
  ): Data {
    const document = this.baselineDocument(snapshot, library);
    for (const role of records(document.experience))
      for (const bullet of records(role.bullets)) {
        const variant = selected.find(
          (item) => item.achievement_id === bullet.id,
        );
        const approved =
          variant &&
          library.variants.find(
            (item) =>
              item.variant_id === variant.variant_id &&
              item.revision === variant.revision &&
              item.text === variant.text &&
              item.status === "approved",
          );
        if (!approved)
          throw conflict(
            "A selected wording variant no longer has exact current approval.",
          );
        bullet.text = approved.text;
      }
    return document;
  }

  private async render(id: string, body: Data): Promise<Resume> {
    const snapshot = await this.workspace.snapshot();
    const resume = snapshot.state.features?.resumes?.[id];
    if (!resume) throw notFound();
    if (resume.version !== body.expected_version)
      throw conflict("This resume changed. Review its current version.");
    const revision = revisionOf(resume);
    if (
      revision.profile_revision !== this.library(snapshot).profileVersion ||
      revision.mechanical.status !== "valid"
    )
      throw conflict(
        "The resume needs exact current wording approval before rendering.",
      );
    let rendered: Awaited<ReturnType<typeof renderDemoResume>>;
    try {
      rendered = await renderDemoResume(revision.document, revision.edit_draft?.plate_document, revision.theme, data(revision.template?.layout).plateDocument);
    } catch {
      await this.commit((draft) => {
        const current = features(draft).resumes?.[id];
        if (!current || current.version !== body.expected_version || current.current_revision !== revision.revision_id) throw conflict("The resume changed while rendering. Its accepted PDF is preserved.");
        revisionOf(current).render_attempts.push({status:"failed",created_at:new Date().toISOString(),failure_code:"browser_render_failed"});
        current.version += 1;
      }, snapshot.resetEpoch);
      throw conflict("The browser could not verify this rendered document. The saved document and last accepted PDF remain available.");
    }
    const blob = rendered.blob;
    const artifactId = crypto.randomUUID();
    const blobId = `resume:${id}:${revision.revision_id}:${artifactId}`;
    let saved: Resume | undefined;
    await this.commit((draft, context) => {
      const current = features(draft).resumes?.[id];
      if (!current) throw notFound();
      if (
        current.version !== body.expected_version ||
        current.current_revision !== revision.revision_id ||
        this.library(draft).profileVersion !== revision.profile_revision
      )
        throw conflict(
          "The resume sources changed while rendering. The last accepted PDF is preserved.",
        );
      context.putBlob(blobId, blob);
      const target = revisionOf(current);
      target.renders.push({
        artifact_id: artifactId, resume_id: id, revision_id: revision.revision_id, filename: "resume.pdf", format: "pdf",
        sha256: rendered.sha256, size_bytes: blob.size, page_count: rendered.pageCount, layout_boxes: rendered.layoutBoxes,
        layout_conflicts: rendered.layoutConflicts, layout_metadata: rendered.layoutMetadata, text_verified: rendered.textVerified,
        blob_id: blobId, content_type: "application/pdf", byte_count: blob.size, synthetic: true,
      });
      target.render_attempts.push({ status: "succeeded", created_at: new Date().toISOString(), artifact_id: artifactId });
      current.version += 1;
      current.updated_at = new Date().toISOString();
      saved = structuredClone(current);
    }, snapshot.resetEpoch);
    return saved!;
  }

  async blob(
    _method: "GET",
    path: readonly string[],
    options: Pick<HttpRequestOptions, "query">,
  ): Promise<Blob> {
    if (path[1] === "resumes" && path[2] && path[3] === "export") {
      const revision = await this.exportRevision(path[2], options.query);
      if (options.query?.format === "html")
        return new Blob([documentHtml(revision.document, revision.edit_draft?.plate_document, revision.theme, data(revision.template?.layout).plateDocument)], {
          type: "text/html",
        });
      if (options.query?.format === "txt")
        return new Blob([documentText(revision.document, revision.theme)], {
          type: "text/plain",
        });
      if (options.query?.format && options.query.format !== "pdf")
        throw new DemoCapabilityError("downloadMaterialDocx");
      const render = options.query?.artifact_id ? revision.renders.find((item) => item.artifact_id === options.query?.artifact_id) : revision.renders.at(-1);
      const blobId = render?.blob_id;
      const blob =
        typeof blobId === "string" ? await this.workspace.blob(blobId) : null;
      if (!blob)
        throw notFound(
          "Render this exact resume revision before downloading it.",
        );
      if (blob.size !== render?.size_bytes || await hashBytes(await blob.arrayBuffer()) !== render.sha256) throw conflict("The registered PDF bytes could not be verified. The saved artifact record has not been replaced.");
      return blob;
    }
    const url = await this.previewAsset(path);
    // Only exact bundled seed assets can be loaded; never an API or visitor URL.
    const response = await fetch(url, {
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok)
      throw notFound("The bundled synthetic preview is unavailable.");
    return response.blob();
  }

  async text(
    method: "GET",
    path: readonly string[],
    options: Pick<HttpRequestOptions, "query">,
  ): Promise<string> {
    if (path[1] === "resumes" && path[2] && path[3] === "export") {
      if (options.query?.format && !["html", "txt"].includes(String(options.query.format))) throw badRequest("Choose an HTML or text source export.");
      const revision = await this.exportRevision(path[2], options.query);
      return options.query?.format === "txt"
        ? documentText(revision.document, revision.theme)
        : documentHtml(revision.document, revision.edit_draft?.plate_document, revision.theme, data(revision.template?.layout).plateDocument);
    }
    return (await this.blob(method, path, options)).text();
  }

  private async exportRevision(
    id: string,
    query: HttpRequestOptions["query"],
  ): Promise<ResumeRevision> {
    const resume = (await this.workspace.snapshot()).state.features?.resumes?.[
      id
    ];
    if (!resume) throw notFound();
    const accepted = query?.accepted === true || query?.accepted === "true";
    const selected = typeof query?.revision_id === "string" ? query.revision_id : accepted ? resume.accepted_revision_id : resume.current_revision;
    if (accepted && !resume.acceptances.some((item) => item.revision_id === selected)) throw conflict("This exact revision has no recorded acceptance.");
    const revision = resume.revisions.find(
      (item) => item.revision_id === selected,
    );
    if (!revision) throw notFound("No accepted resume revision is available.");
    if (query?.artifact_id && !revision.renders.some((item) => item.artifact_id === query.artifact_id)) throw conflict("The registered artifact does not belong to this exact revision.");
    return revision;
  }

  private async previewAsset(path: readonly string[]): Promise<string> {
    const snapshot = await this.workspace.snapshot();
    let url: string | undefined;
    if (path[1] === "profile" && path.length === 3) {
      url =
        path[2] === "preview.pdf"
          ? snapshot.state.artifacts.profileResumePdf.url
          : path[2] === "preview.html"
            ? snapshot.state.artifacts.profileResumeHtml.url
            : undefined;
    } else if (path[1] === "artifacts" && path[2] && path.length === 4) {
      url =
        path[3] === "preview.pdf"
          ? this.api.artifactPreviewPdfUrl(path[2])
          : path[3] === "preview.html"
            ? this.api.artifactPreviewHtmlUrl(path[2])
            : undefined;
    }
    if (
      !url ||
      !isDemoArtifactUrl(url) ||
      !Object.values(snapshot.state.artifacts).some(
        (asset) => asset.url === url,
      )
    )
      throw notFound();
    return url;
  }

  private async commit(
    mutate: (
      draft: DemoWorkspaceSnapshot,
      context: DemoWorkspaceMutationContext,
    ) => void,
    expectedResetEpoch?: number,
  ): Promise<void> {
    const snapshot = await this.workspace.snapshot();
    const commit = await this.workspace.mutate(mutate, {
      expectedResetEpoch: expectedResetEpoch ?? snapshot.resetEpoch,
    });
    if (commit.kind !== "committed")
      throw new JobCtrlApiError(
        503,
        "Persistence Unavailable",
        "Browser storage could not confirm this change. Review the current demo state before retrying.",
      );
  }
}

function features(snapshot: DemoWorkspaceSnapshot): DemoFeatureState {
  return (snapshot.state.features ??= {});
}
function data(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
}
function records(value: unknown): Data[] {
  if (!Array.isArray(value))
    throw badRequest("The document inventory is malformed.");
  return value.map((item) => {
    const record = data(item);
    if (!Object.keys(record).length)
      throw badRequest("The document inventory is malformed.");
    return record;
  });
}
function jobIds(value: unknown, allowEmpty = false): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    (!allowEmpty && !value.length)
  )
    throw badRequest("Select a bounded list of job IDs.");
  const ids = value.map(text);
  if (new Set(ids).size !== ids.length)
    throw badRequest("Selected job IDs must be unique.");
  return ids;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw badRequest("A non-empty text value is required.");
  return value;
}
function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
function integer(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const number =
    typeof value === "string" && value.trim() ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < minimum ||
    number > maximum
  )
    throw badRequest("The request version or pagination value is invalid.");
  return number;
}
function refsFrom(value: unknown): SourceRef[] {
  if (!Array.isArray(value))
    throw badRequest("Current wording source IDs and revisions are required.");
  const refs = value.map((item) => ({
    source_id: text(data(item).source_id),
    revision: integer(data(item).revision, 1),
  }));
  if (new Set(refs.map((ref) => ref.source_id)).size !== refs.length)
    throw badRequest("Wording sources must be unique.");
  return refs;
}
function revisionOf(resume: Resume): ResumeRevision {
  const revision = resume.revisions.find(
    (row) => row.revision_id === resume.current_revision,
  );
  if (!revision) throw notFound();
  return revision;
}
function badRequest(message: string) {
  return new JobCtrlApiError(400, "Bad Request", message);
}
function conflict(message: string) {
  return new JobCtrlApiError(409, "Conflict", message);
}
function notFound(message = "The synthetic demo record does not exist.") {
  return new JobCtrlApiError(404, "Not Found", message);
}
async function hash(value: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(value).buffer);
}
async function hashBytes(value: ArrayBuffer): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(bytes), (item) =>
    item.toString(16).padStart(2, "0"),
  ).join("");
}
