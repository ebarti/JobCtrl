import { describe, expect, it } from "vitest";

import { e2eStubProfileImporter, isE2eStubDispatchEnabled } from "../src/e2e-dispatch.js";

describe("e2e dispatch stubs", () => {
  it("keeps the profile import wizard on a deterministic draft-returning seam", async () => {
    const result = await e2eStubProfileImporter(
      {
        filename: "resume.pdf",
        pdfBytes: Buffer.from("%PDF test"),
        importProfile: true,
        importStyle: true,
      },
      { appDir: "/tmp/jobhunter-e2e", dbPath: "/tmp/jobhunter-e2e/jobhunter.db" },
    );

    expect(result).toMatchObject({
      profile: { personal: { full_name: "E2E Imported Candidate" } },
      source: { filename: "resume.pdf", bytes: 9, e2e: true },
      action: { action: "profile_import", status: "queued", jobKey: "profile" },
    });
  });

  it("enables e2e stubs only for explicit truthy environment values", () => {
    expect(isE2eStubDispatchEnabled({ JOBHUNTER_E2E_STUB_DISPATCH: "1" })).toBe(true);
    expect(isE2eStubDispatchEnabled({ JOBHUNTER_E2E_STUB_DISPATCH: "true" })).toBe(true);
    expect(isE2eStubDispatchEnabled({ JOBHUNTER_E2E_STUB_DISPATCH: "0" })).toBe(false);
    expect(isE2eStubDispatchEnabled({})).toBe(false);
  });
});
