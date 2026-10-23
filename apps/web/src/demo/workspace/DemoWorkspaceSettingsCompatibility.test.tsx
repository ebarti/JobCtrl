import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { SettingsResponseSchema, type SettingsResponse } from "@jobctrl/contracts";

import { AiExecutionPolicyPanel } from "../../contexts/materials/components/AiExecutionPolicyPanel.js";
import { renderWithProviders } from "../../test/render.js";
import { sampleProviderModelsResponse } from "../../test/fixtures/projections.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { DemoApiClientAdapter } from "../DemoApiClientAdapter.js";
import { DemoWorkspaceRepository } from "./DemoWorkspaceRepository.js";
import type { DemoWorkspaceSnapshot } from "./contracts.js";
import { DemoWorkspaceStorageError, InMemoryDemoWorkspaceStore } from "./storage.js";

const clock = { now: () => new Date("2026-10-22T09:00:00.000Z") };
function repository(store: InMemoryDemoWorkspaceStore): DemoWorkspaceRepository {
  return new DemoWorkspaceRepository({
    store,
    clock,
    createWorkspaceId: () => "owned-retained-demo",
    channelFactory: { create: () => null },
  });
}

async function retainedSnapshot(): Promise<DemoWorkspaceSnapshot> {
  const builder = repository(new InMemoryDemoWorkspaceStore());
  await builder.initialize();
  await builder.mutate((draft, context) => {
    Object.assign(draft.state, { title: "Retained authored demo edit" });
    draft.state.readModel.settings.settings.dailyBudgetUsd = 17;
    context.putBlob("retained-preview", new Blob(["owned preview"]));
  });
  const snapshot = await builder.snapshot();
  builder.dispose();
  return snapshot;
}

function omitPolish(snapshot: DemoWorkspaceSnapshot): void {
  const response = snapshot.state.readModel.settings;
  delete (response.settings as Partial<SettingsResponse["settings"]>).resumeVoicePolish;
  delete (response.effectiveSettings as Partial<SettingsResponse["effectiveSettings"]>).resumeVoicePolish;
}

async function legacyWorkspace() {
  const saved = await retainedSnapshot();
  omitPolish(saved);
  const store = new InMemoryDemoWorkspaceStore(saved);
  await store.transact((_current, transaction) => {
    transaction.putBlob("retained-preview", new Blob(["owned preview"]));
  });
  const reopened = repository(store);
  return { saved, store, reopened };
}

const defaultPolish = { value: false, source: "default", activation: "next_workflow", editable: true };

