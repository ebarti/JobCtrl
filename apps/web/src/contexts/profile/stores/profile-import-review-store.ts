import type { ProfileConfigResponse, ProfileImportResponse } from "@jobctrl/contracts";
import { z } from "zod";
import { create } from "zustand";

import type { StoragePort } from "../../../shared/ports/StoragePort.js";
import { isJsonRecord, sameJson } from "../lib/json-record.js";
import { LEGACY_REVIEW_PREFIX, hasProjectedResult, hasProjectedReviewAuthority, hasUnverifiedPersonal, hasUnverifiedProfile, hasUnverifiedStyle, importAttemptId, projectImportReview, projectImportReviewBase, requiresLegacyRereview, type ImportSection } from "../lib/import-review.js";

export interface ProfileImportReviewDraft {
  id: string;
  revision: number;
  projectionVersion?: unknown;
  tenantId: string;
  filename: string;
  importProfile: boolean;
  importStyle: boolean;
  result: Pick<ProfileImportResponse, "profile" | "style" | "source">;
  base: Pick<ProfileConfigResponse, "profileVersion" | "profile">;
  attempt: { profileVersion: number | null; sections: ImportSection[]; count: number } | null;
}

const key = "jh:profile-import-review-v1";
const sectionSchema = z.enum(["personal", "summary", "experience", "education", "skills", "style"]);
const attemptSchema = z.object({
  profileVersion: z.number().int().positive().nullable(),
  sections: z.array(sectionSchema).min(1).max(6).refine((items) => new Set(items).size === items.length),
  count: z.number().int().positive().safe(),
}).strict();
const draftSchema = z.object({
  id: z.string().min(1), revision: z.number().int().nonnegative().safe(), tenantId: z.string(), filename: z.string(),
  importProfile: z.boolean(), importStyle: z.boolean(),
  result: z.object({ profile: z.unknown().optional(), style: z.unknown().optional(), source: z.unknown().optional() }).passthrough(),
  base: z.object({ profileVersion: z.number().int().positive().nullable(),
    profile: z.unknown() }).passthrough(),
  attempt: attemptSchema.nullable(),
}).passthrough();
// Once written, v2 prevents older readers from parsing the new record. It does
// not revoke a draft already loaded by an older tab.
const envelopeSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), drafts: z.array(draftSchema) }).strict();
const legacyPrefix = LEGACY_REVIEW_PREFIX;
const recoveryPrefix = "__jobctrl_resolved_legacy_review_v1";

function legacySnapshots(draft: ProfileImportReviewDraft): ProfileImportReviewDraft[] {
  return Object.entries(draft).flatMap(([name, value]) => {
    if (!name.startsWith(legacyPrefix)) return [];
    const parsed = draftSchema.safeParse(value);
    if (!parsed.success) return [];
    const snapshot = parsed.data as ProfileImportReviewDraft;
    return snapshot.id === draft.id && snapshot.tenantId === draft.tenantId && snapshot.revision < draft.revision ? [snapshot] : [];
  });
}

export function legacyRecoveryRecord(draft: ProfileImportReviewDraft): unknown | null {
  for (const [name, value] of Object.entries(draft)) {
    if (!name.startsWith(recoveryPrefix) || !isJsonRecord(value) || value.version !== 1 || !isJsonRecord(value.record)) continue;
    const parsed = draftSchema.safeParse(value.record);
    if (!parsed.success) continue;
    const rest = Object.fromEntries(Object.entries(draft).filter(([key]) => key !== name));
    if (sameJson(rest, parsed.data)) return parsed.data;
  }
  return hasUnverifiedProfile(draft) || hasUnverifiedPersonal(draft) || hasUnverifiedStyle(draft) ? draft : null;
}

function hasLegacyData(draft: ProfileImportReviewDraft): boolean {
  if (hasUnverifiedProfile(draft) || hasUnverifiedPersonal(draft) || hasUnverifiedStyle(draft)) return true;
  if (draft.projectionVersion !== 2 || Object.keys(draft).some((name) => name.startsWith(legacyPrefix) || name.startsWith(recoveryPrefix))) return true;
  if (!sameJson(draft.base, projectImportReviewBase(draft.base, draft.result))) return true;
  return !hasProjectedResult(draft);
}

function unusedKey(draft: ProfileImportReviewDraft, prefix: string): string {
  let candidate = prefix;
  while (Object.hasOwn(draft, candidate)) candidate += "_";
  return candidate;
}

function readDrafts(raw: string | null): ProfileImportReviewDraft[] {
  if (raw === null) return [];
  const parsed = envelopeSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error("Invalid review draft storage");
  const drafts = parsed.data.drafts as ProfileImportReviewDraft[];
  if (new Set(drafts.map((draft) => draft.id)).size !== drafts.length)
    throw new Error("Duplicate review draft identity");
  return drafts;
}
const serialize = (drafts: ProfileImportReviewDraft[]) => JSON.stringify({ version: 2, drafts });

