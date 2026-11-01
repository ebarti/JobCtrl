import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { expect, it } from "vitest";

import { makeContactListResponse, makeContactSummary } from "../../../test/fixtures/contacts.js";
import { makeCandidateThread, makeOutreachPublicationConflict, makeOutreachThreadResponse } from "../../../test/fixtures/outreach.js";
import { server } from "../../../test/msw/server.js";
import { renderWithProviders } from "../../../test/render.js";
import { outreachKeys } from "../queryKeys.js";
import { OfferCommunication } from "./OfferCommunication.js";

it("keeps recipient A's conflicted edit suspended while the offer recipient selector shows cached B", async () => {
  const jobId = "00000000-0000-4000-8000-000000000001";
  const recipientA = makeContactSummary({ contactId: "contact-A", displayName: "Synthetic recipient A", jobId });
  const recipientB = makeContactSummary({ contactId: "contact-B", displayName: "Synthetic recipient B", jobId });
  const threadA = { ...makeCandidateThread(), threadId: "thread-A", contactId: recipientA.contactId, jobId };
  const threadB = { ...makeCandidateThread(), threadId: "thread-B", contactId: recipientB.contactId, jobId };
  const requests: string[] = [];
  server.use(
    http.get("*/v1/contacts", () => HttpResponse.json(makeContactListResponse([recipientA, recipientB]))),
    http.get("*/v1/contacts/:contactId/outreach", ({ params }) => HttpResponse.json(makeOutreachThreadResponse(params.contactId === recipientA.contactId ? threadA : threadB))),
    http.post("*/v1/outreach/threads/:threadId/drafts", ({ params }) => {
      requests.push(String(params.threadId));
      return HttpResponse.json({ ...makeOutreachPublicationConflict("Edit for recipient A"), threadId: threadA.threadId }, { status: 409 });
    }),
  );
  const view = renderWithProviders(<OfferCommunication jobId={jobId} revisionId="00000000-0000-4000-8000-000000000011" />);
  view.queryClient.setQueryData(outreachKeys.threadForContact(LOCAL_TENANT, recipientB.contactId, jobId), makeOutreachThreadResponse(threadB));
  const user = userEvent.setup();
  await user.click(view.getByText("Draft an offer communication"));
  const select = await view.findByRole("combobox", { name: "Offer recipient" });
  await user.click(select);
  await user.click(await view.findByRole("option", { name: recipientA.displayName }));
  await view.findByRole("heading", { name: "Draft under review" });
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "Edit for recipient A" } });
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  await view.findByRole("group", { name: "Unpublished revision" });
  await user.click(select);
  await user.click(await view.findByRole("option", { name: recipientB.displayName }));
  expect(view.queryByRole("textbox")).not.toBeInTheDocument();
  expect(view.queryByRole("checkbox", { name: /I compared the current thread/ })).not.toBeInTheDocument();
  expect(requests).toEqual(["thread-A"]);
  await user.click(select);
  await user.click(await view.findByRole("option", { name: recipientA.displayName }));
  expect(view.getByRole("textbox")).toHaveValue("Edit for recipient A");
  const proposal = view.getByRole("group", { name: "Unpublished revision" });
  fireEvent.click(within(proposal).getByRole("checkbox", { name: /I compared the current thread/ }));
  fireEvent.click(view.getByRole("button", { name: "Revise draft" }));
  await waitFor(() => expect(requests).toEqual(["thread-A", "thread-A"]));
  console.info(JSON.stringify({ entry: "OfferCommunication recipient selector", requests, recipientA: recipientA.contactId, recipientB: recipientB.contactId, cachedB: true }));
});
