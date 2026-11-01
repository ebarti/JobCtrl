import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DemoFeatureFlagAdapter } from "../../../demo/ports.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { GenerateDraftButton } from "./GenerateDraftButton.js";

describe("<GenerateDraftButton>", () => {
  it("fails closed in the public demo before generating a message", async () => {
    const generateOutreachDraft = vi.fn();
    const ports = buildTestPorts({ api: { generateOutreachDraft } });
    ports.featureFlags = new DemoFeatureFlagAdapter();

    renderWithProviders(<GenerateDraftButton contactId="contact-1" />, { ports });

    const button = screen.getByRole("button", { name: "Generate draft" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      /Draft generation is available in the local app.*does not create messages or use personal contact information/i,
    );
    await userEvent.setup().click(button);
    expect(generateOutreachDraft).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Install JobCtrl" })).toHaveAttribute(
      "href",
      "https://jobctrl.dev/user/getting-started",
    );
  });
});

it("retains a generation conflict through refresh and a failed deliberate retry", async () => {
  const { fireEvent, waitFor, within } = await import("@testing-library/react");
  const { http, HttpResponse } = await import("msw");
  const { server } = await import("../../../test/msw/server.js");
  const { makeOutreachPublicationConflict, makeOutreachThreadResponse } = await import("../../../test/fixtures/outreach.js");
  const { outreachKeys } = await import("../queryKeys.js");
  const { LOCAL_TENANT } = await import("@jobctrl/domain-types");
  const conflict = makeOutreachPublicationConflict("Completed unpublished generated message");
  const requests: unknown[] = [];
  let retryResponse: (response: Response) => void = () => {};
  server.use(http.post("*/v1/contacts/:contactId/outreach/drafts", async ({ request }) => {
    requests.push(await request.json());
    if (requests.length === 1) return HttpResponse.json(conflict, { status: 409 });
    return new Promise<Response>((resolve) => { retryResponse = resolve; });
  }));
  const view = renderWithProviders(<GenerateDraftButton contactId="contact-1" />);
  fireEvent.click(view.getByRole("button", { name: "Generate draft" }));
  const proposal = await view.findByRole("group", { name: "Unpublished draft" });
  expect(view.getByRole("button", { name: "Generate draft" })).toBeDisabled();
  expect(within(proposal).getByText(conflict.unpublishedDraft.bodyText)).toBeInTheDocument();
  expect(within(proposal).getByText(/synthetic-claim-review/)).toBeInTheDocument();
  expect(within(proposal).getByText(/claimId/)).toBeInTheDocument();
  const { axe } = await import("jest-axe");
  expect(await axe(view.container)).toHaveNoViolations();
  view.queryClient.setQueryData(outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null), makeOutreachThreadResponse());
  fireEvent.click(within(proposal).getByRole("checkbox", { name: /I compared the current thread/ }));
  fireEvent.click(view.getByRole("button", { name: "Generate draft" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(view.getByRole("group", { name: "Unpublished draft" })).toBeInTheDocument();
  retryResponse(HttpResponse.json({ message: "Owned provider unavailable" }, { status: 503 }));
  await view.findByText("Owned provider unavailable");
  expect(view.getByRole("group", { name: "Unpublished draft" })).toHaveTextContent(conflict.unpublishedDraft.bodyText);
  expect(view.getByRole("button", { name: "Generate draft" })).toBeDisabled();
  expect(requests).toEqual([{}, {}]);
  fireEvent.click(view.getByRole("button", { name: "Discard unpublished draft" }));
  expect(view.queryByRole("group", { name: "Unpublished draft" })).not.toBeInTheDocument();
  expect(view.queryByText("Owned provider unavailable")).not.toBeInTheDocument();
  expect(view.getByRole("button", { name: "Generate draft" })).toBeEnabled();
  expect(requests).toHaveLength(2);
});

it.each(["recipient", "job", "purpose", "offer revision"])("isolates a delayed generation completion when the %s changes", async (change) => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const { http, HttpResponse } = await import("msw");
  const { server } = await import("../../../test/msw/server.js");
  const { makeOutreachPublicationConflict, makeOutreachThreadResponse } = await import("../../../test/fixtures/outreach.js");
  const original = { contactId: "contact-A", jobId: "00000000-0000-4000-8000-000000000001", kind: "offer_negotiation" as const, offerRevisionId: "00000000-0000-4000-8000-000000000011" };
  const next = {
    ...original,
    ...(change === "recipient" ? { contactId: "contact-B" } : {}),
    ...(change === "job" ? { jobId: "00000000-0000-4000-8000-000000000002" } : {}),
    ...(change === "purpose" ? { kind: "offer_decline" as const } : {}),
    ...(change === "offer revision" ? { offerRevisionId: "00000000-0000-4000-8000-000000000012" } : {}),
  };
  let release: (response: Response) => void = () => {};
  const requests: { target: string; body: unknown }[] = [];
  server.use(http.post("*/v1/contacts/:contactId/outreach/drafts", async ({ params, request }) => {
    requests.push({ target: String(params.contactId), body: await request.json() });
    if (requests.length === 1) return new Promise<Response>((resolve) => { release = resolve; });
    return HttpResponse.json(makeOutreachThreadResponse());
  }));
  const view = renderWithProviders(<GenerateDraftButton {...original} />);
  fireEvent.click(view.getByRole("button", { name: "Generate draft" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  view.rerender(<GenerateDraftButton {...next} />);
  expect(view.getByRole("button", { name: "Generate draft" })).toBeEnabled();
  fireEvent.click(view.getByRole("button", { name: "Generate draft" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  release(HttpResponse.json(makeOutreachPublicationConflict("Late completion for A"), { status: 409 }));
  await waitFor(() => expect(view.queryByRole("button", { name: "Generating…" })).not.toBeInTheDocument());
  expect(view.queryByRole("group", { name: "Unpublished draft" })).not.toBeInTheDocument();
  view.rerender(<GenerateDraftButton {...original} />);
  const retained = await view.findByRole("group", { name: "Unpublished draft" });
  expect(retained).toHaveTextContent("Late completion for A");
  expect(view.getByRole("button", { name: "Generate draft" })).toBeDisabled();
  expect(requests).toEqual([
    { target: original.contactId, body: { jobId: original.jobId, kind: original.kind, offerRevisionId: original.offerRevisionId } },
    { target: next.contactId, body: { jobId: next.jobId, kind: next.kind, offerRevisionId: next.offerRevisionId } },
  ]);
  console.info(JSON.stringify({ boundary: change, requests, retainedForOriginalOnly: true }));
});
