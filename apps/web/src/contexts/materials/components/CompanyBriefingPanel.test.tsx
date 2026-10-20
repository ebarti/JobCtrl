import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { sampleCompanyBriefing } from "../../../test/fixtures/company-briefing.js";
import { renderWithProviders } from "../../../test/render.js";
import { CompanyBriefingPanel } from "./CompanyBriefingPanel.js";

describe("company briefing", () => {
  it("keeps accepted claims visible after failure and exposes dated source excerpts", async () => {
    renderWithProviders(<CompanyBriefingPanel briefing={sampleCompanyBriefing} />);
    expect(screen.getByText("Stale briefing — review required")).toBeVisible();
    expect(screen.getByText(/last accepted briefing remains below/)).toBeVisible();
    expect(screen.getByText("Synthetic company hypothesis")).toBeVisible();
    expect(screen.getByText(/Uncertainty: One source/)).toBeVisible();
    await userEvent.click(screen.getByText("Sources for this claim"));
    expect(screen.getByText("Example public source.")).toBeVisible();
    expect(screen.getByRole("link", { name: "https://example.com/about" })).toHaveAttribute("href", "https://example.com/about");
    await userEvent.click(screen.getByText("Source fingerprint"));
    expect(screen.getByText("d".repeat(64))).toBeVisible();
  });
  it("reports failed verification explicitly and does not invent missing source content", () => {
    renderWithProviders(<CompanyBriefingPanel briefing={{ company: null, accepted: null, lastAttempt: null, staleReasons: [], status: "unavailable" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("could not be verified");
    expect(screen.queryByText("Synthetic company hypothesis")).not.toBeInTheDocument();
  });
});
