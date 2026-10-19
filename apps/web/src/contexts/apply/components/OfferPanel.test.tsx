import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { OfferPanel } from "./OfferPanel.js";
import type {
  OfferReadResponse,
  SaveOfferTerms,
  RecordOfferDecision,
} from "@jobctrl/contracts";

const JOB = "00000000-0000-4000-8000-000000000003";
const revisionId = "00000000-0000-4000-8000-000000000103";
const source = {
  reference: "Synthetic offer letter",
  quote: "Base EUR 90000 per year",
  capturedAt: "2026-10-18T10:00:00.000Z",
  userConfirmed: true as const,
};
const empty: OfferReadResponse = {
  ok: true,
  jobId: JOB,
  termsHistory: [],
  decisions: [],
  currentTerms: null,
  currentDecision: null,
};
function withTerms(): OfferReadResponse {
  const currentTerms = {
    expectedRevisionId: null,
    revisionId,
    recordedAt: source.capturedAt,
    terms: {
      source,
      cash: [
        {
          component: "base_salary" as const,
          amount: 90000,
          currency: "EUR",
          period: "year" as const,
          source,
        },
      ],
      equity: null,
      benefits: null,
      decisionDeadline: null,
    },
  };
  return { ...empty, currentTerms, termsHistory: [currentTerms] };
}
const compensation = {
  postedCompensationFact: vi.fn(async () => ({
    ok: true as const,
    recordStatus: "not_recorded" as const,
    jobKey: JOB,
    legacyRawSalary: null,
  })),
  marketCompensationEstimate: vi.fn(async () => ({
    ok: true as const,
    recordStatus: "not_requested" as const,
    jobKey: JOB,
  })),
};

describe("offer terms and decisions", () => {
  it("saves manually confirmed cash without filling unknown equity, benefits, currency or deadlines", async () => {
    const user = userEvent.setup();
    let current = empty;
    const saveOfferTerms = vi.fn(async (_job: string, body: SaveOfferTerms) => {
      current = {
        ...withTerms(),
        currentTerms: { ...withTerms().currentTerms!, terms: body.terms },
      };
      return current;
    });
    const ports = buildTestPorts({
      api: {
        ...compensation,
        jobOffer: vi.fn(async () => current),
        saveOfferTerms,
      },
    });
    renderWithProviders(<OfferPanel jobId={JOB} />, { ports });
    await screen.findByText("No actual offer terms recorded.");
    await user.click(screen.getByText("Record actual offer terms"));
    await user.type(screen.getByLabelText("Amount 1"), "90000");
    await user.type(
      screen.getByLabelText("Offer source reference"),
      source.reference,
    );
    await user.type(
      screen.getByLabelText("Verbatim offer source quote"),
      source.quote,
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "I confirm these are actual offered terms supported by this source.",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save confirmed offer terms" }),
    );
    await waitFor(() => expect(saveOfferTerms).toHaveBeenCalledTimes(1));
    expect(saveOfferTerms.mock.calls[0]?.[1]).toMatchObject({
      expectedRevisionId: null,
      terms: {
        cash: [{ amount: 90000, currency: null, period: "unknown" }],
        equity: null,
        benefits: null,
        decisionDeadline: null,
      },
    });
    expect(
      (await screen.findAllByText("Equity: Unknown"))[0],
    ).toBeInTheDocument();
    expect(screen.getAllByText("Benefits: Unknown")[0]).toBeInTheDocument();
    expect(
      screen.getAllByText("Decision deadline: Unknown")[0],
    ).toBeInTheDocument();
  });

  it("records an offer decision without interview prep and preserves the review fields on a conflict", async () => {
    const user = userEvent.setup();
    const recordOfferDecision = vi.fn(
      async (_job: string, _body: RecordOfferDecision) => {
        throw new Error(
          "Offer decision changed. Reload before recording a correction.",
        );
      },
    );
    const ports = buildTestPorts({
      api: {
        ...compensation,
        jobOffer: vi.fn(async () => withTerms()),
        recordOfferDecision,
      },
    });
    renderWithProviders(<OfferPanel jobId={JOB} />, { ports });
    await user.click(await screen.findByText("Record offer decision"));
    await user.type(
      screen.getByLabelText("Decision source reference"),
      "Synthetic user attestation",
    );
    await user.type(
      screen.getByLabelText("Decision evidence or your attestation"),
      "I accepted these terms.",
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "I attest to this offer decision on the current terms.",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save offer decision" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Offer decision changed",
    );
    expect(
      screen.getByLabelText("Decision evidence or your attestation"),
    ).toHaveValue("I accepted these terms.");
    expect(recordOfferDecision.mock.calls[0]).toEqual([
      JOB,
      expect.objectContaining({
        expectedDecisionId: null,
        termsRevisionId: revisionId,
        decision: "accepted",
      }),
    ]);
    expect(screen.queryByText(/interview prep/i)).not.toBeInTheDocument();
  });

  it("shows earlier decisions against their terms and the complete correction history", async () => {
    const state = withTerms();
    const first = {
      expectedDecisionId: null,
      decisionId: "00000000-0000-4000-8000-000000000111",
      termsRevisionId: "00000000-0000-4000-8000-000000000110",
      decision: "accepted" as const,
      occurredAt: source.capturedAt,
      recordedAt: source.capturedAt,
      source,
    };
    const corrected = {
      ...first,
      expectedDecisionId: first.decisionId,
      decisionId: "00000000-0000-4000-8000-000000000112",
      decision: "declined" as const,
      correctionReason: "Corrected synthetic decision",
    };
    state.decisions = [first, corrected];
    state.currentDecision = corrected;
    renderWithProviders(<OfferPanel jobId={JOB} />, {
      ports: buildTestPorts({
        api: { ...compensation, jobOffer: vi.fn(async () => state) },
      }),
    });
    expect(
      await screen.findByText("Offer decision: declined"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "This decision refers to earlier terms",
    );
    await userEvent.click(screen.getByText("Offer history"));
    const history = screen.getByText("Offer history").parentElement!;
    expect(within(history).getByText(/accepted/)).toBeInTheDocument();
    expect(
      within(history).getByText(/Corrected synthetic decision/),
    ).toBeInTheDocument();
  });
});
