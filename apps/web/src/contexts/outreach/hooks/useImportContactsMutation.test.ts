import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useImportContactsMutation } from "./useImportContactsMutation.js";

describe("useImportContactsMutation", () => {
  it("returns a read-only vCard preview before commit", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useImportContactsMutation());
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    await act(async () => {
      result.current.mutate({
        filename: "contacts.vcf",
        format: "vcard",
        mode: "preview",
        content: "BEGIN:VCARD\nVERSION:4.0\nFN:Dana Reyes\nORG:Acme\nEND:VCARD",
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.imported).toBe(0);
    expect(result.current.data?.summary.ready).toBe(1);
    expect(result.current.data?.items[0]?.displayName).toBe("Dana Reyes");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("reconciles contact lists when a commit response fails", async () => {
    server.use(
      http.post("*/v1/contacts/import", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useImportContactsMutation());
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    await act(async () => {
      result.current.mutate({ filename: "bad.vcf", format: "vcard", mode: "commit", content: "broken" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tenant", "local", "outreach", "contacts", "list"] });
  });
});
