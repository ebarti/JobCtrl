import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildProviderHarness } from "../../../test/render.js";
import { materialsKeys } from "../queryKeys.js";
import { makeLocaleVariant } from "./MaterialLocaleVariants.stories.js";
import {
  MaterialLocaleVariants,
  LocaleVariantCard,
} from "./MaterialLocaleVariants.js";

describe("independent locale review", () => {
  it("requires both independent confirmations and displays recorded joins", async () => {
    const onReview = vi.fn();
    render(
      <LocaleVariantCard
        variant={makeLocaleVariant()}
        jobKey="job"
        pending={false}
        onReview={onReview}
      />,
    );
    const accept = screen.getByRole("button", { name: "Accept translation" });
    expect(accept).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText(
        "I reviewed terminology and original credential designations",
      ),
    );
    expect(accept).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I reviewed formatting separately"));
    fireEvent.click(accept);
    await waitFor(() => expect(onReview).toHaveBeenCalledWith("accepted", "confirmed", "confirmed"));
    expect(screen.getAllByText("Synthetic historical title")).toHaveLength(2);
  });
  it("never overrides a failed semantic decision and exposes original designation warnings", () => {
    const variant = {
      ...makeLocaleVariant(),
      eligible: false,
      issues: [
        {
          line_id: "source:0",
          kind: "ambiguous_credential" as const,
          citation: {
            source_id: "source:0",
            quote: "Original designation",
            exact_values: [],
          },
          explanation: "No equivalence asserted",
        },
      ],
    };
    render(
      <LocaleVariantCard
        variant={variant}
        jobKey="job"
        pending={false}
        onReview={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByLabelText(
        "I reviewed terminology and original credential designations",
      ),
    );
    fireEvent.click(screen.getByLabelText("I reviewed formatting separately"));
    expect(
      screen.getByRole("button", { name: "Accept translation" }),
    ).toBeDisabled();
    expect(screen.getByText(/No equivalence asserted/)).toBeVisible();
  });
  it("downloads only accepted exports and preserves review history", () => {
    const variant = makeLocaleVariant("accepted");
    variant.reviews = [
      {
        kind: "acceptance",
        decision: "accepted",
        reviewedAt: "2026-10-08",
        sourceHash: variant.binding.sourceHash,
        documentHash: "d",
      },
    ];
    render(
      <LocaleVariantCard
        variant={variant}
        jobKey="job"
        pending={false}
        onReview={() => {}}
      />,
    );
    expect(screen.getAllByRole("link")).toHaveLength(4);
    expect(
      screen.queryByRole("button", { name: "Accept translation" }),
    ).toBeNull();
    fireEvent.click(screen.getByText("Review history and provenance"));
    expect(screen.getByText(/acceptance: accepted/)).toBeVisible();
  });
  it("rolls optimistic state back after review failure and keeps accepted history", async () => {
    const harness = buildProviderHarness();
    const history = {
      ok: true as const,
      revision: 3,
      locales: ["en", "es"] as ("en" | "es")[],
      sources: [],
      variants: [
        makeLocaleVariant("accepted"),
        { ...makeLocaleVariant(), variantId: "locale:candidate" },
      ],
    };
    harness.ports.api.localeVariants = vi.fn().mockResolvedValue(history);
    let reject!: (error: Error) => void;
    harness.ports.api.reviewLocaleVariant = vi.fn().mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    render(<MaterialLocaleVariants jobKey="job" />, {
      wrapper: harness.Wrapper,
    });
    await screen.findByRole("button", { name: "Accept translation" });
    fireEvent.click(
      screen.getByLabelText(
        "I reviewed terminology and original credential designations",
      ),
    );
    fireEvent.click(screen.getByLabelText("I reviewed formatting separately"));
    fireEvent.click(screen.getByRole("button", { name: "Accept translation" }));
    await waitFor(() =>
      expect(harness.ports.api.reviewLocaleVariant).toHaveBeenCalled(),
    );
    expect(
      harness.queryClient.getQueryData<{ variants: { eligible: boolean }[] }>(
        materialsKeys.locales(LOCAL_TENANT, "job"),
      )?.variants[1]?.eligible,
    ).toBe(false);
    reject(new Error("Owned review failure"));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(
        harness.queryClient.getQueryData<{ variants: { eligible: boolean }[] }>(
          materialsKeys.locales(LOCAL_TENANT, "job"),
        )?.variants[1]?.eligible,
      ).toBe(true),
    );
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });
  it("generation failure retains accepted artifacts and unavailable generation is explicit", async () => {
    const harness = buildProviderHarness();
    harness.ports.api.localeVariants = vi
      .fn()
      .mockRejectedValue(new Error("Worker unavailable"));
    render(<MaterialLocaleVariants jobKey="job" />, {
      wrapper: harness.Wrapper,
    });
    await screen.findByRole("alert");
    expect(
      screen.getByRole("button", { name: "Generate locale variant" }),
    ).toBeDisabled();
    expect(screen.getByText(/offline demo cannot generate/)).toBeVisible();
  });
});
