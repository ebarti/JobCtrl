import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useImportContactsMutation } from "./useImportContactsMutation.js";

describe("useImportContactsMutation", () => {
  it("imports parsed CSV rows and returns the imported count", async () => {
    const { result } = renderHookWithProviders(() => useImportContactsMutation());
    await act(async () => {
      result.current.mutate({
        filename: "contacts.csv",
        csvText: "name,email\nDana Reyes,dana@acme.example\nMorgan Blake,morgan@acme.example",
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.imported).toBe(2);
  });

  it("reports an error when the import request fails", async () => {
    server.use(
      http.post("*/v1/contacts/import", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useImportContactsMutation());
    await act(async () => {
      result.current.mutate({ filename: "bad.csv", csvText: "name\nDana" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
