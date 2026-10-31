import type { ProfileImportResponse } from "@jobctrl/contracts";
import { create } from "zustand";
import { z } from "zod";
import type { StoragePort } from "../../../shared/ports/StoragePort.js";

type Coordinator = Pick<StoragePort, "transact">;
interface ProfileImportData {
  filename: string;
  pdfBase64: string;
  importProfile: boolean;
  importStyle: boolean;
}
type StorageFailure = "read" | "write" | "remove" | "conflict";
interface ProfileImportState extends ProfileImportData {
  hydrated: boolean;
  selectionPending: boolean;
  pendingWrites: number;
  storageFailure: StorageFailure | null;
  unresolvedRead: boolean;
  currentRaw: string | null;
  legacyRaw: string | null;
  legacyData: ProfileImportData | null;
  snapshotGeneration: number;
  selectionRevision: number;
  cleanupGeneration: number;
  pendingImports: Array<{
    revision: number;
    cleanupGeneration: number;
    request: ProfileImportData;
  }>;
  completedImports: Array<{
    revision: number;
    cleanupGeneration: number;
    request: ProfileImportData;
    result: ProfileImportResponse;
  }>;
  hydrate: (coordinator: Coordinator) => Promise<void>;
  beginSelection: () => void;
  endSelection: () => void;
  setUpload: (
    filename: string,
    pdfBase64: string,
    coordinator: Coordinator,
    stillCurrent?: () => boolean,
  ) => Promise<boolean>;
  setOptions: (
    importProfile: boolean,
    importStyle: boolean,
    coordinator: Coordinator,
  ) => Promise<boolean>;
  reset: (
    coordinator: Coordinator,
    stillCurrent?: () => boolean,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  retryStorage: (
    coordinator: Coordinator,
    stillCurrent?: () => boolean,
  ) => Promise<boolean>;
  beginImport: (revision: number, coordinator: Coordinator) => Promise<boolean>;
  finishImport: (revision: number, result?: ProfileImportResponse) => void;
}
function sameImportRequest(
  a: ProfileImportData,
  b: ProfileImportData,
): boolean {
  return (
    a.filename === b.filename &&
    a.pdfBase64 === b.pdfBase64 &&
    a.importProfile === b.importProfile &&
    a.importStyle === b.importStyle
  );
}
export function hasCompletedImport(state: ProfileImportState): boolean {
  return state.completedImports.some(
    ({ request, cleanupGeneration }) =>
      cleanupGeneration === state.cleanupGeneration &&
      sameImportRequest(request, state),
  );
}
export function hasPendingImport(state: ProfileImportState): boolean {
  return state.pendingImports.some(({ request }) =>
    sameImportRequest(request, state),
  );
}
type ProfileImportUploadState = Pick<
  ProfileImportState,
  "filename" | "pdfBase64"
> &
  Partial<
    Pick<
      ProfileImportState,
      "hydrated" | "selectionPending" | "pendingWrites" | "storageFailure"
    >
  >;
export function hasProfileImportUpload(
  state: ProfileImportUploadState,
): boolean {
  return (
    state.hydrated !== false &&
    !state.selectionPending &&
    !state.pendingWrites &&
    state.storageFailure !== "read" &&
    state.storageFailure !== "conflict" &&
    state.filename.trim().length > 0 &&
    state.pdfBase64.length > 0
  );
}
const legacyKey = "jh:profile-import";
const storageKey = "jh:profile-import-v2";
const initialState: ProfileImportData = {
  filename: "",
  pdfBase64: "",
  importProfile: true,
  importStyle: true,
};
const stateSchema = z
  .object({
    filename: z.string(),
    pdfBase64: z.string(),
    importProfile: z.boolean(),
    importStyle: z.boolean(),
  })
  .refine(
    ({ filename, pdfBase64 }) =>
      Boolean(filename.trim()) === Boolean(pdfBase64),
  );
const legacySchema = z.object({ version: z.literal(1), state: stateSchema });
const currentSchema = z.object({
  version: z.literal(2),
  revision: z.number().int().nonnegative().safe(),
  state: stateSchema,
});
type Snapshot = {
  data: ProfileImportData;
  currentRaw: string | null;
  legacyRaw: string | null;
  legacyData: ProfileImportData | null;
};
function readSaved(
  currentRaw: string | null,
): { ok: true; snapshot: Snapshot } | { ok: false; unreadLegacy?: string } {
  try {
    const legacyRaw =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(legacyKey);
    let legacyData: ProfileImportData | null = null;
    if (legacyRaw !== null) {
      try {
        const parsed = legacySchema.safeParse(JSON.parse(legacyRaw));
        if (parsed.success) legacyData = parsed.data.state;
      } catch {
        /* Keep unread legacy bytes untouched. */
      }
    }
    if (currentRaw !== null) {
      const parsed = currentSchema.safeParse(JSON.parse(currentRaw));
      if (!parsed.success) return { ok: false };
      return {
        ok: true,
        snapshot: {
          data: parsed.data.state,
          currentRaw,
          legacyRaw,
          legacyData,
        },
      };
    }
    if (legacyRaw !== null && !legacyData)
      return { ok: false, unreadLegacy: legacyRaw };
    return {
      ok: true,
      snapshot: {
        data: legacyData ?? { ...initialState },
        currentRaw,
        legacyRaw,
        legacyData,
      },
    };
  } catch {
    return { ok: false };
  }
}

export const useProfileImportStore = create<ProfileImportState>()((
  set,
  get,
) => {
  type Change = {
    data: ProfileImportData;
    finishSelection?: boolean;
    cleanup?: boolean;
  };
  type Outcome =
    | { kind: "ok"; change: Change; nextRaw: string }
    | { kind: "superseded" | "conflict" | "storage" };
  let tail: Promise<void> = Promise.resolve();
  let hydration: Promise<void> | null = null;
  const cancellable = new Set<AbortController>();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  function cancelSelections() {
    for (const controller of cancellable) controller.abort();
  }
  async function write(
    coordinator: Coordinator,
    prepare: (current: ProfileImportState) => Change | null,
    failure: "write" | "remove",
    cancelOnSelection = false,
    externalSignal?: AbortSignal,
  ): Promise<boolean> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (externalSignal?.aborted) cancel();
    else externalSignal?.addEventListener("abort", cancel, { once: true });
    if (cancelOnSelection) cancellable.add(controller);
    set((current) => ({ pendingWrites: current.pendingWrites + 1 }));
    try {
      return await enqueue(async () => {
        if (controller.signal.aborted) return false;
        let outcome: Outcome;
        try {
          outcome = await coordinator.transact<Outcome>(
            storageKey,
            (actualRaw) => {
              const current = get();
              const change = prepare(current);
              if (!change) return { result: { kind: "superseded" } };
              if (actualRaw !== current.currentRaw)
                return { result: { kind: "conflict" } };
              try {
                // Legacy is never modified. A current-record transaction serializes
                // comparison and replacement even where localStorage is stale.
                if (
                  typeof window !== "undefined" &&
                  window.localStorage.getItem(legacyKey) !== current.legacyRaw
                )
                  return { result: { kind: "conflict" } };
                const revision =
                  actualRaw === null
                    ? 0
                    : currentSchema.parse(JSON.parse(actualRaw)).revision;
                if (revision >= Number.MAX_SAFE_INTEGER)
                  return { result: { kind: "storage" } };
                const nextRaw = JSON.stringify({
                  version: 2,
                  revision: revision + 1,
                  state: change.data,
                });
                return {
                  result: { kind: "ok", change, nextRaw },
                  write: nextRaw,
                };
              } catch {
                return { result: { kind: "storage" } };
              }
            },
            controller.signal,
          );
        } catch {
          if (!controller.signal.aborted && prepare(get()))
            set({ storageFailure: failure });
          return false;
        }
        if (outcome.kind === "ok") {
          const current = get();
          // A transaction can commit just before a replacement or navigation
          // aborts it. Record its durable baseline without ending the newer
          // selection or invalidating its revision.
          const superseded = controller.signal.aborted || !prepare(current);
          const changed =
            outcome.change.finishSelection ||
            !sameImportRequest(current, outcome.change.data);
          set({
            ...outcome.change.data,
            currentRaw: outcome.nextRaw,
            storageFailure: null,
            unresolvedRead: false,
            selectionRevision:
              current.selectionRevision + (!superseded && changed ? 1 : 0),
            snapshotGeneration:
              current.snapshotGeneration +
              (outcome.change.finishSelection || outcome.change.cleanup
                ? 1
                : 0),
            ...(!superseded &&
            (outcome.change.finishSelection || outcome.change.cleanup)
              ? { selectionPending: false }
              : {}),
            ...(outcome.change.cleanup
              ? { cleanupGeneration: current.cleanupGeneration + 1 }
              : {}),
          });
          return !superseded;
        }
        if (prepare(get())) {
          if (outcome.kind === "conflict") set({ storageFailure: "conflict" });
          else if (outcome.kind === "storage") set({ storageFailure: failure });
        }
        return false;
      });
    } finally {
      externalSignal?.removeEventListener("abort", cancel);
      cancellable.delete(controller);
      set((current) => ({ pendingWrites: current.pendingWrites - 1 }));
    }
  }
  async function retryStorage(
    coordinator: Coordinator,
    stillCurrent = () => true,
  ): Promise<boolean> {
    return enqueue(async () => {
      if (!stillCurrent()) return false;
      let result: ReturnType<typeof readSaved>;
      try {
        result = await coordinator.transact(storageKey, (current) => ({
          result: readSaved(current),
        }));
      } catch {
        result = { ok: false };
      }
      if (!stillCurrent()) return false;
      if (!result.ok) {
        set({
          hydrated: true,
          storageFailure: "read",
          unresolvedRead: true,
          ...(result.unreadLegacy !== undefined
            ? {
                currentRaw: null,
                legacyRaw: result.unreadLegacy,
                legacyData: null,
              }
            : {}),
        });
        return false;
      }
      const previous = get();
      set({
        ...result.snapshot.data,
        currentRaw: result.snapshot.currentRaw,
        legacyRaw: result.snapshot.legacyRaw,
        legacyData: result.snapshot.legacyData,
        hydrated: true,
        selectionPending: false,
        storageFailure: null,
        unresolvedRead: false,
        selectionRevision: previous.selectionRevision + 1,
        snapshotGeneration: previous.snapshotGeneration + 1,
      });
      return true;
    });
  }
  return {
    ...initialState,
    hydrated: false,
    currentRaw: null,
    legacyRaw: null,
    legacyData: null,
    snapshotGeneration: 0,
    selectionPending: false,
    pendingWrites: 0,
    storageFailure: null,
    unresolvedRead: false,
    selectionRevision: 0,
    cleanupGeneration: 0,
    pendingImports: [],
    completedImports: [],
    hydrate: async (coordinator) => {
      if (get().hydrated) return;
      hydration ??= retryStorage(coordinator).then(() => undefined);
      await hydration;
      hydration = null;
    },
    beginSelection: () => {
      cancelSelections();
      set((current) => ({
        selectionPending: true,
        selectionRevision: current.selectionRevision + 1,
        snapshotGeneration: current.snapshotGeneration + 1,
        storageFailure:
          current.storageFailure === "conflict" ? current.storageFailure : null,
      }));
    },
    endSelection: () => {
      cancelSelections();
      set((current) => ({
        selectionPending: false,
        selectionRevision:
          current.selectionRevision + (current.selectionPending ? 1 : 0),
        storageFailure: current.unresolvedRead
          ? "read"
          : current.storageFailure === "conflict"
            ? current.storageFailure
            : null,
      }));
    },
    setUpload: (
      filename,
      pdfBase64,
      coordinator,
      stillCurrent = () => true,
    ) => {
      const revision = get().selectionRevision;
      return write(
        coordinator,
        (current) =>
          current.selectionRevision === revision && stillCurrent()
            ? {
                data: {
                  filename,
                  pdfBase64,
                  importProfile: current.importProfile,
                  importStyle: current.importStyle,
                },
                finishSelection: true,
              }
            : null,
        "write",
        true,
      );
    },
    setOptions: (importProfile, importStyle, coordinator) => {
      const { filename, pdfBase64, unresolvedRead, snapshotGeneration } = get();
      if (unresolvedRead) {
        set({ storageFailure: "read" });
        return Promise.resolve(false);
      }
      return write(
        coordinator,
        (current) =>
          current.filename === filename &&
          current.pdfBase64 === pdfBase64 &&
          current.snapshotGeneration === snapshotGeneration &&
          !current.selectionPending
            ? { data: { filename, pdfBase64, importProfile, importStyle } }
            : null,
        "write",
      );
    },
    reset: (coordinator, stillCurrent = () => true, signal) => {
      const revision = get().selectionRevision;
      return write(
        coordinator,
        (current) =>
          current.selectionRevision === revision && stillCurrent()
            ? { data: { ...initialState }, cleanup: true }
            : null,
        "remove",
        true,
        signal,
      );
    },
    retryStorage,
    beginImport: (revision, coordinator) =>
      enqueue(async () => {
        const current = get();
        if (
          current.selectionRevision !== revision ||
          !hasProfileImportUpload(current) ||
          hasPendingImport(current) ||
          hasCompletedImport(current)
        )
          return false;
        let matches = false;
        try {
          matches = await coordinator.transact(storageKey, (actual) => ({
            result:
              actual === current.currentRaw &&
              (typeof window === "undefined" ||
                window.localStorage.getItem(legacyKey) === current.legacyRaw),
          }));
        } catch {
          set({ storageFailure: "read", unresolvedRead: true });
          return false;
        }
        if (!matches) {
          set({ storageFailure: "conflict" });
          return false;
        }
        const latest = get();
        if (
          latest.selectionRevision !== revision ||
          !hasProfileImportUpload(latest) ||
          hasPendingImport(latest) ||
          hasCompletedImport(latest)
        )
          return false;
        const { filename, pdfBase64, importProfile, importStyle } = latest;
        set({
          pendingImports: [
            ...latest.pendingImports,
            {
              revision,
              cleanupGeneration: latest.cleanupGeneration,
              request: { filename, pdfBase64, importProfile, importStyle },
            },
          ],
        });
        return true;
      }),
    finishImport: (revision, result) =>
      set((current) => {
        const pending = current.pendingImports.find(
          (entry) => entry.revision === revision,
        );
        return {
          pendingImports: current.pendingImports.filter(
            (entry) => entry.revision !== revision,
          ),
          completedImports:
            result && pending
              ? [...current.completedImports, { ...pending, result }]
              : current.completedImports,
        };
      }),
  };
});
