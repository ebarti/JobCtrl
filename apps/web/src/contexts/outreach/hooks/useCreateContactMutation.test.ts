import type { ContactListResponse } from "@jobhunter/contracts";
import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { makeContactListResponse, sampleContactSummary } from "../../../test/fixtures/contacts.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { outreachKeys } from "../queryKeys.js";
import { useCreateContactMutation } from "./useCreateContactMutation.js";

const validCreate = {
  role: "recruiter" as const,
  employer: "Acme",
  attributes: [{ kind: "name" as const, value: "Jamie Lee" }],
};

describe("useCreateContactMutation", () => {
  it("optimistically prepends a provisional contact and resolves on success", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useCreateContactMutation());
    queryClient.setQueryData(
      outreachKeys.contactList(LOCAL_TENANT, {}),
      makeContactListResponse([sampleContactSummary]),
    );
    await act(async () => {
      result.current.mutate(validCreate);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the provisional row when the POST fails", async () => {
    server.use(
      http.post("*/v1/contacts", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useCreateContactMutation());
    queryClient.setQueryData(
      outreachKeys.contactList(LOCAL_TENANT, {}),
      makeContactListResponse([sampleContactSummary]),
    );
    await act(async () => {
      result.current.mutate(validCreate);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = queryClient.getQueryData(
      outreachKeys.contactList(LOCAL_TENANT, {}),
    ) as ContactListResponse;
    expect(restored.items).toHaveLength(1);
    expect(restored.items[0]?.contactId).toBe(sampleContactSummary.contactId);
  });
});
