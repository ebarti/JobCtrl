import { describe, expect, it } from "vitest";
import { createInterviewQuestionNoteSaved, DOMAIN_EVENT_TYPES } from "../src/events/index.js";
import { createTenantId } from "../src/tenant.js";

describe("interview note event privacy", () => {
  it("registers the notification and copies only safe IDs and versions", () => {
    const supplied = {
      jobId: "synthetic-job", questionId: "B11", revision: 2,
      sourceGeneration: 1, updatedAt: "2026-10-01T00:00:00Z",
      noteText: "A synthetic private edit", generatedText: "A synthetic private answer",
      profileExcerpt: "A synthetic private fact",
    };
    const event = createInterviewQuestionNoteSaved(createTenantId("synthetic-tenant"), supplied);
    expect(DOMAIN_EVENT_TYPES).toContain("InterviewQuestionNoteSaved");
    expect(event.payload).toEqual({ jobId: supplied.jobId, questionId: "B11", revision: 2, sourceGeneration: 1, updatedAt: supplied.updatedAt });
    expect(JSON.stringify(event)).not.toContain("private");
  });
});
