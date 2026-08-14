import type {
  JobCompensationAudit,
  JobCompensationSummary,
  MarketCompensationDirectBenchmarkLineage,
} from "@jobctrl/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  sampleCompensationAudit,
  sampleCompensationSummary,
} from "../../../test/fixtures/projections.js";
import { CompensationAuditSection } from "./CompensationEvidence.js";

function recordedAudit() {
  if (
    sampleCompensationAudit.posted.recordStatus !== "recorded" ||
    sampleCompensationAudit.posted.fact.parseState !== "parsed_range" ||
    sampleCompensationAudit.market.recordStatus !== "recorded" ||
    sampleCompensationAudit.market.estimate.estimateState !== "estimated_range"
  ) {
    throw new Error("compensation fixtures must contain recorded ranges");
  }
  return {
    posted: sampleCompensationAudit.posted.fact,
    market: sampleCompensationAudit.market.estimate,
  };
}

function renderCompensation({
  summary = sampleCompensationSummary,
  audit = sampleCompensationAudit,
  fallbackSalary = null,
}: {
  readonly summary?: JobCompensationSummary | null;
  readonly audit?: JobCompensationAudit | null;
  readonly fallbackSalary?: string | null;
} = {}) {
  render(
    <CompensationAuditSection
      audit={audit}
      fallbackSalary={fallbackSalary}
      summary={summary}
    />,
  );
  return screen.getByRole("region", { name: "Compensation evidence" });
}

