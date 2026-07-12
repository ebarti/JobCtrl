import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DryRunButton } from "../contexts/apply/components/DryRunButton.js";
import { OpenArtifactButton } from "../contexts/materials/components/OpenArtifactButton.js";
import { MarkAppliedButton } from "../contexts/pipeline/components/MarkAppliedButton.js";
import { renderWithProviders } from "../test/render.js";
import { buildTestPorts } from "../test/testPorts.js";
import { DemoFeatureFlagAdapter } from "./ports.js";

describe("demo action copy", () => {
  it("names rehearsed actions by the effect they simulate", () => {
    const ports = buildTestPorts();
    ports.featureFlags = new DemoFeatureFlagAdapter();

    renderWithProviders(
      <>
        <DryRunButton jobId="job-1" />
        <MarkAppliedButton jobId="job-1" />
        <OpenArtifactButton artifactId="artifact-1" />
      </>,
      { ports },
    );

    expect(
      screen.getByRole("button", { name: "rehearse application" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "record simulated applied" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "preview in browser" }),
    ).toBeInTheDocument();
  });
});
