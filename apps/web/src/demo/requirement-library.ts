import { JobCtrlApiError } from "@jobctrl/api-client";
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
  scope: "resume" | "eligibility" | "logistics" | "employer_condition";
  qualifiers: { dimension: string; value: string }[];
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

const meanings: Omit<DemoCanonicalRequirement, "created_at" | "provenance">[] =
  [
    {
      requirement_id: "requirement-platform",
      revision: 1,
      definition: "Guide reliable platform delivery.",
      scope: "resume",
      qualifiers: [
        { dimension: "responsibility", value: "guide" },
        { dimension: "domain", value: "platform delivery" },
      ],
    },
    {
      requirement_id: "requirement-incident-response",
      revision: 1,
      definition: "Coordinate incident response with the engineering team.",
      scope: "resume",
      qualifiers: [
        { dimension: "responsibility", value: "coordinate" },
        { dimension: "scope", value: "engineering incident response" },
      ],
    },
    {
      requirement_id: "requirement-regulated-domain",
      revision: 1,
      definition: "Lead in a regulated domain.",
      scope: "resume",
      qualifiers: [
        { dimension: "responsibility", value: "lead" },
        { dimension: "domain", value: "regulated industry" },
      ],
    },
    {
      requirement_id: "requirement-systems",
      revision: 1,
      definition: "Lead systems delivery.",
      scope: "resume",
      qualifiers: [
        { dimension: "responsibility", value: "lead" },
        { dimension: "domain", value: "systems delivery" },
      ],
    },
  ];

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
      "requirement-platform",
      DEMO_PLATFORM_ACHIEVEMENT,
    ],
    [
      "demo:association:platform-incident",
      "requirement-incident-response",
      DEMO_PLATFORM_ACHIEVEMENT,
    ],
    [
      "demo:association:incident-practice",
      "requirement-incident-response",
      DEMO_INCIDENT_ACHIEVEMENT,
    ],
    [
      "demo:association:systems-delivery",
      "requirement-systems",
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
  return {
    profile_id: "default",
    readiness: "ready",
    profile_revision: library.profileVersion,
    fact_semantics_version: null,
    wording_revision: library.wordingRevision,
    catalog_revision: 1,
    requirements: demoCanonicalRequirements(snapshot).map((requirement) => ({
      ...requirement,
      assessment: null,
      coverage: [],
      current_wordings: [],
      wording_assignments: [],
      associations: associations
        .filter(
          (association) =>
            association.requirement_id === requirement.requirement_id,
        )
        .map((association) => demoAssociationView(snapshot, association)),
    })),
    synthetic: true,
    provenance: {
      kind: "browser_local_synthetic_demo",
      assessment_status: "unassessed",
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
