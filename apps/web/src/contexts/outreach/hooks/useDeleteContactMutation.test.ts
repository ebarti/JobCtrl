import type { ContactListResponse } from "@jobctl/contracts";
import { LOCAL_TENANT } from "@jobctl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import {
  makeContactListResponse,
  sampleContactSummary,
  sampleSecondaryContactSummary,
} from "../../../test/fixtures/contacts.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { outreachKeys } from "../queryKeys.js";
import { useDeleteContactMutation } from "./useDeleteContactMutation.js";

describe("useDeleteContactMutation", () => {
  it("optimistically removes the row and resolves on success", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useDeleteContactMutation());
    queryClient.setQueryData(
      outreachKeys.contactList(LOCAL_TENANT, {}),
      makeContactListResponse([sampleContactSummary, sampleSecondaryContactSummary]),
    );
    await act(async () => {
      result.current.mutate({ contactId: sampleContactSummary.contactId });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the removed row when the DELETE fails", async () => {
    server.use(
      http.delete("*/v1/contacts/:contactId", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useDeleteContactMutation());
    queryClient.setQueryData(
      outreachKeys.contactList(LOCAL_TENANT, {}),
      makeContactListResponse([sampleContactSummary, sampleSecondaryContactSummary]),
    );
    await act(async () => {
      result.current.mutate({ contactId: sampleContactSummary.contactId });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = queryClient.getQueryData(
      outreachKeys.contactList(LOCAL_TENANT, {}),
    ) as ContactListResponse;
    expect(restored.items.map((contact) => contact.contactId)).toContain(
      sampleContactSummary.contactId,
    );
  });
});
