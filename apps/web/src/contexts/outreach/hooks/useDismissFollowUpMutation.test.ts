import type { OutreachThreadResponse } from "@jobctl/contracts";
import { LOCAL_TENANT } from "@jobctl/domain-types";
import type { QueryClient } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import {
  makeOutreachFollowUp,
  makeOutreachThreadDetail,
  makeOutreachThreadResponse,
} from "../../../test/fixtures/outreach.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { outreachKeys } from "../queryKeys.js";
import { useDismissFollowUpMutation } from "./useDismissFollowUpMutation.js";

function followUp(queryClient: QueryClient) {
  const data = queryClient.getQueryData(
    outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
  ) as OutreachThreadResponse | undefined;
  return data?.thread?.followUp;
}

function scheduledThread() {
  return makeOutreachThreadResponse(
    makeOutreachThreadDetail({ followUp: makeOutreachFollowUp({ state: "scheduled" }) }),
  );
}

describe("useDismissFollowUpMutation", () => {
  it("optimistically dismisses the scheduled follow-up", async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useDismissFollowUpMutation("thread-1", "contact-1"),
    );
    queryClient.setQueryData(
      outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
      scheduledThread(),
    );
    await act(async () => {
      result.current.mutate();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(followUp(queryClient)?.state).toBe("dismissed");
  });

  it("rolls back to scheduled when the POST fails", async () => {
    server.use(
      http.post("*/v1/outreach/threads/:threadId/follow-up/dismiss", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useDismissFollowUpMutation("thread-1", "contact-1"),
    );
    queryClient.setQueryData(
      outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
      scheduledThread(),
    );
    await act(async () => {
      result.current.mutate();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(followUp(queryClient)?.state).toBe("scheduled");
  });
});
