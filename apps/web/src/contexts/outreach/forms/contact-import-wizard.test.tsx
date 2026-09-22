import type { ContactImportRequest, ContactImportResponse } from "@jobctrl/contracts";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderWithProviders } from "../../../test/render.js";
import { useOutreachImportStore } from "../stores/outreach-import-store.js";
import { ContactImportWizard } from "./contact-import-wizard.js";

function reviewedResponse(mode: "preview" | "commit"): ContactImportResponse {
  return {
    ok: true,
    format: "vcard",
    mode,
    imported: mode === "commit" ? 1 : 0,
    skipped: 2,
    contactIds: mode === "commit" ? ["contact-new"] : [],
    summary: { total: 3, ready: 1, duplicates: 1, invalid: 1, unsupported: 1 },
    items: [
      {
        index: 1,
        status: "ready",
        displayName: "Dana Reyes",
        employer: "Acme",
        jobId: null,
        role: "other",
        attributes: [
          { kind: "name", value: "Dana Reyes" },
          { kind: "title", value: "VP Talent" },
          { kind: "email", value: "dana@acme.example" },
        ],
        duplicate: null,
        issues: [{ code: "unsupported_property", message: "PHOTO is not imported.", severity: "warning", property: "PHOTO" }],
        importedContactId: mode === "commit" ? "contact-new" : null,
      },
      {
        index: 2,
        status: "duplicate",
        displayName: "Dana Reyes",
        employer: "Acme",
        jobId: null,
        role: "other",
        attributes: [{ kind: "email", value: "dana@acme.example" }],
        duplicate: { scope: "batch", contactId: null, itemIndex: 1 },
        issues: [],
        importedContactId: null,
      },
      {
        index: 3,
        status: "invalid",
        displayName: "No Employer",
        employer: null,
        jobId: null,
        role: "other",
        attributes: [{ kind: "name", value: "No Employer" }],
        duplicate: null,
        issues: [{ code: "missing_employer", message: "ORG is required.", severity: "error", property: "ORG" }],
        importedContactId: null,
      },
    ],
  };
}

describe("<ContactImportWizard>", () => {
  it("shows server parsed facts and outcomes before an explicit commit", async () => {
    const requests: ContactImportRequest[] = [];
    server.use(
      http.post("*/v1/contacts/import", async ({ request }) => {
        const body = (await request.json()) as ContactImportRequest;
        requests.push(body);
        return HttpResponse.json(reviewedResponse("csvText" in body ? "commit" : body.mode));
      }),
    );
    useOutreachImportStore.getState().reset();
    useOutreachImportStore.getState().setUpload(
      "vcard",
      "network.vcf",
      "BEGIN:VCARD\nVERSION:4.0\nFN:Dana Reyes\nORG:Acme\nEND:VCARD",
    );
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ContactImportWizard onDone={onDone} />);

    await user.click(screen.getByRole("button", { name: "Preview import" }));

    expect(await screen.findByText("VP Talent")).toBeInTheDocument();
    expect(screen.getByText("PHOTO is not imported.")).toBeInTheDocument();
    expect(screen.getByText("ORG is required.")).toBeInTheDocument();
    expect(screen.getByText(/Duplicate of item 1/)).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(screen.getByRole("list", { name: "Contact import preview" })).toHaveAttribute("tabindex", "0");
    expect(requests[0]).toMatchObject({ format: "vcard", mode: "preview", filename: "network.vcf" });

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("network.vcf")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm import" }));

    expect(onDone).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ format: "vcard", mode: "commit", filename: "network.vcf" });
  });
});
