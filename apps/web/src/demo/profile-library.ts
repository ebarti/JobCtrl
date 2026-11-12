import { JobCtrlApiError } from "@jobctrl/api-client";
import { ProfileSchema } from "@jobctrl/contracts";
import type { z } from "zod";

import type { DemoWorkspaceSnapshot } from "./workspace/contracts.js";

type Data = Record<string, unknown>;
type Profile = z.infer<typeof ProfileSchema>;
type Role = Profile["resume"]["experience_entries"][number];
export interface DemoSourceRef {
  source_id: string;
  revision: number;
}
export interface DemoWordingVariant {
  variant_id: string;
  revision: number;
  achievement_id: string;
  text: string;
  status: string;
  approval_id: string | null;
  source_refs: DemoSourceRef[];
  origin_key: string | null;
  provenance: Data;
  previous_status?: string;
}
export interface DemoWordingRole {
  role_id: string;
  achievements: {
    achievement_id: string;
    baseline_variant_id: string;
    source_refs: DemoSourceRef[];
  }[];
}
export interface DemoWordingLibrary {
  ok: true;
  profileVersion: number;
  wordingRevision: number;
  roles: DemoWordingRole[];
  variants: DemoWordingVariant[];
  proposals: Data[];
}
export interface DemoProfileVersion {
  profileVersion: number;
  profile: Profile;
}
export interface DemoProfileSourceVersion {
  text: string;
  revision: number;
}

export const DEMO_PLATFORM_ACHIEVEMENT =
  "demo:achievement:platform-reliability";
export const DEMO_INCIDENT_ACHIEVEMENT = "demo:achievement:incident-practice";
export const DEMO_DELIVERY_ACHIEVEMENT = "demo:achievement:systems-delivery";

function features(snapshot: DemoWorkspaceSnapshot) {
  return (snapshot.state.features ??= {});
}
function failure(message: string) {
  return new JobCtrlApiError(409, "Conflict", message);
}

/** IDs bind authored records, including an older browser's saved synthetic seed. */
export function demoProfileDocument(value: unknown): Profile {
  const parsed = ProfileSchema.safeParse(value);
  if (!parsed.success)
    throw new JobCtrlApiError(
      400,
      "Bad Request",
      "The synthetic Profile has invalid fields.",
    );
  const profile = parsed.data;
  const ids = new Set<string>();
  for (const role of profile.resume.experience_entries) {
    if (
      role.achievement_ids &&
      role.achievement_ids.length !== role.bullets.length
    )
      throw new JobCtrlApiError(
        400,
        "Bad Request",
        "Each achievement needs its original identity.",
      );
    role.achievement_ids ??= role.bullets.map(
      (_, index) => `demo:achievement:${role.id}:${index}`,
    );
    for (const id of role.achievement_ids) {
      if (!id || ids.has(id))
        throw new JobCtrlApiError(
          400,
          "Bad Request",
          "Achievement identities must be unique.",
        );
      ids.add(id);
    }
  }
  if (
    new Set(profile.resume.experience_entries.map((role) => role.id)).size !==
    profile.resume.experience_entries.length
  )
    throw new JobCtrlApiError(
      400,
      "Bad Request",
      "Role identities must be unique.",
    );
  return profile;
}

const alternatives = [
  {
    id: "demo:wording:reliability-collaboration",
    achievement: DEMO_PLATFORM_ACHIEVEMENT,
    status: "pending",
    text: "Worked with the engineering team to improve platform reliability and document repeatable delivery checks.",
  },
] as const;

