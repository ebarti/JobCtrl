import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { profileKeys } from "../queryKeys.js";
import { useImportResumeMutation } from "./useImportResumeMutation.js";

describe("useImportResumeMutation", () => {
  it("calls import-resume and returns the parsed profile", async () => {
    const { result } = renderHookWithProviders(() => useImportResumeMutation());
    await act(async () => {
      result.current.mutate({
        filename: "resume.pdf",
        pdfBase64: "JVBERi0=",
        importProfile: true,
        importStyle: true,
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.ok).toBe(true);
  });

  it("reports error and leaves the profile cache untouched on failure", async () => {
    server.use(
      http.post("*/v1/profile/import-resume", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const initialProfile = { ok: true, profile: { personal: { full_name: "Original" } }, style: {}, templateText: "" };
    const { result, queryClient } = renderHookWithProviders(() => useImportResumeMutation());
    queryClient.setQueryData(profileKeys.profile(LOCAL_TENANT), initialProfile);

    await act(async () => {
      result.current.mutate({
        filename: "bad.pdf",
        pdfBase64: "JVBERi0=",
        importProfile: true,
        importStyle: true,
      });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(profileKeys.profile(LOCAL_TENANT))).toEqual(initialProfile);
  });
});
