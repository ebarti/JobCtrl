import { useSyncExternalStore } from "react";
import { z } from "zod";
import type { Value } from "platejs";
import type { ProfileConfigResponse } from "@jobctrl/contracts";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import type { SessionPort } from "../../../shared/ports/SessionPort.js";
import type { ProfileFormValues } from "../forms/profile-form.js";
import { isJsonRecord } from "./json-record.js";

// Recovery serializes only the explicitly declared editable projection below.
type Projection =
  | { kind: "value" }
  | { kind: "object"; fields: Record<string, Projection> }
  | { kind: "array"; item: Projection }
  | { kind: "map"; item: Projection };
const scalar: Projection = { kind: "value" };
const object = (fields: Record<string, Projection>): Projection => ({
  kind: "object",
  fields,
});
const list = (item: Projection): Projection => ({ kind: "array", item });
const scalars = (names: string): Record<string, Projection> =>
  Object.fromEntries(names.split(" ").map((name) => [name, scalar]));
const strings = list(scalar);
const recoveryProjection = object({
  profile: object({
    personal: object(
      scalars(
        "full_name preferred_name email phone address city province_state country postal_code linkedin_url github_url portfolio_url website_url",
      ),
    ),
    work_authorization: object(
      scalars(
        "legally_authorized_to_work require_sponsorship work_permit_type",
      ),
    ),
    availability: object(
      scalars(
        "earliest_start_date available_for_full_time available_for_contract",
      ),
    ),
    compensation: object(
      scalars(
        "salary_expectation salary_currency salary_range_min salary_range_max currency_conversion_note",
      ),
    ),
    experience: object({
      ...scalars(
        "years_of_experience_total education_level current_job_title current_company target_role target_track target_seniority_floor target_functions target_specializations target_locations target_work_models",
      ),
      target_location_bindings: list(
        object(
          scalars(
            "rowIndex text provider placeId displayName latitude longitude selectedAt provenance",
          ),
        ),
      ),
    }),
    eeo_voluntary: object(
      scalars("gender race_ethnicity veteran_status disability_status"),
    ),
    application_attestations: object(
      scalars(
        "age_18_plus background_check_consent felony_conviction previously_worked_at_employer",
      ),
    ),
    application_preferences: object(scalars("how_heard")),
    resume_constraints: object({ real_metrics: strings }),
    resume: object({
      executive_profile: object(scalars("baseline_text")),
      experience_entries: list(
        object({
          ...scalars("id title company date_range location summary"),
          bullets: strings,
          achievement_ids: strings,
          achievement_evidence: list(
            object({
              ...scalars(
                "id source_text scope action outcome evidence_strength claim_confidence user_confirmed confirmation_review_required",
              ),
              tools: strings,
              metrics: strings,
              tags: strings,
            }),
          ),
        }),
      ),
      education_entries: list(
        object(scalars("id degree institution location date")),
      ),
      skill_categories: list(
        object({ ...scalars("id label"), items: strings }),
      ),
      tailoring_rules: object({
        required_experience_entry_ids: strings,
        required_education_entry_ids: strings,
        required_skill_category_ids: strings,
        required_bullets_by_experience_id: { kind: "map", item: strings },
        required_skills_by_category_id: { kind: "map", item: strings },
        ...scalars("max_experience_bullets custom_tailoring_prompt"),
        tailoring_policy: object({
          ...scalars(
            "mode allow_title_reframing allow_achievement_rewriting allow_skill_reordering allow_summary_rewrite allow_minor_inference claim_mode allow_adjacent_achievement_drafts",
          ),
          auto_approvable_claim_modes: strings,
        }),
        writing_style: object(
          scalars(
            "tone bullet_style verbosity keyword_density avoid_first_person",
          ),
        ),
        revision_gates: object(
          scalars("min_fit_score must_have_coverage max_revision_attempts"),
        ),
      }),
    }),
  }),
  style: object(
    scalars(
      "document_font_size paper_size font_family moderncv_style moderncv_color page_scale hints_column_width_cm body_alignment",
    ),
  ),
  templateText: scalar,
});
function project(spec: Projection, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (spec.kind === "value")
    return typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number"
      ? value
      : undefined;
  if (spec.kind === "array")
    return Array.isArray(value)
      ? value.map((item) => project(spec.item, item))
      : undefined;
  if (!isJsonRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const child =
        spec.kind === "map"
          ? spec.item
          : Object.hasOwn(spec.fields, key)
            ? spec.fields[key]
            : undefined;
      return child ? [[key, project(child, item)]] : [];
    }),
  );
}
function projectionAt(path: readonly string[]): Projection | undefined {
  let spec: Projection | undefined = recoveryProjection;
  for (const part of path) {
    if (spec?.kind === "object")
      spec = Object.hasOwn(spec.fields, part) ? spec.fields[part] : undefined;
    else if (spec?.kind === "map") spec = spec.item;
    else return undefined;
  }
  return spec;
}

