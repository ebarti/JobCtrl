import { JobCtrlApiError } from "@jobctrl/api-client";
import { ProfileSchema } from "@jobctrl/contracts";
import { z } from "zod";

import { stableDemoStringify } from "./digest.js";
import {
  demoWordingLibrary,
  exactDemoRefs,
  DEMO_PLATFORM_ACHIEVEMENT,
  DEMO_INCIDENT_ACHIEVEMENT,
  DEMO_DELIVERY_ACHIEVEMENT,
  type DemoSourceRef,
} from "./profile-library.js";
import type { DemoWorkspaceSnapshot } from "./workspace/contracts.js";

type Data = Record<string, unknown>;
export interface DemoCanonicalRequirement {
  requirement_id: string;
  revision: number;
  definition: string;
  contract_version: "requirements-v2";
  category: "skill" | "professional_experience";
  name: string;
  provenance: Data;
  created_at: string;
}
interface WordingPin {
  variant_id: string;
  variant_revision: number;
  exact_text: string;
  source_refs: DemoSourceRef[];
}
export interface DemoRequirementAssociation {
  association_id: string;
  revision: number;
  profile_id: string;
  requirement_id: string;
  requirement_revision: number;
  achievement_id: string;
  role_id: string;
  achievement_source_refs: DemoSourceRef[];
  wording: WordingPin | null;
  origin: "user";
  assessment_status: "unassessed";
  state: "active" | "removed";
  created_at: string;
  updated_at: string;
  synthetic: true;
}
export interface DemoRequirementAssociations {
  rows: DemoRequirementAssociation[];
  history: Record<string, DemoRequirementAssociation[]>;
  requests: Record<string, string>;
}

const meanings: Omit<DemoCanonicalRequirement, "created_at" | "provenance">[] = [
  { requirement_id: "requirement:v2:demo:platform", revision: 1, contract_version: "requirements-v2", category: "professional_experience",
    name: "Platform delivery leadership", definition: "Guide reliable platform delivery." },
  { requirement_id: "requirement:v2:demo:incident-response", revision: 1, contract_version: "requirements-v2", category: "skill",
    name: "Incident coordination", definition: "Coordinate incident response with the engineering team." },
  { requirement_id: "requirement:v2:demo:release-coordination", revision: 1, contract_version: "requirements-v2", category: "skill",
    name: "Release coordination", definition: "Use release coordination to make delivery plans clear." },
  { requirement_id: "requirement:v2:demo:regulated-domain", revision: 1, contract_version: "requirements-v2", category: "professional_experience",
    name: "Regulated-domain leadership", definition: "Lead in a regulated domain." },
  { requirement_id: "requirement:v2:demo:systems", revision: 1, contract_version: "requirements-v2", category: "professional_experience",
    name: "Systems delivery leadership", definition: "Lead systems delivery." },
];

// Fixed teaching records, bound to exact authored postings and profile IDs.
// These hashes use the same versioned signature shape as the local app; they
// do not represent a model determination or consolidation certificate.
export const DEMO_PLATFORM_DEMANDS = [
  { jobId: "6e2f4a10-20be-4d5f-98a4-a4bb9a877a35", definition: "Guide reliable platform delivery.",
    fingerprint: "65c1d89cc761d191e118a1f51785cd2d2f05618a8207a59c90cf673a59a62585", index: 0, kind: "matched" },
  { jobId: "job-contoso-reliability", definition: "Guide a reliability engineering team.",
    fingerprint: "2efa2238506960d8236ab7aacad6ff39e0158248140e4a282b883cbd11875cc5", index: 1, kind: "missing" },
] as const;
export const DEMO_NORMALIZATION_VERSION = "requirements-capability-demand-v2";
const DEMO_PLATFORM_REQUIREMENT = "requirement:v2:demo:platform";

