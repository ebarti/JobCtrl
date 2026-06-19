import { axe } from "jest-axe";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CompensationSourceRegistryResponse } from "../../operations/types.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { CompensationSourcePolicyPanel } from "./CompensationSourcePolicyPanel.js";

function policyResponse(): CompensationSourceRegistryResponse {
  return {
    ok: true,
    sources: [
      {
        sourceId: "eurostat_structure_of_earnings",
        displayName: "Eurostat Structure of Earnings Survey",
        sourceType: "public_wage_baseline",
        accessMode: "public_dataset",
        availability: "available",
        licenseStatus: "not_required",
        termsUrl: "https://ec.europa.eu/eurostat/about-us/policies/copyright",
        sourceUrl: "https://ec.europa.eu/eurostat/web/microdata/structure-of-earnings-survey",
        freshnessPolicy: "Use the latest published Eurostat SES release available to the importer.",
        attributionRequirement: "Attribute Eurostat as the public statistical source.",
        supportedFields: ["base_salary", "wage_percentiles", "sample_count", "freshness", "attribution"],
        disabledReason: null,
        configured: true,
        coverage: {
          geography: "europe",
          regions: ["EU", "EEA"],
          notes: "Europe-first public wage baseline.",
        },
        notes: ["Public statistical baseline; not employer-specific compensation intelligence."],
      },
      {
        sourceId: "levels_fyi",
        displayName: "Levels.fyi",
        sourceType: "licensed_market_benchmark",
        accessMode: "unavailable_until_permitted",
        availability: "unavailable",
        licenseStatus: "requires_license",
        termsUrl: "https://www.levels.fyi/offerings/data/",
        sourceUrl: "https://www.levels.fyi/",
        freshnessPolicy: "Unavailable until permitted access and Europe coverage are explicitly configured.",
        attributionRequirement: "Do not display imported Levels.fyi compensation data.",
        supportedFields: [],
        disabledReason: "Requires licensed Levels.fyi access mode and explicit Europe coverage confirmation.",
        configured: false,
        coverage: {
          geography: "licensed_provider_configured",
          regions: [],
          notes: "Europe coverage is not configured.",
        },
        notes: [
          "Policy seam only; no Levels.fyi fetch, scrape, cache, credential, or salary import path is registered here.",
        ],
      },
      {
        sourceId: "glassdoor",
        displayName: "Glassdoor",
        sourceType: "licensed_market_benchmark",
        accessMode: "unavailable_until_permitted",
        availability: "unavailable",
        licenseStatus: "requires_permission",
        termsUrl: "https://www.glassdoor.com/about/terms/",
        sourceUrl: "https://www.glassdoor.com/",
        freshnessPolicy: "Unavailable until partner API or written permission is configured.",
        attributionRequirement: "Do not display imported Glassdoor compensation data.",
        supportedFields: [],
        disabledReason: "Requires Glassdoor partner API access or written permission.",
        configured: false,
        coverage: {
          geography: "licensed_provider_configured",
          regions: [],
          notes: "Coverage is not configured.",
        },
        notes: [
          "Policy seam only; no Glassdoor fetch, scrape, cache, credential, or salary import path is registered here.",
        ],
      },
    ],
  };
}

describe("<CompensationSourcePolicyPanel>", () => {
  it("renders public Europe baselines and disabled licensed seams with required policy fields", async () => {
    renderWithProviders(<CompensationSourcePolicyPanel />, {
      ports: buildTestPorts({
        api: { compensationSources: vi.fn(async () => policyResponse()) },
      }),
    });

    expect(screen.getByRole("heading", { name: "Compensation sources" })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Compensation source policy" });
    expect(table).toHaveTextContent("Eurostat Structure of Earnings Survey");
    expect(table).toHaveTextContent("public wage baseline");
    expect(table).toHaveTextContent("available");
    expect(table).toHaveTextContent("not required");
    expect(table).toHaveTextContent("public dataset");
    expect(table).toHaveTextContent("Use the latest published Eurostat SES release");
    expect(table).toHaveTextContent("Attribute Eurostat as the public statistical source.");
    expect(table).toHaveTextContent("base salary");
    expect(table).toHaveTextContent("wage percentiles");
    expect(table).toHaveTextContent("EU, EEA");
    expect(table).toHaveTextContent("Levels.fyi");
    expect(table).toHaveTextContent(
      "Requires licensed Levels.fyi access mode and explicit Europe coverage confirmation.",
    );
    expect(table).toHaveTextContent("Glassdoor");
    expect(table).toHaveTextContent("Requires Glassdoor partner API access or written permission.");
    expect(table).toHaveTextContent("none until permitted");
  });

  it("renders loading and error states", async () => {
    renderWithProviders(<CompensationSourcePolicyPanel />, {
      ports: buildTestPorts({
        api: {
          compensationSources: vi.fn(
            () => new Promise<CompensationSourceRegistryResponse>(() => undefined),
          ),
        },
      }),
    });
    expect(screen.getByText("Loading compensation sources.")).toBeInTheDocument();

    renderWithProviders(<CompensationSourcePolicyPanel />, {
      ports: buildTestPorts({
        api: {
          compensationSources: vi.fn(async () => {
            throw new Error("source policy failed");
          }),
        },
      }),
    });
    await waitFor(() => expect(screen.getByText("source policy failed")).toBeInTheDocument());
  });

  it("does not nest cards", async () => {
    const { container } = renderWithProviders(<CompensationSourcePolicyPanel />, {
      ports: buildTestPorts({
        api: { compensationSources: vi.fn(async () => policyResponse()) },
      }),
    });

    await screen.findByText("Eurostat Structure of Earnings Survey");
    expect(container.querySelectorAll(".card .card")).toHaveLength(0);
  });

  it("has no critical or serious axe violations", async () => {
    const view = renderWithProviders(<CompensationSourcePolicyPanel />, {
      ports: buildTestPorts({
        api: { compensationSources: vi.fn(async () => policyResponse()) },
      }),
    });

    await screen.findByText("Eurostat Structure of Earnings Survey");
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
