import { axe } from "jest-axe";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
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
        sourceId: "manual_reported_compensation",
        displayName: "Manual reported compensation import",
        sourceType: "reported_compensation",
        accessMode: "manual_import",
        availability: "available",
        licenseStatus: "not_required",
        termsUrl: null,
        sourceUrl: null,
        freshnessPolicy: "Uses the reported year/snapshot supplied in the local JSON import.",
        attributionRequirement: "Show as a manual reported-compensation import.",
        supportedFields: ["base_salary", "total_compensation", "sample_count", "freshness", "attribution"],
        disabledReason: null,
        configured: true,
        control: { kind: "fixed", enabled: true },
        coverage: {
          geography: "import_file",
          regions: ["Europe"],
          notes: "Coverage follows imported rows.",
        },
        notes: ["Explicit local imports are additive with configured licensed sources and Euro Top Tech refresh data."],
      },
      {
        sourceId: "euro_top_tech",
        displayName: "Euro Top Tech",
        sourceType: "reported_compensation",
        accessMode: "public_dataset",
        availability: "available",
        licenseStatus: "not_required",
        termsUrl: "https://www.eurotoptech.com/terms",
        sourceUrl: "https://www.eurotoptech.com/data",
        freshnessPolicy: "Uses approved public data-entry rows exposed by Euro Top Tech at refresh time.",
        attributionRequirement: "Show attribution to Euro Top Tech when its observations contribute to an estimate.",
        supportedFields: ["total_compensation", "sample_count", "freshness", "attribution"],
        disabledReason: null,
        configured: true,
        control: { kind: "fixed", enabled: true },
        coverage: {
          geography: "public_dataset",
          regions: ["Europe"],
          notes: "Coverage follows Euro Top Tech submitted European data-entry rows.",
        },
        notes: [
          "Public crowdsourced software-engineer compensation rows are imported during compensation refresh.",
        ],
      },
      {
        sourceId: "levels_fyi",
        displayName: "Levels.fyi",
        sourceType: "reported_compensation",
        accessMode: "public_markdown",
        availability: "unavailable",
        licenseStatus: "permitted",
        termsUrl: "https://www.levels.fyi/about/terms.html",
        sourceUrl: "https://www.levels.fyi/llms.txt",
        freshnessPolicy: "Disabled until the user enables this source in Compensation sources settings.",
        attributionRequirement: "Do not display Levels.fyi compensation data until the source is enabled.",
        supportedFields: [],
        disabledReason: "Disabled in Compensation sources settings.",
        configured: false,
        control: {
          kind: "user_preference",
          enabled: false,
          accessMode: "public_markdown",
          allowedAccessModes: [
            "public_markdown",
            "licensed_api",
            "licensed_data_feed",
            "enterprise_mcp",
          ],
          europeCoverageRequired: false,
          europeCoverageConfirmed: false,
        },
        coverage: {
          geography: "job_matched_public_pages",
          regions: [],
          notes: "Coverage follows public Levels.fyi pages matched to current job roles and locations.",
        },
        notes: [
          "Refresh reads tokenless provider-published Markdown pages and falls back to the same public page's structured data when needed.",
        ],
      },
      {
        sourceId: "glassdoor",
        displayName: "Glassdoor",
        sourceType: "reported_compensation",
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
        control: {
          kind: "user_preference",
          enabled: false,
          accessMode: null,
          allowedAccessModes: ["partner_api", "written_permission"],
          europeCoverageRequired: false,
          europeCoverageConfirmed: false,
        },
        coverage: {
          geography: "licensed_provider_configured",
          regions: [],
          notes: "Coverage is not configured.",
        },
        notes: [
          "Refresh automatically loads configured permitted rows from JOBCTRL_GLASSDOOR_OBSERVATIONS_PATH or JOBCTRL_GLASSDOOR_OBSERVATIONS_URL when access is permitted.",
        ],
      },
    ],
  };
}

describe("<CompensationSourcePolicyPanel>", () => {
  it("renders reported compensation sources with required policy fields", async () => {
    renderWithProviders(<CompensationSourcePolicyPanel />, {
      ports: buildTestPorts({
        api: { compensationSources: vi.fn(async () => policyResponse()) },
      }),
    });

    expect(screen.getByRole("heading", { name: "Compensation sources" })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Compensation source policy" });
    expect(table).toHaveTextContent("Manual reported compensation import");
    expect(table).toHaveTextContent("reported compensation");
    expect(table).toHaveTextContent("available");
    expect(table).toHaveTextContent("not required");
    expect(table).toHaveTextContent("manual import");
    expect(table).toHaveTextContent("Uses the reported year/snapshot supplied");
    expect(table).toHaveTextContent("Show as a manual reported-compensation import.");
    expect(table).toHaveTextContent("base salary");
    expect(table).toHaveTextContent("total compensation");
    expect(table).toHaveTextContent("Europe");
    expect(table).toHaveTextContent("Euro Top Tech");
    expect(table).toHaveTextContent("public dataset");
    expect(screen.getByRole("link", { name: "Euro Top Tech source" })).toHaveAttribute(
      "href",
      "https://www.eurotoptech.com/data",
    );
    expect(table).toHaveTextContent("Show attribution to Euro Top Tech");
    expect(table).toHaveTextContent("Levels.fyi");
    expect(table).toHaveTextContent("Disabled in Compensation sources settings.");
    expect(table).toHaveTextContent("Glassdoor");
    expect(table).toHaveTextContent("Requires Glassdoor partner API access or written permission.");
    expect(table).toHaveTextContent("none until permitted");
  });

  it("offers user-controlled enablement for Levels.fyi and Glassdoor", async () => {
    renderWithProviders(<CompensationSourcePolicyPanel />, {
      ports: buildTestPorts({
        api: { compensationSources: vi.fn(async () => policyResponse()) },
      }),
    });

    expect(
      await screen.findByRole("switch", { name: "Enable Levels.fyi" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Levels.fyi access mode" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Confirm Levels.fyi Europe coverage" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enable Glassdoor" })).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Glassdoor access mode" }),
    ).toBeInTheDocument();
  });

  it("enables tokenless public Levels.fyi access through the API port", async () => {
    const user = userEvent.setup();
    const updateCompensationSourcePolicy = vi.fn(async () => policyResponse());
    renderWithProviders(<CompensationSourcePolicyPanel />, {
      ports: buildTestPorts({
        api: {
          compensationSources: vi.fn(async () => policyResponse()),
          updateCompensationSourcePolicy,
        },
      }),
    });

    await user.click(
      await screen.findByRole("switch", {
        name: "Enable Levels.fyi",
      }),
    );

    await waitFor(() =>
      expect(updateCompensationSourcePolicy).toHaveBeenCalledWith({
        sourceId: "levels_fyi",
        enabled: true,
        accessMode: "public_markdown",
        europeCoverageConfirmed: false,
      }),
    );
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

    await screen.findByText("Manual reported compensation import");
    expect(container.querySelectorAll(".card .card")).toHaveLength(0);
  });

  it("has no critical or serious axe violations", async () => {
    const view = renderWithProviders(<CompensationSourcePolicyPanel />, {
      ports: buildTestPorts({
        api: { compensationSources: vi.fn(async () => policyResponse()) },
      }),
    });

    await screen.findByText("Manual reported compensation import");
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
