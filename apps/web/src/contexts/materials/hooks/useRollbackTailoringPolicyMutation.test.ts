import type {
  TailoringPolicyRevisionListResponse,
  TailoringPolicyRevisionSummary,
  TailoringPolicyRollbackResponse,
} from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { learningKeys } from "../../operations/learningKeys.js";
import { useRollbackTailoringPolicyMutation } from "./useRollbackTailoringPolicyMutation.js";

const original: TailoringPolicyRevisionSummary = {
  context: "materials",
  policyKind: "tailoring_rule",
  version: 1,
  status: "superseded",
  learnedRules: [],
  sourceReviewId: null,
  sourceRecommendationId: null,
  rollbackOfVersion: null,
  rollbackReasonCode: null,
  createdAt: "2026-08-01T10:00:00.000Z",
};

const learned: TailoringPolicyRevisionSummary = {
  ...original,
  version: 2,
  status: "current",
  learnedRules: [{ ruleKey: "fact_handling", ruleValue: "require_source_match" }],
  sourceReviewId: `learning-recommendation-review:${"b".repeat(64)}`,
  sourceRecommendationId: `learning-recommendation:${"a".repeat(64)}`,
  createdAt: "2026-08-01T11:00:00.000Z",
};

const pageInput = { page: 1, pageSize: 50 } as const;
const history: TailoringPolicyRevisionListResponse = {
  ok: true,
  revisions: [learned, original],
  page: 1,
  pageSize: 50,
  total: 2,
  totalPages: 1,
};

const rollback: TailoringPolicyRollbackResponse = {
  ok: true,
  context: "materials",
  policyKind: "tailoring_rule",
  version: 3,
  status: "current",
  learnedRules: [],
  sourceReviewId: null,
  sourceRecommendationId: null,
  rollbackOfVersion: 1,
  rollbackReasonCode: "user_requested",
  createdAt: "2026-08-01T12:00:00.000Z",
};

describe("useRollbackTailoringPolicyMutation", () => {
  it("patches the cached audit history with the exact rollback response", async () => {
    const rollbackTailoringPolicy = vi.fn(async () => rollback);
    const { result, queryClient } = renderHookWithProviders(
      () => useRollbackTailoringPolicyMutation(),
      { ports: buildTestPorts({ api: { rollbackTailoringPolicy } }) },
    );
    const key = learningKeys.policyRevisionList(LOCAL_TENANT, pageInput);
    queryClient.setQueryData(key, history);

    await act(async () => {
      await expect(result.current.mutateAsync(1)).resolves.toBe(rollback);
    });

    expect(rollbackTailoringPolicy).toHaveBeenCalledWith({ targetVersion: 1 });
    expect(queryClient.getQueryData<TailoringPolicyRevisionListResponse>(key)).toEqual({
      ...history,
      revisions: [
        {
          context: rollback.context,
          policyKind: rollback.policyKind,
          version: rollback.version,
          status: rollback.status,
          learnedRules: rollback.learnedRules,
          sourceReviewId: null,
          sourceRecommendationId: null,
          rollbackOfVersion: rollback.rollbackOfVersion,
          rollbackReasonCode: rollback.rollbackReasonCode,
          createdAt: rollback.createdAt,
        },
        { ...learned, status: "superseded" },
        original,
      ],
      total: 3,
      totalPages: 1,
    });
  });

  it("restores the exact cached history when rollback fails", async () => {
    let rejectRollback: ((error: Error) => void) | undefined;
    const rollbackTailoringPolicy = vi.fn(
      () =>
        new Promise<TailoringPolicyRollbackResponse>((_resolve, reject) => {
          rejectRollback = reject;
        }),
    );
    const { result, queryClient } = renderHookWithProviders(
      () => useRollbackTailoringPolicyMutation(),
      { ports: buildTestPorts({ api: { rollbackTailoringPolicy } }) },
    );
    const key = learningKeys.policyRevisionList(LOCAL_TENANT, pageInput);
    queryClient.setQueryData(key, history);

    act(() => result.current.mutate(1));
    await waitFor(() =>
      expect(
        queryClient.getQueryData<TailoringPolicyRevisionListResponse>(key)?.revisions[0],
      ).toMatchObject({ version: 3, status: "current", rollbackOfVersion: 1 }),
    );
    act(() => rejectRollback?.(new Error("rollback unavailable")));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData<TailoringPolicyRevisionListResponse>(key)).toEqual(history);
  });
});
