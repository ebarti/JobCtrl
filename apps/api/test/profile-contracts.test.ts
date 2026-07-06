import { describe, expect, it } from "vitest";

import { ProfileSchema } from "../src/contracts.js";

describe("ProfileSchema application attestations", () => {
  it("normalizes typed attestation defaults and preserves additional values", () => {
    const parsed = ProfileSchema.parse({
      resume: {
        experience_entries: [
          {
            id: "role",
            title: "Engineer",
            company: "Example",
          },
        ],
      },
      application_attestations: {
        background_check_consent: true,
        additional: { can_travel: null },
      },
      application_preferences: {
        how_heard: "Referral",
      },
    });

    expect(parsed.application_attestations).toEqual({
      age_18_plus: null,
      background_check_consent: true,
      felony_conviction: null,
      previously_worked_at_employer: null,
      additional: { can_travel: null },
    });
    expect(parsed.application_preferences).toEqual({ how_heard: "Referral" });
  });
});