export function demoFitProfile(snapshot: DemoWorkspaceSnapshot) {
  const saved = snapshot.state.features?.fitProfileSourceSignature;
  const assessed = saved ? ProfileSchema.parse(JSON.parse(saved)) : null;
  const profile = ProfileSchema.parse(snapshot.state.readModel.profile.config.profile);
  const sections = ["experience_entries", "skill_categories", "education_entries", "language_entries"] as const;
  const current = assessed !== null && !snapshot.state.features?.profileSourcesChanged
    && sections.every((section) => stableDemoStringify(assessed.resume[section]) === stableDemoStringify(profile.resume[section]));
  return { assessed, current, evidenceProfile: assessed ?? profile };
}

/** An authored per-job example; it never infers support from visitor edits. */
export function demoPlatformDemandAssessment(snapshot: DemoWorkspaceSnapshot, jobId: string) {
  const demand = DEMO_PLATFORM_DEMANDS.find((item) => item.jobId === jobId);
  if (!demand) return null;
  const { assessed, current } = demoFitProfile(snapshot);
  const evidence = assessed?.resume.experience_entries.flatMap((role) => {
    const index = role.achievement_ids?.indexOf(DEMO_PLATFORM_ACHIEVEMENT) ?? -1;
    return index < 0 || !role.bullets[index] ? [] : [{ source_id: `achievement:${DEMO_PLATFORM_ACHIEVEMENT}`, revision: 1, quote: role.bullets[index]! }];
  }) ?? [];
  const matched = demand.kind === "matched" && evidence.length > 0;
  const kind = !assessed ? "not_assessed" : demand.kind === "missing" ? "missing" : matched ? "matched" : "not_assessed";
  return {
    contract_version: "requirements-v2" as const,
    assessment_id: `demo:assessment:v2:${demand.jobId}:reusable:${demand.index}`,
    requirement_id: DEMO_PLATFORM_REQUIREMENT, requirement_revision: 1,
    name: "Platform delivery leadership", category: "professional_experience" as const, definition: demand.definition,
    demand_fingerprint: demand.fingerprint, kind, confidence: kind === "not_assessed" ? "low" : "high",
    achievement_ids: matched ? [DEMO_PLATFORM_ACHIEVEMENT] : [], evidence_refs: matched ? evidence : [],
    wording_support: matched ? "achievement" as const : "none" as const,
    rationale: matched ? "Authored synthetic illustration: the saved achievement supports this delivery demand; no model assessment ran."
      : kind === "missing" ? "Authored synthetic illustration: the saved sources do not establish leadership of a reliability engineering team; no model assessment ran."
      : "Authored synthetic illustration: the saved example sources are unavailable; no model assessment ran.",
    origin: "bundled_synthetic_example" as const, determination_id: `demo:bundled-synthetic:v2:${demand.jobId}`,
    provenance: { kind: "bundled_synthetic_example", synthetic: true, model_called: false },
    current, stale_reasons: current ? [] : [assessed ? "profile_facts_changed" : "profile_sources_unavailable"],
  };
}

/** Authored source examples, explicitly distinct from model-assessed evidence. */
export function demoCanonicalRequirements(
  snapshot: DemoWorkspaceSnapshot,
): DemoCanonicalRequirement[] {
  return meanings.map((meaning) => ({
    ...structuredClone(meaning),
    created_at: snapshot.createdAt,
    provenance: {
      kind: "bundled_synthetic_meaning",
      synthetic: true,
      model_called: false,
    },
  }));
}