export const recoveryChangeSchema = z
  .object({
    path: z.array(z.string()).min(1),
    beforePresent: z.boolean(),
    afterPresent: z.boolean(),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
  })
  .strict();
export const profileRecoverySchema = z
  .object({
    version: z.literal(2),
    baseProfileVersion: z.number().nullable(),
    changes: z.array(recoveryChangeSchema).max(5000),
  })
  .strict()
  .superRefine((record, context) => {
    for (const [index, change] of record.changes.entries()) {
      const spec = projectionAt(change.path);
      if (
        !spec ||
        JSON.stringify(project(spec, change.before)) !==
          JSON.stringify(change.before) ||
        JSON.stringify(project(spec, change.after)) !==
          JSON.stringify(change.after)
      )
        context.addIssue({
          code: "custom",
          message:
            "Only declared non-secret editable fields can enter browser recovery.",
          path: ["changes", index],
        });
    }
  });
export type ProfileSafeRecovery = z.infer<typeof profileRecoverySchema>;
export function profileSnapshotValues(
  base: ProfileConfigResponse,
): ProfileFormValues {
  return {
    profile: isJsonRecord(base.profile) ? base.profile : null,
    style: isJsonRecord(base.style) ? base.style : null,
    templateText: base.templateText,
  };
}
export interface ProfileSessionDraft {
  ownerId: string;
  base: ProfileConfigResponse;
  values: ProfileFormValues;
  durable?: boolean;
}
export interface ProfilePlateSessionDraft {
  ownerId: string;
  profileVersion: number | null;
  value: Value;
  durable: boolean;
}
interface Bucket {
  id: number;
  drafts: Map<string, ProfileSessionDraft>;
  plates: Map<string, ProfilePlateSessionDraft>;
  generation: number;
  listeners: Set<() => void>;
}
let nextBucketId = 0;
const buckets = new WeakMap<SessionPort, Bucket>();
function bucket(session: SessionPort): Bucket {
  let value = buckets.get(session);
  if (!value) {
    value = {
      id: ++nextBucketId,
      drafts: new Map(),
      plates: new Map(),
      generation: 0,
      listeners: new Set(),
    };
    buckets.set(session, value);
  }
  return value;
}
export function profileDraftKey(tenant: string, section: string) {
  return JSON.stringify([tenant, section]);
}
export function getProfileSessionDraft(
  session: SessionPort,
  tenant: string,
  section: string,
) {
  return bucket(session).drafts.get(profileDraftKey(tenant, section));
}
export function setProfileSessionDraft(
  session: SessionPort,
  tenant: string,
  section: string,
  value: ProfileSessionDraft | null,
) {
  const current = bucket(session),
    drafts = current.drafts;
  if (value) drafts.set(profileDraftKey(tenant, section), value);
  else drafts.delete(profileDraftKey(tenant, section));
  for (const listener of current.listeners) listener();
}
export function getProfilePlateSessionDraft(
  session: SessionPort,
  tenant: string,
) {
  return bucket(session).plates.get(tenant);
}
export function setProfilePlateSessionDraft(
  session: SessionPort,
  tenant: string,
  value: ProfilePlateSessionDraft | null,
) {
  const current = bucket(session);
  if (value) current.plates.set(tenant, value);
  else current.plates.delete(tenant);
  for (const listener of current.listeners) listener();
}
export function clearProfileEditorDraftsForSession(
  session: SessionPort,
  tenant: string,
) {
  const current = bucket(session);
  for (const key of current.drafts.keys())
    if ((JSON.parse(key) as string[])[0] === tenant) current.drafts.delete(key);
  current.plates.delete(tenant);
  current.generation += 1;
  for (const listener of current.listeners) listener();
}
export function profileSessionIdentity(session: SessionPort) {
  return bucket(session).id;
}
export function profileDraftGeneration(session: SessionPort) {
  return bucket(session).generation;
}
export function useProfilePrivateDraftStatus(): boolean {
  const { session } = usePorts();
  const tenant = useTenantId();
  const current = bucket(session);
  return useSyncExternalStore(
    (listener) => {
      current.listeners.add(listener);
      return () => current.listeners.delete(listener);
    },
    () =>
      [...current.drafts].some(
        ([key, draft]) =>
          (JSON.parse(key) as string[])[0] === tenant &&
          (!draft.durable ||
            hasPrivateDraftChanges(
              profileSnapshotValues(draft.base),
              draft.values,
            )),
      ) ||
      Boolean(
        current.plates.get(tenant) && !current.plates.get(tenant)?.durable,
      ),
    () => false,
  );
}
export function useProfileDraftGeneration(session: SessionPort) {
  const current = bucket(session);
  return useSyncExternalStore(
    (listener) => {
      current.listeners.add(listener);
      return () => current.listeners.delete(listener);
    },
    () => current.generation,
    () => current.generation,
  );
}

function redact(value: unknown): unknown {
  return project(recoveryProjection, value);
}

