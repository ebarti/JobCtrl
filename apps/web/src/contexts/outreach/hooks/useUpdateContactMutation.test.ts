import type { ContactDetailResponse } from "@jobhunter/contracts";
import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import {
  makeContactDetailResponse,
  makeContactListResponse,
  sampleContactDetail,
  sampleContactSummary,
} from "../../../test/fixtures/contacts.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { outreachKeys } from "../queryKeys.js";
import { useUpdateContactMutation } from "./useUpdateContactMutation.js";

describe("useUpdateContactMutation", () => {
  it("optimistically patches the detail role and resolves on success", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useUpdateContactMutation());
    queryClient.setQueryData(
      outreachKeys.contactDetail(LOCAL_TENANT, "contact-1"),
      makeContactDetailResponse(),
    );
    await act(async () => {
      result.current.mutate({ contactId: "contact-1", body: { role: "referrer" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the optimistic role change when the PATCH fails", async () => {
    server.use(
      http.patch("*/v1/contacts/:contactId", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useUpdateContactMutation());
    queryClient.setQueryData(
      outreachKeys.contactDetail(LOCAL_TENANT, "contact-1"),
      makeContactDetailResponse(),
    );
    queryClient.setQueryData(
      outreachKeys.contactList(LOCAL_TENANT, {}),
      makeContactListResponse([sampleContactSummary]),
    );
    await act(async () => {
      result.current.mutate({ contactId: "contact-1", body: { role: "referrer" } });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = queryClient.getQueryData(
      outreachKeys.contactDetail(LOCAL_TENANT, "contact-1"),
    ) as ContactDetailResponse;
    expect(restored.contact.role).toBe(sampleContactDetail.role);
  });
});
