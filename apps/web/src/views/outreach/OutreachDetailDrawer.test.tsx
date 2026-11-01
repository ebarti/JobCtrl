import { userEvent } from "@testing-library/user-event";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { http, HttpResponse } from "msw";
import { axe } from "jest-axe";
import { JobCtrlApiUnconfirmedWriteError } from "@jobctrl/api-client";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { ContactUpdateRequestSchema, type ContactAttributeKind, type ContactDetail, type ContactUpdateRequest, type LogOutreachSendResponse } from "@jobctrl/contracts";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../test/render.js";
import { OutreachDetailDrawer } from "./OutreachDetailDrawer.js";
import { makeContactDetail, makeContactProvenance } from "../../test/fixtures/contacts.js";
import { makeOutreachSendLog } from "../../test/fixtures/outreach.js";
import { server } from "../../test/msw/server.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { outreachKeys } from "../../contexts/outreach/queryKeys.js";

function syntheticContactServer(initial: ContactDetail) {
  let canonical = structuredClone(initial);
  const requests: ContactUpdateRequest[] = [];
  let writes = 0;
  server.use(
    http.get("*/v1/contacts/:contactId", () => HttpResponse.json({ ok: true, contact: canonical })),
    http.patch("*/v1/contacts/:contactId", async ({ request }) => {
      const body = await request.json() as ContactUpdateRequest;
      requests.push(body);
      if (!ContactUpdateRequestSchema.safeParse(body).success) {
        return HttpResponse.json({ ok: false, error: "invalid_contact" }, { status: 400 });
      }
      if (body.expectedFingerprint !== canonical.fingerprint) {
        return HttpResponse.json({ ok: false, error: "contact_revision_conflict", message: "Contact changed" }, { status: 409 });
      }
      const remaining = [...canonical.attributes];
      const specified = new Set(body.attributes?.flatMap((fact) => fact.attributeId ? [fact.attributeId] : []) ?? []);
      const attributes = body.attributes?.map((fact, index) => {
        const match = remaining.findIndex((old) => fact.attributeId
          ? old.attributeId === fact.attributeId && old.kind === fact.kind && old.value === fact.value
          : !specified.has(old.attributeId) && old.kind === fact.kind && old.value === fact.value.trim());
        if (match >= 0) return remaining.splice(match, 1)[0]!;
        return { attributeId: `new-${writes}-${index}`, kind: fact.kind, value: fact.value.trim(),
          provenance: makeContactProvenance({ sourceRef: "synthetic-second-editor" }) };
      }) ?? canonical.attributes;
      writes += 1;
      canonical = { ...canonical, role: body.role ?? canonical.role,
        employer: body.employer === undefined ? canonical.employer : body.employer,
        jobId: body.jobId === undefined ? canonical.jobId : body.jobId,
        attributes, fingerprint: (writes + 10).toString(16).padStart(64, "0") };
      return HttpResponse.json({ ok: true, contact: canonical });
    }),
  );
  return {
    requests,
    current: () => structuredClone(canonical),
    change: (update: (contact: ContactDetail) => ContactDetail) => {
      canonical = { ...update(structuredClone(canonical)), fingerprint: "e".repeat(64) };
    },
  };
}