export function demoRequirementAssociations(
  snapshot: DemoWorkspaceSnapshot,
): DemoRequirementAssociations {
  const saved = snapshot.state.features?.requirementAssociations;
  if (saved) return structuredClone(saved);
  const library = demoWordingLibrary(snapshot);
  const examples = [
    [
      "demo:association:platform-delivery",
      "requirement:v2:demo:platform",
      DEMO_PLATFORM_ACHIEVEMENT,
    ],
    [
      "demo:association:platform-incident",
      "requirement:v2:demo:incident-response",
      DEMO_PLATFORM_ACHIEVEMENT,
    ],
    [
      "demo:association:incident-practice",
      "requirement:v2:demo:incident-response",
      DEMO_INCIDENT_ACHIEVEMENT,
    ],
    [
      "demo:association:systems-delivery",
      "requirement:v2:demo:systems",
      DEMO_DELIVERY_ACHIEVEMENT,
    ],
  ];
  const rows: DemoRequirementAssociation[] = [];
  for (const [association_id, requirement_id, achievement_id] of examples) {
    const role = library.roles.find((item) =>
      item.achievements.some(
        (achievement) => achievement.achievement_id === achievement_id,
      ),
    );
    const achievement = role?.achievements.find(
      (item) => item.achievement_id === achievement_id,
    );
    const variant = library.variants.find(
      (item) => item.variant_id === achievement?.baseline_variant_id,
    );
    if (!role || !achievement || !variant) continue;
    rows.push({
      association_id: association_id!,
      revision: 1,
      profile_id: "default",
      requirement_id: requirement_id!,
      requirement_revision: 1,
      achievement_id: achievement_id!,
      role_id: role.role_id,
      achievement_source_refs: structuredClone(achievement.source_refs),
      wording: {
        variant_id: variant.variant_id,
        variant_revision: variant.revision,
        exact_text: variant.text,
        source_refs: structuredClone(variant.source_refs),
      },
      origin: "user",
      assessment_status: "unassessed",
      state: "active",
      created_at: snapshot.createdAt,
      updated_at: snapshot.createdAt,
      synthetic: true,
    });
  }
  return { rows, history: {}, requests: {} };
}

export function demoAssociationView(
  snapshot: DemoWorkspaceSnapshot,
  association: DemoRequirementAssociation,
) {
  const library = demoWordingLibrary(snapshot);
  const requirement = demoCanonicalRequirements(snapshot).find(
    (item) => item.requirement_id === association.requirement_id,
  );
  const achievement = library.roles
    .flatMap((role) => role.achievements)
    .find((item) => item.achievement_id === association.achievement_id);
  const reasons: string[] = [];
  if (!requirement || requirement.revision !== association.requirement_revision)
    reasons.push("requirement_revised");
  if (!achievement) reasons.push("achievement_unavailable");
  else if (
    !exactDemoRefs(achievement.source_refs, association.achievement_source_refs)
  )
    reasons.push("achievement_sources_changed");
  if (association.wording) {
    const pin = association.wording;
    const variant = library.variants.find(
      (item) => item.variant_id === pin.variant_id,
    );
    if (
      !variant ||
      variant.achievement_id !== association.achievement_id ||
      variant.revision !== pin.variant_revision ||
      variant.text !== pin.exact_text ||
      !exactDemoRefs(variant.source_refs, pin.source_refs) ||
      variant.status === "stale"
    )
      reasons.push("wording_changed_or_unavailable");
  }
  return {
    ...structuredClone(association),
    current: !reasons.length,
    stale_reasons: reasons,
  };
}

