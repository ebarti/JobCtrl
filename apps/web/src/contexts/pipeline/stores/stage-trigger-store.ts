import {
  PIPELINE_VALIDATION_MODES,
  PIPELINE_RUN_STAGES,
  type PipelineRunStage,
  type PipelineValidationMode,
} from "@jobctrl/contracts";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export interface StageTriggerConfig {
  limit: string;
  workers: string;
  minScore: string;
  validationMode: PipelineValidationMode;
  dryRun: boolean;
  rescore: boolean;
  retailor: boolean;
  tailorModels: string;
  tailorJudgeModel: string;
  discoverySourceIds: string[];
  headless: boolean;
  model: string;
  continuous: boolean;
}

type StageTriggerConfigs = Record<PipelineRunStage, StageTriggerConfig>;

interface StageTriggerState {
  activeStage: PipelineRunStage;
  configs: StageTriggerConfigs;
  internalConcurrency: string;
  storageRecoveryRequired: boolean;
  setActiveStage: (stage: PipelineRunStage) => void;
  setInternalConcurrency: (value: string) => void;
  patchStageConfig: (stage: PipelineRunStage, patch: Partial<StageTriggerConfig>) => void;
  reset: () => void;
}

const defaultConfig: StageTriggerConfig = {
  limit: "25",
  workers: "1",
  minScore: "7",
  validationMode: "normal",
  dryRun: true,
  rescore: false,
  retailor: false,
  tailorModels: "",
  tailorJudgeModel: "",
  discoverySourceIds: [],
  headless: false,
  model: "default",
  continuous: false,
};

function defaultConfigForStage(stage: PipelineRunStage): StageTriggerConfig {
  return { ...defaultConfig, dryRun: stage !== "discover" };
}

function createDefaultConfigs(): StageTriggerConfigs {
  return Object.fromEntries(PIPELINE_RUN_STAGES.map((stage) => [stage, defaultConfigForStage(stage)])) as StageTriggerConfigs;
}

interface SyncStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function createMemoryStorage(): SyncStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

const fallbackStorage = createMemoryStorage();

