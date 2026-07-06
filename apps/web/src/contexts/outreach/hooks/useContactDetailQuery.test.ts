import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useContactDetailQuery } from "./useContactDetailQuery.js";

describe("useContactDetailQuery", () => {
  it("returns the mocked contact detail with provenance", async () => {
    const { result } = renderHookWithProviders(() => useContactDetailQuery("contact-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.contact.contactId).toBe("contact-1");
    expect(result.current.data?.contact.attributes[0]?.provenance.sourceKind).toBeTruthy();
  });

  it("stays idle when no contactId is provided", () => {
    const { result } = renderHookWithProviders(() => useContactDetailQuery(""));
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
  });

  it("reports an error when the detail request fails", async () => {
    server.use(
      http.get("*/v1/contacts/:contactId", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useContactDetailQuery("contact-1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