describe("<OutreachDetailDrawer>", () => {
  it.each(["success", "failure", "conflict"] as const)(
    "retains a newer contact draft when a pending save ends in %s", async (result) => {
      const user = userEvent.setup();
      const source = syntheticContactServer(makeContactDetail({ jobId: "00000000-0000-4000-8000-000000000011" }));
      const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
      const originalUpdate = view.ports.api.updateContact.bind(view.ports.api);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const update = vi.spyOn(view.ports.api, "updateContact").mockImplementationOnce(async (id, body) => {
        await gate;
        if (result === "failure") throw new Error("Synthetic save failure");
        return originalUpdate(id, body);
      });
      await user.click(await view.findByRole("button", { name: "Edit" }));
      const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
      await user.clear(dialog.getByLabelText("Employer"));
      await user.type(dialog.getByLabelText("Employer"), "Submitted employer");
      await user.click(dialog.getByRole("button", { name: "save contact" }));
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      await user.clear(dialog.getByLabelText("Employer"));
      await user.type(dialog.getByLabelText("Employer"), "Newer draft employer");
      await user.click(dialog.getByRole("button", { name: "Add fact" }));
      await user.type(dialog.getAllByLabelText("Value").at(-1)!, "after-submit@example.test");
      const other = { attributeId: "other-imported", kind: "email", value: "other@example.test",
        provenance: makeContactProvenance({ sourceRef: "synthetic-other-source" }) };
      if (result === "conflict") {
        source.change((contact) => ({ ...contact, role: "warm_intro", attributes: [...contact.attributes, other] }));
      }
      await act(async () => { release(); await update.mock.results[0]!.value.catch(() => undefined); });
      expect(dialog.getByLabelText("Employer")).toHaveValue("Newer draft employer");
      expect(dialog.getAllByLabelText("Value").at(-1)).toHaveValue("after-submit@example.test");
      expect(update).toHaveBeenCalledTimes(1);
      if (result !== "failure") {
        if (result === "success") expect(dialog.getByRole("alert")).toHaveTextContent(/submitted changes were saved/i);
        expect(dialog.getByRole("button", { name: "save contact" })).toBeDisabled();
        await user.click(dialog.getByRole("button", { name: "Load latest contact" }));
        await dialog.findByRole("heading", { name: "Latest saved contact" });
        await user.click(dialog.getByRole("button", { name: "Reconcile changes" }));
        if (result === "success") {
          await user.click(dialog.getByRole("radio", { name: "Keep my draft for Employer" }));
          await user.click(dialog.getByRole("button", { name: "Apply choices" }));
        }
      }
      await user.click(dialog.getByRole("button", { name: "save contact" }));
      await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
      expect(update).toHaveBeenCalledTimes(2);
      expect(update.mock.calls[0]![1].employer).toBe("Submitted employer");
      expect(update.mock.calls[1]![1].employer).toBe("Newer draft employer");
      expect(source.current().attributes.some((fact) => fact.value === "after-submit@example.test")).toBe(true);
      if (result === "conflict") {
        expect(source.current().role).toBe("warm_intro");
        expect(source.current().attributes.find((fact) => fact.attributeId === other.attributeId)).toEqual(other);
      }
    },
  );

  it("does not let an earlier save close a reopened contact editor", async () => {
    const user = userEvent.setup();
    syntheticContactServer(makeContactDetail({ jobId: "00000000-0000-4000-8000-000000000011" }));
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    const originalUpdate = view.ports.api.updateContact.bind(view.ports.api);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const update = vi.spyOn(view.ports.api, "updateContact").mockImplementationOnce(async (id, body) => {
      await gate;
      return originalUpdate(id, body);
    });
    await user.click(await view.findByRole("button", { name: "Edit" }));
    let dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    await user.clear(dialog.getByLabelText("Employer"));
    await user.type(dialog.getByLabelText("Employer"), "Submitted employer");
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    await user.click(view.getByRole("button", { name: "Edit" }));
    dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    await user.clear(dialog.getByLabelText("Employer"));
    await user.type(dialog.getByLabelText("Employer"), "New session draft");
    await act(async () => { release(); await update.mock.results[0]!.value; });
    expect(view.getByRole("dialog", { name: "Edit contact" })).toBeInTheDocument();
    expect(dialog.getByLabelText("Employer")).toHaveValue("New session draft");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("retains a conflicted contact draft while a send-log request settles", async () => {
    const user = userEvent.setup();
    const source = syntheticContactServer(makeContactDetail({ jobId: "00000000-0000-4000-8000-000000000011" }));
    let finishSend!: (response: LogOutreachSendResponse) => void;
    const pendingSend = new Promise<LogOutreachSendResponse>((resolve) => { finishSend = resolve; });
    const logOutreachSend = vi.fn(() => pendingSend);
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />,
      { ports: buildTestPorts({ api: { logOutreachSend } }) });
    await user.click(await view.findByRole("button", { name: "Log a send" }));
    await user.click(view.getByRole("button", { name: "Record send" }));
    await waitFor(() => expect(logOutreachSend).toHaveBeenCalledTimes(1));
    await user.click(view.getByRole("button", { name: "Edit" }));
    const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    await user.clear(dialog.getByLabelText("Employer"));
    await user.type(dialog.getByLabelText("Employer"), "Retained draft employer");
    const added = { attributeId: "newer-imported", kind: "email", value: "newer@example.test",
      provenance: makeContactProvenance({ sourceRef: "synthetic-newer-source" }) };
    source.change((contact) => ({ ...contact, role: "warm_intro", attributes: [...contact.attributes, added] }));
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await dialog.findByRole("alert");
    await act(async () => { finishSend({ ok: true, sendLog: makeOutreachSendLog() }); await pendingSend; });
    expect(dialog.getByLabelText("Employer")).toHaveValue("Retained draft employer");
    expect(dialog.getByRole("button", { name: "save contact" })).toBeDisabled();
    await user.click(dialog.getByRole("button", { name: "Load latest contact" }));
    await dialog.findByText("newer@example.test");
    await user.click(dialog.getByRole("button", { name: "Reconcile changes" }));
    expect(dialog.getByLabelText("Employer")).toHaveValue("Retained draft employer");
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.current()).toMatchObject({ employer: "Retained draft employer", role: "warm_intro" });
    expect(source.current().attributes.find((fact) => fact.attributeId === added.attributeId)).toEqual(added);
    expect(logOutreachSend).toHaveBeenCalledTimes(1);
  });

  it("reconciles an employer-only draft with another editor's role and new sourced fact", async () => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    const source = syntheticContactServer(makeContactDetail({ jobId }));
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    const otherBase = (await view.ports.api.contact("contact-1")).contact;
    await user.clear(dialog.getByLabelText("Employer"));
    await user.type(dialog.getByLabelText("Employer"), "Draft employer");
    const other = await view.ports.api.updateContact("contact-1", {
      expectedFingerprint: otherBase.fingerprint, role: "warm_intro",
      attributes: [...otherBase.attributes.map(({ kind, value }) => ({ kind: kind as ContactAttributeKind, value })),
        { kind: "email", value: "newer@example.test" }],
    });
    const added = other.contact.attributes.find((fact) => fact.value === "newer@example.test")!;
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await dialog.findByRole("alert");
    await user.click(dialog.getByRole("button", { name: "Load latest contact" }));
    await dialog.findByText("newer@example.test");
    await user.click(dialog.getByRole("button", { name: "Reconcile changes" }));
    expect(dialog.getByLabelText("Employer")).toHaveValue("Draft employer");
    expect(dialog.getByRole("combobox", { name: "Role" })).toHaveTextContent("Warm intro");
    expect(dialog.getAllByLabelText("Value").some((input) => (input as HTMLInputElement).value === "newer@example.test")).toBe(true);
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.current()).toMatchObject({ employer: "Draft employer", role: "warm_intro" });
    expect(source.current().attributes.find((fact) => fact.value === "newer@example.test")).toEqual(added);
    expect(source.requests.at(-1)?.attributes).toBeUndefined();
  });

  it("requires an explicit choice when both editors change the employer", async () => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    const source = syntheticContactServer(makeContactDetail({ jobId }));
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    const otherBase = (await view.ports.api.contact("contact-1")).contact;
    await user.clear(dialog.getByLabelText("Employer"));
    await user.type(dialog.getByLabelText("Employer"), "My employer");
    await view.ports.api.updateContact("contact-1", { expectedFingerprint: otherBase.fingerprint, employer: "Other employer" });
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await dialog.findByRole("alert");
    await user.click(dialog.getByRole("button", { name: "Load latest contact" }));
    await dialog.findByText("Other employer");
    await user.click(dialog.getByRole("button", { name: "Reconcile changes" }));
    expect(dialog.getByRole("button", { name: "Apply choices" })).toBeDisabled();
    expect(await axe(view.getByRole("dialog", { name: "Edit contact" }))).toHaveNoViolations();
    expect(dialog.getByLabelText("Employer")).toHaveValue("My employer");
    expect(source.current().employer).toBe("Other employer");
    await user.click(dialog.getByRole("radio", { name: "Keep my draft for Employer" }));
    await user.click(dialog.getByRole("button", { name: "Apply choices" }));
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.current().employer).toBe("My employer");
  });

  it("preserves a newer duplicate fact's identity when the draft deletes the original", async () => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    const source = syntheticContactServer(makeContactDetail({ jobId }));
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    const otherBase = (await view.ports.api.contact("contact-1")).contact;
    const original = otherBase.attributes[2]!;
    await user.click(dialog.getByRole("button", { name: "Remove fact 3" }));
    const other = await view.ports.api.updateContact("contact-1", { expectedFingerprint: otherBase.fingerprint,
      attributes: [...otherBase.attributes.map(({ kind, value }) => ({ kind: kind as ContactAttributeKind, value })),
        { kind: "email", value: original.value }] });
    const newer = other.contact.attributes.find((fact) => fact.value === original.value && fact.attributeId !== original.attributeId)!;
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await dialog.findByRole("alert");
    await user.click(dialog.getByRole("button", { name: "Load latest contact" }));
    await dialog.findByRole("heading", { name: "Latest saved contact" });
    await user.click(dialog.getByRole("button", { name: "Reconcile changes" }));
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.current().attributes.find((fact) => fact.attributeId === newer.attributeId)).toEqual(newer);
    expect(source.current().attributes.find((fact) => fact.attributeId === original.attributeId)).toBeUndefined();
    expect(source.requests.at(-1)?.attributes).toContainEqual({ attributeId: newer.attributeId, kind: "email", value: original.value });
  });

  it.each([
    { choice: "Keep added fact", retained: true },
    { choice: "Remove added fact", retained: false },
  ])("requires '$choice' when another editor replaces a deleted draft fact", async ({ choice, retained }) => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    const source = syntheticContactServer(makeContactDetail({ jobId }));
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    const otherBase = (await view.ports.api.contact("contact-1")).contact;
    await user.click(dialog.getByRole("button", { name: "Remove fact 3" }));
    const other = await view.ports.api.updateContact("contact-1", { expectedFingerprint: otherBase.fingerprint,
      attributes: [...otherBase.attributes.slice(0, 2).map(({ kind, value }) => ({ kind: kind as ContactAttributeKind, value })),
        { attributeId: otherBase.attributes[2]!.attributeId, kind: "email", value: "revised@example.test" }] });
    const revised = other.contact.attributes.find((fact) => fact.value === "revised@example.test")!;
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await dialog.findByRole("alert");
    await user.click(dialog.getByRole("button", { name: "Load latest contact" }));
    await dialog.findByText("revised@example.test");
    await user.click(dialog.getByRole("button", { name: "Reconcile changes" }));
    expect(dialog.getByText(/relationship is unknown/i)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Apply choices" })).toBeDisabled();
    await user.click(dialog.getByRole("radio", { name: `${choice} for New fact 1` }));
    await user.click(dialog.getByRole("button", { name: "Apply choices" }));
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    const after = source.current().attributes.find((fact) => fact.value === "revised@example.test");
    if (retained) expect(after).toEqual(revised);
    else expect(after).toBeUndefined();
  });

  it("requires an explicit choice when a drafted fact was deleted by another editor", async () => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    const source = syntheticContactServer(makeContactDetail({ jobId }));
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    const otherBase = (await view.ports.api.contact("contact-1")).contact;
    await user.clear(dialog.getAllByLabelText("Value")[2]!);
    await user.type(dialog.getAllByLabelText("Value")[2]!, "draft@example.test");
    await view.ports.api.updateContact("contact-1", { expectedFingerprint: otherBase.fingerprint,
      attributes: otherBase.attributes.slice(0, 2).map(({ kind, value }) => ({ kind: kind as ContactAttributeKind, value })) });
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await dialog.findByRole("alert");
    await user.click(dialog.getByRole("button", { name: "Load latest contact" }));
    await dialog.findByRole("heading", { name: "Latest saved contact" });
    await user.click(dialog.getByRole("button", { name: "Reconcile changes" }));
    expect(dialog.getByRole("button", { name: "Apply choices" })).toBeDisabled();
    expect(dialog.getByDisplayValue("draft@example.test")).toBeInTheDocument();
    await user.click(dialog.getByRole("radio", { name: "Keep latest for Fact 3" }));
    await user.click(dialog.getByRole("button", { name: "Apply choices" }));
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.current().attributes).toHaveLength(2);
    expect(source.current().attributes.find((fact) => fact.value === "draft@example.test")).toBeUndefined();
  });

  it("requires a choice when the draft edits a fact whose provenance changed", async () => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    const source = syntheticContactServer(makeContactDetail({ jobId }));
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    await user.clear(dialog.getAllByLabelText("Value")[2]!);
    await user.type(dialog.getAllByLabelText("Value")[2]!, "draft@example.test");
    source.change((contact) => {
      contact.attributes[2]!.provenance.sourceRef = "synthetic-newer-source";
      return contact;
    });
    const newer = source.current().attributes[2]!;
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await dialog.findByRole("alert");
    await user.click(dialog.getByRole("button", { name: "Load latest contact" }));
    await dialog.findByText("synthetic-newer-source");
    await user.click(dialog.getByRole("button", { name: "Reconcile changes" }));
    await user.click(dialog.getByRole("radio", { name: "Keep latest for Fact 3" }));
    await user.click(dialog.getByRole("button", { name: "Apply choices" }));
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.current().attributes[2]).toEqual(newer);
    expect(source.requests.at(-1)?.attributes).toBeUndefined();
  });

  it("invalidates pending conflict choices if the draft is edited before applying them", async () => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    const source = syntheticContactServer(makeContactDetail({ jobId }));
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    const otherBase = (await view.ports.api.contact("contact-1")).contact;
    await user.clear(dialog.getByLabelText("Employer"));
    await user.type(dialog.getByLabelText("Employer"), "First draft");
    await view.ports.api.updateContact("contact-1", { expectedFingerprint: otherBase.fingerprint, employer: "Other employer" });
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await dialog.findByRole("alert");
    await user.click(dialog.getByRole("button", { name: "Load latest contact" }));
    await dialog.findByText("Other employer");
    await user.click(dialog.getByRole("button", { name: "Reconcile changes" }));
    await user.click(dialog.getByRole("radio", { name: "Keep my draft for Employer" }));
    await user.clear(dialog.getByLabelText("Employer"));
    await user.type(dialog.getByLabelText("Employer"), "Edited after review");
    await user.click(dialog.getByRole("button", { name: "Apply choices" }));
    expect(dialog.getByText(/draft or the loaded contact changed/i)).toBeInTheDocument();
    expect(dialog.getByLabelText("Employer")).toHaveValue("Edited after review");
    expect(dialog.getByRole("button", { name: "save contact" })).toBeDisabled();
    expect(source.current().employer).toBe("Other employer");
    await user.click(dialog.getByRole("button", { name: "Reconcile changes" }));
    await user.click(dialog.getByRole("radio", { name: "Keep my draft for Employer" }));
    await user.click(dialog.getByRole("button", { name: "Apply choices" }));
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.current().employer).toBe("Edited after review");
  });

  it("preserves an unsupported saved fact during other edits and refuses changing it implicitly", async () => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    const initial = makeContactDetail({ jobId });
    initial.attributes = [...initial.attributes, { attributeId: "legacy-fact", kind: "legacy_kind",
      value: "Synthetic retained value", provenance: makeContactProvenance({ sourceRef: "synthetic-legacy" }) }];
    const source = syntheticContactServer(initial);
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    let dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    expect(dialog.getByText(/Saved fact type: legacy_kind/)).toBeInTheDocument();
    await user.clear(dialog.getByLabelText("Employer"));
    await user.type(dialog.getByLabelText("Employer"), "Unrelated edit");
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.requests.at(-1)?.attributes).toBeUndefined();
    expect(source.current().attributes).toEqual(initial.attributes);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    await user.clear(dialog.getAllByLabelText("Value")[0]!);
    await user.type(dialog.getAllByLabelText("Value")[0]!, "Changed draft");
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.current().attributes.find((fact) => fact.attributeId === "legacy-fact")).toEqual(initial.attributes[3]);
    const latest = source.current();
    await waitFor(() => expect(view.queryClient.getQueryData<{ contact: ContactDetail }>(
      outreachKeys.contactDetail(LOCAL_TENANT, "contact-1"))?.contact.fingerprint).toBe(latest.fingerprint));
    await user.click(await view.findByRole("button", { name: "Edit" }));
    dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    await user.clear(dialog.getAllByLabelText("Value")[3]!);
    await user.type(dialog.getAllByLabelText("Value")[3]!, "Changed legacy value");
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    expect(dialog.getByText(/cannot change an unsupported saved fact/i)).toBeInTheDocument();
    expect(dialog.getByDisplayValue("Changed legacy value")).toBeInTheDocument();
    expect(source.requests).toHaveLength(2);
    expect(source.current().attributes.find((fact) => fact.attributeId === "legacy-fact")).toEqual(initial.attributes[3]);
  });

  it("preserves a saved fact's provenance when input whitespace normalizes to the same value", async () => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    const initial = makeContactDetail({ jobId });
    const source = syntheticContactServer(initial);
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    await user.type(dialog.getAllByLabelText("Value")[2]!, " ");
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.requests.at(-1)?.attributes).toBeUndefined();
    expect(source.current().attributes).toEqual(initial.attributes);
  });

  it("retains a 2,000-character sourced fact when whitespace is appended and another fact changes", async () => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    const initial = makeContactDetail({ jobId });
    initial.attributes = structuredClone(initial.attributes);
    initial.attributes[1] = { ...initial.attributes[1]!, value: "é".repeat(2000),
      provenance: makeContactProvenance({ sourceKind: "user_imported_list", sourceRef: "synthetic-boundary-import" }) };
    const original = structuredClone(initial.attributes[1]!);
    const source = syntheticContactServer(initial);
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    const values = dialog.getAllByLabelText("Value");
    fireEvent.change(values[1]!, { target: { value: `${original.value} ` } });
    fireEvent.change(values[2]!, { target: { value: "changed@example.test" } });
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.requests.at(-1)?.attributes).toContainEqual({
      attributeId: original.attributeId, kind: original.kind, value: original.value,
    });
    expect(source.requests.at(-1)?.attributes).toContainEqual({
      attributeId: initial.attributes[2]!.attributeId, kind: "email", value: "changed@example.test",
    });
    const retained = source.current().attributes.find((fact) => fact.attributeId === original.attributeId);
    expect(retained).toEqual(original);
    expect(Buffer.from(retained!.value, "utf8")).toEqual(Buffer.from(original.value, "utf8"));
    expect(source.current().attributes.find((fact) => fact.value === "changed@example.test")).toBeDefined();
  });

  it("saves unrelated and other-fact edits while retaining a long sourced fact exactly", async () => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    const initial = makeContactDetail({ jobId });
    initial.attributes = structuredClone(initial.attributes);
    initial.attributes[1] = { ...initial.attributes[1]!, value: "L".repeat(2001),
      provenance: makeContactProvenance({ sourceKind: "user_imported_list", sourceRef: "synthetic-long-import" }) };
    const source = syntheticContactServer(initial);
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    let dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    await user.clear(dialog.getByLabelText("Employer"));
    await user.type(dialog.getByLabelText("Employer"), "Unrelated employer");
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.requests.at(-1)?.attributes).toBeUndefined();
    expect(source.current().attributes[1]).toEqual(initial.attributes[1]);
    await waitFor(() => expect(view.queryClient.getQueryData<{ contact: ContactDetail }>(
      outreachKeys.contactDetail(LOCAL_TENANT, "contact-1"))?.contact.employer).toBe("Unrelated employer"));
    await user.click(await view.findByRole("button", { name: "Edit" }));
    dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    await user.clear(dialog.getAllByLabelText("Value")[2]!);
    await user.type(dialog.getAllByLabelText("Value")[2]!, "other@example.test");
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.current().attributes.find((fact) => fact.attributeId === initial.attributes[1]!.attributeId)).toEqual(initial.attributes[1]);
    expect(source.requests.at(-1)?.attributes).toContainEqual({ attributeId: initial.attributes[1]!.attributeId, kind: "title", value: "L".repeat(2001) });
    const latest = source.current();
    await waitFor(() => expect(view.queryClient.getQueryData<{ contact: ContactDetail }>(
      outreachKeys.contactDetail(LOCAL_TENANT, "contact-1"))?.contact.fingerprint).toBe(latest.fingerprint));
    await user.click(await view.findByRole("button", { name: "Edit" }));
    dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    fireEvent.change(dialog.getAllByLabelText("Value")[1]!, { target: { value: "X".repeat(2001) } });
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    expect(dialog.getByText(/2000/)).toBeInTheDocument();
    expect(source.requests).toHaveLength(2);
    expect(source.current().attributes.find((fact) => fact.attributeId === initial.attributes[1]!.attributeId)).toEqual(initial.attributes[1]);
  });

  it("accepts a new 2,000-character fact with surrounding input whitespace", async () => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    const source = syntheticContactServer(makeContactDetail({ jobId }));
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    await user.click(dialog.getByRole("button", { name: "Add fact" }));
    fireEvent.change(dialog.getAllByLabelText("Value").at(-1)!, { target: { value: `${"N".repeat(2000)} ` } });
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(source.current().attributes.find((fact) => fact.value === "N".repeat(2000))).toBeDefined();
  });

  it("retains a draft after a lost write acknowledgement and fences a deliberate retry", async () => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    let canonical = makeContactDetail({ jobId });
    const requests: ContactUpdateRequest[] = [];
    let committedWrites = 0;
    server.use(
      http.get("*/v1/contacts/:contactId", () => HttpResponse.json({ ok: true, contact: canonical })),
      http.patch("*/v1/contacts/:contactId", async ({ request }) => {
        const body = await request.json() as ContactUpdateRequest;
        requests.push(body);
        if (body.expectedFingerprint !== canonical.fingerprint) {
          return HttpResponse.json({ ok: false, error: "contact_revision_conflict", message: "Contact changed" }, { status: 409 });
        }
        committedWrites += 1;
        canonical = { ...canonical, role: body.role ?? canonical.role,
          employer: body.employer === undefined ? canonical.employer : body.employer,
          fingerprint: committedWrites === 1 ? "b".repeat(64) : "d".repeat(64) };
        return committedWrites === 1 ? HttpResponse.error() : HttpResponse.json({ ok: true, contact: canonical });
      }),
    );
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    const update = vi.spyOn(view.ports.api, "updateContact");
    await user.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    await user.clear(dialog.getByLabelText("Employer"));
    await user.type(dialog.getByLabelText("Employer"), "My retained draft");
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await dialog.findByText(/could not confirm the response/i);
    await expect(update.mock.results[0]!.value).rejects.toBeInstanceOf(JobCtrlApiUnconfirmedWriteError);
    expect(requests).toHaveLength(1);
    expect(committedWrites).toBe(1);
    expect(dialog.getByLabelText("Employer")).toHaveValue("My retained draft");

    canonical = { ...canonical, employer: "Newer saved employer", fingerprint: "c".repeat(64) };
    const newer = structuredClone(canonical);
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await dialog.findByRole("alert");
    expect(requests[1]?.expectedFingerprint).toBe("a".repeat(64));
    expect(committedWrites).toBe(1);
    expect(canonical).toEqual(newer);
    expect(dialog.getByLabelText("Employer")).toHaveValue("My retained draft");

    await user.click(dialog.getByRole("button", { name: "Load latest contact" }));
    await dialog.findByText("Newer saved employer");
    await user.click(dialog.getByRole("button", { name: "Reconcile changes" }));
    await user.click(dialog.getByRole("radio", { name: "Keep latest for Employer" }));
    await user.click(dialog.getByRole("button", { name: "Apply choices" }));
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(requests[2]?.expectedFingerprint).toBe("c".repeat(64));
    expect(committedWrites).toBe(2);
    expect(canonical.employer).toBe("Newer saved employer");
  });

  it("pins the edit base through refetch, retains every draft field through repeated conflicts and explicitly reconciles", async () => {
    const user = userEvent.setup();
    const jobId = "00000000-0000-4000-8000-000000000011";
    let canonical = makeContactDetail({ jobId });
    const requests: ContactUpdateRequest[] = [];
    server.use(
      http.get("*/v1/contacts/:contactId", () => HttpResponse.json({ ok: true, contact: canonical })),
      http.patch("*/v1/contacts/:contactId", async ({ request }) => {
        const body = await request.json() as ContactUpdateRequest;
        requests.push(body);
        if (body.expectedFingerprint !== canonical.fingerprint) {
          return HttpResponse.json({ ok: false, error: "contact_revision_conflict", message: "Contact changed" }, { status: 409 });
        }
        canonical = { ...canonical, ...body, attributes: canonical.attributes, fingerprint: "f".repeat(64) } as typeof canonical;
        return HttpResponse.json({ ok: true, contact: canonical });
      }),
    );
    const view = renderWithProviders(<OutreachDetailDrawer contactId="contact-1" onClose={vi.fn()} />);
    await user.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(view.getByRole("dialog", { name: "Edit contact" }));
    await user.clear(dialog.getByLabelText("Employer"));
    await user.type(dialog.getByLabelText("Employer"), "My draft employer");
    await user.clear(dialog.getAllByLabelText("Value")[0]!);
    await user.type(dialog.getAllByLabelText("Value")[0]!, "My draft name");
    await user.click(dialog.getByRole("combobox", { name: "Role" }));
    await user.click(await view.findByRole("option", { name: "Referrer" }));
    canonical = { ...canonical, employer: "Newer canonical employer", role: "warm_intro", fingerprint: "b".repeat(64) };
    await act(async () => { await view.queryClient.refetchQueries({ queryKey: outreachKeys.contactDetail(LOCAL_TENANT, "contact-1") }); });
    expect(dialog.getByLabelText("Employer")).toHaveValue("My draft employer");
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await dialog.findByRole("alert");
    expect(requests[0]?.expectedFingerprint).toBe("a".repeat(64));
    expect(requests[0]).toMatchObject({ role: "referrer", employer: "My draft employer",
      attributes: expect.arrayContaining([expect.objectContaining({ attributeId: "attr-name", kind: "name", value: "My draft name" })]) });
    expect(requests[0]?.jobId).toBeUndefined();
    expect(dialog.getByRole("button", { name: "save contact" })).toBeDisabled();
    expect(dialog.getByLabelText("Employer")).toHaveValue("My draft employer");
    expect(dialog.getAllByLabelText("Value")[0]).toHaveValue("My draft name");
    expect(dialog.getByLabelText("Job")).toHaveValue(jobId);
    expect(dialog.getByRole("combobox", { name: "Role" })).toHaveTextContent("Referrer");
    const stored = view.queryClient.getQueryData<{ contact: typeof canonical }>(outreachKeys.contactDetail(LOCAL_TENANT, "contact-1"));
    expect(stored?.contact.employer).toBe("Newer canonical employer");
    await user.click(dialog.getByRole("button", { name: "Load latest contact" }));
    await dialog.findByRole("heading", { name: "Latest saved contact" });
    expect(dialog.getByText("Newer canonical employer")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "save contact" })).toBeDisabled();
    expect(await axe(view.getByRole("dialog", { name: "Edit contact" }))).toHaveNoViolations();
    await user.click(dialog.getByRole("button", { name: "Reconcile changes" }));
    await user.click(dialog.getByRole("radio", { name: "Keep my draft for Role" }));
    await user.click(dialog.getByRole("radio", { name: "Keep my draft for Employer" }));
    await user.click(dialog.getByRole("button", { name: "Apply choices" }));
    canonical = { ...canonical, fingerprint: "c".repeat(64), employer: "Changed again" };
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await dialog.findByRole("alert");
    expect(requests[1]?.expectedFingerprint).toBe("b".repeat(64));
    expect(dialog.getByLabelText("Employer")).toHaveValue("My draft employer");
    await user.click(dialog.getByRole("button", { name: "Load latest contact" }));
    await dialog.findByText("Changed again");
    await user.click(dialog.getByRole("button", { name: "Reconcile changes" }));
    await user.click(dialog.getByRole("radio", { name: "Keep my draft for Employer" }));
    await user.click(dialog.getByRole("button", { name: "Apply choices" }));
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Edit contact" })).not.toBeInTheDocument());
    expect(requests[2]?.expectedFingerprint).toBe("c".repeat(64));
    expect(requests[2]?.employer).toBe("My draft employer");
  });
  it("shows the contact's facts and composes the outreach draft review surface", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = renderWithProviders(
      <OutreachDetailDrawer contactId="contact-1" onClose={onClose} />,
    );
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Dana Reyes" })).toBeInTheDocument(),
    );
    expect(view.getByRole("heading", { name: "Dana Reyes" })).toHaveAttribute(
      "data-typography",
      "page-title",
    );
    // Phase 1 facts + provenance remain.
    expect(view.getByText("dana.reyes@acme.example")).toBeInTheDocument();
    // Phase 3 outreach thread panel is composed into the drawer (contact-only thread).
    await waitFor(() =>
      expect(view.getByRole("heading", { name: "Outreach" })).toBeInTheDocument(),
    );
    expect(view.getByRole("heading", { name: "Approved message" })).toBeInTheDocument();
    expect(view.getByRole("article", { name: "Contact details" })).toHaveClass(
      "route-workspace",
      "contact-detail-workspace",
    );
    expect(
      view.queryByRole("dialog", { name: "Contact details" }),
    ).not.toBeInTheDocument();

    await user.click(view.getByRole("button", { name: "Back to contacts" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