/** Pure read: bundled alternatives are authored examples, never model results. */
export function demoWordingLibrary(
  snapshot: DemoWorkspaceSnapshot,
): DemoWordingLibrary {
  const profileVersion =
    snapshot.state.readModel.profile.config.profileVersion ?? 1;
  const saved = snapshot.state.features?.wording;
  const profile = demoProfileDocument(
    snapshot.state.readModel.profile.config.profile,
  );
  const ledger = snapshot.state.features?.profileSourceVersions ?? {};
  const baselines: DemoWordingVariant[] = [];
  const roles = profile.resume.experience_entries.map((role) => ({
    role_id: role.id,
    achievements: role.bullets.map((text, index) => {
      const achievement_id = role.achievement_ids![index]!;
      const retainedBaseline = saved?.variants
        .filter(
          (variant) =>
            variant.achievement_id === achievement_id &&
            variant.variant_id.startsWith("baseline:"),
        )
        .sort(
          (left, right) =>
            (right.source_refs[0]?.revision ?? 0) -
            (left.source_refs[0]?.revision ?? 0),
        )[0];
      const previous =
        ledger[achievement_id] ??
        (retainedBaseline
          ? {
              text: retainedBaseline.text,
              revision: retainedBaseline.source_refs[0]?.revision ?? 1,
            }
          : undefined);
      const revision = previous
        ? previous.revision + Number(previous.text !== text)
        : 1;
      const source_refs = [
        { source_id: `achievement:${achievement_id}`, revision },
      ];
      const variant_id = `baseline:${achievement_id}:${revision}`;
      baselines.push({
        variant_id,
        revision: 1,
        achievement_id,
        text,
        source_refs,
        status: "approved",
        approval_id: `demo:authored-baseline:${variant_id}`,
        origin_key: null,
        provenance: {
          kind: "authored_baseline",
          authority: "authored_save",
          synthetic: true,
          origin: "bundled_or_user_authored_browser_demo",
        },
      });
      return { achievement_id, baseline_variant_id: variant_id, source_refs };
    }),
  }));
  const current = new Map(
    roles
      .flatMap((role) => role.achievements)
      .map((item) => [item.achievement_id, item]),
  );
  const retained = (saved?.variants ?? [])
    .filter(
      (variant) =>
        !baselines.some(
          (baseline) => baseline.variant_id === variant.variant_id,
        ),
    )
    .map((original) => {
      const variant = structuredClone(original);
      const achievement = current.get(variant.achievement_id);
      const fresh =
        achievement &&
        exactDemoRefs(variant.source_refs, achievement.source_refs);
      if (!fresh && variant.status !== "stale") {
        variant.previous_status = variant.status;
        variant.status = "stale";
      } else if (
        fresh &&
        variant.status === "stale" &&
        variant.previous_status
      ) {
        variant.status = variant.previous_status;
        delete variant.previous_status;
      }
      return variant;
    });
  if (!saved)
    for (const example of alternatives) {
      const achievement = current.get(example.achievement);
      if (!achievement) continue;
      retained.push({
        variant_id: example.id,
        revision: 1,
        achievement_id: example.achievement,
        text: example.text,
        status: example.status,
        approval_id: null,
        source_refs: structuredClone(achievement.source_refs),
        origin_key: null,
        provenance: {
          kind: "proposed_revision",
          synthetic: true,
          assessment_status: "unassessed",
          replaces_variant_id: achievement.baseline_variant_id,
          replaces_variant_revision: 1,
        },
      });
    }
  return {
    ok: true,
    profileVersion,
    wordingRevision: saved?.wordingRevision ?? 1,
    roles,
    variants: [...baselines, ...retained],
    proposals: structuredClone(saved?.proposals ?? []),
  };
}

export function exactDemoRefs(
  left: readonly DemoSourceRef[],
  right: readonly DemoSourceRef[],
): boolean {
  return (
    left.length === right.length &&
    new Set(left.map((ref) => ref.source_id)).size === left.length &&
    left.every((ref) =>
      right.some(
        (other) =>
          other.source_id === ref.source_id && other.revision === ref.revision,
      ),
    )
  );
}

/** Retain the latest exact document and source pins before a local Profile write. */
export function retainDemoProfile(snapshot: DemoWorkspaceSnapshot) {
  const state = features(snapshot);
  const profileVersion =
    snapshot.state.readModel.profile.config.profileVersion ?? 1;
  const history = (state.profileVersions ??= []);
  if (!history.some((item) => item.profileVersion === profileVersion))
    history.push({
      profileVersion,
      profile: demoProfileDocument(
        snapshot.state.readModel.profile.config.profile,
      ),
    });
  const library = demoWordingLibrary(snapshot);
  state.wording = library;
  const ledger = (state.profileSourceVersions ??= {});
  for (const role of library.roles)
    for (const achievement of role.achievements) {
      const baseline = library.variants.find(
        (variant) => variant.variant_id === achievement.baseline_variant_id,
      )!;
      ledger[achievement.achievement_id] = {
        text: baseline.text,
        revision: achievement.source_refs[0]!.revision,
      };
    }
}

export function reconcileDemoProfile(snapshot: DemoWorkspaceSnapshot) {
  const state = features(snapshot);
  const library = demoWordingLibrary(snapshot);
  library.wordingRevision += 1;
  state.wording = library;
  for (const role of library.roles)
    for (const achievement of role.achievements) {
      const variant = library.variants.find(
        (item) => item.variant_id === achievement.baseline_variant_id,
      )!;
      (state.profileSourceVersions ??= {})[achievement.achievement_id] = {
        text: variant.text,
        revision: achievement.source_refs[0]!.revision,
      };
    }
}