function getStorage(): SyncStorage {
  if (typeof window === "undefined") {
    throw new Error("Pipeline control storage unavailable");
  }
  const storage = window.localStorage as Partial<SyncStorage> | undefined;
  if (
    storage &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  ) {
    return storage as SyncStorage;
  }
  throw new Error("Pipeline control storage unavailable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A damaged value is distinct from an absent key. Keep the original value
// until the user explicitly chooses a Discover mode, including during the
// panel's automatic synchronization of internal concurrency.
let storageRecoveryRequired = false;
const recoveryValue = JSON.stringify({ state: {}, version: 3 });
const recoverableStorage: StateStorage = {
  getItem: (key) => {
    let serialized: string | null;
    try {
      serialized = getStorage().getItem(key);
    } catch {
      serialized = fallbackStorage.getItem(key);
      if (serialized === null) {
        storageRecoveryRequired = true;
        return recoveryValue;
      }
    }
    if (serialized === null) {
      storageRecoveryRequired = false;
      return null;
    }
    try {
      const value: unknown = JSON.parse(serialized);
      if (!isRecord(value) || !isRecord(value.state)) {
        storageRecoveryRequired = true;
        return recoveryValue;
      }
      const configs = value.state.configs;
      const discover = isRecord(configs) ? configs.discover : undefined;
      storageRecoveryRequired =
        !isRecord(configs) ||
        !isRecord(discover) ||
        (discover.dryRun !== undefined && typeof discover.dryRun !== "boolean");
      return serialized;
    } catch {
      storageRecoveryRequired = true;
      return recoveryValue;
    }
  },
  setItem: (key, value) => {
    if (storageRecoveryRequired) return;
    try {
      getStorage().setItem(key, value);
    } catch {
      fallbackStorage.setItem(key, value);
    }
  },
  removeItem: (key) => {
    storageRecoveryRequired = false;
    try {
      getStorage().removeItem(key);
    } catch {
      fallbackStorage.removeItem(key);
    }
  },
};

function isStage(value: unknown): value is PipelineRunStage {
  return typeof value === "string" && PIPELINE_RUN_STAGES.includes(value as PipelineRunStage);
}

function isValidationMode(value: unknown): value is PipelineValidationMode {
  return typeof value === "string" && PIPELINE_VALIDATION_MODES.includes(value as PipelineValidationMode);
}

function mergeConfig(value: unknown): StageTriggerConfig {
  const source =
    typeof value === "object" && value !== null
      ? (value as Partial<StageTriggerConfig> & { discoverySourceId?: unknown })
      : {};
  const { discoverySourceId, ...currentSource } = source;
  const legacyDiscoverySourceId =
    typeof discoverySourceId === "string" ? discoverySourceId.trim() : "";
  const discoverySourceIds = Array.isArray(source.discoverySourceIds)
    ? [
        ...new Set(
          source.discoverySourceIds
            .filter((sourceId): sourceId is string => typeof sourceId === "string")
            .map((sourceId) => sourceId.trim())
            .filter(Boolean),
        ),
      ].slice(0, 50)
    : legacyDiscoverySourceId
      ? [legacyDiscoverySourceId]
      : [];
  return {
    ...defaultConfig,
    ...currentSource,
    discoverySourceIds,
    dryRun: typeof source.dryRun === "boolean" ? source.dryRun : defaultConfig.dryRun,
    validationMode: isValidationMode(source.validationMode) ? source.validationMode : defaultConfig.validationMode,
  };
}

function mergeConfigs(value: unknown): StageTriggerConfigs {
  const source =
    typeof value === "object" && value !== null ? (value as Partial<Record<PipelineRunStage, unknown>>) : {};
  return Object.fromEntries(PIPELINE_RUN_STAGES.map((stage) => [stage, mergeConfig(source[stage])])) as StageTriggerConfigs;
}

const initialState = {
  activeStage: PIPELINE_RUN_STAGES[0],
  configs: createDefaultConfigs(),
  internalConcurrency: defaultConfig.workers,
  storageRecoveryRequired: false,
};

function normalizeInternalConcurrency(value: unknown): string {
  if (typeof value !== "string") return defaultConfig.workers;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? String(Math.min(16, Math.max(1, parsed)))
    : defaultConfig.workers;
}

export const useStageTriggerStore = create<StageTriggerState>()(
  persist(
    (set) => ({
      ...initialState,
      setActiveStage: (stage) => set({ activeStage: stage }),
      setInternalConcurrency: (value) => set({ internalConcurrency: value }),
      patchStageConfig: (stage, patch) => {
        const recoversStorage = stage === "discover" && typeof patch.dryRun === "boolean";
        if (recoversStorage) storageRecoveryRequired = false;
        set((state) => ({
          configs: {
            ...state.configs,
            [stage]: { ...state.configs[stage], ...patch },
          },
          storageRecoveryRequired: recoversStorage ? false : state.storageRecoveryRequired,
        }));
      },
      reset: () => {
        storageRecoveryRequired = false;
        set({
          activeStage: initialState.activeStage,
          configs: createDefaultConfigs(),
          internalConcurrency: initialState.internalConcurrency,
          storageRecoveryRequired: false,
        });
      },
    }),
    {
      name: "jh:stage-trigger-config",
      storage: createJSONStorage(() => recoverableStorage),
      version: 3,
      migrate: (persisted) => persisted,
      partialize: ({ activeStage, configs, internalConcurrency }) => ({
        activeStage,
        configs,
        internalConcurrency,
      }),
      merge: (persisted, current) => {
        if (persisted === undefined && !storageRecoveryRequired) {
          return { ...current, ...initialState, configs: createDefaultConfigs() };
        }
        const source =
          typeof persisted === "object" && persisted !== null
            ? (persisted as Partial<
                Pick<
                  StageTriggerState,
                  "activeStage" | "configs" | "internalConcurrency"
                >
              >)
            : {};
        const activeStage = isStage(source.activeStage)
          ? source.activeStage
          : current.activeStage;
        const configs = mergeConfigs(source.configs);
        const legacyConcurrency = configs[activeStage].workers;
        return {
          ...current,
          activeStage,
          configs,
          storageRecoveryRequired,
          internalConcurrency: normalizeInternalConcurrency(
            source.internalConcurrency ?? legacyConcurrency,
          ),
        };
      },
    },
  ),
);
