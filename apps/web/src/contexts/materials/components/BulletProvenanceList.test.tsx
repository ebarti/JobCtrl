import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { annotatedChanges, provenanceEntries } from "../../../test/fixtures/materials-inspector.js";
import { BulletProvenanceList } from "./BulletProvenanceList.js";

describe("<BulletProvenanceList>", () => {
  it("renders per-bullet evidence × requirement × transform × control × rationale", () => {
    render(<BulletProvenanceList provenance={provenanceEntries} annotatedChanges={annotatedChanges} />);

    expect(screen.getByText("Per-bullet provenance (2)")).toBeInTheDocument();
    expect(screen.getByText("Rephrased")).toBeInTheDocument();
    expect(screen.getByText("Rephrase Allowed")).toBeInTheDocument();
    expect(screen.getByText("ev-platform")).toBeInTheDocument();
    expect(screen.getByText("req-1")).toBeInTheDocument();
    expect(screen.getByText("platform reliability")).toBeInTheDocument();
    expect(
      screen.getByText("Reworded the source bullet to foreground reliability ownership."),
    ).toBeInTheDocument();
  });

  it("renders the original → tailored diff from annotated changes (INSPECT-04)", () => {
    render(<BulletProvenanceList provenance={provenanceEntries} annotatedChanges={annotatedChanges} />);

    expect(screen.getByText("Responsible for keeping the platform up and running.")).toBeInTheDocument();
    expect(
      screen.getByText("Led platform reliability programs across 4 engineering teams."),
    ).toBeInTheDocument();
  });

  it("renders an explicit not-recorded original when no annotated change matches (INSPECT-05)", () => {
    // The second entry (exp-2) has no matching annotated change → honest missing state.
    render(<BulletProvenanceList provenance={provenanceEntries} annotatedChanges={annotatedChanges} />);

    expect(screen.getByText("Original profile bullet not recorded for this line.")).toBeInTheDocument();
  });

  it("renders explicit none-recorded for empty requirement/keyword sets", () => {
    render(<BulletProvenanceList provenance={[provenanceEntries[1]!]} annotatedChanges={[]} />);

    // exp-2 has no requirementIds / matchedKeywords.
    expect(screen.getAllByText("none recorded").length).toBeGreaterThan(0);
  });

  it("renders an explicit empty state when no provenance rows exist", () => {
    render(<BulletProvenanceList provenance={[]} />);

    expect(screen.getByText("Per-bullet provenance")).toBeInTheDocument();
    expect(
      screen.getByText(/No per-bullet provenance was recorded for this artifact/i),
    ).toBeInTheDocument();
  });
});
