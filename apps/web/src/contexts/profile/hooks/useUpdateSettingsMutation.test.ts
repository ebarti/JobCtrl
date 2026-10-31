import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { createTestQueryClient, renderHookWithProviders } from "../../../test/render.js";
import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { profileKeys } from "../queryKeys.js";
import { useUpdateSettingsMutation } from "./useUpdateSettingsMutation.js";
import { useSettingsQuery } from "./useSettingsQuery.js";

describe("useUpdateSettingsMutation", () => {
  it("returns the mocked settings response after submit", async () => {
    const { result } = renderHookWithProviders(() => useUpdateSettingsMutation());
    await act(async () => {
      result.current.mutate({ dailyBudgetUsd: 30 });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.settings.dailyBudgetUsd).toBe(25);
  });

  it("rolls back the optimistic settings when the PATCH fails", async () => {
    server.use(
      http.patch("*/v1/settings", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useUpdateSettingsMutation());
    queryClient.setQueryData(profileKeys.settings(LOCAL_TENANT), sampleSettingsResponse);

    await act(async () => {
      result.current.mutate({ dailyBudgetUsd: 999 });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = queryClient.getQueryData(profileKeys.settings(LOCAL_TENANT)) as {
      settings: { dailyBudgetUsd: number };
    };
    expect(restored.settings.dailyBudgetUsd).toBe(25);
  });
});

it("preserves a newer canonical settings publication when an older write and reconciliation fail", async () => {
  let rejectWrite!: () => void;
  let writes = 0;
  let reads = 0;
  server.use(
    http.patch("*/v1/settings", async () => {
      writes += 1;
      await new Promise<void>((resolve) => { rejectWrite = resolve; });
      return HttpResponse.json({ ok: false }, { status: 500 });
    }),
    http.get("*/v1/settings", () => {
      reads += 1;
      return HttpResponse.json({ ok: false }, { status: 500 });
    }),
  );
  const queryClient = createTestQueryClient();
  const key = profileKeys.settings(LOCAL_TENANT);
  queryClient.setQueryData(key, sampleSettingsResponse);
  const { result } = renderHookWithProviders(() => ({
    mutation: useUpdateSettingsMutation(),
    settings: useSettingsQuery(),
  }), { queryClient });

  act(() => result.current.mutation.mutate({ dailyBudgetUsd: 40 }));
  await waitFor(() => expect(writes).toBe(1));
  expect(result.current.settings.data?.settings.dailyBudgetUsd).toBe(40);
  const newer = {
    ...sampleSettingsResponse,
    settings: { ...sampleSettingsResponse.settings, dailyBudgetUsd: 60, applyConcurrency: 5 },
    effectiveSettings: {
      ...sampleSettingsResponse.effectiveSettings,
      dailyBudgetUsd: { ...sampleSettingsResponse.effectiveSettings.dailyBudgetUsd, value: 60 },
      applyConcurrency: { ...sampleSettingsResponse.effectiveSettings.applyConcurrency, value: 5 },
    },
  };
  act(() => queryClient.setQueryData(key, newer));
  act(() => rejectWrite());
  await waitFor(() => expect(result.current.mutation.isError).toBe(true));
  await waitFor(() => expect(reads).toBeGreaterThan(0));
  await waitFor(() => expect(result.current.settings.isRefetchError).toBe(true));
  expect(result.current.settings.data).toEqual(newer);
});

it("rolls back only the failed settings edit when an overlapping independent edit succeeds", async () => {
  let releaseOld!: () => void;
  let oldWrites = 0;
  let newWrites = 0;
  let failedReads = 0;
  server.use(
    http.patch("*/v1/settings", async ({ request }) => {
      const body = await request.json() as { dailyBudgetUsd?: number; applyConcurrency?: number };
      if (body.dailyBudgetUsd === 40) {
        oldWrites += 1;
        await new Promise<void>((resolve) => { releaseOld = resolve; });
        return HttpResponse.json({ ok: false }, { status: 500 });
      }
      newWrites += 1;
      return HttpResponse.json({ ...sampleSettingsResponse, settings: { ...sampleSettingsResponse.settings, applyConcurrency: body.applyConcurrency } });
    }),
    http.get("*/v1/settings", () => {
      failedReads += 1;
      return HttpResponse.json({ ok: false }, { status: 500 });
    }),
  );
  const queryClient = createTestQueryClient();
  const key = profileKeys.settings(LOCAL_TENANT);
  queryClient.setQueryData(key, sampleSettingsResponse);
  const { result } = renderHookWithProviders(() => ({
    old: useUpdateSettingsMutation(),
    newer: useUpdateSettingsMutation(),
    settings: useSettingsQuery(),
  }), { queryClient });

  act(() => result.current.old.mutate({ dailyBudgetUsd: 40 }));
  await waitFor(() => expect(oldWrites).toBe(1));
  act(() => result.current.newer.mutate({ applyConcurrency: 5 }));
  await waitFor(() => expect(newWrites).toBe(1));
  await waitFor(() => expect(result.current.newer.isSuccess).toBe(true));
  expect(failedReads).toBe(0);
  expect(result.current.settings.data?.settings).toMatchObject({ dailyBudgetUsd: 40, applyConcurrency: 5 });
  act(() => releaseOld());
  await waitFor(() => expect(result.current.old.isError).toBe(true));
  await waitFor(() => expect(failedReads).toBeGreaterThan(0));
  await waitFor(() => expect(result.current.settings.isRefetchError).toBe(true));
  expect(result.current.settings.data?.settings).toMatchObject({ dailyBudgetUsd: 25, applyConcurrency: 5 });
  expect(result.current.settings.data?.effectiveSettings.dailyBudgetUsd.value).toBe(25);
  expect(result.current.settings.data?.effectiveSettings.applyConcurrency.value).toBe(5);
});

for (const failFirst of ["old", "newer"] as const) {
  it.each(["success", "failure"] as const)(`defers the failed ${failFirst} write's read while its peer is pending and ends in %s`, async (outcome) => {
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    let oldWrites = 0;
    let newWrites = 0;
    let reads = 0;
    server.use(
      http.patch("*/v1/settings", async ({ request }) => {
        const body = await request.json() as { dailyBudgetUsd?: number };
        const operation = body.dailyBudgetUsd === 40 ? "old" : "newer";
        if (operation === "old") {
          oldWrites += 1;
          await new Promise<void>((resolve) => { releaseOld = resolve; });
        } else {
          newWrites += 1;
          await new Promise<void>((resolve) => { releaseNew = resolve; });
        }
        if (operation === failFirst || outcome === "failure") return HttpResponse.json({ ok: false }, { status: 500 });
        const dailyBudgetUsd = operation === "old" ? 40 : 25;
        const applyConcurrency = operation === "newer" ? 5 : 2;
        return HttpResponse.json({
          ...sampleSettingsResponse,
          settings: { ...sampleSettingsResponse.settings, dailyBudgetUsd, applyConcurrency },
          effectiveSettings: {
            ...sampleSettingsResponse.effectiveSettings,
            dailyBudgetUsd: { ...sampleSettingsResponse.effectiveSettings.dailyBudgetUsd, value: dailyBudgetUsd },
            applyConcurrency: { ...sampleSettingsResponse.effectiveSettings.applyConcurrency, value: applyConcurrency },
          },
        });
      }),
      http.get("*/v1/settings", () => {
        reads += 1;
        return HttpResponse.json({ ok: false }, { status: 500 });
      }),
    );
    const queryClient = createTestQueryClient();
    const key = profileKeys.settings(LOCAL_TENANT);
    queryClient.setQueryData(key, sampleSettingsResponse);
    const { result } = renderHookWithProviders(() => ({
      old: useUpdateSettingsMutation(), newer: useUpdateSettingsMutation(), settings: useSettingsQuery(),
    }), { queryClient });

    act(() => result.current.old.mutate({ dailyBudgetUsd: 40 }));
    await waitFor(() => expect(oldWrites).toBe(1));
    act(() => result.current.newer.mutate({ applyConcurrency: 5 }));
    await waitFor(() => expect(newWrites).toBe(1));
    act(() => { if (failFirst === "old") releaseOld(); else releaseNew(); });
    await waitFor(() => expect(result.current[failFirst].isError).toBe(true));
    const stillPending = failFirst === "old" ? "newer" : "old";
    expect(reads).toBe(0);
    expect(result.current.settings.data?.settings).toMatchObject({
      dailyBudgetUsd: stillPending === "old" ? 40 : 25,
      applyConcurrency: stillPending === "newer" ? 5 : 2,
    });
    act(() => { if (stillPending === "old") releaseOld(); else releaseNew(); });
    await waitFor(() => expect(result.current[stillPending].status).toBe(outcome === "success" ? "success" : "error"));
    await waitFor(() => expect(result.current.settings.isRefetchError).toBe(true));
    expect(reads).toBeGreaterThan(0);
    const settings = result.current.settings.data!;
    const expectedBudget = outcome === "success" && stillPending === "old" ? 40 : 25;
    const expectedConcurrency = outcome === "success" && stillPending === "newer" ? 5 : 2;
    expect(settings.settings).toMatchObject({ dailyBudgetUsd: expectedBudget, applyConcurrency: expectedConcurrency });
    expect(settings.effectiveSettings.dailyBudgetUsd.value).toBe(expectedBudget);
    expect(settings.effectiveSettings.applyConcurrency.value).toBe(expectedConcurrency);
  });
}

it("keeps a later independent same-field write after a committed pending save and a failed refresh", async () => {
  let releaseOld!: () => void;
  let releaseNew!: () => void;
  let oldWrites = 0;
  let newWrites = 0;
  let reads = 0;
  const committed = {
    ...sampleSettingsResponse,
    settings: { ...sampleSettingsResponse.settings, applyConcurrency: 5 },
    effectiveSettings: {
      ...sampleSettingsResponse.effectiveSettings,
      applyConcurrency: { ...sampleSettingsResponse.effectiveSettings.applyConcurrency, value: 5 },
    },
  };
  const canonical = {
    ...sampleSettingsResponse,
    settings: { ...sampleSettingsResponse.settings, dailyBudgetUsd: 60, applyConcurrency: 4 },
    effectiveSettings: {
      ...sampleSettingsResponse.effectiveSettings,
      dailyBudgetUsd: { ...sampleSettingsResponse.effectiveSettings.dailyBudgetUsd, value: 60 },
      applyConcurrency: { ...sampleSettingsResponse.effectiveSettings.applyConcurrency, value: 4 },
    },
  };
  let serverValue = sampleSettingsResponse;
  server.use(
    http.patch("*/v1/settings", async ({ request }) => {
      const body = await request.json() as { dailyBudgetUsd?: number };
      if (body.dailyBudgetUsd === 40) {
        oldWrites += 1;
        await new Promise<void>((resolve) => { releaseOld = resolve; });
        return HttpResponse.json({ ok: false }, { status: 500 });
      }
      newWrites += 1;
      serverValue = committed;
      await new Promise<void>((resolve) => { releaseNew = resolve; });
      return HttpResponse.json(committed);
    }),
    http.get("*/v1/settings", () => {
      reads += 1;
      return reads === 1 ? HttpResponse.json(serverValue) : HttpResponse.json({ ok: false }, { status: 500 });
    }),
  );
  const queryClient = createTestQueryClient();
  const key = profileKeys.settings(LOCAL_TENANT);
  queryClient.setQueryData(key, sampleSettingsResponse);
  const { result } = renderHookWithProviders(() => ({
    old: useUpdateSettingsMutation(), newer: useUpdateSettingsMutation(), settings: useSettingsQuery(),
  }), { queryClient });
  act(() => result.current.old.mutate({ dailyBudgetUsd: 40 }));
  await waitFor(() => expect(oldWrites).toBe(1));
  act(() => result.current.newer.mutate({ applyConcurrency: 5 }));
  await waitFor(() => expect(newWrites).toBe(1));
  expect(serverValue.settings.applyConcurrency).toBe(5);
  act(() => releaseOld());
  await waitFor(() => expect(result.current.old.isError).toBe(true));
  expect(reads).toBe(0);
  // A distinct writer commits after the newer request, before its response.
  serverValue = canonical;
  void queryClient.refetchQueries({ queryKey: key, exact: true });
  await waitFor(() => expect(result.current.settings.data).toEqual(canonical));
  act(() => releaseNew());
  await waitFor(() => expect(result.current.newer.isSuccess).toBe(true));
  await waitFor(() => expect(result.current.settings.isRefetchError).toBe(true));
  expect(result.current.settings.data).toEqual(canonical);
});
