import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useContactsListQuery } from "./useContactsListQuery.js";

describe("useContactsListQuery", () => {
  it("returns the mocked contact list", async () => {
    const { result } = renderHookWithProviders(() => useContactsListQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items.map((contact) => contact.contactId)).toContain("contact-1");
  });

  it("reports an error when the list request fails", async () => {
    server.use(
      http.get("*/v1/contacts", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useContactsListQuery());
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
