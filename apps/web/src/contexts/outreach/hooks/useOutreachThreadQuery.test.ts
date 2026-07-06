import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeOutreachThreadResponse } from "../../../test/fixtures/outreach.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useOutreachThreadQuery } from "./useOutreachThreadQuery.js";

describe("useOutreachThreadQuery", () => {
  it("returns the mocked thread with its drafts, gate results, and provenance", async () => {
    const { result } = renderHookWithProviders(() =>
      useOutreachThreadQuery({ contactId: "contact-1" }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.thread?.threadId).toBe("thread-1");
    expect(result.current.data?.thread?.drafts.length).toBeGreaterThan(0);
    expect(result.current.data?.thread?.drafts[0]?.gateResults).toBeTruthy();
  });

  it("returns a null thread when the contact has no drafts yet", async () => {
    server.use(
      http.get("*/v1/contacts/:contactId/outreach", () =>
        HttpResponse.json(makeOutreachThreadResponse(null)),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useOutreachThreadQuery({ contactId: "contact-1" }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.thread).toBeNull();
  });

  it("stays idle when no contactId is provided", () => {
    const { result } = renderHookWithProviders(() => useOutreachThreadQuery({ contactId: "" }));
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
  });
});
