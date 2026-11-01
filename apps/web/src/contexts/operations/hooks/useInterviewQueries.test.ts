import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { sampleEvidenceMapResponse, sampleProfileResponse } from "../../../test/fixtures/projections.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useInterviewEvidenceChoices } from "./useInterviewQueries.js";

it("preserves exact canonical ID identity and allows a confirmed source-text-only fact", async () => {
  const evidenceId = "Legacy.Source-1 ";
  const sourceText = "Saved and confirmed source excerpt.";
  const entry = { ...sampleEvidenceMapResponse.entries[0]!, entryId: evidenceId, evidenceId, title: "Source-only fact", story: null };
  const { result } = renderHookWithProviders(() => useInterviewEvidenceChoices("job-1"), { ports: buildTestPorts({ api: {
    profile: async () => ({ ...sampleProfileResponse, profile: { resume: { experience_entries: [{ id: "role", title: "Role", company: "Synthetic", achievement_evidence: [{ id: evidenceId, source_text: sourceText, evidence_strength: "verified", user_confirmed: true }] }] } } }),
    evidenceMap: async () => ({ ...sampleEvidenceMapResponse, entries: [entry] }),
  } }) });
  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(result.current.choices).toMatchObject([{ evidenceId, excerpt: sourceText }]);
  expect(result.current.profileVersion).toBe(3);
});

describe("canonical selection eligibility", () => {
  it("excludes duplicate IDs across all saved profile facts, including an unaccepted duplicate", async () => {
    const evidenceId = "ev-platform-reliability";
    const { result } = renderHookWithProviders(() => useInterviewEvidenceChoices("job-1"), { ports: buildTestPorts({ api: {
      profile: async () => ({ ...sampleProfileResponse, profile: { resume: { experience_entries: [{ id: "role", title: "Role", company: "Synthetic", achievement_evidence: [{ id: evidenceId, source_text: "Confirmed", user_confirmed: true, evidence_strength: "verified" }, { id: evidenceId, source_text: "Unconfirmed duplicate", user_confirmed: false, evidence_strength: "draft" }] }] } } }),
    } }) });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.choices).toEqual([]);
  });

  it("excludes blank and over-budget canonical IDs without normalizing valid IDs", async () => {
    const base = sampleEvidenceMapResponse.entries[0]!;
    const { result } = renderHookWithProviders(() => useInterviewEvidenceChoices("job-1"), { ports: buildTestPorts({ api: { evidenceMap: async () => ({ ...sampleEvidenceMapResponse, entries: [
      { ...base, entryId: "  ", evidenceId: "  " }, { ...base, entryId: "a".repeat(201), evidenceId: "a".repeat(201) },
    ] }) } }) });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.choices).toEqual([]);
  });
});
