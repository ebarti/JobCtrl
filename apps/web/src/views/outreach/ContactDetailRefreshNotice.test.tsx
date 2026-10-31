import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { act } from "react";
import { expect, it, vi } from "vitest";

import { outreachKeys } from "../../contexts/outreach/queryKeys.js";
import { makeContactDetail, makeContactDetailResponse } from "../../test/fixtures/contacts.js";
import { createTestQueryClient, renderWithProviders } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { OutreachDetailDrawer } from "./OutreachDetailDrawer.js";

it("retains accepted contact details with a retryable notice after a failed refresh", async () => {
  const contact = makeContactDetail({ contactId: "contact-synthetic", displayName: "Synthetic contact" });
  const accepted = makeContactDetailResponse(contact);
  const getContact = vi.fn().mockRejectedValueOnce(new Error("Synthetic read failure")).mockResolvedValueOnce(accepted);
  const queryClient = createTestQueryClient();
  const key = outreachKeys.contactDetail(LOCAL_TENANT, contact.contactId);
  queryClient.setQueryData(key, accepted);
  const view = renderWithProviders(<OutreachDetailDrawer contactId={contact.contactId} onClose={() => {}} />, {
    queryClient, ports: buildTestPorts({ api: { contact: getContact } }),
  });
  await act(async () => { await queryClient.invalidateQueries({ queryKey: key, exact: true }); });
  expect(await view.findByText("Contact details could not be refreshed. The details shown may be out of date.")).toBeVisible();
  expect(view.getByRole("heading", { name: "Synthetic contact" })).toBeInTheDocument();
  await userEvent.setup().click(view.getByRole("button", { name: "Retry refresh" }));
  await waitFor(() => expect(view.queryByText("Contact details could not be refreshed. The details shown may be out of date.")).not.toBeInTheDocument());
  expect(getContact).toHaveBeenCalledTimes(2);
  expect(queryClient.getQueryData(key)).toEqual(accepted);
});
