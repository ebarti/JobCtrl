// @vitest-environment node

import { describe, expect, it } from "vitest";

import { makeArtifactTailoringExplanation } from "../../../test/fixtures/projections.js";
import type { BulletProvenanceEntry } from "@jobctrl/contracts";
import {
  emptyRiskSignals,
  pinsFromResumeLines,
  pinStatus,
  pinTone,
} from "./resume-provenance.js";

const entry: BulletProvenanceEntry = {
  bulletId: "claim:1",
  section: "experience",
  sourceId: "experience:role#0",
  sourceText: ["Canonical source"],
  generatedText: "Rendered claim",
  transformType: "kept",
  control: "verified_only",
  evidenceIds: ["evidence:1"],
  requirementIds: ["requirement:1"],
  matchedKeywords: [],
  rationale: "Recorded rationale",
};

describe("recorded provenance joins", () => {
  it("joins the recorded bullet ID regardless of rendered wording and refuses matching prose without that ID", () => {
    const explanation = makeArtifactTailoringExplanation(null, {
      bulletProvenance: [entry],
    });
    const pins = pinsFromResumeLines(
      [
        {
          kind: "bullet",
          semanticId: "claim:1",
          lineNumber: 1,
          text: "Completely edited wording",
        },
        {
          kind: "bullet",
          semanticId: "foreign:1",
          lineNumber: 2,
          text: "Rendered claim",
        },
        { kind: "bullet", lineNumber: 3, text: "Canonical source" },
      ],
      explanation,
      [],
    );
    expect(pins[0]).toMatchObject({
      sourceId: entry.sourceId,
      sourceText: entry.sourceText,
      evidenceIds: entry.evidenceIds,
    });
    for (const pin of pins.slice(1)) {
      expect(pin.provenanceState).toBe("missing");
      expect(pinStatus(pin, emptyRiskSignals())).toBe("no recorded source");
      expect(pinTone(pin, emptyRiskSignals())).toBe("warn");
    }
  });

  it("joins profile paths explicitly and leaves document structure exempt from claim attribution", () => {
    const pins = pinsFromResumeLines(
      [
        {
          kind: "name",
          profileField: "personal:full_name",
          text: "Display name",
        },
        { kind: "body", text: "Canonical name" },
        { kind: "section", text: "Experience" },
      ],
      null,
      [
        {
          path: "personal:full_name",
          label: "Full name",
          value: "Canonical name",
          section: "personal",
        },
      ],
    );
    expect(pins[0]).toMatchObject({
      sourceGranularity: "profile_field",
      sourceId: "personal:full_name",
      sourceText: ["Full name: Canonical name"],
    });
    expect(pins[1]?.provenanceState).toBe("missing");
    expect(pins[2]?.provenanceState).toBe("not_applicable");
  });

  it("renders claim risk only for the persisted finding's line ID", () => {
    const pins = pinsFromResumeLines(
      [{ kind: "bullet", semanticId: entry.bulletId, text: "Edited" }],
      makeArtifactTailoringExplanation(null, { bulletProvenance: [entry] }),
      [],
    );
    const pin = pins[0]!;
    const risk = emptyRiskSignals();
    expect(pinStatus(pin, risk)).toBe("line evidence");
    const finding = {
      lineId: "foreign:1",
      kind: "unsupported_claim" as const,
      rationale: "Edited",
      determinationId: "a".repeat(64),
    };
    expect(pinStatus(pin, { ...risk, lineFindings: [finding] })).toBe(
      "line evidence",
    );
    expect(
      pinStatus(pin, {
        ...risk,
        lineFindings: [{ ...finding, lineId: pin.id }],
      }),
    ).toBe("claim risk");
  });
});