export function demoRequirementLibrary(snapshot: DemoWorkspaceSnapshot) {
  const library = demoWordingLibrary(snapshot);
  const associations = demoRequirementAssociations(snapshot).rows;
  const { current, evidenceProfile } = demoFitProfile(snapshot);
  const skills = evidenceProfile.resume.skill_categories.find((item) => item.id === "demo:skills:delivery");
  return {
    contract_version: "requirements-v2",
    profile_id: "default",
    readiness: "ready",
    profile_revision: library.profileVersion,
    fact_semantics_version: null,
    wording_revision: library.wordingRevision,
    catalog_revision: 1,
    requirements: demoCanonicalRequirements(snapshot).map((requirement) => {
      const demands = requirement.requirement_id === DEMO_PLATFORM_REQUIREMENT ? DEMO_PLATFORM_DEMANDS.flatMap((demand) => {
        const job = snapshot.state.readModel.jobs.details[demand.jobId]?.job;
        const savedPosting = snapshot.state.features?.postings?.[demand.jobId];
        if (!job || job.deletedAt || savedPosting && (savedPosting.revision !== 1 || !savedPosting.description.includes(demand.definition))) return [];
        const assessment = demoPlatformDemandAssessment(snapshot, demand.jobId)!;
        return [{ demand_fingerprint: demand.fingerprint, definition: demand.definition, capability_definition: requirement.definition,
          normalization_version: DEMO_NORMALIZATION_VERSION, job_ids: [demand.jobId], assessment,
          state: assessment.current ? "current" as const : "stale" as const, current: assessment.current, stale_reasons: assessment.stale_reasons }];
      }) : null;
      return {
        ...requirement,
        assessment: demands ? demands.length === 1 ? demands[0]!.assessment : null : requirement.requirement_id === "requirement:v2:demo:release-coordination" && skills ? {
          contract_version: "requirements-v2", assessment_id: "demo:assessment:v2:release-section", requirement_id: requirement.requirement_id,
          requirement_revision: requirement.revision, name: requirement.name, category: requirement.category, definition: requirement.definition,
          kind: "matched", confidence: "high", achievement_ids: [], wording_support: "section",
          rationale: "Authored illustration: release coordination is supported from the saved structured Skills section. Achievement wording is not required.",
          origin: "bundled_synthetic_example", determination_id: "demo:bundled-synthetic:v2:release-section",
          evidence_refs: [{ source_id: `demo:profile-section:skill_categories:${skills.id}`, revision: 1, quote: JSON.stringify(skills) }],
          provenance: { kind: "bundled_synthetic_example", synthetic: true, model_called: false }, current,
          stale_reasons: current ? [] : ["profile_facts_changed"],
        } : null,
        ...(demands ? { assessment_scope: demands.length > 1 ? "varies_by_job" as const : demands.length === 1 ? "single_demand" as const : "not_applicable" as const,
          assessment_summary: { demand_count: demands.length, assessed_count: demands.length, current_count: demands.filter((demand) => demand.current).length },
          demand_assessments: demands, historical_alias_records: [] } : {}),
        coverage: [],
        current_wordings: [],
        wording_assignments: [],
        associations: associations
          .filter(
            (association) =>
              association.requirement_id === requirement.requirement_id,
          )
          .map((association) => demoAssociationView(snapshot, association)),
      };
    }),
    synthetic: true,
    provenance: {
      kind: "browser_local_synthetic_demo",
      illustrated_assessments: "authored_examples",
      manual_links_assessment_status: "unassessed",
      model_called: false,
    },
  };
}

const ref = z
  .object({
    source_id: z.string().min(1).max(500),
    revision: z.number().int().positive(),
  })
  .strict();
const pin = z
  .object({
    variant_id: z.string().min(1).max(200),
    variant_revision: z.number().int().positive(),
    exact_text: z.string().min(1).max(30000),
    source_refs: z.array(ref).max(200),
  })
  .strict();
const create = z
  .object({
    association_id: z.string().min(1).max(200),
    profile_id: z.literal("default"),
    expected_profile_revision: z.number().int().positive(),
    requirement_id: z.string().min(1).max(120),
    requirement_revision: z.number().int().positive(),
    achievement_id: z.string().min(1).max(200),
    achievement_source_refs: z.array(ref).min(1).max(200),
    wording: pin.nullable(),
  })
  .strict();
const revise = create.extend({
  expected_revision: z.number().int().positive(),
});
const state = z
  .object({
    profile_id: z.literal("default"),
    expected_revision: z.number().int().positive(),
    state: z.enum(["active", "removed"]),
  })
  .strict();
function conflict(message: string) {
  return new JobCtrlApiError(409, "Conflict", message);
}
function invalid() {
  return new JobCtrlApiError(
    422,
    "Invalid Request",
    "The association fields are invalid.",
  );
}

