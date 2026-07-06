import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { sampleDailyDigest } from "../../test/fixtures/projections.js";
import { server } from "../../test/msw/server.js";
import { renderWithProviders } from "../../test/render.js";
import { DigestPanel } from "./DigestPanel.js";

describe("DigestPanel", () => {
  it("renders digest rows with exact URL-owned deep links", async () => {
    renderWithProviders(<DigestPanel />);

    expect(await screen.findByRole("heading", { name: "Daily digest" })).toBeInTheDocument();
    const newMatches = await screen.findByRole("link", { name: /new matches/i });

    expect(within(newMatches).getByText("3")).toBeInTheDocument();
    expect(newMatches.getAttribute("href")).toContain("discoveredSince=");
    expect(newMatches.getAttribute("href")).toContain("scoredSince=");
    expect(screen.getByText("7d, UTC")).toBeInTheDocument();
  });

  it("acknowledges only when the operator marks the digest reviewed", async () => {
    let postedBody: unknown = null;
    server.use(
      http.post("*/v1/digest/acknowledge", async ({ request }) => {
        postedBody = await request.json();
        return HttpResponse.json({
          ok: true,
          state: {
            lastAcknowledgedAt: sampleDailyDigest.generatedAt,
            updatedAt: sampleDailyDigest.generatedAt,
          },
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<DigestPanel />);

    await screen.findByRole("heading", { name: "Daily digest" });
    expect(postedBody).toBeNull();

    await user.click(await screen.findByRole("button", { name: /mark reviewed/i }));

    await waitFor(() =>
      expect(postedBody).toEqual({ acknowledgedAt: sampleDailyDigest.generatedAt }),
    );
  });
});