interface ProfileImportReviewState {
  drafts: ProfileImportReviewDraft[];
  pendingIds: string[];
  storageError: boolean;
  hydrate: (storage: StoragePort) => Promise<boolean>;
  stage: (draft: Omit<ProfileImportReviewDraft, "id" | "revision" | "attempt">, storage: StoragePort) => Promise<boolean>;
  retry: (storage: StoragePort) => Promise<boolean>;
  verify: (draft: ProfileImportReviewDraft, storage: StoragePort) => Promise<boolean>;
  beginAttempt: (draft: ProfileImportReviewDraft, sections: ImportSection[], storage: StoragePort) => Promise<ProfileImportReviewDraft | null>;
  clearRejectedAttempt: (draft: ProfileImportReviewDraft, storage: StoragePort) => Promise<boolean>;
  discard: (draft: ProfileImportReviewDraft, storage: StoragePort) => Promise<boolean>;
  rebase: (draft: ProfileImportReviewDraft, base: ProfileConfigResponse, storage: StoragePort) => Promise<boolean>;
}

/** Transactional browser storage owns review drafts independently of the uploaded PDF. */
export const useProfileImportReviewStore = create<ProfileImportReviewState>((set, get) => {
  let tail: Promise<void> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  function merge(durable: ProfileImportReviewDraft[], excludedId?: string) {
    const ids = new Set(durable.map((draft) => draft.id));
    // Another tab may have removed a draft this tab still has open. Keep the
    // local copy visible, but `verify` prevents it from being saved again.
    return [...durable, ...get().drafts.filter((draft) => draft.id !== excludedId && !ids.has(draft.id))];
  }
  async function persist(id: string, storage: StoragePort): Promise<boolean> {
    return enqueue(async () => {
      const draft = get().drafts.find((item) => item.id === id);
      if (!draft) return false;
      try {
        const saved = await storage.transact(key, (raw) => {
          const drafts = readDrafts(raw);
          const existing = drafts.find((item) => item.id === id);
          if (existing && !sameJson(existing, draft))
            throw new Error("Review draft changed elsewhere");
          const next = existing ? drafts : [...drafts, draft];
          return { result: next, write: serialize(next) };
        });
        const pendingIds = get().pendingIds.filter((item) => item !== id);
        set({ drafts: merge(saved), pendingIds, storageError: pendingIds.length > 0 });
        return true;
      } catch {
        set({ storageError: true });
        return false;
      }
    });
  }
  async function hydrate(storage: StoragePort): Promise<boolean> {
    return enqueue(async () => {
      try {
        const saved = await storage.transact(key, (raw) => ({ result: readDrafts(raw) }));
        const pendingIds = get().pendingIds;
        set({ drafts: merge(saved), storageError: pendingIds.length > 0 });
        return true;
      } catch {
        set({ storageError: true });
        return false;
      }
    });
  }
  return {
    drafts: [], pendingIds: [], storageError: false,
    hydrate,
    stage: async (input, storage) => {
      const projected = projectImportReview(input);
      const draft = { ...projected, id: importAttemptId(projected.result) ?? crypto.randomUUID(), revision: 0, projectionVersion: 2 as const, attempt: null };
      const existing = get().drafts.find((item) => item.id === draft.id);
      if (existing) {
        if (!sameJson(existing, draft)) return false;
        return get().pendingIds.includes(draft.id) ? persist(draft.id, storage) : true;
      }
      set((state) => ({ drafts: [...state.drafts, draft], pendingIds: [...state.pendingIds, draft.id] }));
      return persist(draft.id, storage);
    },
    retry: async (storage) => {
      if (!(await hydrate(storage))) return false;
      for (const id of [...get().pendingIds]) if (!(await persist(id, storage))) return false;
      return true;
    },
    verify: (draft, storage) => enqueue(async () => {
      try {
        return await storage.transact(key, (raw) => ({
          result: readDrafts(raw).some((item) => item.id === draft.id && item.revision === draft.revision && sameJson(item, draft)),
        }));
      } catch {
        set({ storageError: true });
        return false;
      }
    }),
    beginAttempt: (draft, sections, storage) => enqueue(async () => {
      try {
        const result = await storage.transact(key, (raw) => {
          const drafts = readDrafts(raw);
          const existing = drafts.find((item) => item.id === draft.id);
          if (!existing || existing.revision >= Number.MAX_SAFE_INTEGER || !sameJson(existing, draft))
            throw new Error("Review draft changed elsewhere");
          if (existing.attempt && (!sameJson(existing.attempt.sections, sections)
              || existing.attempt.profileVersion !== existing.base.profileVersion
              || existing.attempt.count >= Number.MAX_SAFE_INTEGER))
            throw new Error("Review attempt changed");
          const nextDraft = { ...existing, revision: existing.revision + 1, attempt: {
            profileVersion: existing.base.profileVersion, sections: [...sections], count: (existing.attempt?.count ?? 0) + 1,
          } };
          if (!attemptSchema.safeParse(nextDraft.attempt).success) throw new Error("Invalid review attempt");
          const next = drafts.map((item) => item.id === draft.id ? nextDraft : item);
          return { result: { drafts: next, draft: nextDraft }, write: serialize(next) };
        });
        set({ drafts: merge(result.drafts) });
        return result.draft;
      } catch {
        set({ storageError: true });
        return null;
      }
    }),
    clearRejectedAttempt: (draft, storage) => enqueue(async () => {
      try {
        const saved = await storage.transact(key, (raw) => {
          const drafts = readDrafts(raw);
          const existing = drafts.find((item) => item.id === draft.id);
          if (!existing || !sameJson(existing, draft) || existing.attempt?.count !== 1
              || existing.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Review attempt changed");
          const next = drafts.map((item) => {
            if (item.id !== draft.id) return item;
            return { ...item, attempt: null, revision: item.revision + 1 };
          });
          return { result: next, write: serialize(next) };
        });
        set({ drafts: merge(saved) });
        return true;
      } catch {
        set({ storageError: true });
        return false;
      }
    }),
    discard: (draft, storage) => enqueue(async () => {
      try {
        const saved = await storage.transact(key, (raw) => {
          const drafts = readDrafts(raw);
          const existing = drafts.find((item) => item.id === draft.id);
          if (existing && !sameJson(existing, draft)) throw new Error("Review draft changed elsewhere");
          const next = drafts.filter((item) => item.id !== draft.id);
          if (hasLegacyData(draft)) {
            const snapshot = structuredClone(draft);
            if (!sameJson(snapshot, draft)) throw new Error("Legacy review could not be preserved");
            const name = unusedKey(draft, recoveryPrefix);
            next.push({ ...draft, [name]: { version: 1, record: snapshot } });
          }
          return { result: next, write: serialize(next) };
        });
        const pendingIds = get().pendingIds.filter((item) => item !== draft.id);
        set({ drafts: merge(saved, draft.id), pendingIds, storageError: pendingIds.length > 0 });
        return true;
      } catch {
        set({ storageError: true });
        return false;
      }
    }),
    rebase: (draft, base, storage) => enqueue(async () => {
      try {
        const saved = await storage.transact(key, (raw) => {
          const drafts = readDrafts(raw);
          const existing = drafts.find((item) => item.id === draft.id);
          if (!existing || !sameJson(existing, draft) || existing.attempt || existing.revision >= Number.MAX_SAFE_INTEGER)
            throw new Error("Review draft changed elsewhere");
          const next = drafts.map((item) => {
            if (item.id !== draft.id) return item;
            const preserved: Record<string, unknown> = {};
            let result = item.result;
            if (item.projectionVersion !== 2 || !sameJson(item.base, projectImportReviewBase(item.base, item.result))) {
              const key = unusedKey(item, legacyPrefix);
              const snapshot = structuredClone(item);
              if (!sameJson(snapshot, item)) throw new Error("Legacy review could not be preserved");
              preserved[key] = snapshot;
            }
            if (item.projectionVersion === 1 && !requiresLegacyRereview(item)) {
              // v1 without a legacy snapshot was already projected before it
              // was stored. Its current base can match an earlier proposal;
              // filtering it again would permanently erase that proposal.
              if (!hasProjectedReviewAuthority(item))
                throw new Error("Projected review could not be verified");
            } else if (item.projectionVersion !== 2) {
              if (item.projectionVersion !== undefined && item.projectionVersion !== 1)
                throw new Error("Review projection version is unsupported");
              const snapshots = legacySnapshots(item);
              const matches = snapshots.filter((snapshot) => sameJson(snapshot.result, item.result)
                && snapshot.importProfile === item.importProfile && snapshot.importStyle === item.importStyle);
              if ((requiresLegacyRereview(item) && !matches.length)
                || (snapshots.length && (!matches.length || matches.some((snapshot) => !sameJson(snapshot.base, matches[0]!.base)))))
                throw new Error("Legacy extraction base could not be verified");
              result = projectImportReview(matches[0] ?? item).result;
            } else if (!hasProjectedReviewAuthority(item)) {
              throw new Error("Projected review could not be verified");
            }
            return { ...item, ...preserved, result, revision: item.revision + 1, projectionVersion: 2 as const, base: projectImportReviewBase(base, result) };
          });
          return { result: next, write: serialize(next) };
        });
        set({ drafts: merge(saved) });
        return true;
      } catch {
        set({ storageError: true });
        return false;
      }
    }),
  };
});
