import type { RequirementFitReport } from "@jobctrl/contracts";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  degradedEmployerAnalysis,
  emptyEmployerAnalysis,
  populatedEmployerAnalysis,
  populatedRequirementFitReport,
} from "../../../test/fixtures/materials-inspector.js";
import { EmployerAnalysisPanel } from "./EmployerAnalysisPanel.js";

describe("<EmployerAnalysisPanel>", () => {
  it("renders requirements with tier + importance and quoted evidence spans", () => {
    render(<EmployerAnalysisPanel analysis={populatedEmployerAnalysis} />);

    expect(
      screen.getByRole("region", { name: "Role Analysis" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Employer analysis")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Lead platform reliability programs across multiple teams",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Must Have")).toBeInTheDocument();
    expect(screen.getByText("importance 90%")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Lead our platform reliability initiatives across the engineering org",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Nice To Have")).toBeInTheDocument();
    expect(screen.getByText("importance 55%")).toBeInTheDocument();
  });

  it("renders each requirement beside canonical requirement fit evidence", async () => {
    const user = userEvent.setup();
    render(
      <EmployerAnalysisPanel
        analysis={populatedEmployerAnalysis}
        requirementFitReport={populatedRequirementFitReport}
        resolveEvidenceReference={(evidenceId) => {
          if (evidenceId === "ev-platform") {
            return {
              entryId: evidenceId,
              title: "Led a platform reliability transformation",
              excerpt: "Reduced incident response time by 42%.",
            };
          }
          if (evidenceId === "ev-k8s") {
            return {
              entryId: evidenceId,
              title: "Operated Kubernetes services",
              excerpt:
                "Improved deployment reliability across shared services.",
            };
          }
          return null;
        }}
      />,
    );

    const matched = screen.getByRole("article", {
      name: "Requirement: Lead platform reliability programs across multiple teams",
    });
    expect(within(matched).getByText("Requirement fit")).toBeInTheDocument();
    expect(within(matched).getByText("matched")).toBeInTheDocument();
    expect(within(matched).getByText("Score contribution")).toBeInTheDocument();
    expect(
      within(matched).getByText("1.125 / 1.125 points"),
    ).toBeInTheDocument();
    expect(
      within(matched).getByText("Tailoring directive"),
    ).toBeInTheDocument();
    expect(
      within(matched).getByText("Double Down · priority 90%"),
    ).toBeInTheDocument();
    expect(
      within(matched).getByText("Led a platform reliability transformation"),
    ).toBeInTheDocument();
    expect(
      within(matched).getByText("Reduced incident response time by 42%."),
    ).toBeInTheDocument();
    expect(within(matched).queryByText("ev-platform")).not.toBeInTheDocument();

    await user.click(
      within(matched).getByRole("button", { name: "Technical details" }),
    );

    expect(within(matched).getByText("ev-platform")).toBeInTheDocument();

    await user.click(
      within(matched).getByRole("button", { name: "Additional audit details" }),
    );

    expect(
      within(matched).getByText("platform reliability"),
    ).toBeInTheDocument();
    expect(within(matched).getByText("Covered · 1 bullet")).toBeInTheDocument();

    const transferable = screen.getByRole("article", {
      name: "Requirement: Experience with Kubernetes-based developer platforms",
    });
    expect(within(transferable).getByText("transferable")).toBeInTheDocument();
    expect(
      within(transferable).getByText("Bridge Gap · priority 55%"),
    ).toBeInTheDocument();
    expect(
      within(transferable).getByText("Operated Kubernetes services"),
    ).toBeInTheDocument();

    await user.click(
      within(transferable).getByRole("button", {
        name: "Additional audit details",
      }),
    );

    expect(
      within(transferable).getByText(
        "Kubernetes operations evidence can support adjacent platform experience.",
      ),
    ).toBeInTheDocument();

    expect(
      within(transferable).getByText(
        "owned Kubernetes developer platforms end to end",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the compact fit summary bounded while evidence stays readable", () => {
    render(
      <EmployerAnalysisPanel
        analysis={populatedEmployerAnalysis}
        requirementFitReport={populatedRequirementFitReport}
        resolveEvidenceReference={(evidenceId) =>
          evidenceId === "ev-platform"
            ? {
                entryId: evidenceId,
                title: "Led a platform reliability transformation",
                excerpt: "Reduced incident response time by 42%.",
              }
            : {
                entryId: evidenceId,
                title: "Improved platform incident reliability",
                excerpt: "Cut mean time to recovery for shared services.",
              }
        }
      />,
    );

    const matched = screen.getByRole("article", {
      name: "Requirement: Lead platform reliability programs across multiple teams",
    });
    const summary = within(matched).getByRole("group", { name: "Fit summary" });

    expect(
      summary.querySelectorAll('[data-slot="requirement-fit-metric"]'),
    ).toHaveLength(2);
    expect(
      within(summary).getByText("Led a platform reliability transformation"),
    ).toBeInTheDocument();
    expect(
      within(summary).getByText("Reduced incident response time by 42%."),
    ).toBeInTheDocument();
    expect(
      within(summary).queryByText("Target keywords"),
    ).not.toBeInTheDocument();
    expect(
      within(matched).getAllByRole("button", {
        name: "Additional audit details",
      }),
    ).toHaveLength(1);
    expect(
      matched.querySelectorAll('[data-slot="requirement-fit-audit-details"]'),
    ).toHaveLength(1);
  });

  it("keeps unresolved profile evidence IDs behind technical details", async () => {
    const user = userEvent.setup();
    const directAssessment = populatedRequirementFitReport.assessments[0]!;
    if (directAssessment.fit.kind !== "matched") {
      throw new Error(
        "Employer-analysis fixture must include a matched assessment",
      );
    }
    const unresolvedEvidenceId = "glovo_staff_platform_bullet_1";

    render(
      <EmployerAnalysisPanel
        analysis={populatedEmployerAnalysis}
        requirementFitReport={{
          ...populatedRequirementFitReport,
          assessments: [
            {
              ...directAssessment,
              fit: {
                ...directAssessment.fit,
                evidenceIds: [unresolvedEvidenceId],
              },
            },
          ],
        }}
        resolveEvidenceReference={() => null}
      />,
    );

    const matched = screen.getByRole("article", {
      name: "Requirement: Lead platform reliability programs across multiple teams",
    });
    expect(
      within(matched).getByText("Evidence reference unavailable."),
    ).toBeInTheDocument();
    expect(
      within(matched).queryByText(unresolvedEvidenceId),
    ).not.toBeInTheDocument();

    await user.click(
      within(matched).getByRole("button", { name: "Technical details" }),
    );

    expect(within(matched).getByText(unresolvedEvidenceId)).toBeInTheDocument();
  });

  it("distinguishes requirement gaps in profile evidence from gaps in the accepted tailored resume", async () => {
    const user = userEvent.setup();
    const directAssessment = populatedRequirementFitReport.assessments[0]!;
    const transferableAssessment =
      populatedRequirementFitReport.assessments[1]!;

    render(
      <EmployerAnalysisPanel
        analysis={populatedEmployerAnalysis}
        requirementFitReport={{
          ...populatedRequirementFitReport,
          assessments: [
            {
              ...directAssessment,
              artifactCoverage: {
                state: "missing_from_resume",
                source: "tailored_resume_bullet_provenance",
                bulletCount: 0,
                examples: [],
              },
            },
            {
              ...transferableAssessment,
              artifactCoverage: {
                state: "missing_from_profile",
                source: "tailored_resume_bullet_provenance",
                bulletCount: 0,
                examples: [],
              },
            },
          ],
        }}
      />,
    );

    const matched = screen.getByRole("article", {
      name: "Requirement: Lead platform reliability programs across multiple teams",
    });
    await user.click(
      within(matched).getByRole("button", { name: "Additional audit details" }),
    );
    expect(
      within(matched).getByText("missing from tailored resume · 0 bullets"),
    ).toBeInTheDocument();

    const transferable = screen.getByRole("article", {
      name: "Requirement: Experience with Kubernetes-based developer platforms",
    });
    await user.click(
      within(transferable).getByRole("button", {
        name: "Additional audit details",
      }),
    );
    expect(
      within(transferable).getByText("missing from profile · 0 bullets"),
    ).toBeInTheDocument();
  });

  it("keeps rendering legacy transferable assessments when a persisted row value is missing", async () => {
    const user = userEvent.setup();
    const transferableAssessment =
      populatedRequirementFitReport.assessments[1]!;
    const legacyReport = {
      ...populatedRequirementFitReport,
      assessments: [
        populatedRequirementFitReport.assessments[0]!,
        {
          ...transferableAssessment,
          fit: {
            kind: "transferable",
            evidenceIds:
              transferableAssessment.fit.kind === "transferable"
                ? transferableAssessment.fit.evidenceIds
                : [],
            bridge:
              "Kubernetes operations evidence can support adjacent platform experience.",
          },
          tailoring: {
            ...transferableAssessment.tailoring,
            targetKeywords: undefined,
            prohibitedClaims: undefined,
          },
          artifactCoverage: {
            ...transferableAssessment.artifactCoverage,
            examples: undefined,
          },
        },
      ],
    } as unknown as RequirementFitReport;

    render(
      <EmployerAnalysisPanel
        analysis={populatedEmployerAnalysis}
        requirementFitReport={legacyReport}
        resolveEvidenceReference={(evidenceId) =>
          evidenceId === "ev-k8s"
            ? {
                entryId: evidenceId,
                title: "Operated Kubernetes services",
                excerpt: null,
              }
            : null
        }
      />,
    );

    const transferable = screen.getByRole("article", {
      name: "Requirement: Experience with Kubernetes-based developer platforms",
    });
    expect(within(transferable).getByText("transferable")).toBeInTheDocument();

    await user.click(
      within(transferable).getByRole("button", {
        name: "Additional audit details",
      }),
    );

    expect(within(transferable).getByText("Bridge")).toBeInTheDocument();
    expect(
      within(transferable).getByText(
        "Kubernetes operations evidence can support adjacent platform experience.",
      ),
    ).toBeInTheDocument();
    expect(
      within(transferable).getByText("Operated Kubernetes services"),
    ).toBeInTheDocument();
    expect(within(transferable).queryByText("ev-k8s")).not.toBeInTheDocument();
    expect(within(transferable).queryByText("Gap")).not.toBeInTheDocument();
  });

  it("shows not assessed when no requirement fit report exists", () => {
    render(<EmployerAnalysisPanel analysis={populatedEmployerAnalysis} />);

    const matched = screen.getByRole("article", {
      name: "Requirement: Lead platform reliability programs across multiple teams",
    });
    expect(within(matched).getByText("Requirement fit")).toBeInTheDocument();
    expect(within(matched).getByText("not assessed")).toBeInTheDocument();
    expect(
      within(matched).getByText(
        "Re-score this job with the current policy to produce requirement-level candidate fit.",
      ),
    ).toBeInTheDocument();

    const missing = screen.getByRole("article", {
      name: "Requirement: Experience with Kubernetes-based developer platforms",
    });
    expect(within(missing).getByText("Requirement fit")).toBeInTheDocument();
    expect(within(missing).getByText("not assessed")).toBeInTheDocument();
  });

  it("renders reasoned keywords with evidence spans and flags orphans", () => {
    render(<EmployerAnalysisPanel analysis={populatedEmployerAnalysis} />);

    expect(screen.getByText("platform reliability")).toBeInTheDocument();
    expect(screen.getByText("Kubernetes")).toBeInTheDocument();
    expect(screen.getByText("orphan")).toBeInTheDocument();
    expect(
      screen.getByText("Named technology with no dedicated requirement."),
    ).toBeInTheDocument();
  });

  it("shows a keyword's canonical requirement text while keeping its raw reference technical", async () => {
    const user = userEvent.setup();
    render(<EmployerAnalysisPanel analysis={populatedEmployerAnalysis} />);

    const keyword = screen.getByText("platform reliability").closest("article");
    expect(keyword).not.toBeNull();
    const keywordView = within(keyword!);

    expect(
      keywordView.getByText(
        "Lead platform reliability programs across multiple teams",
      ),
    ).toBeInTheDocument();
    expect(keywordView.queryByText("req-1")).not.toBeInTheDocument();

    await user.click(
      keywordView.getByRole("button", { name: "Technical details" }),
    );

    expect(keywordView.getByText("req-1")).toBeInTheDocument();
  });

  it("surfaces a degraded ensemble with the succeeded/attempted ratio and failure", () => {
    render(<EmployerAnalysisPanel analysis={degradedEmployerAnalysis} />);

    expect(screen.getByText("degraded (1/2)")).toBeInTheDocument();
    expect(screen.getByText("ensemble divergence")).toBeInTheDocument();
    expect(screen.getByText("codex: timeout after 60s")).toBeInTheDocument();
  });

  it("renders explicit empty states when no requirements/keywords were recorded", () => {
    render(<EmployerAnalysisPanel analysis={emptyEmployerAnalysis} />);

    expect(
      screen.getByText("No requirements were recorded for this analysis."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No reasoned keywords were recorded for this analysis."),
    ).toBeInTheDocument();
  });

  it("renders an explicit not-recorded state when no analysis exists (never blank)", () => {
    render(<EmployerAnalysisPanel analysis={null} />);

    expect(screen.getByText("Role Analysis")).toBeInTheDocument();
    expect(
      screen.getByText(/No role analysis has been recorded for this job yet/i),
    ).toBeInTheDocument();
  });
});
