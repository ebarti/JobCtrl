import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { createTestQueryClient, renderHookWithProviders } from "../../../test/render.js";
import { useReviseDraftMutation } from "./useReviseDraftMutation.js";

describe("useReviseDraftMutation", () => {
  it("revises the draft from edited text and returns the re-gated thread", async () => {
    const { result } = renderHookWithProviders(() =>
      useReviseDraftMutation("thread-1", "contact-1"),
    );
    await act(async () => {
      result.current.mutate({ editedBodyText: "Hi Dana, an edited intro message." });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.thread?.threadId).toBe("thread-1");
  });

  it("surfaces an error when the revision fails", async () => {
    server.use(
      http.post("*/v1/outreach/threads/:threadId/drafts", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useReviseDraftMutation("thread-1", "contact-1"),
    );
    await act(async () => {
      result.current.mutate({ editedBodyText: "Hi Dana, an edited intro message." });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

it("retains an explicit conflict and request variables without an automatic retry", async () => {
  const { makeOutreachPublicationConflict } = await import("../../../test/fixtures/outreach.js");
  const { JobCtrlApiError } = await import("@jobctrl/api-client");
  const queryClient = createTestQueryClient();
  queryClient.setDefaultOptions({ mutations: { retry: 2, retryDelay: 0 } });
  let calls = 0;
  server.use(http.post("*/v1/outreach/threads/:threadId/drafts", () => {
    calls += 1;
    return HttpResponse.json(makeOutreachPublicationConflict(), { status: 409 });
  }));
  const { result } = renderHookWithProviders(() => useReviseDraftMutation("thread-1", "contact-1"), { queryClient });
  act(() => result.current.mutate({ editedBodyText: "My retained message" }));
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.error).toBeInstanceOf(JobCtrlApiError);
  expect((result.current.error as InstanceType<typeof JobCtrlApiError>).responseBody).toMatchObject({ outcome: "conflict" });
  expect(result.current.variables?.editedBodyText).toBe("My retained message");
  expect(calls).toBe(1);
});

it("does not retry a revision after an ambiguous failure even when mutations retry by default", async () => {
  const queryClient = createTestQueryClient();
  queryClient.setDefaultOptions({ mutations: { retry: 2, retryDelay: 0 } });
  let calls = 0;
  server.use(http.post("*/v1/outreach/threads/:threadId/drafts", () => {
    calls += 1;
    return HttpResponse.json({ message: "Synthetic response unavailable" }, { status: 500 });
  }));
  const { result } = renderHookWithProviders(() => useReviseDraftMutation("thread-1", "contact-1"), { queryClient });
  act(() => result.current.mutate({ editedBodyText: "My retained message" }));
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.variables?.editedBodyText).toBe("My retained message");
  expect(calls).toBe(1);
});
