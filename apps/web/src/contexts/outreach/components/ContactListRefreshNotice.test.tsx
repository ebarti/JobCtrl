import type { ContactMutationResponse } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { makeContactDetail, makeContactListResponse, makeContactMutationResponse, makeContactSummary } from "../../../test/fixtures/contacts.js";
import { createTestQueryClient, renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useUpdateContactMutation } from "../hooks/useUpdateContactMutation.js";
import { useDeleteContactMutation } from "../hooks/useDeleteContactMutation.js";
import { useCreateContactMutation } from "../hooks/useCreateContactMutation.js";
import { outreachKeys } from "../queryKeys.js";
import { JobContactsPanel } from "./JobContactsPanel.js";
import { OfferCommunication } from "./OfferCommunication.js";

const jobId = "00000000-0000-4000-8000-000000000001";
const contact = makeContactSummary({ contactId: "contact-synthetic", jobId, displayName: "Synthetic contact", role: "other" });

function View({ surface }: { surface: "job" | "offer" }) {
  const update = useUpdateContactMutation();
  return <>
    {surface === "job" ? <JobContactsPanel jobId={jobId} /> : <OfferCommunication jobId={jobId} revisionId="revision-synthetic" />}
    <button type="button" onClick={() => update.mutate({ contactId: contact.contactId, body: { role: "referrer" } })}>Save synthetic</button>
  </>;
}

function FirstReadView({ operation }: { operation: "update" | "delete" | "create" }) {
  const update = useUpdateContactMutation();
  const deletion = useDeleteContactMutation();
  const creation = useCreateContactMutation();
  const success = operation === "update" ? update.isSuccess : operation === "delete" ? deletion.isSuccess : creation.isSuccess;
  return <>
    <JobContactsPanel jobId={jobId} />
    <button type="button" onClick={() => {
      if (operation === "update") update.mutate({ contactId: contact.contactId, body: { role: "referrer" } });
      else if (operation === "delete") deletion.mutate({ contactId: contact.contactId });
      else creation.mutate({ jobId, role: "other", attributes: [{ kind: "name", value: "Synthetic contact" }] });
    }}>Save synthetic</button>
    <output aria-label="Save status">{success ? "saved" : "pending"}</output>
  </>;
}

