import { beforeEach, describe, expect, it } from "vitest";

import { useStageTriggerStore } from "./stage-trigger-store.js";

const storageKey = "jh:stage-trigger-config";

describe("stage trigger storage recovery", () => {
  beforeEach(async () => {
    window.localStorage.removeItem(storageKey);
    await useStageTriggerStore.persist.rehydrate();
  });

  it("uses the ordinary Discover default only when storage is absent", () => {
    const state = useStageTriggerStore.getState();
    expect(useStageTriggerStore.persist.hasHydrated()).toBe(true);
    expect(state.configs.discover.dryRun).toBe(false);
    for (const stage of ["score", "tailor", "cover", "apply"] as const) {
      expect(state.configs[stage].dryRun).toBe(true);
    }
    expect(state.storageRecoveryRequired).toBe(false);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it.each([true, false])("restores explicit Discover mode %s and other saved stages", async (dryRun) => {
    const saved = JSON.stringify({
      version: 3,
      state: {
        activeStage: "discover",
        configs: {
          discover: { dryRun, limit: "42", discoverySourceIds: ["jobspy:indeed"] },
          score: { dryRun: false },
          apply: { dryRun: false, limit: "17" },
        },
      },
    });
    window.localStorage.setItem(storageKey, saved);
    await useStageTriggerStore.persist.rehydrate();

    const state = useStageTriggerStore.getState();
    expect(useStageTriggerStore.persist.hasHydrated()).toBe(true);
    expect(state.configs.discover).toMatchObject({ dryRun, limit: "42", discoverySourceIds: ["jobspy:indeed"] });
    expect(state.configs.score.dryRun).toBe(false);
    expect(state.configs.apply).toMatchObject({ dryRun: false, limit: "17" });
    expect(state.storageRecoveryRequired).toBe(false);
    expect(window.localStorage.getItem(storageKey)).toBe(saved);
  });

  it("retains the safe mode and saved fields in a legacy partial record", async () => {
    window.localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      state: {
        activeStage: "discover",
        configs: { discover: { discoverySourceId: "jobspy:linkedin", workers: "7" }, apply: { dryRun: false } },
      },
    }));
    await useStageTriggerStore.persist.rehydrate();

    const state = useStageTriggerStore.getState();
    expect(useStageTriggerStore.persist.hasHydrated()).toBe(true);
    expect(state.configs.discover).toMatchObject({ dryRun: true, discoverySourceIds: ["jobspy:linkedin"], workers: "7" });
    expect(state.internalConcurrency).toBe("7");
    expect(state.configs.apply.dryRun).toBe(false);
  });

  it.each([
    ["null envelope", "null"],
    ["string envelope", JSON.stringify("unreadable")],
    ["null state", JSON.stringify({ version: 3, state: null })],
    ["string state", JSON.stringify({ version: 3, state: "unreadable" })],
    ["null configs", JSON.stringify({ version: 3, state: { configs: null } })],
    ["string configs", JSON.stringify({ version: 3, state: { configs: "unreadable" } })],
    ["missing Discover", JSON.stringify({ version: 3, state: { configs: { apply: { dryRun: false } } } })],
    ["invalid JSON", "{"],
  ])("recovers safely from %s without replacing it automatically", async (_label, saved) => {
    window.localStorage.setItem(storageKey, saved);
    await useStageTriggerStore.persist.rehydrate();

    expect(useStageTriggerStore.persist.hasHydrated()).toBe(true);
    expect(useStageTriggerStore.getState().configs.discover.dryRun).toBe(true);
    expect(useStageTriggerStore.getState().storageRecoveryRequired).toBe(true);
    expect(window.localStorage.getItem(storageKey)).toBe(saved);
    useStageTriggerStore.getState().setInternalConcurrency("3");
    useStageTriggerStore.getState().patchStageConfig("discover", { limit: "42" });
    expect(window.localStorage.getItem(storageKey)).toBe(saved);

    useStageTriggerStore.getState().patchStageConfig("discover", { dryRun: false });
    expect(useStageTriggerStore.getState().storageRecoveryRequired).toBe(false);
    const recovered = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as {
      state: { configs: { discover: { dryRun: boolean; limit: string }; apply: { dryRun: boolean } } };
    };
    expect(recovered.state.configs.discover).toMatchObject({ dryRun: false, limit: "42" });
    expect(recovered.state.configs.apply.dryRun).toBe(_label === "missing Discover" ? false : true);
    await useStageTriggerStore.persist.rehydrate();
    expect(useStageTriggerStore.persist.hasHydrated()).toBe(true);
    expect(useStageTriggerStore.getState().configs.discover.dryRun).toBe(false);
  });

  it("treats unavailable storage as unreadable and completes hydration", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => { throw new Error("storage unavailable"); },
    });
    try {
      await useStageTriggerStore.persist.rehydrate();
      expect(useStageTriggerStore.persist.hasHydrated()).toBe(true);
      expect(useStageTriggerStore.getState().configs.discover.dryRun).toBe(true);
      expect(useStageTriggerStore.getState().configs.apply.dryRun).toBe(true);
      expect(useStageTriggerStore.getState().storageRecoveryRequired).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
    }
  });
});
