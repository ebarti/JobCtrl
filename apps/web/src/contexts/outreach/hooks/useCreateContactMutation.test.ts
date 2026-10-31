import type { ContactCreateRequest, ContactListResponse, ContactMutationResponse } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { useQuery } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { makeContactDetail, makeContactListResponse, makeContactMutationResponse, makeContactProvenance, makeContactSummary, sampleContactSummary } from "../../../test/fixtures/contacts.js";
import { server } from "../../../test/msw/server.js";
import { createTestQueryClient, renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { outreachKeys } from "../queryKeys.js";
import { contactListMayInclude, provisionalContactSummary } from "../lib/contact-patches.js";
import { useCreateContactMutation } from "./useCreateContactMutation.js";
import { useUpdateContactMutation } from "./useUpdateContactMutation.js";

const validCreate = {
  role: "recruiter" as const,
  employer: "Acme",
  attributes: [{ kind: "name" as const, value: "Jamie Lee" }],
};

describe("useCreateContactMutation", () => {
  it("uses distinct provisional identities without UUID support even in the same millisecond", () => {
    vi.stubGlobal("crypto", {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(123);
    try {
      expect(provisionalContactSummary(validCreate).contactId).not.toBe(provisionalContactSummary(validCreate).contactId);
    } finally {
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("skips only known disjoint filters and treats unrecognized filter shapes conservatively", () => {
    const prefix = outreachKeys.contactLists(LOCAL_TENANT);
    const contact = provisionalContactSummary({ ...validCreate, employer: "  Employer A  " });
    expect(contactListMayInclude(outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer A" }), prefix.length, contact)).toBe(true);
    expect(contactListMayInclude(outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer B" }), prefix.length, contact)).toBe(false);
    expect(contactListMayInclude(outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer B", futureFilter: true }), prefix.length, contact)).toBe(true);
    expect(contactListMayInclude([...prefix, { employer: 123 }], prefix.length, contact)).toBe(true);
  });

  it("lets an unrelated filtered contact update reconcile while a create stays pending", async () => {
    let rejectCreate!: (error: Error) => void;
    let finishEarlierRead!: (value: ContactListResponse) => void;
    let readsA = 0;
    let readsB = 0;
    const createContact = vi.fn(() => new Promise<ContactMutationResponse>((_resolve, reject) => { rejectCreate = reject; }));
    const before = makeContactSummary({ contactId: "contact-b", employer: "Employer B", displayName: "Before synthetic" });
    const after = { ...before, displayName: "After synthetic" };
    let serverB = makeContactListResponse([before]);
    const updateContact = vi.fn(async () => {
      serverB = makeContactListResponse([after]);
      return makeContactMutationResponse(makeContactDetail({ contactId: "contact-b", employer: "Employer B", displayName: "After synthetic" }));
    });
    const queryClient = createTestQueryClient();
    const keyA = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer A" });
    const keyB = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer B" });
    queryClient.setQueryData(keyA, makeContactListResponse([]));
    queryClient.setQueryData(keyB, serverB);
    const { result } = renderHookWithProviders(() => ({
      create: useCreateContactMutation(),
      update: useUpdateContactMutation(),
      listA: useQuery<ContactListResponse>({ queryKey: keyA, queryFn: async () => {
        readsA += 1;
        return makeContactListResponse([]);
      } }),
      listB: useQuery<ContactListResponse>({ queryKey: keyB, queryFn: async () => {
        readsB += 1;
        return readsB === 1 ? new Promise<ContactListResponse>((resolve) => { finishEarlierRead = resolve; }) : serverB;
      } }),
    }), { queryClient, ports: buildTestPorts({ api: { createContact, updateContact } }) });

    void queryClient.refetchQueries({ queryKey: keyB, exact: true });
    await waitFor(() => expect(readsB).toBe(1));
    act(() => result.current.create.mutate({ ...validCreate, employer: "  Employer A  " }));
    await waitFor(() => expect(createContact).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.create.isPending).toBe(true));
    expect(queryClient.getQueryState(keyB)?.fetchStatus).toBe("fetching");
    expect(queryClient.getQueryData<ContactListResponse>(keyA)?.items).toHaveLength(1);
    expect(queryClient.getQueryData<ContactListResponse>(keyB)?.items).toEqual([before]);
    act(() => finishEarlierRead(makeContactListResponse([before])));
    await waitFor(() => expect(result.current.listB.fetchStatus).toBe("idle"));

    act(() => result.current.update.mutate({ contactId: "contact-b", body: { attributes: [{ kind: "name", value: "After synthetic" }] } }));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.listB.data?.items[0]?.displayName).toBe("After synthetic"));
    expect(readsB).toBeGreaterThan(1);
    expect(readsA).toBe(0);
    expect(result.current.create.isPending).toBe(true);

    act(() => rejectCreate(new Error("Synthetic create failure")));
    await waitFor(() => expect(result.current.create.isError).toBe(true));
    expect(result.current.listB.data?.items[0]?.displayName).toBe("After synthetic");
  });

  it("optimistically prepends a provisional contact and resolves on success", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useCreateContactMutation());
    queryClient.setQueryData(
      outreachKeys.contactList(LOCAL_TENANT, {}),
      makeContactListResponse([sampleContactSummary]),
    );
    await act(async () => {
      result.current.mutate(validCreate);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("keeps the later provisional contact identity when an overlapping create fails", async () => {
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    let oldStarted = false;
    let newStarted = false;
    server.use(http.post("*/v1/contacts", async ({ request }) => {
      const body = await request.json() as { employer: string };
      if (body.employer === "Old Synthetic") {
        oldStarted = true;
        await new Promise<void>((resolve) => { releaseOld = resolve; });
      } else {
        newStarted = true;
        await new Promise<void>((resolve) => { releaseNew = resolve; });
      }
      return HttpResponse.json({ ok: false }, { status: 500 });
    }));
    const { result, queryClient } = renderHookWithProviders(() => ({
      old: useCreateContactMutation(), newer: useCreateContactMutation(),
    }));
    const key = outreachKeys.contactList(LOCAL_TENANT, {});
    queryClient.setQueryData(key, makeContactListResponse([sampleContactSummary]));
    act(() => result.current.old.mutate({ ...validCreate, employer: "Old Synthetic" }));
    await waitFor(() => expect(oldStarted).toBe(true));
    act(() => result.current.newer.mutate({ ...validCreate, employer: "New Synthetic" }));
    await waitFor(() => expect(newStarted).toBe(true));
    const before = queryClient.getQueryData<ContactListResponse>(key)!.items[0]!.contactId;
    act(() => releaseOld());
    await waitFor(() => expect(result.current.old.isError).toBe(true));
    const after = queryClient.getQueryData<ContactListResponse>(key)!.items[0]!.contactId;
    act(() => releaseNew());
    await waitFor(() => expect(result.current.newer.isError).toBe(true));
    expect(after).toBe(before);
    expect(queryClient.getQueryData<ContactListResponse>(key)!.items).toEqual([sampleContactSummary]);
  });

  it.each(["independent", "deferred-success", "deferred-failure"] as const)("does not duplicate a committed contact with a delayed response and %s reconciliation", async (mode) => {
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (value: ContactMutationResponse) => void;
    let committed = false;
    const response = makeContactMutationResponse(makeContactDetail({
      contactId: "contact-committed", displayName: "New synthetic", employer: "New Synthetic", jobId: null, attributes: [],
    }));
    const canonical = makeContactListResponse([makeContactSummary({
      contactId: response.contact.contactId, displayName: response.contact.displayName, employer: response.contact.employer,
      jobId: null, attributeCount: 0, confirmedCount: 0, sourceKinds: [], allConfirmed: false,
    }), sampleContactSummary]);
    const createContact = vi.fn((body: ContactCreateRequest) => {
      if (body.employer === "Old Synthetic") return new Promise<ContactMutationResponse>((_resolve, reject) => { rejectOld = reject; });
      committed = true;
      return new Promise<ContactMutationResponse>((resolve) => { resolveNew = resolve; });
    });
    let reads = 0;
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, {});
    queryClient.setQueryData(key, makeContactListResponse([sampleContactSummary]));
    const { result } = renderHookWithProviders(() => ({
      old: useCreateContactMutation(), newer: useCreateContactMutation(),
      query: useQuery<ContactListResponse>({ queryKey: key, queryFn: async () => {
        reads += 1;
        if (mode === "deferred-success" || (mode === "independent" && reads === 1)) return canonical;
        throw new Error("Synthetic reconciliation failure");
      } }),
    }), { queryClient, ports: buildTestPorts({ api: { createContact } }) });
    act(() => result.current.old.mutate({ ...validCreate, employer: "Old Synthetic" }));
    await waitFor(() => expect(createContact).toHaveBeenCalledTimes(1));
    act(() => result.current.newer.mutate({ ...validCreate, employer: "New Synthetic" }));
    await waitFor(() => expect(committed).toBe(true));
    const provisionalId = queryClient.getQueryData<ContactListResponse>(key)!.items[0]!.contactId;
    act(() => rejectOld(new Error("Synthetic older failure")));
    await waitFor(() => expect(result.current.old.isError).toBe(true));
    expect(reads).toBe(0);
    if (mode === "independent") {
      void queryClient.refetchQueries({ queryKey: key, exact: true });
      await waitFor(() => expect(result.current.query.data).toEqual(canonical));
    }
    act(() => resolveNew(response));
    await waitFor(() => expect(result.current.newer.isSuccess).toBe(true));
    if (mode === "deferred-success") {
      await waitFor(() => expect(result.current.query.data).toEqual(canonical));
    } else {
      await waitFor(() => expect(result.current.query.isRefetchError).toBe(true));
    }
    const matches = queryClient.getQueryData<ContactListResponse>(key)!.items.filter((item) => item.employer === "New Synthetic");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.contactId).toBe("contact-committed");
    expect(queryClient.getQueryData<ContactListResponse>(key)!.items.map((item) => item.contactId)).not.toContain(provisionalId);
  });

  it("reconciles the owned placeholder to the server identity in matching lists when later reads fail", async () => {
    let resolveCreate!: (value: ContactMutationResponse) => void;
    const createContact = vi.fn(() => new Promise<ContactMutationResponse>((resolve) => { resolveCreate = resolve; }));
    const response = makeContactMutationResponse(makeContactDetail({
      contactId: "contact-created-canonical", displayName: "Synthetic Name", employer: "New Synthetic", jobId: null,
      attributes: [
        { attributeId: "a", kind: "name", value: "Synthetic Name", provenance: makeContactProvenance() },
        { attributeId: "b", kind: "title", value: "Synthetic Role", provenance: makeContactProvenance({ sourceKind: "public_web_page", userConfirmed: false }) },
      ],
    }));
    const independent = makeContactSummary({ contactId: "other-contact", employer: "Other Synthetic" });
    const queryClient = createTestQueryClient();
    const allKey = outreachKeys.contactList(LOCAL_TENANT, {});
    const matchingKey = outreachKeys.contactList(LOCAL_TENANT, { employer: "New Synthetic" });
    const otherKey = outreachKeys.contactList(LOCAL_TENANT, { employer: "Other Synthetic" });
    queryClient.setQueryData(allKey, makeContactListResponse([independent]));
    queryClient.setQueryData(matchingKey, makeContactListResponse([]));
    queryClient.setQueryData(otherKey, makeContactListResponse([independent]));
    const failedRead = async () => { throw new Error("Synthetic reconciliation failure"); };
    const { result } = renderHookWithProviders(() => ({
      mutation: useCreateContactMutation(),
      all: useQuery<ContactListResponse>({ queryKey: allKey, queryFn: failedRead }),
      matching: useQuery<ContactListResponse>({ queryKey: matchingKey, queryFn: failedRead }),
      other: useQuery<ContactListResponse>({ queryKey: otherKey, queryFn: failedRead }),
    }), { queryClient, ports: buildTestPorts({ api: { createContact } }) });
    act(() => result.current.mutation.mutate({ ...validCreate, employer: "New Synthetic" }));
    await waitFor(() => expect(createContact).toHaveBeenCalledTimes(1));
    const provisionalId = result.current.all.data!.items[0]!.contactId;
    expect(result.current.matching.data?.items.map((item) => item.contactId)).toEqual([provisionalId]);
    expect(result.current.other.data?.items).toEqual([independent]);
    act(() => resolveCreate(response));
    await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.all.isRefetchError).toBe(true));
    await waitFor(() => expect(result.current.matching.isRefetchError).toBe(true));
    await waitFor(() => expect(result.current.other.isRefetchError).toBe(true));
    const created = result.current.matching.data!.items[0]!;
    expect(created).toMatchObject({
      contactId: "contact-created-canonical", displayName: "Synthetic Name", employer: "New Synthetic",
      attributeCount: 2, confirmedCount: 1, sourceKinds: ["user_entered", "public_web_page"], allConfirmed: false,
    });
    expect(result.current.all.data?.items).toContainEqual(created);
    expect(result.current.all.data?.items).toContainEqual(independent);
    expect(result.current.all.data?.items.map((item) => item.contactId)).not.toContain(provisionalId);
    expect(result.current.other.data?.items).toEqual([independent]);
  });

  it("removes only its placeholder when a newer canonical row with the returned identity is already present", async () => {
    let resolveCreate!: (value: ContactMutationResponse) => void;
    const createContact = vi.fn(() => new Promise<ContactMutationResponse>((resolve) => { resolveCreate = resolve; }));
    const response = makeContactMutationResponse(makeContactDetail({ contactId: "contact-created-canonical", employer: "New Synthetic", jobId: null }));
    const newer = makeContactSummary({ contactId: response.contact.contactId, employer: "New Synthetic", displayName: "Newer independent name" });
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, {});
    queryClient.setQueryData(key, makeContactListResponse([sampleContactSummary]));
    const { result } = renderHookWithProviders(() => ({
      mutation: useCreateContactMutation(),
      query: useQuery<ContactListResponse>({ queryKey: key, queryFn: async () => { throw new Error("Synthetic reconciliation failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { createContact } }) });
    act(() => result.current.mutation.mutate({ ...validCreate, employer: "New Synthetic" }));
    await waitFor(() => expect(createContact).toHaveBeenCalledTimes(1));
    const provisionalId = result.current.query.data!.items[0]!.contactId;
    act(() => queryClient.setQueryData<ContactListResponse>(key, (current) => ({ ...current!, items: [newer, ...current!.items] })));
    act(() => resolveCreate(response));
    await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.query.isRefetchError).toBe(true));
    const items = result.current.query.data!.items;
    expect(items.filter((item) => item.contactId === newer.contactId)).toEqual([newer]);
    expect(items.map((item) => item.contactId)).not.toContain(provisionalId);
    expect(items).toContainEqual(sampleContactSummary);
  });

  it("removes the placeholder from a filtered list when the server result no longer matches", async () => {
    let resolveCreate!: (value: ContactMutationResponse) => void;
    const createContact = vi.fn(() => new Promise<ContactMutationResponse>((resolve) => { resolveCreate = resolve; }));
    const response = makeContactMutationResponse(makeContactDetail({ contactId: "contact-created-canonical", employer: "Other Synthetic", jobId: null }));
    const queryClient = createTestQueryClient();
    const allKey = outreachKeys.contactList(LOCAL_TENANT, {});
    const filteredKey = outreachKeys.contactList(LOCAL_TENANT, { employer: "New Synthetic" });
    queryClient.setQueryData(allKey, makeContactListResponse([]));
    queryClient.setQueryData(filteredKey, makeContactListResponse([]));
    const { result } = renderHookWithProviders(() => ({
      mutation: useCreateContactMutation(),
      all: useQuery<ContactListResponse>({ queryKey: allKey, queryFn: async () => { throw new Error("Synthetic reconciliation failure"); } }),
      filtered: useQuery<ContactListResponse>({ queryKey: filteredKey, queryFn: async () => { throw new Error("Synthetic reconciliation failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { createContact } }) });
    act(() => result.current.mutation.mutate({ ...validCreate, employer: "New Synthetic" }));
    await waitFor(() => expect(createContact).toHaveBeenCalledTimes(1));
    expect(result.current.filtered.data?.items).toHaveLength(1);
    act(() => resolveCreate(response));
    await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.filtered.isRefetchError).toBe(true));
    expect(result.current.filtered.data?.items).toEqual([]);
    expect(result.current.all.data?.items.map((item) => item.contactId)).toEqual(["contact-created-canonical"]);
  });

  it("rolls back the provisional row when the POST fails", async () => {
    server.use(
      http.post("*/v1/contacts", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useCreateContactMutation());
    queryClient.setQueryData(
      outreachKeys.contactList(LOCAL_TENANT, {}),
      makeContactListResponse([sampleContactSummary]),
    );
    await act(async () => {
      result.current.mutate(validCreate);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = queryClient.getQueryData(
      outreachKeys.contactList(LOCAL_TENANT, {}),
    ) as ContactListResponse;
    expect(restored.items).toHaveLength(1);
    expect(restored.items[0]?.contactId).toBe(sampleContactSummary.contactId);
  });
});
