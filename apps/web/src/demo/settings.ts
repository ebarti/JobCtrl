import { z } from "zod";

export const DEMO_APPLICATION_SETTINGS_SCHEMA = z
  .object({
    revision: z.number().int().positive(),
    defaultProvider: z.enum(["codex", "claude", "google"]),
    providerModels: z.record(z.string(), z.string()),
    dailyBudgetUsd: z.number().min(0),
    laneTokenLimits: z.record(z.string(), z.number().int().min(0)),
    laneConcurrency: z.record(z.string(), z.number().int().min(1)),
    providerConfiguration: z.record(z.string(), z.string()),
    resumeMode: z.enum(["baseline", "tailored"]),
    aiExecutionPolicy: z.object({ enabled: z.boolean() }).strict(),
    workerActivitySlots: z.number().int().min(1),
    applyConcurrency: z.number().int().min(1),
    applyTimeoutSeconds: z.number().int().min(30),
    applyMaxBudgetUsd: z.number().min(0),
    minFitScore: z.number().int().min(1).max(10),
    scoreCriteria: z.string(),
    targetCriteria: z.string(),
    applyAutomationEnabled: z.boolean(),
    codexReasoningEfforts: z.record(
      z.string(),
      z.enum(["low", "medium", "high", "xhigh", "max"]),
    ),
    modelPricingQuotes: z.record(
      z.string(),
      z
        .object({
          inputUsdPerMillion: z.number().min(0),
          outputUsdPerMillion: z.number().min(0),
          source: z.string(),
          revision: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type DemoSettingsSnapshot = z.infer<typeof DEMO_APPLICATION_SETTINGS_SCHEMA>;

export const DEMO_APPLICATION_SETTINGS: DemoSettingsSnapshot = DEMO_APPLICATION_SETTINGS_SCHEMA.parse({revision:1,defaultProvider:"codex",providerModels:{},dailyBudgetUsd:20,laneTokenLimits:{},laneConcurrency:{},providerConfiguration:{},resumeMode:"baseline",aiExecutionPolicy:{enabled:false},workerActivitySlots:4,applyConcurrency:1,applyTimeoutSeconds:900,applyMaxBudgetUsd:5,minFitScore:7,scoreCriteria:"Synthetic demonstration criteria.",targetCriteria:"Synthetic demonstration target.",applyAutomationEnabled:false,codexReasoningEfforts:{},modelPricingQuotes:{}});