export function createDemoAssociation(
  snapshot: DemoWorkspaceSnapshot,
  value: unknown,
) {
  const parsed = create.safeParse(value);
  if (!parsed.success) throw invalid();
  const body = parsed.data;
  const library = demoWordingLibrary(snapshot);
  const associations = demoRequirementAssociations(snapshot);
  const request = stableDemoStringify(body);
  const existing = associations.rows.find(
    (row) => row.association_id === body.association_id,
  );
  if (existing) {
    if (associations.requests[body.association_id] !== request)
      throw conflict(
        "This association identity already records a different request.",
      );
    return demoAssociationView(snapshot, existing);
  }
  if (body.expected_profile_revision !== library.profileVersion)
    throw conflict(
      "The reviewed Profile changed before the association was saved.",
    );
  const role = library.roles.find((item) =>
    item.achievements.some(
      (achievement) => achievement.achievement_id === body.achievement_id,
    ),
  );
  const record: DemoRequirementAssociation = {
    ...body,
    role_id: role?.role_id ?? "",
    revision: 1,
    origin: "user",
    assessment_status: "unassessed",
    state: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    synthetic: true,
  };
  if (demoAssociationView(snapshot, record).stale_reasons.length || !role)
    throw conflict(
      "The selected requirement, achievement or wording changed. Review its current revision.",
    );
  const duplicate = associations.rows.find(
    (item) =>
      item.state === "active" &&
      item.requirement_id === record.requirement_id &&
      item.achievement_id === record.achievement_id,
  );
  if (duplicate)
    throw conflict(
      "This achievement already has an active association with the requirement. Revise that association.",
    );
  associations.rows.push(record);
  associations.requests[body.association_id] = request;
  (snapshot.state.features ??= {}).requirementAssociations = associations;
  return demoAssociationView(snapshot, record);
}

export function reviseDemoAssociation(
  snapshot: DemoWorkspaceSnapshot,
  associationId: string,
  value: unknown,
) {
  const parsed = revise.safeParse(value);
  if (!parsed.success) throw invalid();
  const body = parsed.data;
  const associations = demoRequirementAssociations(snapshot);
  const previous = associations.rows.find(
    (row) => row.association_id === associationId,
  );
  if (!previous)
    throw new JobCtrlApiError(
      404,
      "Not Found",
      "The synthetic association is unavailable.",
    );
  if (
    body.association_id !== associationId ||
    previous.revision !== body.expected_revision ||
    previous.state !== "active" ||
    previous.requirement_id !== body.requirement_id ||
    previous.achievement_id !== body.achievement_id
  )
    throw conflict(
      "The active association changed. Review its current revision and identities.",
    );
  if (
    body.expected_profile_revision !==
    demoWordingLibrary(snapshot).profileVersion
  )
    throw conflict(
      "The reviewed Profile changed before the association was saved.",
    );
  const next = {
    ...previous,
    requirement_revision: body.requirement_revision,
    achievement_source_refs: body.achievement_source_refs,
    wording: body.wording,
  };
  if (demoAssociationView(snapshot, next).stale_reasons.length)
    throw conflict(
      "The selected requirement, achievement or wording changed. Review its current revision.",
    );
  const pins = (row: DemoRequirementAssociation) =>
    stableDemoStringify([
      row.requirement_revision,
      row.achievement_source_refs,
      row.wording,
    ]);
  if (pins(next) === pins(previous))
    return demoAssociationView(snapshot, previous);
  (associations.history[associationId] ??= []).push(structuredClone(previous));
  next.revision += 1;
  next.updated_at = new Date().toISOString();
  associations.rows[associations.rows.indexOf(previous)] = next;
  (snapshot.state.features ??= {}).requirementAssociations = associations;
  return demoAssociationView(snapshot, next);
}

export function changeDemoAssociation(
  snapshot: DemoWorkspaceSnapshot,
  associationId: string,
  value: unknown,
) {
  const parsed = state.safeParse(value);
  if (!parsed.success) throw invalid();
  const body = parsed.data;
  const associations = demoRequirementAssociations(snapshot);
  const record = associations.rows.find(
    (row) => row.association_id === associationId,
  );
  if (!record)
    throw new JobCtrlApiError(
      404,
      "Not Found",
      "The synthetic association is unavailable.",
    );
  if (record.revision !== body.expected_revision)
    throw conflict("This association changed. Review its current revision.");
  if (record.state !== body.state) {
    if (
      body.state === "active" &&
      associations.rows.some(
        (row) =>
          row.association_id !== associationId &&
          row.state === "active" &&
          row.requirement_id === record.requirement_id &&
          row.achievement_id === record.achievement_id,
      )
    )
      throw conflict("This exact association is already active.");
    (associations.history[associationId] ??= []).push(structuredClone(record));
    record.state = body.state;
    record.revision += 1;
    record.updated_at = new Date().toISOString();
    (snapshot.state.features ??= {}).requirementAssociations = associations;
  }
  return demoAssociationView(snapshot, record);
}