export function validateDemoProfileSave(
  snapshot: DemoWorkspaceSnapshot,
  value: unknown,
): Profile {
  const proposed = ProfileSchema.safeParse(value);
  if (!proposed.success)
    throw new JobCtrlApiError(
      400,
      "Bad Request",
      "The synthetic Profile has invalid fields.",
    );
  const profile = demoProfileDocument(value);
  const current = demoProfileDocument(
    snapshot.state.readModel.profile.config.profile,
  );
  const documents = [
    ...(snapshot.state.features?.profileVersions ?? []).map(
      (version) => version.profile,
    ),
    current,
  ];
  const ownership = new Map(
    documents.flatMap((document) =>
      document.resume.experience_entries.flatMap((role) =>
        role.achievement_ids!.map((id) => [id, role.id]),
      ),
    ),
  );
  for (const role of proposed.data.resume.experience_entries) {
    const previous = current.resume.experience_entries.find(
      (item) => item.id === role.id,
    );
    if (
      previous &&
      !role.achievement_ids &&
      JSON.stringify(previous.bullets) !== JSON.stringify(role.bullets)
    )
      throw failure(
        "Reload the saved Profile before changing achievement text or order.",
      );
  }
  for (const role of profile.resume.experience_entries)
    for (const id of role.achievement_ids!) {
      const owner = ownership.get(id);
      if (owner && owner !== role.id)
        throw failure(
          "An achievement belongs to a different role. Reload the Profile before saving.",
        );
    }
  return profile;
}

export function demoProfileRecovery(snapshot: DemoWorkspaceSnapshot) {
  const profile = demoProfileDocument(
    snapshot.state.readModel.profile.config.profile,
  );
  const activeRoles = new Set(
    profile.resume.experience_entries.map((role) => role.id),
  );
  const activeAchievements = new Set(
    profile.resume.experience_entries.flatMap((role) => role.achievement_ids!),
  );
  const roles = new Map<
    string,
    { role_id: string; profile_revision: number; role: Role }
  >();
  const achievements = new Map<
    string,
    {
      role_id: string;
      achievement_id: string;
      profile_revision: number;
      text: string;
      position: number;
    }
  >();
  for (const version of [
    ...(snapshot.state.features?.profileVersions ?? []),
  ].reverse()) {
    for (const role of version.profile.resume.experience_entries) {
      if (!activeRoles.has(role.id) && !roles.has(role.id))
        roles.set(role.id, {
          role_id: role.id,
          profile_revision: version.profileVersion,
          role: structuredClone(role),
        });
      if (activeRoles.has(role.id))
        role.achievement_ids!.forEach((id, position) => {
          if (!activeAchievements.has(id) && !achievements.has(id))
            achievements.set(id, {
              role_id: role.id,
              achievement_id: id,
              profile_revision: version.profileVersion,
              text: role.bullets[position]!,
              position,
            });
        });
    }
  }
  return {
    ok: true,
    profileVersion: snapshot.state.readModel.profile.config.profileVersion,
    roles: [...roles.values()],
    achievements: [...achievements.values()],
  };
}

export function restoreDemoProfile(
  snapshot: DemoWorkspaceSnapshot,
  body: Data,
): Profile {
  if (
    body.expectedProfileVersion !==
    snapshot.state.readModel.profile.config.profileVersion
  )
    throw failure("The Profile changed before restoration.");
  const recovery = demoProfileRecovery(snapshot);
  const profile = demoProfileDocument(
    snapshot.state.readModel.profile.config.profile,
  );
  if (body.kind === "role") {
    const item = recovery.roles.find(
      (row) =>
        row.role_id === body.id &&
        row.profile_revision === body.sourceProfileVersion,
    );
    if (!item)
      throw failure(
        "This removed role is no longer available for restoration.",
      );
    profile.resume.experience_entries.push(structuredClone(item.role));
  } else if (body.kind === "achievement") {
    const item = recovery.achievements.find(
      (row) =>
        row.achievement_id === body.id &&
        row.profile_revision === body.sourceProfileVersion,
    );
    const role = profile.resume.experience_entries.find(
      (row) => row.id === item?.role_id,
    );
    if (!item || !role)
      throw failure("Restore the role before its achievement.");
    const index = Math.min(item.position, role.bullets.length);
    role.bullets.splice(index, 0, item.text);
    role.achievement_ids!.splice(index, 0, item.achievement_id);
  } else
    throw new JobCtrlApiError(
      400,
      "Bad Request",
      "Choose a removed role or achievement.",
    );
  return profile;
}
