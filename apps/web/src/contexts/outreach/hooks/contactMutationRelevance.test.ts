import type { ContactDeleteResponse, ContactDetailResponse, ContactListResponse, ContactMutationResponse, ContactUpdateRequest } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { useQuery } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { makeContactDetail, makeContactDetailResponse, makeContactListResponse, makeContactMutationResponse, makeContactSummary } from "../../../test/fixtures/contacts.js";
import { applyPartialQueryPatch } from "../../../shared/lib/createOptimisticMutation.js";
import { createTestQueryClient, renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { outreachKeys } from "../queryKeys.js";
import { useCreateContactMutation } from "./useCreateContactMutation.js";
import { useDeleteContactMutation } from "./useDeleteContactMutation.js";
import { useContactsListQuery } from "./useContactsListQuery.js";
import { useUpdateContactMutation } from "./useUpdateContactMutation.js";

const contactA = makeContactSummary({ contactId: "contact-a", employer: "Employer A", jobId: null, displayName: "A synthetic", role: "other" });
const contactB = makeContactSummary({ contactId: "contact-b", employer: "Employer B", jobId: null, displayName: "B before", role: "other" });

function detailFor(contact: typeof contactA) {
  return makeContactDetail({
    contactId: contact.contactId, employer: contact.employer, jobId: contact.jobId,
    displayName: contact.displayName, role: contact.role,
  });
}

describe("contact list response reconciliation", () => {
  it.each(["update", "delete"] as const)("publishes an independent success after an older %s and its readback fail", async (operation) => {
    let rejectOlder!: (error: Error) => void;
    let resolveNewer!: (value: ContactMutationResponse) => void;
    const updateContact = vi.fn((id: string) => id === contactA.contactId
      ? new Promise<ContactMutationResponse>((_resolve, reject) => { rejectOlder = reject; })
      : new Promise<ContactMutationResponse>((resolve) => { resolveNewer = resolve; }));
    const deleteContact = vi.fn(() => new Promise<ContactDeleteResponse>((_resolve, reject) => { rejectOlder = reject; }));
    const listContacts = vi.fn(async () => { throw new Error("Synthetic readback failure"); });
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, {});
    queryClient.setQueryData(key, makeContactListResponse([contactA, contactB]));
    const { result } = renderHookWithProviders(() => ({
      older: useUpdateContactMutation(), deletion: useDeleteContactMutation(), newer: useUpdateContactMutation(),
      list: useContactsListQuery(),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact, deleteContact, listContacts } }) });
    act(() => {
      if (operation === "update") result.current.older.mutate({ contactId: contactA.contactId, body: { role: "referrer" } });
      else result.current.deletion.mutate({ contactId: contactA.contactId });
    });
    await waitFor(() => expect(operation === "update" ? updateContact : deleteContact).toHaveBeenCalledTimes(1));
    act(() => result.current.newer.mutate({ contactId: contactB.contactId, body: { role: "hiring_manager" } }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(operation === "update" ? 2 : 1));
    act(() => rejectOlder(new Error("Synthetic older failure")));
    await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    expect(result.current.newer.isPending).toBe(true);
    act(() => resolveNewer(makeContactMutationResponse(detailFor({ ...contactB, role: "hiring_manager" }))));
    await waitFor(() => expect(result.current.newer.isSuccess).toBe(true));
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(2));
    expect(result.current.list.isRefetchError).toBe(true);
    expect(result.current.list.data?.items.find((item) => item.contactId === contactA.contactId)).toEqual(contactA);
    expect(result.current.list.data?.items.find((item) => item.contactId === contactB.contactId)?.role).toBe("hiring_manager");
  });

  it.each(["pending", "failed"] as const)("keeps both disjoint successful updates when the first readback is %s", async (readback) => {
    const responses = new Map<string, (value: ContactMutationResponse) => void>();
    let resolveRead!: (value: ContactListResponse) => void;
    const updateContact = vi.fn((id: string) => new Promise<ContactMutationResponse>((resolve) => { responses.set(id, resolve); }));
    const listContacts = vi.fn<() => Promise<ContactListResponse>>().mockRejectedValue(new Error("Synthetic readback failure"));
    if (readback === "pending") listContacts.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, {});
    queryClient.setQueryData(key, makeContactListResponse([contactA, contactB]));
    const { result } = renderHookWithProviders(() => ({
      first: useUpdateContactMutation(), second: useUpdateContactMutation(), list: useContactsListQuery(),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact, listContacts } }) });
    act(() => {
      result.current.first.mutate({ contactId: contactA.contactId, body: { role: "referrer" } });
      result.current.second.mutate({ contactId: contactB.contactId, body: { role: "hiring_manager" } });
    });
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(2));
    act(() => responses.get(contactA.contactId)!(makeContactMutationResponse(detailFor({ ...contactA, role: "referrer" }))));
    await waitFor(() => expect(result.current.first.isSuccess).toBe(true));
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(1));
    if (readback === "failed") await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    else expect(result.current.list.fetchStatus).toBe("fetching");
    act(() => responses.get(contactB.contactId)!(makeContactMutationResponse(detailFor({ ...contactB, role: "hiring_manager" }))));
    await waitFor(() => expect(result.current.second.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    if (readback === "pending") act(() => resolveRead(makeContactListResponse([contactA, contactB])));
    expect(result.current.list.data?.items.find((item) => item.contactId === contactA.contactId)?.role).toBe("referrer");
    expect(result.current.list.data?.items.find((item) => item.contactId === contactB.contactId)?.role).toBe("hiring_manager");
  });

  it("does not reinsert a contact after a newer delete confirms its already-absent row", async () => {
    let resolveOlder!: (value: ContactMutationResponse) => void;
    const updateContact = vi.fn(() => new Promise<ContactMutationResponse>((resolve) => { resolveOlder = resolve; }));
    const deleteContact = vi.fn(async () => ({ ok: true as const, contactId: contactB.contactId, deletedAt: "2026-06-30T12:00:00Z" }));
    const listContacts = vi.fn(async () => { throw new Error("Synthetic readback failure"); });
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer A" });
    queryClient.setQueryData(key, makeContactListResponse([]));
    const { result } = renderHookWithProviders(() => ({
      older: useUpdateContactMutation(), deletion: useDeleteContactMutation(), list: useContactsListQuery({ employer: "Employer A" }),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact, deleteContact, listContacts } }) });
    act(() => result.current.older.mutate({ contactId: contactB.contactId, body: { employer: "Employer A" } }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    act(() => result.current.deletion.mutate({ contactId: contactB.contactId }));
    await waitFor(() => expect(result.current.deletion.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    act(() => resolveOlder(makeContactMutationResponse(detailFor({ ...contactB, employer: "Employer A" }))));
    await waitFor(() => expect(result.current.older.isSuccess).toBe(true));
    expect(result.current.list.data?.items).toEqual([]);
    expect(result.current.list.isRefetchError).toBe(true);
  });

  it.each([
    ["age-stale", "before-edit"], ["age-stale", "after-edit"],
    ["recent", "before-edit"], ["recent", "after-edit"],
  ] as const)("retains an accepted %s list after a cross-client move and independent write %s", async (age, order) => {
    let resolveEdit!: (value: ContactMutationResponse) => void;
    let readsB = 0;
    let serverB = makeContactListResponse([contactB]);
    let serverA = { ...contactA, employer: "Employer B" };
    const moved = { ...contactA, employer: "Employer B", role: "recruiter" as const };
    const updatedB = { ...contactB, displayName: "B after" };
    const updateContact = vi.fn((id: string) => {
      if (id === contactA.contactId) {
        // In the second history the edit commits first; its response is delayed.
        if (order === "after-edit") serverA = { ...serverA, role: "referrer" };
        serverA = { ...serverA, role: "recruiter" };
        return new Promise<ContactMutationResponse>((resolve) => { resolveEdit = resolve; });
      }
      serverB = makeContactListResponse([serverA, updatedB]);
      return Promise.resolve(makeContactMutationResponse(detailFor(updatedB)));
    });
    const queryClient = createTestQueryClient();
    const keyA = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer A" });
    const keyB = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer B" });
    const updatedAt = Date.now() - (age === "age-stale" ? 60_000 : 0);
    queryClient.setQueryData(keyA, makeContactListResponse([contactA]), { updatedAt });
    queryClient.setQueryData(keyB, serverB, { updatedAt });
    const queryA = queryClient.getQueryCache().find({ queryKey: keyA, exact: true })!;
    expect(queryA.state.isInvalidated).toBe(false);
    expect(queryA.isStaleByTime(30_000)).toBe(age === "age-stale");
    const { result } = renderHookWithProviders(() => ({
      edit: useUpdateContactMutation(), other: useUpdateContactMutation(),
      listB: useQuery<ContactListResponse>({ queryKey: keyB, queryFn: async () => {
        readsB += 1;
        if (readsB > 1) throw new Error("Synthetic final read failure");
        return serverB;
      } }),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact } }) });

    // Another client moved A, but its event has not arrived at this query client.
    act(() => result.current.edit.mutate({ contactId: contactA.contactId, body: { role: "referrer" } }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    act(() => result.current.other.mutate({ contactId: contactB.contactId, body: { attributes: [{ kind: "name", value: "B after" }] } }));
    await waitFor(() => expect(result.current.other.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.listB.data?.items).toEqual([moved, updatedB]));
    expect(readsB).toBe(1);
    expect(result.current.edit.isPending).toBe(true);

    if (order === "before-edit") serverA = { ...serverA, role: "referrer" };
    act(() => resolveEdit(makeContactMutationResponse(detailFor({ ...serverA, role: "referrer" }))));
    await waitFor(() => expect(result.current.edit.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.listB.isRefetchError).toBe(true));
    expect(readsB).toBeGreaterThan(1);
    // Both histories have the same client-visible ordering. Keep the accepted
    // list rather than claiming which unversioned server write was later.
    expect(result.current.listB.data?.items).toEqual([moved, updatedB]);
  });

  it.each(["update", "delete"] as const)("does not cancel or defer an unrelated list while a contact %s is pending", async (operation) => {
    let rejectA!: (error: Error) => void;
    let finishEarlierRead!: (value: ContactListResponse) => void;
    let readsB = 0;
    let serverB = makeContactListResponse([contactB]);
    const after = { ...contactB, displayName: "B after" };
    const updateContact = vi.fn((id: string) => {
      if (id === contactA.contactId) return new Promise<ContactMutationResponse>((_resolve, reject) => { rejectA = reject; });
      serverB = makeContactListResponse([after]);
      return Promise.resolve(makeContactMutationResponse(detailFor(after)));
    });
    const deleteContact = vi.fn(() => new Promise<ContactDeleteResponse>((_resolve, reject) => { rejectA = reject; }));
    const queryClient = createTestQueryClient();
    const keyA = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer A" });
    const keyB = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer B" });
    queryClient.setQueryData(keyA, makeContactListResponse([contactA]));
    queryClient.setQueryData(keyB, serverB);
    const { result } = renderHookWithProviders(() => ({
      first: useUpdateContactMutation(), other: useUpdateContactMutation(), deletion: useDeleteContactMutation(),
      listB: useQuery<ContactListResponse>({ queryKey: keyB, queryFn: async () => {
        readsB += 1;
        return readsB === 1 ? new Promise<ContactListResponse>((resolve) => { finishEarlierRead = resolve; }) : serverB;
      } }),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact, deleteContact } }) });
    void queryClient.refetchQueries({ queryKey: keyB, exact: true });
    await waitFor(() => expect(readsB).toBe(1));
    if (operation === "update") {
      act(() => result.current.first.mutate({ contactId: contactA.contactId, body: { role: "referrer" } }));
      await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    } else {
      act(() => result.current.deletion.mutate({ contactId: contactA.contactId }));
      await waitFor(() => expect(deleteContact).toHaveBeenCalledTimes(1));
    }
    expect(queryClient.getQueryState(keyB)?.fetchStatus).toBe("fetching");
    act(() => finishEarlierRead(serverB));
    await waitFor(() => expect(result.current.listB.fetchStatus).toBe("idle"));
    act(() => result.current.other.mutate({ contactId: contactB.contactId, body: { attributes: [{ kind: "name", value: "B after" }] } }));
    await waitFor(() => expect(result.current.other.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.listB.data?.items[0]?.displayName).toBe("B after"));
    expect(readsB).toBeGreaterThan(1);
    expect(operation === "update" ? result.current.first.isPending : result.current.deletion.isPending).toBe(true);
    act(() => rejectA(new Error("Synthetic first failure")));
    await waitFor(() => expect(operation === "update" ? result.current.first.isError : result.current.deletion.isError).toBe(true));
    expect(result.current.listB.data?.items[0]?.displayName).toBe("B after");
  });

  it("publishes a different existing contact while a same-list create remains pending", async () => {
    let resolveUpdate!: (value: ContactMutationResponse) => void;
    let rejectCreate!: (error: Error) => void;
    let reads = 0;
    const updateContact = vi.fn(() => new Promise<ContactMutationResponse>((resolve) => { resolveUpdate = resolve; }));
    const createContact = vi.fn(() => new Promise<ContactMutationResponse>((_resolve, reject) => { rejectCreate = reject; }));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer B" });
    queryClient.setQueryData(key, makeContactListResponse([contactB]));
    const { result } = renderHookWithProviders(() => ({
      update: useUpdateContactMutation(), create: useCreateContactMutation(),
      list: useQuery<ContactListResponse>({ queryKey: key, queryFn: async () => { reads += 1; throw new Error("Synthetic read failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact, createContact } }) });
    act(() => result.current.update.mutate({ contactId: contactB.contactId, body: { attributes: [{ kind: "name", value: "B after" }] } }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    act(() => result.current.create.mutate({ employer: "Employer B", role: "other", attributes: [{ kind: "name", value: "New synthetic" }] }));
    await waitFor(() => expect(createContact).toHaveBeenCalledTimes(1));
    expect(result.current.list.data?.items).toHaveLength(2);
    act(() => resolveUpdate(makeContactMutationResponse(detailFor({ ...contactB, displayName: "B after" }))));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(result.current.create.isPending).toBe(true);
    expect(result.current.list.data?.items.find((item) => item.contactId === contactB.contactId)?.displayName).toBe("B after");
    expect(reads).toBe(0);
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    act(() => rejectCreate(new Error("Synthetic create failure")));
    await waitFor(() => expect(result.current.create.isError).toBe(true));
    await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    expect(reads).toBeGreaterThan(0);
    expect(result.current.list.data?.items.map((item) => item.contactId)).toEqual([contactB.contactId]);
    expect(result.current.list.data?.items[0]?.displayName).toBe("B after");
  });

  it("keeps an independent response fence when a create cancels a read without changing accepted data", async () => {
    let resolveUpdate!: (value: ContactMutationResponse) => void;
    let rejectCreate!: (error: Error) => void;
    let resolveRead!: (value: ContactListResponse) => void;
    const updateContact = vi.fn(() => new Promise<ContactMutationResponse>((resolve) => { resolveUpdate = resolve; }));
    const createContact = vi.fn(() => new Promise<ContactMutationResponse>((_resolve, reject) => { rejectCreate = reject; }));
    const listContacts = vi.fn<() => Promise<ContactListResponse>>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }))
      .mockRejectedValue(new Error("Synthetic readback failure"));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, {});
    queryClient.setQueryData(key, makeContactListResponse([contactB]));
    const { result } = renderHookWithProviders(() => ({
      update: useUpdateContactMutation(), create: useCreateContactMutation(), list: useContactsListQuery(),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact, createContact, listContacts } }) });
    act(() => result.current.update.mutate({ contactId: contactB.contactId, body: { role: "referrer" } }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    let cancelledRead!: ReturnType<typeof result.current.list.refetch>;
    act(() => { cancelledRead = result.current.list.refetch(); });
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(1));
    act(() => result.current.create.mutate({ role: "other", attributes: [{ kind: "name", value: "New synthetic" }] }));
    await waitFor(() => expect(createContact).toHaveBeenCalledTimes(1));
    expect(result.current.list.data?.items).toHaveLength(2);
    act(() => resolveUpdate(makeContactMutationResponse(detailFor({ ...contactB, role: "referrer" }))));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(result.current.create.isPending).toBe(true);
    expect(result.current.list.data?.items.find((item) => item.contactId === contactB.contactId)?.role).toBe("referrer");
    act(() => rejectCreate(new Error("Synthetic create failure")));
    await waitFor(() => expect(result.current.create.isError).toBe(true));
    await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    await act(async () => {
      resolveRead(makeContactListResponse([contactB]));
      await cancelledRead;
    });
    expect(result.current.list.data?.items.map((item) => item.contactId)).toEqual([contactB.contactId]);
    expect(result.current.list.data?.items[0]?.role).toBe("referrer");
  });

  it("keeps an earlier list refresh failure visible while independent partial changes are published", async () => {
    let resolveUpdate!: (value: ContactMutationResponse) => void;
    let rejectCreate!: (error: Error) => void;
    const updateContact = vi.fn(() => new Promise<ContactMutationResponse>((resolve) => { resolveUpdate = resolve; }));
    const createContact = vi.fn(() => new Promise<ContactMutationResponse>((_resolve, reject) => { rejectCreate = reject; }));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer B" });
    queryClient.setQueryData(key, makeContactListResponse([contactB]));
    const { result } = renderHookWithProviders(() => ({
      update: useUpdateContactMutation(), create: useCreateContactMutation(),
      list: useQuery<ContactListResponse>({ queryKey: key, queryFn: async () => { throw new Error("Synthetic read failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact, createContact } }) });
    expect(result.current.list.isRefetchError).toBe(false);
    await act(async () => { await result.current.list.refetch(); });
    await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    act(() => result.current.update.mutate({ contactId: contactB.contactId, body: { role: "referrer" } }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    act(() => result.current.create.mutate({ employer: "Employer B", role: "other", attributes: [{ kind: "name", value: "New synthetic" }] }));
    await waitFor(() => expect(createContact).toHaveBeenCalledTimes(1));
    expect(result.current.list.isRefetchError).toBe(true);
    act(() => resolveUpdate(makeContactMutationResponse(detailFor({ ...contactB, role: "referrer" }))));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(result.current.list.isRefetchError).toBe(true);
    expect(result.current.list.data?.items.find((item) => item.contactId === contactB.contactId)?.role).toBe("referrer");
    expect(result.current.create.isPending).toBe(true);
    act(() => rejectCreate(new Error("Synthetic create failure")));
    await waitFor(() => expect(result.current.create.isError).toBe(true));
  });

  it("does not assume a pending create is different when the updated ID was not in the snapshot", async () => {
    let resolveUpdate!: (value: ContactMutationResponse) => void;
    let resolveCreate!: (value: ContactMutationResponse) => void;
    const updateContact = vi.fn(() => new Promise<ContactMutationResponse>((resolve) => { resolveUpdate = resolve; }));
    const createContact = vi.fn(() => new Promise<ContactMutationResponse>((resolve) => { resolveCreate = resolve; }));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer B" });
    queryClient.setQueryData(key, makeContactListResponse([contactB]));
    const { result } = renderHookWithProviders(() => ({
      update: useUpdateContactMutation(), create: useCreateContactMutation(),
      list: useQuery<ContactListResponse>({ queryKey: key, queryFn: async () => { throw new Error("Synthetic read failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact, createContact } }) });
    act(() => result.current.update.mutate({ contactId: "contact-created", body: { role: "referrer" } }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    act(() => result.current.create.mutate({ employer: "Employer B", role: "other", attributes: [{ kind: "name", value: "New synthetic" }] }));
    await waitFor(() => expect(createContact).toHaveBeenCalledTimes(1));
    const created = { ...contactB, contactId: "contact-created", displayName: "New synthetic" };
    act(() => resolveUpdate(makeContactMutationResponse(detailFor({ ...created, role: "referrer" }))));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(result.current.list.data?.items.some((item) => item.contactId === created.contactId)).toBe(false);
    act(() => resolveCreate(makeContactMutationResponse(detailFor(created))));
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    expect(result.current.list.data?.items.filter((item) => item.contactId === created.contactId)).toHaveLength(1);
    expect(result.current.list.data?.items.some((item) => item.contactId.startsWith("optimistic-"))).toBe(false);
  });

  it("crosses only different-contact local partials while a create holds the shared list", async () => {
    let resolveB!: (value: ContactMutationResponse) => void;
    let rejectCreate!: (error: Error) => void;
    const contactC = { ...contactB, contactId: "contact-c", displayName: "C before" };
    const updateContact = vi.fn((id: string) => id === contactB.contactId
      ? new Promise<ContactMutationResponse>((resolve) => { resolveB = resolve; })
      : Promise.resolve(makeContactMutationResponse(detailFor({ ...contactC, displayName: "C after" }))));
    const createContact = vi.fn(() => new Promise<ContactMutationResponse>((_resolve, reject) => { rejectCreate = reject; }));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer B" });
    queryClient.setQueryData(key, makeContactListResponse([contactB, contactC]));
    const { result } = renderHookWithProviders(() => ({
      first: useUpdateContactMutation(), second: useUpdateContactMutation(), create: useCreateContactMutation(),
      list: useQuery<ContactListResponse>({ queryKey: key, queryFn: async () => { throw new Error("Synthetic read failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact, createContact } }) });
    act(() => result.current.first.mutate({ contactId: contactB.contactId, body: { attributes: [{ kind: "name", value: "B after" }] } }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    act(() => result.current.create.mutate({ employer: "Employer B", role: "other", attributes: [{ kind: "name", value: "New synthetic" }] }));
    await waitFor(() => expect(createContact).toHaveBeenCalledTimes(1));
    act(() => result.current.second.mutate({ contactId: contactC.contactId, body: { attributes: [{ kind: "name", value: "C after" }] } }));
    await waitFor(() => expect(result.current.second.isSuccess).toBe(true));
    act(() => resolveB(makeContactMutationResponse(detailFor({ ...contactB, displayName: "B after" }))));
    await waitFor(() => expect(result.current.first.isSuccess).toBe(true));
    expect(result.current.create.isPending).toBe(true);
    expect(result.current.list.data?.items.find((item) => item.contactId === contactB.contactId)?.displayName).toBe("B after");
    expect(result.current.list.data?.items.find((item) => item.contactId === contactC.contactId)?.displayName).toBe("C after");
    act(() => rejectCreate(new Error("Synthetic create failure")));
    await waitFor(() => expect(result.current.create.isError).toBe(true));
    await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    expect(result.current.list.data?.items.find((item) => item.contactId === contactB.contactId)?.displayName).toBe("B after");
    expect(result.current.list.data?.items.find((item) => item.contactId === contactC.contactId)?.displayName).toBe("C after");
  });

  it("does not cross a later publication for the same contact while a create is pending", async () => {
    let resolveOlder!: (value: ContactMutationResponse) => void;
    let rejectCreate!: (error: Error) => void;
    const updateContact = vi.fn((_id: string, body: ContactUpdateRequest) => body.role === "referrer"
      ? new Promise<ContactMutationResponse>((resolve) => { resolveOlder = resolve; })
      : Promise.resolve(makeContactMutationResponse(detailFor({ ...contactB, role: "hiring_manager" }))));
    const createContact = vi.fn(() => new Promise<ContactMutationResponse>((_resolve, reject) => { rejectCreate = reject; }));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer B" });
    queryClient.setQueryData(key, makeContactListResponse([contactB]));
    const { result } = renderHookWithProviders(() => ({
      older: useUpdateContactMutation(), newer: useUpdateContactMutation(), create: useCreateContactMutation(),
      list: useQuery<ContactListResponse>({ queryKey: key, queryFn: async () => { throw new Error("Synthetic read failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact, createContact } }) });
    act(() => result.current.older.mutate({ contactId: contactB.contactId, body: { role: "referrer" } }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    act(() => result.current.create.mutate({ employer: "Employer B", role: "other", attributes: [{ kind: "name", value: "New synthetic" }] }));
    await waitFor(() => expect(createContact).toHaveBeenCalledTimes(1));
    act(() => result.current.newer.mutate({ contactId: contactB.contactId, body: { role: "hiring_manager" } }));
    await waitFor(() => expect(result.current.newer.isSuccess).toBe(true));
    act(() => resolveOlder(makeContactMutationResponse(detailFor({ ...contactB, role: "referrer" }))));
    await waitFor(() => expect(result.current.older.isSuccess).toBe(true));
    expect(result.current.list.data?.items.find((item) => item.contactId === contactB.contactId)?.role).toBe("hiring_manager");
    act(() => rejectCreate(new Error("Synthetic create failure")));
    await waitFor(() => expect(result.current.create.isError).toBe(true));
    await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    expect(result.current.list.data?.items.find((item) => item.contactId === contactB.contactId)?.role).toBe("hiring_manager");
  });

  it("does not cross an unidentified partial publication while a create is pending", async () => {
    let resolveUpdate!: (value: ContactMutationResponse) => void;
    let rejectCreate!: (error: Error) => void;
    const updateContact = vi.fn(() => new Promise<ContactMutationResponse>((resolve) => { resolveUpdate = resolve; }));
    const createContact = vi.fn(() => new Promise<ContactMutationResponse>((_resolve, reject) => { rejectCreate = reject; }));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer B" });
    queryClient.setQueryData(key, makeContactListResponse([contactB]));
    const { result } = renderHookWithProviders(() => ({
      update: useUpdateContactMutation(), create: useCreateContactMutation(),
      list: useQuery<ContactListResponse>({ queryKey: key, queryFn: async () => { throw new Error("Synthetic read failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact, createContact } }) });
    act(() => result.current.update.mutate({ contactId: contactB.contactId, body: { role: "referrer" } }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    act(() => result.current.create.mutate({ employer: "Employer B", role: "other", attributes: [{ kind: "name", value: "New synthetic" }] }));
    await waitFor(() => expect(createContact).toHaveBeenCalledTimes(1));
    const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })!;
    act(() => applyPartialQueryPatch(queryClient, query, (current) => {
      const list = current as ContactListResponse;
      return { ...list, items: list.items.map((item) => item.contactId === contactB.contactId ? { ...item, role: "recruiter" } : item) };
    }));
    act(() => resolveUpdate(makeContactMutationResponse(detailFor({ ...contactB, role: "referrer" }))));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(result.current.list.data?.items.find((item) => item.contactId === contactB.contactId)?.role).toBe("recruiter");
    act(() => rejectCreate(new Error("Synthetic create failure")));
    await waitFor(() => expect(result.current.create.isError).toBe(true));
    await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    expect(result.current.list.data?.items.find((item) => item.contactId === contactB.contactId)?.role).toBe("recruiter");
  });

  it("keeps the optimistic detail while a move is pending and applies its confirmed membership on failed readback", async () => {
    let resolveMove!: (value: ContactMutationResponse) => void;
    const updateContact = vi.fn(() => new Promise<ContactMutationResponse>((resolve) => { resolveMove = resolve; }));
    const queryClient = createTestQueryClient();
    const keyA = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer A" });
    const keyB = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer B" });
    const detailKey = outreachKeys.contactDetail(LOCAL_TENANT, contactB.contactId);
    queryClient.setQueryData(keyA, makeContactListResponse([contactA]));
    queryClient.setQueryData(keyB, makeContactListResponse([contactB]));
    queryClient.setQueryData(detailKey, makeContactDetailResponse(detailFor(contactB)));
    const { result } = renderHookWithProviders(() => ({
      move: useUpdateContactMutation(),
      listA: useQuery<ContactListResponse>({ queryKey: keyA, queryFn: async () => { throw new Error("Synthetic A read failure"); } }),
      listB: useQuery<ContactListResponse>({ queryKey: keyB, queryFn: async () => { throw new Error("Synthetic B read failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact } }) });
    act(() => result.current.move.mutate({ contactId: contactB.contactId, body: { employer: "Employer A", role: "referrer" } }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    expect(queryClient.getQueryData<ContactDetailResponse>(detailKey)?.contact.role).toBe("referrer");
    expect(result.current.listA.data?.items).toEqual([contactA]);
    expect(result.current.listB.data?.items).toEqual([contactB]);
    act(() => resolveMove(makeContactMutationResponse(detailFor({ ...contactB, employer: "Employer A", role: "referrer" }))));
    await waitFor(() => expect(result.current.move.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.listA.isRefetchError).toBe(true));
    await waitFor(() => expect(result.current.listB.isRefetchError).toBe(true));
    expect(result.current.listA.data?.items.find((item) => item.contactId === contactB.contactId)).toMatchObject({ employer: "Employer A", role: "referrer" });
    expect(result.current.listA.data?.items.find((item) => item.contactId === contactA.contactId)).toEqual(contactA);
    expect(result.current.listB.data?.items).toEqual([]);
  });

  it.each(["update", "delete"] as const)("retains the list on a failed %s and rolls back a pending detail edit", async (operation) => {
    let reject!: (error: Error) => void;
    const updateContact = vi.fn(() => new Promise<ContactMutationResponse>((_resolve, fail) => { reject = fail; }));
    const deleteContact = vi.fn(() => new Promise<ContactDeleteResponse>((_resolve, fail) => { reject = fail; }));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer A" });
    const detailKey = outreachKeys.contactDetail(LOCAL_TENANT, contactA.contactId);
    queryClient.setQueryData(key, makeContactListResponse([contactA]));
    queryClient.setQueryData(detailKey, makeContactDetailResponse(detailFor(contactA)));
    const { result } = renderHookWithProviders(() => ({ update: useUpdateContactMutation(), deletion: useDeleteContactMutation() }),
      { queryClient, ports: buildTestPorts({ api: { updateContact, deleteContact } }) });
    if (operation === "update") {
      act(() => result.current.update.mutate({ contactId: contactA.contactId, body: { role: "referrer" } }));
      await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
      expect(queryClient.getQueryData<ContactDetailResponse>(detailKey)?.contact.role).toBe("referrer");
    } else {
      act(() => result.current.deletion.mutate({ contactId: contactA.contactId }));
      await waitFor(() => expect(deleteContact).toHaveBeenCalledTimes(1));
    }
    expect(queryClient.getQueryData<ContactListResponse>(key)?.items).toEqual([contactA]);
    act(() => reject(new Error("Synthetic write failure")));
    await waitFor(() => expect(operation === "update" ? result.current.update.isError : result.current.deletion.isError).toBe(true));
    expect(queryClient.getQueryData<ContactListResponse>(key)?.items).toEqual([contactA]);
    expect(queryClient.getQueryData<ContactDetailResponse>(detailKey)?.contact.role).toBe(contactA.role);
  });

  it("removes only the confirmed deleted row when the subsequent list read fails", async () => {
    let resolveDelete!: (value: ContactDeleteResponse) => void;
    const deleteContact = vi.fn(() => new Promise<ContactDeleteResponse>((resolve) => { resolveDelete = resolve; }));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, {});
    queryClient.setQueryData(key, makeContactListResponse([contactA, contactB]));
    const { result } = renderHookWithProviders(() => ({
      deletion: useDeleteContactMutation(),
      list: useQuery<ContactListResponse>({ queryKey: key, queryFn: async () => { throw new Error("Synthetic list read failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { deleteContact } }) });
    act(() => result.current.deletion.mutate({ contactId: contactA.contactId }));
    await waitFor(() => expect(deleteContact).toHaveBeenCalledTimes(1));
    expect(result.current.list.data?.items).toEqual([contactA, contactB]);
    act(() => resolveDelete({ ok: true, contactId: contactA.contactId, deletedAt: "2026-06-30T12:00:00Z" }));
    await waitFor(() => expect(result.current.deletion.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    expect(result.current.list.data?.items).toEqual([contactB]);
  });

  it("preserves a later successful update when an earlier delete fails and readback fails", async () => {
    let rejectDelete!: (error: Error) => void;
    const deleteContact = vi.fn(() => new Promise<ContactDeleteResponse>((_resolve, reject) => { rejectDelete = reject; }));
    const updateContact = vi.fn(async () => makeContactMutationResponse(detailFor({ ...contactB, role: "referrer" })));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer B" });
    queryClient.setQueryData(key, makeContactListResponse([contactB]));
    const { result } = renderHookWithProviders(() => ({
      deletion: useDeleteContactMutation(), update: useUpdateContactMutation(),
      list: useQuery<ContactListResponse>({ queryKey: key, queryFn: async () => { throw new Error("Synthetic list read failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { deleteContact, updateContact } }) });
    act(() => result.current.deletion.mutate({ contactId: contactB.contactId }));
    await waitFor(() => expect(deleteContact).toHaveBeenCalledTimes(1));
    expect(result.current.list.data?.items).toEqual([contactB]);
    act(() => result.current.update.mutate({ contactId: contactB.contactId, body: { role: "referrer" } }));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    expect(result.current.list.data?.items[0]?.role).toBe("referrer");
    act(() => rejectDelete(new Error("Synthetic delete failure")));
    await waitFor(() => expect(result.current.deletion.isError).toBe(true));
    expect(result.current.list.data?.items[0]?.role).toBe("referrer");
  });

  it("preserves a newer successful detail edit after an older failure and failed readback", async () => {
    let rejectOlder!: (error: Error) => void;
    const updateContact = vi.fn((_id: string, body: ContactUpdateRequest) => body.role === "referrer"
      ? new Promise<ContactMutationResponse>((_resolve, reject) => { rejectOlder = reject; })
      : Promise.resolve(makeContactMutationResponse(detailFor({ ...contactA, role: "hiring_manager" }))));
    const queryClient = createTestQueryClient();
    const detailKey = outreachKeys.contactDetail(LOCAL_TENANT, contactA.contactId);
    const key = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer A" });
    queryClient.setQueryData(detailKey, makeContactDetailResponse(detailFor(contactA)));
    queryClient.setQueryData(key, makeContactListResponse([contactA]));
    const { result } = renderHookWithProviders(() => ({
      older: useUpdateContactMutation(), newer: useUpdateContactMutation(),
      detail: useQuery<ContactDetailResponse>({ queryKey: detailKey, queryFn: async () => { throw new Error("Synthetic detail read failure"); } }),
      list: useQuery<ContactListResponse>({ queryKey: key, queryFn: async () => { throw new Error("Synthetic list read failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { updateContact } }) });
    act(() => result.current.older.mutate({ contactId: contactA.contactId, body: { role: "referrer" } }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    act(() => result.current.newer.mutate({ contactId: contactA.contactId, body: { role: "hiring_manager" } }));
    await waitFor(() => expect(result.current.newer.isSuccess).toBe(true));
    expect(result.current.detail.data?.contact.role).toBe("hiring_manager");
    act(() => rejectOlder(new Error("Synthetic older failure")));
    await waitFor(() => expect(result.current.older.isError).toBe(true));
    await waitFor(() => expect(result.current.detail.isRefetchError).toBe(true));
    await waitFor(() => expect(result.current.list.isRefetchError).toBe(true));
    expect(result.current.detail.data?.contact.role).toBe("hiring_manager");
    expect(result.current.list.data?.items[0]?.role).toBe("hiring_manager");
  });

  it.each(["publication", "same-value", "eviction"] as const)("preserves a newer %s before a delayed response and failed readback", async (change) => {
    let resolveEdit!: (value: ContactMutationResponse) => void;
    const updateContact = vi.fn(() => new Promise<ContactMutationResponse>((resolve) => { resolveEdit = resolve; }));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { employer: "Employer A" });
    queryClient.setQueryData(key, makeContactListResponse([contactA]));
    const ports = buildTestPorts({ api: { updateContact } });
    const { result } = renderHookWithProviders(() => useUpdateContactMutation(), { queryClient, ports });
    act(() => result.current.mutate({ contactId: contactA.contactId, body: { role: "referrer" } }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    const accepted = change === "same-value"
      ? queryClient.getQueryData<ContactListResponse>(key)!
      : makeContactListResponse([{ ...contactA, role: "recruiter", displayName: "Newer synthetic" }]);
    act(() => {
      if (change === "eviction") queryClient.removeQueries({ queryKey: key, exact: true });
      queryClient.setQueryData(key, accepted);
    });
    const view = renderHookWithProviders(() => useQuery<ContactListResponse>({ queryKey: key, queryFn: async () => { throw new Error("Synthetic read failure"); } }), { queryClient, ports });
    act(() => resolveEdit(makeContactMutationResponse(detailFor({ ...contactA, role: "referrer" }))));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(view.result.current.isRefetchError).toBe(true));
    expect(view.result.current.data).toEqual(accepted);
  });
});
