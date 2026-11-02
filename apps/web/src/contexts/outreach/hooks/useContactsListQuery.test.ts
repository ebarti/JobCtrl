import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { applyPartialQueryPatch } from "../../../shared/lib/createOptimisticMutation.js";
import { createTestQueryClient } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { contactsListQuery, prefetchContactsList } from "../readQueries.js";
import { outreachKeys } from "../queryKeys.js";
import { makeContactListResponse, makeContactSummary } from "../../../test/fixtures/contacts.js";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useContactsListQuery } from "./useContactsListQuery.js";

describe("useContactsListQuery", () => {
  it("keeps a publication made after the first read began without rejecting a joined loader", async () => {
    let resolveRead!: (value: ReturnType<typeof makeContactListResponse>) => void;
    const listContacts = vi.fn(() => new Promise<ReturnType<typeof makeContactListResponse>>((resolve) => { resolveRead = resolve; }));
    const queryClient = createTestQueryClient();
    const ports = buildTestPorts({ api: { listContacts } });
    const filters = { employer: "Synthetic" };
    const key = outreachKeys.contactList(LOCAL_TENANT, filters);
    const { result } = renderHookWithProviders(() => useContactsListQuery(filters), { queryClient, ports });
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(1));
    const loader = queryClient.ensureQueryData(contactsListQuery({ queryClient, ports, tenantId: LOCAL_TENANT }, filters));
    const old = makeContactListResponse([makeContactSummary({ employer: "Synthetic", displayName: "Before publication" })]);
    const accepted = makeContactListResponse([makeContactSummary({ employer: "Synthetic", displayName: "Accepted publication" })]);
    act(() => queryClient.setQueryData(key, accepted));
    await act(async () => {
      resolveRead(old);
      await expect(loader).resolves.toEqual(old);
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(queryClient.getQueryData(key)).toEqual(accepted);
    expect(result.current.data).toEqual(accepted);
    expect(listContacts).toHaveBeenCalledTimes(1);
  });

  it("keeps the refresh error when a superseded read retains a later partial publication", async () => {
    let resolveRead!: (value: ReturnType<typeof makeContactListResponse>) => void;
    const listContacts = vi.fn<() => Promise<ReturnType<typeof makeContactListResponse>>>()
      .mockRejectedValueOnce(new Error("Synthetic failed refresh"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }))
      .mockResolvedValueOnce(makeContactListResponse([makeContactSummary({ displayName: "Fresh read" })]));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, {});
    const original = makeContactListResponse([makeContactSummary({ displayName: "Before publication" })]);
    queryClient.setQueryData(key, original);
    const { result } = renderHookWithProviders(() => useContactsListQuery(), { queryClient, ports: buildTestPorts({ api: { listContacts } }) });
    expect(result.current.data).toEqual(original);
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.isRefetchError).toBe(false);
    await act(async () => { await result.current.refetch(); });
    expect(queryClient.getQueryState(key)?.status).toBe("error");
    await waitFor(() => expect(result.current.isRefetchError).toBe(true));
    let refetch!: ReturnType<typeof result.current.refetch>;
    act(() => { refetch = result.current.refetch(); });
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.fetchStatus).toBe("fetching"));
    const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })!;
    const accepted = makeContactListResponse([makeContactSummary({ displayName: "Accepted partial" })]);
    act(() => applyPartialQueryPatch(queryClient, query, () => accepted));
    await waitFor(() => expect(result.current.data).toEqual(accepted));
    expect(result.current.isRefetchError).toBe(true);
    await act(async () => {
      resolveRead(original);
      await refetch;
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(result.current.data).toEqual(accepted);
    expect(result.current.isRefetchError).toBe(true);
    expect(query.state.isInvalidated).toBe(true);
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.isRefetchError).toBe(false));
    expect(result.current.data?.items[0]?.displayName).toBe("Fresh read");
  });

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
