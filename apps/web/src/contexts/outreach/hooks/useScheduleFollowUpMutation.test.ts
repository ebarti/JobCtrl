import type { OutreachThreadResponse } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import type { QueryClient } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { makeOutreachThreadResponse } from "../../../test/fixtures/outreach.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { outreachKeys } from "../queryKeys.js";
import { useScheduleFollowUpMutation } from "./useScheduleFollowUpMutation.js";

function followUp(queryClient: QueryClient) {
  const data = queryClient.getQueryData(
    outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
  ) as OutreachThreadResponse | undefined;
  return data?.thread?.followUp;
}

describe("useScheduleFollowUpMutation", () => {
  it("optimistically schedules the follow-up with the requested due date", async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useScheduleFollowUpMutation("thread-1", "contact-1"),
    );
    queryClient.setQueryData(
      outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
      makeOutreachThreadResponse(),
    );
    await act(async () => {
      result.current.mutate({ dueAt: "2026-07-20" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(followUp(queryClient)?.state).toBe("scheduled");
    expect(followUp(queryClient)?.dueAt).toBe("2026-07-20");
  });

  it("rolls back the optimistic schedule when the POST fails", async () => {
    server.use(
      http.post("*/v1/outreach/threads/:threadId/follow-up/schedule", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useScheduleFollowUpMutation("thread-1", "contact-1"),
    );
    queryClient.setQueryData(
      outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
      makeOutreachThreadResponse(),
    );
    await act(async () => {
      result.current.mutate({ dueAt: "2026-07-20" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(followUp(queryClient)).toBeNull();
  });
});