describe("<CompensationAuditSection>", () => {
  it("labels an explicitly priced stock amount as equity rather than additive cash", () => {
    const { posted } = recordedAudit();
    const audit: JobCompensationAudit = {
      ...sampleCompensationAudit,
      posted: {
        ok: true,
        recordStatus: "recorded",
        fact: {
          ...posted,
          sourceText: "Equity compensation: USD 100,000/year in stock options.",
          component: "equity",
          currency: "USD",
          minimumAmount: 100_000,
          maximumAmount: 100_000,
          annualizedMinimumAmount: 100_000,
          annualizedMaximumAmount: 100_000,
          parserVersion: "posted-compensation-v2",
          warnings: [
            {
              code: "equity_component",
              message:
                "The posting mentions stock or equity compensation; review the amount type below.",
            },
          ],
        },
      },
    };
    const summary: JobCompensationSummary = {
      ...sampleCompensationSummary,
      posted: {
        ...sampleCompensationSummary.posted,
        range: {
          ...sampleCompensationSummary.posted.range!,
          currency: "USD",
          component: "equity",
          minimumAmount: 100_000,
          maximumAmount: 100_000,
          annualizedMinimumAmount: 100_000,
          annualizedMaximumAmount: 100_000,
          displayRange: "USD 100000/year",
        },
        displayRange: "USD 100000/year",
      },
    };

    const compensation = renderCompensation({ audit, summary });

    expect(
      within(compensation).getByRole("heading", {
        level: 4,
        name: "Employer posted",
      }),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(/employer-stated value of the equity/i),
    ).toBeInTheDocument();
    expect(
      within(compensation).queryByText(/cash amount stated/i),
    ).not.toBeInTheDocument();
    fireEvent.click(within(compensation).getByText("View posting evidence"));
    expect(within(compensation).getByText("equity")).toBeInTheDocument();
  });

  it("distinguishes unavailable sources from weak or dispersed evidence", () => {
    const { market } = recordedAudit();
    const audit: JobCompensationAudit = {
      ...sampleCompensationAudit,
      market: {
        ok: true,
        recordStatus: "recorded",
        estimate: {
          ...market,
          estimateState: "source_unavailable",
          sources: [],
          evidence: [],
          sourceCount: 0,
          sampleCount: null,
          sourceUnavailableReasons: [
            {
              code: "stale_source_snapshot",
              message: "The available salary snapshot is stale.",
            },
          ],
        },
      },
    };
    const summary: JobCompensationSummary = {
      ...sampleCompensationSummary,
      market: {
        ...sampleCompensationSummary.market,
        estimateState: "source_unavailable",
        sourceCount: 0,
        sampleCount: null,
        range: null,
        displayRange: null,
        confidenceInterval: null,
        displayConfidenceInterval: null,
      },
    };

    const compensation = renderCompensation({ audit, summary });

    expect(
      within(compensation).getByText("Market sources unavailable"),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(/could not be used/i),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText("The available salary snapshot is stale."),
    ).toBeInTheDocument();
    expect(
      within(compensation).queryByText(/too dispersed|weakly matched/i),
    ).not.toBeInTheDocument();
  });

  it("explains unsupported market inputs without claiming evidence was reviewed", () => {
    const { market } = recordedAudit();
    const audit: JobCompensationAudit = {
      ...sampleCompensationAudit,
      market: {
        ok: true,
        recordStatus: "recorded",
        estimate: {
          ...market,
          estimateState: "unsupported",
          sources: [],
          evidence: [],
          sourceCount: 0,
          sampleCount: null,
          unsupportedReasons: [
            {
              code: "unsupported_component",
              message: "Equity-only market ranges are not supported.",
            },
          ],
        },
      },
    };
    const summary: JobCompensationSummary = {
      ...sampleCompensationSummary,
      market: {
        ...sampleCompensationSummary.market,
        estimateState: "unsupported",
        sourceCount: 0,
        sampleCount: null,
        range: null,
        displayRange: null,
        confidenceInterval: null,
        displayConfidenceInterval: null,
      },
    };

    const compensation = renderCompensation({ audit, summary });

    expect(
      within(compensation).getByText("Market range unsupported"),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(/outside the supported market model/i),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(
        "Equity-only market ranges are not supported.",
      ),
    ).toBeInTheDocument();
    expect(
      within(compensation).queryByText(/salary records were reviewed/i),
    ).not.toBeInTheDocument();
  });

  it("shows canonical all-level director evidence with aggregate sample counts", () => {
    const { market } = recordedAudit();
    const lineage = market.benchmarkLineage;
    if (!lineage) throw new Error("market fixture must include lineage");
    const directLineage: MarketCompensationDirectBenchmarkLineage = {
      kind: "direct",
      factId: "benchmark-direct-es-privacy-all-levels",
      taxonomyVersion: lineage.taxonomyVersion,
      roleFamilyCode: "security_privacy",
      seniorityLabel: "unknown",
      targetGeography: lineage.targetGeography,
      component: lineage.component,
      asOfDate: lineage.asOfDate,
      observedAt: lineage.observedAt,
      freshUntil: lineage.freshUntil,
      directInputs: lineage.directInputs,
      priceLevelInputs: [],
    };
    const audit: JobCompensationAudit = {
      ...sampleCompensationAudit,
      market: {
        ok: true,
        recordStatus: "recorded",
        estimate: {
          ...market,
          seniorityLabel: "unknown",
          roleTitle: "Privacy Engineering Director",
          normalizedRole: "privacy engineering director",
          sourceCount: 1,
          sampleCount: 20,
          sources: [
            {
              ...market.sources[0]!,
              sampleCount: 20,
            },
          ],
          evidence: [
            {
              ...market.evidence[0]!,
              roleTitle: "Security and privacy engineering",
              levelLabel: "All levels",
              sampleCount: 20,
            },
          ],
          factors: [
            {
              name: "role",
              score: 1,
              band: "high",
              reason: "Matched canonical role family security_privacy.",
            },
            {
              name: "level",
              score: 0.72,
              band: "medium",
              reason:
                "Used all-level fallback for the director benchmark slice.",
            },
          ],
          benchmarkLineage: directLineage,
          estimatorVersion:
            "company-role-reported-compensation-canonical-benchmark-v1:direct:benchmark-direct-es-privacy-all-levels",
        },
      },
    };
    const summary: JobCompensationSummary = {
      ...sampleCompensationSummary,
      market: {
        ...sampleCompensationSummary.market,
        benchmarkKind: "direct",
        sourceCount: 1,
        sampleCount: 20,
      },
    };

    const compensation = renderCompensation({ audit, summary });

    expect(
      within(compensation).getByRole("heading", {
        level: 4,
        name: "Market salary estimate",
      }),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(
        /direct benchmark for the matched role family/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(/uses all-level evidence/i),
    ).toBeInTheDocument();
    const evidenceSummary = within(compensation).getByText("Evidence reviewed");
    expect(evidenceSummary.closest("details")).toHaveTextContent(
      "1 evidence record · 1 provider · 20 reported samples",
    );
    const assessmentSummary = within(compensation).getByText(
      "How this was assessed",
    );
    expect(
      assessmentSummary.closest("details")?.querySelector("svg"),
    ).not.toBeNull();
    fireEvent.click(assessmentSummary);
    expect(
      within(compensation).getByText("Benchmark level").closest("div"),
    ).toHaveTextContent("all levels");
    expect(
      within(compensation).getByText(
        "Matched canonical role family security_privacy.",
      ),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(
        "Used all-level fallback for the director benchmark slice.",
      ),
    ).toBeInTheDocument();
    expect(
      within(compensation).queryByText(/classified as unknown/i),
    ).not.toBeInTheDocument();
  });

  it("keeps an unparsed employer value visible beside a current market result", () => {
    const summary: JobCompensationSummary = {
      ...sampleCompensationSummary,
      legacyRawSalary: "EUR 95k/year",
      posted: {
        sourceKind: "posted",
        recordStatus: "not_recorded",
        parseState: null,
        confidence: "none",
        warningCount: 0,
        range: null,
        displayRange: null,
      },
    };

    const compensation = renderCompensation({
      audit: null,
      summary,
    });

    expect(within(compensation).getByText("EUR 95k/year")).toBeInTheDocument();
    expect(
      within(compensation).getByText("unparsed posting value"),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText("EUR 112000-142000/year"),
    ).toBeInTheDocument();
  });

  it("keeps a raw posting value visible when projections are absent", () => {
    const compensation = renderCompensation({
      audit: null,
      fallbackSalary: "USD 180k-220k",
      summary: null,
    });

    expect(within(compensation).getByText("USD 180k-220k")).toBeInTheDocument();
    expect(
      within(compensation).getByText("unparsed posting value"),
    ).toBeInTheDocument();
  });

  it("uses summary authority without inventing missing detailed evidence counts", () => {
    const compensation = renderCompensation({
      audit: null,
      summary: sampleCompensationSummary,
    });

    expect(
      within(compensation).getByText("EUR 112000-142000/year"),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(
        /derived from a matched role-family benchmark/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(
        /detailed evidence records are unavailable/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(
        /summary records 2 providers and 7 reported samples/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(compensation).queryByText(/0 evidence records/i),
    ).not.toBeInTheDocument();
  });

  it("reconstructs posted and market ranges from an audit-only projection", () => {
    const compensation = renderCompensation({
      audit: sampleCompensationAudit,
      summary: null,
    });

    expect(
      within(compensation).getAllByText("EUR 70000-90000/year").length,
    ).toBeGreaterThan(0);
    expect(
      within(compensation).getByText("EUR 112000-142000/year"),
    ).toBeInTheDocument();
    expect(
      within(compensation).queryByText("No safe amount extracted"),
    ).not.toBeInTheDocument();
  });
});