describe("contact list refresh notice", () => {
  it.each(["create", "update", "delete"] as const)("reconciles a held first list read after %s and offers retry when readback fails", async (operation) => {
    let resolveFirst!: (value: ReturnType<typeof makeContactListResponse>) => void;
    const firstRead = new Promise<ReturnType<typeof makeContactListResponse>>((resolve) => { resolveFirst = resolve; });
    const current = operation === "update" ? makeContactListResponse([{ ...contact, role: "referrer" }])
      : operation === "delete" ? makeContactListResponse([]) : makeContactListResponse([contact]);
    const listContacts = vi.fn().mockImplementationOnce(() => firstRead)
      .mockRejectedValueOnce(new Error("Synthetic follow-up failure"))
      .mockResolvedValueOnce(current);
    const updateContact = vi.fn(async () => makeContactMutationResponse(makeContactDetail({ contactId: contact.contactId, jobId, role: "referrer" })));
    const deleteContact = vi.fn(async () => ({ ok: true as const, contactId: contact.contactId, deletedAt: "2026-06-30T12:00:00Z" }));
    const createContact = vi.fn(async () => makeContactMutationResponse(makeContactDetail({ contactId: contact.contactId, jobId, role: "other" })));
    const ports = buildTestPorts({ api: { listContacts, updateContact, deleteContact, createContact } });
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { jobId });
    const view = renderWithProviders(<FirstReadView operation={operation} />, { queryClient, ports });
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(1));
    const loader = queryClient.ensureQueryData({ queryKey: key, queryFn: () => ports.api.listContacts({ jobId }) });
    fireEvent.click(view.getByRole("button", { name: "Save synthetic" }));
    await waitFor(() => expect(view.getByLabelText("Save status")).toHaveTextContent("saved"));
    expect(listContacts).toHaveBeenCalledTimes(1);
    const old = operation === "create" ? makeContactListResponse([]) : makeContactListResponse([contact]);
    act(() => resolveFirst(old));
    await expect(loader).resolves.toEqual(old);
    expect(await view.findByText("Contacts could not be refreshed. The list shown may be out of date.")).toBeVisible();
    if (operation === "create") expect(view.queryByText("No contacts linked to this job yet.")).not.toBeInTheDocument();
    else expect(view.getByText("Synthetic contact")).toBeInTheDocument();
    expect(listContacts).toHaveBeenCalledTimes(2);
    fireEvent.click(view.getByRole("button", { name: "Retry refresh" }));
    await waitFor(() => expect(view.queryByText("Contacts could not be refreshed. The list shown may be out of date.")).not.toBeInTheDocument());
    await waitFor(() => expect(queryClient.getQueryData(key)).toEqual(current));
    expect(listContacts).toHaveBeenCalledTimes(3);
  });

  it("coalesces settlements behind one first read without delaying either write", async () => {
    let resolveFirst!: (value: ReturnType<typeof makeContactListResponse>) => void;
    const firstRead = new Promise<ReturnType<typeof makeContactListResponse>>((resolve) => { resolveFirst = resolve; });
    const current = makeContactListResponse([{ ...contact, role: "referrer" }]);
    const listContacts = vi.fn().mockImplementationOnce(() => firstRead).mockResolvedValueOnce(current);
    const updateContact = vi.fn(async () => makeContactMutationResponse(makeContactDetail({ contactId: contact.contactId, jobId, role: "referrer" })));
    const queryClient = createTestQueryClient();
    const view = renderWithProviders(<FirstReadView operation="update" />, { queryClient, ports: buildTestPorts({ api: { listContacts, updateContact } }) });
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: "Save synthetic" }));
    await waitFor(() => expect(view.getByLabelText("Save status")).toHaveTextContent("saved"));
    fireEvent.click(view.getByRole("button", { name: "Save synthetic" }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.getByLabelText("Save status")).toHaveTextContent("saved"));
    expect(listContacts).toHaveBeenCalledTimes(1);
    act(() => resolveFirst(makeContactListResponse([contact])));
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(queryClient.getQueryData(outreachKeys.contactList(LOCAL_TENANT, { jobId }))).toEqual(current));
    expect(listContacts).toHaveBeenCalledTimes(2);
  });

  it("keeps a joined loader's first-read failure and offers retry after the follow-up also fails", async () => {
    let rejectFirst!: (error: Error) => void;
    const firstRead = new Promise<ReturnType<typeof makeContactListResponse>>((_resolve, reject) => { rejectFirst = reject; });
    const current = makeContactListResponse([{ ...contact, role: "referrer" }]);
    const listContacts = vi.fn().mockImplementationOnce(() => firstRead)
      .mockRejectedValueOnce(new Error("Synthetic follow-up failure"))
      .mockResolvedValueOnce(current);
    const updateContact = vi.fn(async () => makeContactMutationResponse(makeContactDetail({ contactId: contact.contactId, jobId, role: "referrer" })));
    const queryClient = createTestQueryClient();
    const ports = buildTestPorts({ api: { listContacts, updateContact } });
    const key = outreachKeys.contactList(LOCAL_TENANT, { jobId });
    const view = renderWithProviders(<FirstReadView operation="update" />, { queryClient, ports });
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(1));
    const loader = queryClient.ensureQueryData({ queryKey: key, queryFn: () => ports.api.listContacts({ jobId }) });
    const loaderFailure = expect(loader).rejects.toThrow("Synthetic first-read failure");
    fireEvent.click(view.getByRole("button", { name: "Save synthetic" }));
    await waitFor(() => expect(view.getByLabelText("Save status")).toHaveTextContent("saved"));
    act(() => rejectFirst(new Error("Synthetic first-read failure")));
    await loaderFailure;
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(2));
    expect(await view.findByText("Contacts could not be loaded.")).toBeVisible();
    expect(view.queryByText("No contacts linked to this job yet.")).not.toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "Retry refresh" }));
    await waitFor(() => expect(queryClient.getQueryData(key)).toEqual(current));
    expect(view.queryByText("Contacts could not be loaded.")).not.toBeInTheDocument();
    expect(listContacts).toHaveBeenCalledTimes(3);
  });

  it("does not follow an evicted first-read query into its replacement", async () => {
    let resolveFirst!: (value: ReturnType<typeof makeContactListResponse>) => void;
    const firstRead = new Promise<ReturnType<typeof makeContactListResponse>>((resolve) => { resolveFirst = resolve; });
    const listContacts = vi.fn().mockImplementationOnce(() => firstRead);
    const updateContact = vi.fn(async () => makeContactMutationResponse(makeContactDetail({ contactId: contact.contactId, jobId, role: "referrer" })));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { jobId });
    const view = renderWithProviders(<FirstReadView operation="update" />, { queryClient, ports: buildTestPorts({ api: { listContacts, updateContact } }) });
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: "Save synthetic" }));
    await waitFor(() => expect(view.getByLabelText("Save status")).toHaveTextContent("saved"));
    const newer = makeContactListResponse([{ ...contact, displayName: "Replacement synthetic" }]);
    await act(async () => {
      queryClient.removeQueries({ queryKey: key, exact: true });
      queryClient.setQueryData(key, newer);
      resolveFirst(makeContactListResponse([contact]));
      await firstRead;
    });
    await waitFor(() => expect(queryClient.getQueryData(key)).toEqual(newer));
    expect(listContacts).toHaveBeenCalledTimes(1);
  });

  it.each(["fails", "succeeds"] as const)("keeps a later manual publication when the first read %s", async (outcome) => {
    let finishFirst!: () => void;
    const firstRead = new Promise<ReturnType<typeof makeContactListResponse>>((resolve, reject) => {
      finishFirst = () => outcome === "fails"
        ? reject(new Error("Synthetic first-read failure"))
        : resolve(makeContactListResponse([contact]));
    });
    const listContacts = vi.fn().mockImplementationOnce(() => firstRead);
    const updateContact = vi.fn(async () => makeContactMutationResponse(makeContactDetail({ contactId: contact.contactId, jobId, role: "referrer" })));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { jobId });
    const view = renderWithProviders(<FirstReadView operation="update" />, { queryClient, ports: buildTestPorts({ api: { listContacts, updateContact } }) });
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: "Save synthetic" }));
    await waitFor(() => expect(view.getByLabelText("Save status")).toHaveTextContent("saved"));
    const newer = makeContactListResponse([{ ...contact, displayName: "Later synthetic" }]);
    act(() => queryClient.setQueryData(key, newer));
    await act(async () => {
      finishFirst();
      await firstRead.catch(() => undefined);
    });
    if (outcome === "fails") expect(await view.findByText("Contacts could not be refreshed. The list shown may be out of date.")).toBeVisible();
    else await waitFor(() => expect(queryClient.getQueryState(key)?.fetchStatus).toBe("idle"));
    expect(queryClient.getQueryData(key)).toEqual(newer);
    expect(view.getByText("Later synthetic")).toBeInTheDocument();
    expect(listContacts).toHaveBeenCalledTimes(1);
  });

  it("does not restart a newer read that begins as the first read publishes", async () => {
    let resolveFirst!: (value: ReturnType<typeof makeContactListResponse>) => void;
    const firstRead = new Promise<ReturnType<typeof makeContactListResponse>>((resolve) => { resolveFirst = resolve; });
    const newer = makeContactListResponse([{ ...contact, displayName: "Later synthetic" }]);
    const listContacts = vi.fn().mockImplementationOnce(() => firstRead).mockResolvedValueOnce(newer);
    const updateContact = vi.fn(async () => makeContactMutationResponse(makeContactDetail({ contactId: contact.contactId, jobId, role: "referrer" })));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { jobId });
    const view = renderWithProviders(<FirstReadView operation="update" />, { queryClient, ports: buildTestPorts({ api: { listContacts, updateContact } }) });
    await waitFor(() => expect(listContacts).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByRole("button", { name: "Save synthetic" }));
    await waitFor(() => expect(view.getByLabelText("Save status")).toHaveTextContent("saved"));
    const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })!;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.query !== query || event.action.type !== "success" || event.action.manual) return;
      unsubscribe();
      void queryClient.refetchQueries({ queryKey: key, exact: true });
    });
    act(() => resolveFirst(makeContactListResponse([contact])));
    await waitFor(() => expect(queryClient.getQueryData(key)).toEqual(newer));
    expect(listContacts).toHaveBeenCalledTimes(2);
  });

  it.each(["job", "offer"] as const)("shows retained data and retries a failed read in the %s surface", async (surface) => {
    let resolve!: (value: ContactMutationResponse) => void;
    const updateContact = vi.fn(() => new Promise<ContactMutationResponse>((done) => { resolve = done; }));
    const accepted = makeContactListResponse([{ ...contact, displayName: "Newer synthetic", role: "recruiter" }]);
    const listContacts = vi.fn().mockRejectedValueOnce(new Error("Synthetic read failure")).mockResolvedValueOnce(accepted);
    const queryClient = createTestQueryClient();
    const key = outreachKeys.contactList(LOCAL_TENANT, { jobId });
    queryClient.setQueryData(key, makeContactListResponse([contact]));
    const view = renderWithProviders(<View surface={surface} />, { queryClient, ports: buildTestPorts({ api: { updateContact, listContacts } }) });
    if (surface === "offer") fireEvent.click(view.getByText("Draft an offer communication"));
    fireEvent.click(view.getByRole("button", { name: "Save synthetic" }));
    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    act(() => queryClient.setQueryData(key, accepted));
    act(() => resolve(makeContactMutationResponse(makeContactDetail({ contactId: contact.contactId, jobId, role: "referrer" }))));
    const notice = await view.findByText("Contacts could not be refreshed. The list shown may be out of date.");
    expect(notice).toBeVisible();
    expect(queryClient.getQueryData(key)).toEqual(accepted);
    fireEvent.click(view.getByRole("button", { name: "Retry refresh" }));
    await waitFor(() => expect(view.queryByText("Contacts could not be refreshed. The list shown may be out of date.")).not.toBeInTheDocument());
    expect(listContacts).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(key)).toEqual(accepted);
  });
});