describe("retained demo settings compatibility", () => {
  it.each([undefined, false, true])("retains cover-letter opt-in %s across reopening older saved settings", async (enabled) => {
    const saved = await retainedSnapshot();
    const response = saved.state.readModel.settings;
    delete (response.settings as Partial<SettingsResponse["settings"]>).coverLetterGeneration;
    delete (response.effectiveSettings as Partial<SettingsResponse["effectiveSettings"]>).coverLetterGeneration;
    if (enabled !== undefined) response.settings.coverLetterGeneration = enabled;
    const store = new InMemoryDemoWorkspaceStore(saved);
    const reopened = repository(store);
    await reopened.initialize();
    const current = SettingsResponseSchema.parse(await new DemoApiClientAdapter(reopened).settings());
    expect(current.settings.coverLetterGeneration).toBe(enabled ?? false);
    expect(current.effectiveSettings.coverLetterGeneration).toEqual({
      value: enabled ?? false, source: enabled === undefined ? "default" : "persisted", activation: "next_workflow", editable: true,
    });
    expect((await reopened.snapshot()).revision).toBe(saved.revision);
    expect(await store.readSnapshot()).toEqual(saved);
    reopened.dispose();
  });

  it("reopens current pre-flag state without changing identity, revision, edits, receipts or blobs", async () => {
    const { saved, store, reopened } = await legacyWorkspace();
    const expected = structuredClone(saved);
    Object.assign(expected.state.readModel.settings.settings, { resumeVoicePolish: false });
    Object.assign(expected.state.readModel.settings.effectiveSettings, { resumeVoicePolish: defaultPolish });
    const ready = await reopened.initialize();
    expect(ready).toMatchObject({ kind: "ready", snapshot: expected });
    expect(reopened.snapshotNow()).toEqual(expected);
    expect(await reopened.snapshot()).toEqual(expected);
    expect(await reopened.rereadAfterExternalChange()).toEqual(expected);
    expect(SettingsResponseSchema.parse(await new DemoApiClientAdapter(reopened).settings())).toEqual(expected.state.readModel.settings);
    expect(await reopened.blob("retained-preview")).toEqual(expect.objectContaining({ size: 13 }));
    expect(await store.readSnapshot()).toEqual(saved);
    reopened.dispose();
  });

  it.each([true, false])("keeps already recorded %s and its provenance exactly", async (enabled) => {
    const saved = await retainedSnapshot();
    saved.state.readModel.settings.settings.resumeVoicePolish = enabled;
    saved.state.readModel.settings.effectiveSettings.resumeVoicePolish = {
      value: enabled, source: "persisted", activation: "next_workflow", editable: true,
    };
    const reopened = repository(new InMemoryDemoWorkspaceStore(saved));
    await reopened.initialize();
    expect(await reopened.snapshot()).toEqual(saved);
    reopened.dispose();
  });

  it.each([
    [true, "settings"], [false, "settings"], [true, "effectiveSettings"], [false, "effectiveSettings"],
  ] as const)("fills only the missing %s counterpart in %s", async (enabled, missing) => {
    const saved = await retainedSnapshot();
    const response = saved.state.readModel.settings;
    response.settings.resumeVoicePolish = enabled;
    response.effectiveSettings.resumeVoicePolish = {
      value: enabled, source: "persisted", activation: "next_workflow", editable: true,
    };
    if (missing === "settings") {
      delete (response.settings as Partial<SettingsResponse["settings"]>).resumeVoicePolish;
    } else {
      delete (response.effectiveSettings as Partial<SettingsResponse["effectiveSettings"]>).resumeVoicePolish;
    }
    const reopened = repository(new InMemoryDemoWorkspaceStore(saved));
    await reopened.initialize();
    const current = SettingsResponseSchema.parse(await new DemoApiClientAdapter(reopened).settings());
    expect(current.settings.resumeVoicePolish).toBe(enabled);
    expect(current.effectiveSettings.resumeVoicePolish).toEqual({
      value: enabled, source: "persisted", activation: "next_workflow", editable: true,
    });
    expect((await reopened.snapshot()).revision).toBe(saved.revision);
    reopened.dispose();
  });

  it.each([null, undefined, "false", 0])("does not coerce a present malformed value %s", async (value) => {
    const saved = await retainedSnapshot();
    Object.assign(saved.state.readModel.settings.settings, { resumeVoicePolish: value });
    const reopened = repository(new InMemoryDemoWorkspaceStore(saved));
    await reopened.initialize();
    const response = await new DemoApiClientAdapter(reopened).settings();
    expect(response.settings.resumeVoicePolish).toBe(value);
    expect(SettingsResponseSchema.safeParse(response).success).toBe(false);
    reopened.dispose();
  });

  it.each([[true, false], [false, true]])("persists both subsequent boolean saves in order %s then %s", async (first, second) => {
    const { saved, store, reopened } = await legacyWorkspace();
    await reopened.initialize();
    const adapter = new DemoApiClientAdapter(reopened);
    let revision = saved.revision;
    for (const enabled of [first, second]) {
      const response = SettingsResponseSchema.parse(await adapter.updateSettings({ resumeVoicePolish: enabled }));
      expect(response.settings.resumeVoicePolish).toBe(enabled);
      expect(response.effectiveSettings.resumeVoicePolish).toEqual({
        value: enabled, source: "persisted", activation: "next_workflow", editable: true,
      });
      expect(await adapter.settings()).toEqual(response);
      const current = await store.readSnapshot();
      expect(current).toMatchObject({
        workspaceId: saved.workspaceId, revision: ++revision, resetEpoch: saved.resetEpoch,
        resetCount: saved.resetCount, createdAt: saved.createdAt,
      });
      expect(current?.state.title).toBe(saved.state.title);
      expect(current?.state.receipts).toEqual(saved.state.receipts);
      expect(current?.state.artifacts).toEqual(saved.state.artifacts);
      expect(await reopened.blob("retained-preview")).toEqual(expect.objectContaining({ size: 13 }));
    }
    reopened.dispose();
    const again = repository(store);
    await again.initialize();
    expect(SettingsResponseSchema.parse(await new DemoApiClientAdapter(again).settings()).settings.resumeVoicePolish).toBe(second);
    again.dispose();
  });

  it("normalizes the latest transaction state after an older tab writes missing fields", async () => {
    const { saved, store, reopened } = await legacyWorkspace();
    await reopened.initialize();
    await store.transact((_current, transaction) => {
      const external = structuredClone(saved);
      Object.assign(external.state, { title: "Other tab retained edit" });
      transaction.putSnapshot({ ...external, revision: saved.revision + 1 });
    });
    const refreshed = await reopened.rereadAfterExternalChange();
    expect(refreshed.state.readModel.settings.effectiveSettings.resumeVoicePolish).toEqual(defaultPolish);
    const result = await new DemoApiClientAdapter(reopened).updateSettings({ resumeVoicePolish: true });
    expect(SettingsResponseSchema.parse(result).effectiveSettings.resumeVoicePolish.value).toBe(true);
    expect((await reopened.snapshot()).state.title).toBe("Other tab retained edit");
    expect((await reopened.snapshot()).revision).toBe(saved.revision + 2);
    reopened.dispose();
  });

  it("keeps normalized settings when retained storage becomes unavailable", async () => {
    const { saved, store } = await legacyWorkspace();
    let unavailable = false;
    const reopened = new DemoWorkspaceRepository({
      store: {
        storageMode: "indexeddb",
        readSnapshot: () => unavailable ? Promise.reject(new DemoWorkspaceStorageError("unavailable")) : store.readSnapshot(),
        readBlob: (id) => store.readBlob(id), readAllBlobs: () => store.readAllBlobs(),
        transact: (operation) => store.transact(operation),
      }, clock, channelFactory: { create: () => null },
    });
    await reopened.initialize();
    unavailable = true;
    const fallback = await reopened.snapshot();
    expect(fallback).toMatchObject({ workspaceId: saved.workspaceId, revision: saved.revision, resetEpoch: saved.resetEpoch });
    expect(SettingsResponseSchema.parse(fallback.state.readModel.settings).effectiveSettings.resumeVoicePolish).toEqual(defaultPolish);
    expect(await reopened.blob("retained-preview")).toEqual(expect.objectContaining({ size: 13 }));
    reopened.dispose();
  });

  it("renders and saves true then false through the real reopened adapter", async () => {
    const { reopened } = await legacyWorkspace();
    await reopened.initialize();
    const adapter = new DemoApiClientAdapter(reopened);
    const user = userEvent.setup();
    renderWithProviders(<AiExecutionPolicyPanel />, { ports: buildTestPorts({ api: {
      settings: () => adapter.settings(), updateSettings: (body) => adapter.updateSettings(body),
      providerModels: async () => sampleProviderModelsResponse,
    } }) });
    const checkbox = await screen.findByRole("checkbox", { name: "Extra résumé polish" });
    expect(checkbox).toHaveAttribute("aria-checked", "false");
    for (const enabled of [true, false]) {
      await user.click(checkbox);
      const save = screen.getByRole("button", { name: "Save AI policy" });
      await waitFor(() => expect(save).toBeEnabled());
      await user.click(save);
      await waitFor(async () => expect((await adapter.settings()).settings.resumeVoicePolish).toBe(enabled));
      expect(SettingsResponseSchema.parse(await adapter.settings()).effectiveSettings.resumeVoicePolish.value).toBe(enabled);
      await waitFor(() => expect(save).toBeDisabled());
    }
    reopened.dispose();
  });
});
