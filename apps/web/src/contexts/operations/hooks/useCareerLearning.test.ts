import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  CareerLearningCommand,
  CareerLearningResponse,
} from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";

import { careerLearningFixture } from "../../../test/fixtures/career-learning.js";
import {
  createTestQueryClient,
  renderHookWithProviders,
} from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { evidenceMapKeys } from "../evidenceMapKeys.js";
import { profileKeys } from "../queryKeys.js";
import {
  useCareerLearningMutation,
  useCareerLearningQuery,
} from "./useCareerLearning.js";

describe("career learning ownership and rollback", () => {
  it("optimistically patches activity, rolls it back on failure and retains the accepted comparison", async () => {
    const previous = careerLearningFixture();
    const client = createTestQueryClient();
    const key = evidenceMapKeys.learning(LOCAL_TENANT);
    client.setQueryData(key, previous);
    let reject!: (error: Error) => void;
    const write = vi.fn(
      (_command: CareerLearningCommand) =>
        new Promise<CareerLearningResponse>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const { result } = renderHookWithProviders(
      () => useCareerLearningMutation(),
      {
        queryClient: client,
        ports: buildTestPorts({ api: { writeCareerLearning: write } }),
      },
    );
    const command = {
      action: "update" as const,
      milestoneId: previous.milestones[0]!.milestoneId,
      expectedRevision: 1,
      status: "completed" as const,
      completionEvidence: "Owned report",
    };
    act(() => result.current.mutate(command));
    await waitFor(() =>
      expect(
        client.getQueryData<CareerLearningResponse>(key)?.milestones[0]?.status,
      ).toBe("completed"),
    );
    expect(client.getQueryData<CareerLearningResponse>(key)?.cohorts).toEqual(
      previous.cohorts,
    );
    act(() => reject(new Error("revision_conflict")));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(key)).toEqual(previous);
  });

  it("installs the canonical write response without changing the profile cache", async () => {
    const response = careerLearningFixture();
    response.milestones[0]!.revision = 2;
    response.milestones[0]!.status = "completed";
    const client = createTestQueryClient();
    client.setQueryData(profileKeys.profile(LOCAL_TENANT), { untouched: true });
    const { result } = renderHookWithProviders(
      () => useCareerLearningMutation(),
      {
        queryClient: client,
        ports: buildTestPorts({
          api: { writeCareerLearning: async () => response },
        }),
      },
    );
    await act(async () => {
      await result.current.mutateAsync({
        action: "update",
        milestoneId: response.milestones[0]!.milestoneId,
        expectedRevision: 1,
        status: "completed",
        completionEvidence: "Owned report",
      });
    });
    expect(client.getQueryData(evidenceMapKeys.learning(LOCAL_TENANT))).toEqual(
      response,
    );
    expect(client.getQueryData(profileKeys.profile(LOCAL_TENANT))).toEqual({
      untouched: true,
    });
  });

  it("reads only through the API port", async () => {
    const read = vi.fn(async () => careerLearningFixture());
    const ports = buildTestPorts({ api: { careerLearning: read } });
    const { result } = renderHookWithProviders(() => useCareerLearningQuery(), {
      ports,
    });
    await waitFor(() => expect(result.current.data?.cohorts).toHaveLength(1));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not read the local worker when the demo capability is unavailable", () => {
    const read = vi.fn(async () => careerLearningFixture());
    const base = buildTestPorts({ api: { careerLearning: read } });
    const ports = {
      ...base,
      featureFlags: {
        get<T extends boolean | string | number>(key: string, fallback: T): T {
          return (key === "demoMode" ? true : fallback) as T;
        },
      },
    };
    const { result } = renderHookWithProviders(() => useCareerLearningQuery(), {
      ports,
    });
    expect(result.current.availability.available).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});
