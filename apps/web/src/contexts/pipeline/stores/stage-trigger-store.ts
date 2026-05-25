import {
  PIPELINE_VALIDATION_MODES,
  PIPELINE_RUN_STAGES,
  type PipelineRunStage,
  type PipelineValidationMode,
} from "@jobhunter/contracts";
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
  headless: boolean;
  model: string;
  continuous: boolean;
}

type StageTriggerConfigs = Record<PipelineRunStage, StageTriggerConfig>;

interface StageTriggerState {
  activeStage: PipelineRunStage;
  configs: StageTriggerConfigs;
  setActiveStage: (stage: PipelineRunStage) => void;
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
  headless: false,
  model: "default",
  continuous: false,
};

function createDefaultConfigs(): StageTriggerConfigs {
  return Object.fromEntries(PIPELINE_RUN_STAGES.map((stage) => [stage, { ...defaultConfig }])) as StageTriggerConfigs;
}

function createMemoryStorage(): StateStorage {
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

function getStorage(): StateStorage {
  if (typeof window === "undefined") {
    return fallbackStorage;
  }
  const storage = window.localStorage as Partial<StateStorage> | undefined;
  if (
    storage &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  ) {
    return storage as StateStorage;
  }
  return fallbackStorage;
}

function isStage(value: unknown): value is PipelineRunStage {
  return typeof value === "string" && PIPELINE_RUN_STAGES.includes(value as PipelineRunStage);
}

function isValidationMode(value: unknown): value is PipelineValidationMode {
  return typeof value === "string" && PIPELINE_VALIDATION_MODES.includes(value as PipelineValidationMode);
}

function mergeConfig(value: unknown): StageTriggerConfig {
  const source = typeof value === "object" && value !== null ? (value as Partial<StageTriggerConfig>) : {};
  return {
    ...defaultConfig,
    ...source,
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
};

export const useStageTriggerStore = create<StageTriggerState>()(
  persist(
    (set) => ({
      ...initialState,
      setActiveStage: (stage) => set({ activeStage: stage }),
      patchStageConfig: (stage, patch) =>
        set((state) => ({
          configs: {
            ...state.configs,
            [stage]: { ...state.configs[stage], ...patch },
          },
        })),
      reset: () => set({ activeStage: initialState.activeStage, configs: createDefaultConfigs() }),
    }),
    {
      name: "jh:stage-trigger-config",
      storage: createJSONStorage(getStorage),
      version: 1,
      partialize: ({ activeStage, configs }) => ({ activeStage, configs }),
      merge: (persisted, current) => {
        const source =
          typeof persisted === "object" && persisted !== null
            ? (persisted as Partial<Pick<StageTriggerState, "activeStage" | "configs">>)
            : {};
        return {
          ...current,
          activeStage: isStage(source.activeStage) ? source.activeStage : current.activeStage,
          configs: mergeConfigs(source.configs),
        };
      },
    },
  ),
);