export function safeProfileChanges(
  base: ProfileFormValues,
  values: ProfileFormValues,
): ProfileSafeRecovery["changes"] {
  const changes: ProfileSafeRecovery["changes"] = [];
  const visit = (
    before: unknown,
    after: unknown,
    path: string[],
    beforePresent = true,
    afterPresent = true,
  ) => {
    if (
      JSON.stringify(before) === JSON.stringify(after) &&
      beforePresent === afterPresent
    )
      return;
    if (isJsonRecord(before) && isJsonRecord(after)) {
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ]))
        visit(
          before[key],
          after[key],
          [...path, key],
          Object.hasOwn(before, key),
          Object.hasOwn(after, key),
        );
      return;
    }
    changes.push({
      path,
      beforePresent,
      afterPresent,
      ...(beforePresent ? { before } : {}),
      ...(afterPresent ? { after } : {}),
    });
  };
  const safeBase = redact(base) as Record<string, unknown>,
    safeValues = redact(values) as Record<string, unknown>;
  for (const key of ["profile", "style", "templateText"])
    visit(safeBase[key], safeValues[key], [key]);
  return changes;
}
function at(
  root: unknown,
  path: readonly string[],
): { present: boolean; value: unknown } {
  let value = root;
  for (const part of path) {
    if (!isJsonRecord(value) || !Object.hasOwn(value, part))
      return { present: false, value: undefined };
    value = value[part];
  }
  return { present: true, value };
}
function mergePreservingPrivate(previous: unknown, incoming: unknown): unknown {
  if (Array.isArray(incoming))
    return incoming.map((entry, index) => {
      const old = Array.isArray(previous)
        ? isJsonRecord(entry) && typeof entry["id"] === "string"
          ? previous.find(
              (item) => isJsonRecord(item) && item["id"] === entry["id"],
            )
          : previous[index]
        : undefined;
      return mergePreservingPrivate(old, entry);
    });
  if (isJsonRecord(incoming))
    return {
      ...(isJsonRecord(previous) ? previous : {}),
      ...Object.fromEntries(
        Object.entries(incoming).map(([key, item]) => [
          key,
          mergePreservingPrivate(
            isJsonRecord(previous) ? previous[key] : undefined,
            item,
          ),
        ]),
      ),
    };
  return incoming;
}
export function restoreProfileChanges(
  record: ProfileSafeRecovery,
  current: ProfileFormValues,
  force = false,
): { values: ProfileFormValues; conflicts: string[] } {
  const values = structuredClone(current),
    projected = redact(current),
    conflicts: string[] = [];
  for (const change of record.changes) {
    const actual = at(projected, change.path);
    const matchesBefore =
      actual.present === change.beforePresent &&
      JSON.stringify(actual.value) === JSON.stringify(change.before);
    const matchesAfter =
      actual.present === change.afterPresent &&
      JSON.stringify(actual.value) === JSON.stringify(change.after);
    if (!matchesBefore && !matchesAfter && !force) {
      conflicts.push(change.path.join("."));
      continue;
    }
    let parent = values as unknown as Record<string, unknown>;
    for (const part of change.path.slice(0, -1)) {
      if (!Object.hasOwn(parent, part) || !isJsonRecord(parent[part]))
        Object.defineProperty(parent, part, {
          value: {},
          writable: true,
          configurable: true,
          enumerable: true,
        });
      parent = parent[part] as Record<string, unknown>;
    }
    const key = change.path.at(-1)!;
    if (change.afterPresent)
      Object.defineProperty(parent, key, {
        value: mergePreservingPrivate(
          Object.hasOwn(parent, key) ? parent[key] : undefined,
          change.after,
        ),
        writable: true,
        configurable: true,
        enumerable: true,
      });
    else delete parent[key];
  }
  return { values, conflicts };
}
const passwordPath = ["profile", "personal", "password"] as const;
export function hasPrivateDraftChanges(
  base: ProfileFormValues,
  values: ProfileFormValues,
): boolean {
  const before = at(base, passwordPath),
    after = at(values, passwordPath);
  return (
    before.present !== after.present ||
    JSON.stringify(before.value) !== JSON.stringify(after.value)
  );
}

/** Only the declared credential input survives navigation, in session memory.
 * It rejoins only while its exact canonical credential source is unchanged. */
export function restoreSessionPrivateFields(
  base: unknown,
  draft: unknown,
  current: unknown,
): unknown {
  const before = at(base, passwordPath),
    edited = at(draft, passwordPath),
    saved = at(current, passwordPath);
  if (
    !edited.present ||
    before.present !== saved.present ||
    JSON.stringify(before.value) !== JSON.stringify(saved.value) ||
    !isJsonRecord(current) ||
    !isJsonRecord(current["profile"])
  )
    return current;
  const profile = current["profile"];
  return {
    ...current,
    profile: {
      ...profile,
      personal: {
        ...(isJsonRecord(profile["personal"]) ? profile["personal"] : {}),
        password: edited.value,
      },
    },
  };
}
