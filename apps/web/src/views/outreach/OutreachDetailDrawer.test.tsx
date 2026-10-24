import { userEvent } from "@testing-library/user-event";
import { waitFor, within } from "@testing-library/react";
import { act } from "react";
import { http, HttpResponse } from "msw";
import { axe } from "jest-axe";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import type { ContactUpdateRequest } from "@jobctrl/contracts";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../test/render.js";
import { OutreachDetailDrawer } from "./OutreachDetailDrawer.js";
import { makeContactDetail } from "../../test/fixtures/contacts.js";
import { server } from "../../test/msw/server.js";
import { outreachKeys } from "../../contexts/outreach/queryKeys.js";

describe("<OutreachDetailDrawer>", () => {
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
    expect(requests[0]).toMatchObject({ role: "referrer", employer: "My draft employer", jobId,
      attributes: expect.arrayContaining([{ kind: "name", value: "My draft name" }]) });
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
    await user.click(dialog.getByRole("button", { name: "I reviewed the latest contact; keep my draft" }));
    canonical = { ...canonical, fingerprint: "c".repeat(64), employer: "Changed again" };
    await user.click(dialog.getByRole("button", { name: "save contact" }));
    await dialog.findByRole("alert");
    expect(requests[1]?.expectedFingerprint).toBe("b".repeat(64));
    expect(dialog.getByLabelText("Employer")).toHaveValue("My draft employer");
    await user.click(dialog.getByRole("button", { name: "Load latest contact" }));
    await dialog.findByText("Changed again");
    await user.click(dialog.getByRole("button", { name: "I reviewed the latest contact; keep my draft" }));
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
