import type { TailoringPolicyRevisionListResponse, TailoringPolicyRollbackRequest, TailoringPolicyRollbackResponse } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { sampleTailoringPolicyRevisionList, sampleTailoringPolicyRollback } from "../../../test/fixtures/learning.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { learningKeys } from "../../operations/learningKeys.js";
import { useRollbackTailoringPolicyMutation } from "./useRollbackTailoringPolicyMutation.js";

const command: TailoringPolicyRollbackRequest = {
  targetVersion: 1, expectedCurrentVersion: 4,
  commandId: "11111111-1111-4111-8111-111111111111", reasonCode: "user_requested",
};

describe("useRollbackTailoringPolicyMutation", () => {
  it("never presents a pending or delayed replay as the current policy", async () => {
    let resolve: ((response: TailoringPolicyRollbackResponse) => void) | undefined;
    const rollbackTailoringPolicy = vi.fn(() => new Promise<TailoringPolicyRollbackResponse>((done) => { resolve = done; }));
    const { result, queryClient } = renderHookWithProviders(
      () => useRollbackTailoringPolicyMutation(),
      { ports: buildTestPorts({ api: { rollbackTailoringPolicy } }) },
    );
    const key = learningKeys.policyRevisionList(LOCAL_TENANT, { page: 1, pageSize: 100 });
    const head = { ...sampleTailoringPolicyRevisionList, revisions: [
      { ...sampleTailoringPolicyRevisionList.revisions[0]!, version: 6, status: "current" as const },
      ...sampleTailoringPolicyRevisionList.revisions.map((revision) => ({ ...revision, status: "superseded" as const })),
    ] };
    queryClient.setQueryData(key, head);
    act(() => result.current.mutate(command));
    await waitFor(() => expect(rollbackTailoringPolicy).toHaveBeenCalledWith(command));
    expect(queryClient.getQueryData<TailoringPolicyRevisionListResponse>(key)).toEqual(head);
    act(() => resolve?.({ ...sampleTailoringPolicyRollback, status: "superseded", currentVersion: 6, replayed: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData<TailoringPolicyRevisionListResponse>(key)).toEqual(head);
  });
});
