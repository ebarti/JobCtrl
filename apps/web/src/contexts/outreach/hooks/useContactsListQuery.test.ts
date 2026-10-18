import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { createTestQueryClient } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { prefetchContactsList } from "../readQueries.js";
import { outreachKeys } from "../queryKeys.js";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useContactsListQuery } from "./useContactsListQuery.js";

describe("useContactsListQuery", () => {
  it("reuses the loader cache, retains accepted data on failure and recovers", async () => {
    const ports = buildTestPorts();
    const queryClient = createTestQueryClient();
    queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 60_000, gcTime: Infinity },
    });
    const read = vi.spyOn(ports.api, "listContacts");
    await prefetchContactsList(
      { ports, queryClient, tenantId: LOCAL_TENANT },
      { employer: "Acme" },
    );
    const key = outreachKeys.contactList(LOCAL_TENANT, { employer: "Acme" });
    const accepted = queryClient.getQueryData(key);
    expect(accepted).toBeDefined();
    const { result } = renderHookWithProviders(
      () => useContactsListQuery({ employer: "Acme" }),
      {
        ports,
        queryClient,
      },
    );
    expect(result.current.data).toEqual(accepted);
    // Observe status before settlement so Query's tracked-property subscription
    // delivers a failed refresh even when accepted data is unchanged.
    expect(result.current.isError).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRejectedValueOnce(new Error("synthetic refresh failure"));
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toEqual(accepted);
    expect(queryClient.getQueryData(key)).toEqual(accepted);
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("returns the mocked contact list", async () => {
    const { result } = renderHookWithProviders(() => useContactsListQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      result.current.data?.items.map((contact) => contact.contactId),
    ).toContain("contact-1");
  });

  it("reports an error when the list request fails", async () => {
    server.use(
      http.get(
        "*/v1/contacts",
        () => new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useContactsListQuery());
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
