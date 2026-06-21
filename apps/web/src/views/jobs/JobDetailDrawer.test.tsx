import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { server } from "../../test/msw/server.js";
import { buildProviderHarness } from "../../test/render.js";
import {
  populatedEmployerAnalysis,
  populatedRequirementFitReport,
} from "../../test/fixtures/materials-inspector.js";
import {
  jobDetailWithCompensation,
  jobWithCompensation,
  makeAmbiguousPostedCompensationAudit,
  makeApplyAudit,
  makeCompensationAudit,
  makeCompensationFloorComparison,
  makeCompensationFloorComparisonArm,
  makeCompensationSummary,
  makeEstimatedMarketCompensationAudit,
  makeInsufficientMarketCompensationAudit,
  makeJobDetail,
  makeMarketCompensationSummary,
  makeMissingPostedCompensationAudit,
  makeRecordedPostedCompensationAudit,
  makeSourceConflictMarketCompensationAudit,
  makeUnavailableMarketCompensationAudit,
  makeUnparseablePostedCompensationAudit,
  makeUnsupportedMarketCompensationAudit,
  sampleCompensationAudit,
  sampleJob,
  sampleSecondaryJob,
} from "../../test/fixtures/projections.js";
import { JobDetailDrawer } from "./JobDetailDrawer.js";

function RoutedJobDetailDrawer({ jobId }: { readonly jobId: string }) {
  const navigate = useNavigate();
  const search = useSearch({ from: "/jobs" });
  return (
    <JobDetailDrawer
      jobId={jobId}
      onClose={() => {
        void navigate({ to: "/jobs", search });
      }}
    />
  );
}

function renderJobDetailDrawer(jobId: string) {
  const harness = buildProviderHarness();
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs",
    validateSearch: jobsSearchSchema,
    component: () => <Outlet />,
  });
  const detailRoute = createRoute({
    getParentRoute: () => jobsRoute,
    path: "/$jobId",
    component: () => <RoutedJobDetailDrawer jobId={jobId} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([jobsRoute.addChildren([detailRoute])]),
    history: createMemoryHistory({
      initialEntries: [
        `/jobs/${encodeURIComponent(jobId)}?stage=all&state=all&deleted=active&sort=discovered_at&dir=desc&page=1&pageSize=50`,
      ],
    }),
  });
  return {
    router,
    ...render(<RouterProvider router={router} />, { wrapper: harness.Wrapper }),
  };
}

describe("<JobDetailDrawer>", () => {
  it("renders compensation audit after job audit triage and before description", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) =>
        HttpResponse.json(
          jobDetailWithCompensation(
            jobWithCompensation({ jobKey: String(params["jobKey"]) }),
            {
              compensationAudit: makeCompensationAudit({
                posted: makeRecordedPostedCompensationAudit(),
                market: makeEstimatedMarketCompensationAudit(),
              }),
            },
          ),
        ),
      ),
    );

    renderJobDetailDrawer("job-compensation-audit");

    const triage = await screen.findByRole("region", { name: "Why this job is here" });
    const compensation = screen.getByRole("region", { name: "Compensation audit" });
    const description = screen.getByText("Description").closest("section");
    expect(description).not.toBeNull();
    expect(triage.compareDocumentPosition(compensation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(compensation.compareDocumentPosition(description as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders posted salary, market estimate, and floor comparison as separate top summary items", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", () =>
        HttpResponse.json(
          jobDetailWithCompensation(undefined, {
            compensationAudit: makeCompensationAudit({
              posted: makeRecordedPostedCompensationAudit(),
              market: makeEstimatedMarketCompensationAudit(),
              floorComparison: makeCompensationFloorComparison({
                basis: "both_posted_and_market",
                warningCount: 1,
                warningLabels: ["compensation_below_profile_floor"],
              }),
            }),
          }),
        ),
      ),
    );

    renderJobDetailDrawer("job-compensation-summary");

    const compensation = await screen.findByRole("region", { name: "Compensation audit" });
    expect(within(compensation).getByText("Warning-only salary evidence")).toBeInTheDocument();
    expect(within(compensation).getByText("Posted salary")).toBeInTheDocument();
    expect(within(compensation).getAllByText("EUR 120k-150k").length).toBeGreaterThan(0);
    expect(within(compensation).getByText("Market estimate")).toBeInTheDocument();
    expect(within(compensation).getAllByText("EUR 135k-165k").length).toBeGreaterThan(0);
    expect(within(compensation).getByText("Floor comparison")).toBeInTheDocument();
    expect(within(compensation).getByText("Both posted and market")).toBeInTheDocument();
  });

  it("renders legacy compensation payloads without a floor comparison as unavailable", async () => {
    const legacyAudit = makeCompensationAudit({
      posted: makeRecordedPostedCompensationAudit(),
      market: makeEstimatedMarketCompensationAudit(),
    }) as unknown as Record<string, unknown>;
    const legacySummary = makeCompensationSummary() as unknown as Record<string, unknown>;
    delete legacyAudit["floorComparison"];
    delete legacySummary["floorComparison"];
    server.use(
      http.get("*/v1/jobs/:jobKey", () =>
        HttpResponse.json(
          jobDetailWithCompensation(jobWithCompensation({ compensationSummary: legacySummary as never }), {
            compensationAudit: legacyAudit as never,
          }),
        ),
      ),
    );

    renderJobDetailDrawer("job-compensation-legacy-floor");

    const compensation = await screen.findByRole("region", { name: "Compensation audit" });
    expect(within(compensation).getByText("No compensation facts recorded.")).toBeInTheDocument();
    expect(
      within(compensation).getByText(
        "Posted salary and market estimate details will appear here after the compensation projection records them.",
      ),
    ).toBeInTheDocument();
  });

  it("renders compensation payloads with malformed floor arms as unavailable", async () => {
    const shallowFloorComparison = makeCompensationFloorComparison({
      basis: "both_posted_and_market",
      posted: {} as never,
      market: {} as never,
      warningCount: 1,
      warningLabels: ["compensation_below_profile_floor"],
    });
    const legacyAudit = {
      floorComparison: shallowFloorComparison,
      posted: { ok: true, recordStatus: "recorded", fact: {} },
      market: { ok: true, recordStatus: "recorded", estimate: {} },
    };
    const legacySummary = { floorComparison: shallowFloorComparison, posted: {}, market: {} };
    server.use(
      http.get("*/v1/jobs/:jobKey", () =>
        HttpResponse.json(
          jobDetailWithCompensation(jobWithCompensation({ compensationSummary: legacySummary as never }), {
            compensationAudit: legacyAudit as never,
          }),
        ),
      ),
    );

    renderJobDetailDrawer("job-compensation-shallow-floor");

    const compensation = await screen.findByRole("region", { name: "Compensation audit" });
    expect(within(compensation).getByText("No compensation facts recorded.")).toBeInTheDocument();
    expect(
      within(compensation).getByText(
        "Posted salary and market estimate details will appear here after the compensation projection records them.",
      ),
    ).toBeInTheDocument();
  });

  it("renders compensation payloads with malformed floor values as unavailable", async () => {
    const malformedFloorComparison = makeCompensationFloorComparison({
      floor: {} as never,
    });
    server.use(
      http.get("*/v1/jobs/:jobKey", () =>
        HttpResponse.json(
          jobDetailWithCompensation(
            jobWithCompensation({
              compensationSummary: makeCompensationSummary({
                floorComparison: malformedFloorComparison,
              }) as never,
            }),
            {
              compensationAudit: makeCompensationAudit({
                floorComparison: malformedFloorComparison,
                posted: makeRecordedPostedCompensationAudit(),
                market: makeEstimatedMarketCompensationAudit(),
              }) as never,
            },
          ),
        ),
      ),
    );

    renderJobDetailDrawer("job-compensation-malformed-floor");

    const compensation = await screen.findByRole("region", { name: "Compensation audit" });
    expect(within(compensation).getByText("No compensation facts recorded.")).toBeInTheDocument();
    expect(compensation).not.toHaveTextContent("undefined");
  });

  it("renders compensation payloads with invalid floor enum and value data as unavailable", async () => {
    const malformedFloorComparison = makeCompensationFloorComparison({
      state: "legacy_bad_state" as never,
      basis: "legacy_bad_basis" as never,
      floor: { amount: -1, currency: "", period: "year" },
      posted: makeCompensationFloorComparisonArm({
        state: "legacy_bad_arm" as never,
      }),
    });
    server.use(
      http.get("*/v1/jobs/:jobKey", () =>
        HttpResponse.json(
          jobDetailWithCompensation(
            jobWithCompensation({
              compensationSummary: makeCompensationSummary({
                floorComparison: malformedFloorComparison,
              }) as never,
            }),
            {
              compensationAudit: makeCompensationAudit({
                floorComparison: malformedFloorComparison,
                posted: makeRecordedPostedCompensationAudit(),
                market: makeEstimatedMarketCompensationAudit(),
              }) as never,
            },
          ),
        ),
      ),
    );

    renderJobDetailDrawer("job-compensation-invalid-floor-enum");

    const compensation = await screen.findByRole("region", { name: "Compensation audit" });
    expect(within(compensation).getByText("No compensation facts recorded.")).toBeInTheDocument();
    expect(compensation).not.toHaveTextContent("undefined");
  });

  it("renders compensation payloads with invalid posted and market enum data as unavailable", async () => {
    const legacySummary = makeCompensationSummary() as never as Record<string, any>;
    legacySummary["posted"].confidence = "legacy_bad_confidence";
    legacySummary["market"].estimateState = "legacy_bad_market";
    legacySummary["market"].confidenceBand = "legacy_bad_band";
    const legacyAudit = makeCompensationAudit({
      posted: makeRecordedPostedCompensationAudit(),
      market: makeEstimatedMarketCompensationAudit(),
    }) as never as Record<string, any>;
    legacyAudit["posted"].fact.parseState = "legacy_bad_parse";
    legacyAudit["market"].estimate.estimateState = "legacy_bad_market";
    legacyAudit["market"].estimate.confidenceBand = "legacy_bad_band";

    server.use(
      http.get("*/v1/jobs/:jobKey", () =>
        HttpResponse.json(
          jobDetailWithCompensation(jobWithCompensation({ compensationSummary: legacySummary as never }), {
            compensationAudit: legacyAudit as never,
          }),
        ),
      ),
    );

    renderJobDetailDrawer("job-compensation-invalid-enums");

    const compensation = await screen.findByRole("region", { name: "Compensation audit" });
    expect(within(compensation).getByText("No compensation facts recorded.")).toBeInTheDocument();
    expect(compensation).not.toHaveTextContent("undefined");
  });

  it("renders progressive disclosures for source trail plus confidence factors and assumptions", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", () =>
        HttpResponse.json(
          jobDetailWithCompensation(undefined, {
            compensationAudit: makeCompensationAudit({
              posted: makeRecordedPostedCompensationAudit(),
              market: makeEstimatedMarketCompensationAudit(),
            }),
          }),
        ),
      ),
    );

    renderJobDetailDrawer("job-compensation-disclosures");

    const compensation = await screen.findByRole("region", { name: "Compensation audit" });
    expect(within(compensation).getByText("Source trail")).toBeInTheDocument();
    expect(within(compensation).getByText("2 sources")).toBeInTheDocument();
    expect(within(compensation).getByText("Manual reported compensation import")).toBeInTheDocument();
    expect(within(compensation).getByText("Glassdoor")).toBeInTheDocument();
    expect(within(compensation).getByText("Confidence factors and assumptions")).toBeInTheDocument();
    expect(within(compensation).getByText("3 confidence factors")).toBeInTheDocument();
    expect(within(compensation).getByText("Annual gross base salary.")).toBeInTheDocument();
  });

  it("renders explicit posted and market missing, weak, and unavailable states", async () => {
    const details = new Map([
      [
        "missing-posted",
        jobDetailWithCompensation(undefined, {
          compensationAudit: makeCompensationAudit({ posted: makeMissingPostedCompensationAudit() }),
        }),
      ],
      [
        "unparseable-posted",
        jobDetailWithCompensation(undefined, {
          compensationAudit: makeCompensationAudit({ posted: makeUnparseablePostedCompensationAudit() }),
        }),
      ],
      [
        "ambiguous-posted",
        jobDetailWithCompensation(undefined, {
          compensationAudit: makeCompensationAudit({ posted: makeAmbiguousPostedCompensationAudit() }),
        }),
      ],
      [
        "unsupported-market",
        jobDetailWithCompensation(undefined, {
          compensationAudit: makeCompensationAudit({ market: makeUnsupportedMarketCompensationAudit() }),
        }),
      ],
      [
        "insufficient-market",
        jobDetailWithCompensation(undefined, {
          compensationAudit: makeCompensationAudit({ market: makeInsufficientMarketCompensationAudit() }),
        }),
      ],
      [
        "unavailable-market",
        jobDetailWithCompensation(undefined, {
          compensationAudit: makeCompensationAudit({ market: makeUnavailableMarketCompensationAudit() }),
        }),
      ],
      [
        "not-requested-market",
        jobDetailWithCompensation(undefined, {
          compensationAudit: makeCompensationAudit({ market: { ok: true, recordStatus: "not_requested", jobKey: sampleJob.jobKey } }),
        }),
      ],
    ]);
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) =>
        HttpResponse.json(details.get(String(params["jobKey"])) ?? makeJobDetail()),
      ),
    );

    const expectations = [
      ["missing-posted", "No posted salary recorded"],
      ["unparseable-posted", "Posted salary unparseable"],
      ["ambiguous-posted", "Posted salary ambiguous"],
      ["unsupported-market", "Market estimate unsupported"],
      ["insufficient-market", "Insufficient market evidence"],
      ["unavailable-market", "Market source unavailable"],
      ["unavailable-market", "Levels.fyi access unavailable until permitted source access is configured."],
      ["not-requested-market", "Market estimate not requested"],
    ] as const;

    for (const [jobId, expectedText] of expectations) {
      const view = renderJobDetailDrawer(jobId);
      const compensation = await screen.findByRole("region", { name: "Compensation audit" });
      expect(within(compensation).getByText(expectedText)).toBeInTheDocument();
      view.unmount();
    }
  });

  it("names every floor comparison basis without making it an apply concern", async () => {
    const basisDetails = new Map([
      [
        "posted-basis",
        makeCompensationFloorComparison({
          state: "below_floor",
          basis: "posted_salary_basis",
          market: null,
          warningCount: 1,
          warningLabels: ["posted_compensation_below_profile_floor"],
        }),
      ],
      [
        "market-basis",
        makeCompensationFloorComparison({
          state: "below_floor",
          basis: "market_estimate_basis",
          posted: null,
          warningCount: 1,
          warningLabels: ["market_compensation_below_profile_floor"],
        }),
      ],
      [
        "both-basis",
        makeCompensationFloorComparison({
          state: "below_floor",
          basis: "both_posted_and_market",
          warningCount: 1,
          warningLabels: ["compensation_below_profile_floor"],
        }),
      ],
      [
        "no-comparable-basis",
        makeCompensationFloorComparison({
          state: "not_comparable",
          basis: "no_comparable_compensation_basis",
          floor: { amount: 140_000, currency: "EUR", period: "year" },
          posted: makeCompensationFloorComparisonArm({ state: "not_comparable", displayRange: null }),
          market: null,
          warningCount: 0,
          warningLabels: [],
        }),
      ],
      [
        "floor-not-configured",
        makeCompensationFloorComparison({
          state: "not_configured",
          basis: "floor_not_configured",
          floor: null,
          posted: null,
          market: null,
          warningCount: 0,
          warningLabels: [],
        }),
      ],
    ]);
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) =>
        HttpResponse.json(
          jobDetailWithCompensation(undefined, {
            compensationAudit: makeCompensationAudit({
              floorComparison: basisDetails.get(String(params["jobKey"])) ?? makeCompensationFloorComparison(),
            }),
          }),
        ),
      ),
    );

    const expectations = [
      ["posted-basis", "Posted salary basis"],
      ["market-basis", "Market estimate basis"],
      ["both-basis", "Both posted and market"],
      ["no-comparable-basis", "No comparable compensation basis"],
      ["floor-not-configured", "Floor not configured"],
    ] as const;

    for (const [jobId, expectedText] of expectations) {
      const view = renderJobDetailDrawer(jobId);
      const compensation = await screen.findByRole("region", { name: "Compensation audit" });
      expect(within(compensation).getByText(expectedText)).toBeInTheDocument();
      view.unmount();
    }
  });

  it("keeps compensation floor warnings out of apply concerns and readiness controls", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", () =>
        HttpResponse.json(
          jobDetailWithCompensation(undefined, {
            applyAudit: makeApplyAudit({
              state: "ready",
              label: "materials ready",
              summary: "The tailored materials are ready to review before approval.",
            }),
            compensationAudit: makeCompensationAudit({
              floorComparison: makeCompensationFloorComparison({
                state: "below_floor",
                basis: "posted_salary_basis",
                market: null,
                warningCount: 1,
                warningLabels: ["posted_compensation_below_profile_floor"],
              }),
            }),
          }),
        ),
      ),
    );

    renderJobDetailDrawer("job-warning-only-boundary");

    const compensation = await screen.findByRole("region", { name: "Compensation audit" });
    expect(within(compensation).getByText("posted_compensation_below_profile_floor")).toBeInTheDocument();
    expect(
      within(compensation).getByText("Compensation warnings do not change ranking, filters, apply readiness, blockers, or dispatch in v1.3."),
    ).toBeInTheDocument();

    const triage = screen.getByRole("region", { name: "Why this job is here" });
    const drawer = screen.getByRole("dialog", { name: "Job details" });
    expect(within(triage).queryByText("posted_compensation_below_profile_floor")).not.toBeInTheDocument();
    expect(within(triage).queryByText("Compensation audit")).not.toBeInTheDocument();
    expect(within(triage).queryByText("Apply concerns")).not.toBeInTheDocument();
    expect(within(drawer).getByLabelText("Apply readiness")).toHaveTextContent("materials ready");
    expect(within(triage).getByText("Fit score")).toBeInTheDocument();
  });

  it("renders source-conflict compensation warnings only inside compensation audit", async () => {
    const market = makeSourceConflictMarketCompensationAudit();
    expect(JSON.stringify(market)).toContain("source_conflict_with_posted_salary");
    expect(JSON.stringify(market)).toContain("reported_compensation_sample");
    expect(JSON.stringify(market)).not.toMatch(/~\/\.jobhunter|\/Users\/|api[_-]?key|oauth|resume|cover letter/i);

    server.use(
      http.get("*/v1/jobs/:jobKey", () =>
        HttpResponse.json(
          jobDetailWithCompensation(
            jobWithCompensation({
              compensationSummary: makeCompensationSummary({
                warningCount: 2,
                market: makeMarketCompensationSummary({
                  confidenceBand: "medium",
                  sourceCount: 2,
                  warningCount: 2,
                }),
              }),
            }),
            {
              applyAudit: makeApplyAudit({
                state: "blocked",
                label: "missing apply link",
                summary: "Application review is blocked until the posting URL is confirmed.",
                missingPrerequisites: [
                  {
                    code: "missing_resume_pdf",
                    label: "Submit-ready PDF missing",
                    detail: "A submit-ready PDF is still missing.",
                    severity: "warning",
                    source: "materials.pdf",
                  },
                ],
                hardBlockers: [
                  {
                    code: "missing_application_url",
                    label: "Missing apply link",
                    detail: "No application URL is recorded.",
                    severity: "blocking",
                    source: "application_url",
                  },
                ],
                eligibilityConcerns: [
                  {
                    code: "score_eligibility_warning",
                    label: "Eligibility warning",
                    detail: "Sponsorship requirements need review.",
                    severity: "warning",
                    source: "score_eligibility",
                  },
                ],
              }),
              compensationAudit: makeCompensationAudit({
                posted: makeRecordedPostedCompensationAudit(),
                market,
              }),
            },
          ),
        ),
      ),
    );

    renderJobDetailDrawer("job-source-conflict");

    const compensation = await screen.findByRole("region", { name: "Compensation audit" });
    expect(within(compensation).getByText("source_conflict_with_posted_salary")).toBeInTheDocument();
    expect(within(compensation).getByText("Market estimate is above the posted range.")).toBeInTheDocument();
    expect(within(compensation).getByText("reported_compensation_sample")).toBeInTheDocument();
    expect(
      within(compensation).getByText("The estimate uses reported compensation rows for the job company and role."),
    ).toBeInTheDocument();

    const triage = screen.getByRole("region", { name: "Why this job is here" });
    const drawer = screen.getByRole("dialog", { name: "Job details" });
    for (const text of [
      "source_conflict_with_posted_salary",
      "Market estimate is above the posted range.",
      "reported_compensation_sample",
      "The estimate uses reported compensation rows for the job company and role.",
    ]) {
      expect(within(triage).queryByText(text)).not.toBeInTheDocument();
    }
    expect(within(triage).getByText("Apply concerns")).toBeInTheDocument();
    expect(within(triage).getByText("Missing apply link: No application URL is recorded.")).toBeInTheDocument();
    expect(within(triage).getByText("Submit-ready PDF missing: A submit-ready PDF is still missing.")).toBeInTheDocument();
    expect(within(triage).getByText("Eligibility warning: Sponsorship requirements need review.")).toBeInTheDocument();
    expect(within(drawer).getByLabelText("Apply readiness")).toHaveTextContent("missing apply link");
    expect(within(drawer).getByLabelText("Apply readiness")).not.toHaveTextContent(/compensation|salary|source conflict/i);
    expect(
      within(triage).getByRole("link", { name: "Open Apply Review for Staff Software Engineer" }),
    ).not.toHaveTextContent(/compensation|salary|source conflict/i);
  });

  it("summarizes ranking, readiness, blockers, eligibility, and Apply Review handoff", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) => {
        return HttpResponse.json(
          makeJobDetail({
            ...sampleJob,
            jobKey: String(params["jobKey"]),
            currentStage: "apply",
            currentSubstage: "apply",
            currentState: "pending",
            scoreKeywords: ["platform reliability", "sre"],
            scoreBreakdown: {
              ...sampleJob.scoreBreakdown!,
              eligibility: {
                status: "warning",
                hardBlockers: [],
                warnings: ["Sponsorship requirements need review."],
              },
            },
          }, {
            applyAudit: makeApplyAudit({
              state: "blocked",
              label: "missing apply link",
              summary: "No application or posting URL is recorded, so apply review cannot proceed.",
              missingPrerequisites: [
                {
                  code: "missing_resume_pdf",
                  label: "Submit-ready PDF missing",
                  detail: "Reviewable resume text may be available, but the submit-ready PDF is still missing.",
                  severity: "warning",
                  source: "materials.pdf",
                },
              ],
              hardBlockers: [
                {
                  code: "missing_application_url",
                  label: "Missing apply link",
                  detail: "No application or posting URL is recorded, so apply review cannot proceed.",
                  severity: "blocking",
                  source: "application_url",
                },
              ],
              eligibilityConcerns: [
                {
                  code: "score_eligibility_warning",
                  label: "Eligibility warning",
                  detail: "Sponsorship requirements need review.",
                  severity: "warning",
                  source: "score_eligibility",
                },
              ],
            }),
            requirementFitReport: populatedRequirementFitReport,
          }),
        );
      }),
    );

    renderJobDetailDrawer("https://example.com/jobs/1");

    const triage = await screen.findByRole("region", { name: "Why this job is here" });
    const drawer = screen.getByRole("dialog", { name: "Job details" });
    expect(drawer).toHaveClass("job-detail-drawer");
    expect(drawer.querySelector(".job-detail-drawer-content")).not.toBeNull();
    expect(drawer.querySelector(".job-detail-drawer-main")).not.toBeNull();
    expect(within(triage).getByText("Audit triage")).toBeInTheDocument();
    expect(within(triage).getByText("8/10")).toBeInTheDocument();
    expect(within(triage).getByText("strong")).toBeInTheDocument();
    expect(within(triage).getByText("high")).toBeInTheDocument();
    expect(within(triage).getByText("Requirement fit")).toBeInTheDocument();
    expect(within(triage).getByText("78%")).toBeInTheDocument();
    expect(within(triage).getByText("Must-haves")).toBeInTheDocument();
    expect(within(triage).getByText("100%")).toBeInTheDocument();
    expect(within(triage).getByText("Strong fit on platform reliability.")).toBeInTheDocument();
    expect(within(triage).getAllByText("platform reliability").length).toBeGreaterThan(0);
    expect(within(triage).getByText("Matched requirements")).toBeInTheDocument();
    expect(within(triage).getByText("Lead platform reliability programs across multiple teams")).toBeInTheDocument();
    expect(within(triage).getByText("Transferable requirements")).toBeInTheDocument();
    expect(within(triage).getByText("Experience with Kubernetes-based developer platforms")).toBeInTheDocument();
    const readiness = within(drawer).getByLabelText("Apply readiness");
    expect(within(readiness).getByText("missing apply link")).toBeInTheDocument();
    expect(within(triage).getByText("Apply concerns")).toBeInTheDocument();
    expect(
      within(triage).getByText("Missing apply link: No application or posting URL is recorded, so apply review cannot proceed."),
    ).toBeInTheDocument();
    expect(
      within(triage).getByText("Eligibility warning: Sponsorship requirements need review."),
    ).toBeInTheDocument();
    const handoff = within(triage).getByRole("link", { name: "Open Apply Review for Staff Software Engineer" });
    const handoffUrl = new URL(handoff.getAttribute("href") ?? "", "http://localhost");
    expect(handoffUrl.pathname).toBe("/apply-review");
    expect(handoffUrl.searchParams.get("jobKey")).toBe("https://example.com/jobs/1");
    expect(screen.getByText("Preparation diagnostics")).toBeInTheDocument();
    expect(screen.queryByText("Score breakdown")).not.toBeInTheDocument();
    expect(screen.queryByText("Tailoring rationale")).not.toBeInTheDocument();
    const description = screen.getByText("Description").closest("section");
    expect(description).not.toBeNull();
    expect(description).toHaveClass("job-detail-description");
    expect(triage.compareDocumentPosition(description as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows a not-found state instead of the raw API 404 for missing jobs", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", () =>
        HttpResponse.json({ ok: false, error: "job_not_found" }, { status: 404 }),
      ),
    );

    renderJobDetailDrawer("https://example.com/jobs/missing-parent");

    await waitFor(() => expect(screen.getByText("Job not found.")).toBeInTheDocument());
    expect(screen.queryByText(/JobHunter API request failed: 404/i)).not.toBeInTheDocument();
  });

  it("renders compensation audit range, statistical confidence, and reported sources", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) => {
        return HttpResponse.json(
          makeJobDetail(
            {
              ...sampleSecondaryJob,
              jobKey: String(params["jobKey"]),
            },
            {
              compensationAudit: {
                ...sampleCompensationAudit,
              },
            },
          ),
        );
      }),
    );

    renderJobDetailDrawer("https://example.com/jobs/compensation");

    const compensation = await screen.findByRole("region", { name: "Compensation evidence" });
    expect(within(compensation).getByText("Compensation")).toBeInTheDocument();
    expect(within(compensation).getAllByText("EUR 112000-142000/year").length).toBeGreaterThan(0);
    expect(within(compensation).getAllByText("EUR 70000-90000/year").length).toBeGreaterThan(0);
    expect(within(compensation).getAllByText(/market confidence medium/i).length).toBeGreaterThan(0);
    expect(within(compensation).getByText("82%")).toBeInTheDocument();
    expect(within(compensation).getAllByText(/2 sources/i).length).toBeGreaterThan(0);
    expect(within(compensation).getAllByText(/7 samples/i).length).toBeGreaterThan(0);
    expect(within(compensation).getByText("Posted Salary")).toBeInTheDocument();
    expect(within(compensation).getByText("Reported Company-Role Market")).toBeInTheDocument();
    expect(within(compensation).getByText("Levels.fyi")).toBeInTheDocument();
    expect(within(compensation).getByText("Glassdoor")).toBeInTheDocument();
    expect(within(compensation).getByText("exact company role")).toBeInTheDocument();
    expect(within(compensation).getByText("Confidence factors")).toBeInTheDocument();
    expect(within(compensation).getByText("Reported rows match Globex directly.")).toBeInTheDocument();
  });

  it("shows employer requirements beside canonical requirement fit evidence", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) => {
        return HttpResponse.json(
          makeJobDetail(
            {
              ...sampleJob,
              jobKey: String(params["jobKey"]),
              scoreBreakdown: {
                ...sampleJob.scoreBreakdown!,
                matchedSignals: ["platform reliability"],
                missingSignals: ["Kubernetes-based developer platforms"],
                transferableSignals: [],
              },
            },
            {
              employerAnalysis: populatedEmployerAnalysis,
              requirementFitReport: populatedRequirementFitReport,
            },
          ),
        );
      }),
    );

    renderJobDetailDrawer("https://example.com/jobs/1");

    const requirement = await screen.findByRole("article", {
      name: "Requirement: Lead platform reliability programs across multiple teams",
    });
    expect(within(requirement).getByText("Requirement fit")).toBeInTheDocument();
    expect(within(requirement).getByText("matched")).toBeInTheDocument();
    expect(within(requirement).getByText("Score contribution")).toBeInTheDocument();
    expect(within(requirement).getByText("Double Down · priority 90%")).toBeInTheDocument();

    const transferableRequirement = screen.getByRole("article", {
      name: "Requirement: Experience with Kubernetes-based developer platforms",
    });
    expect(within(transferableRequirement).getByText("transferable")).toBeInTheDocument();
    expect(within(transferableRequirement).getByText("Bridge Gap · priority 55%")).toBeInTheDocument();
  });

  it("shows not assessed plus a re-score path for legacy jobs without requirement fit reports", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) => {
        return HttpResponse.json(
          makeJobDetail(
            {
              ...sampleJob,
              jobKey: String(params["jobKey"]),
              scoreBreakdown: {
                ...sampleJob.scoreBreakdown!,
                matchedSignals: ["platform reliability"],
                missingSignals: ["Kubernetes-based developer platforms"],
                transferableSignals: [],
              },
            },
            {
              employerAnalysis: populatedEmployerAnalysis,
              requirementFitReport: null,
            },
          ),
        );
      }),
    );

    renderJobDetailDrawer("https://example.com/jobs/legacy-fit");

    const callout = await screen.findByRole("region", { name: "Requirement fit not assessed" });
    expect(within(callout).getByText("Requirement fit not assessed")).toBeInTheDocument();
    expect(
      within(callout).getByText(/stored score predates requirement-level fit/i),
    ).toBeInTheDocument();
    expect(within(callout).getByRole("button", { name: "re-score requirement fit" })).toBeInTheDocument();

    const requirement = screen.getByRole("article", {
      name: "Requirement: Lead platform reliability programs across multiple teams",
    });
    expect(within(requirement).getByText("Requirement fit")).toBeInTheDocument();
    expect(within(requirement).getByText("not assessed")).toBeInTheDocument();
    expect(
      within(requirement).getByText("Re-score this job with the current policy to produce requirement-level candidate fit."),
    ).toBeInTheDocument();
    expect(within(requirement).queryByText("Legacy score signals")).not.toBeInTheDocument();
    expect(within(requirement).queryByText("Matched score signal")).not.toBeInTheDocument();
  });

  it("closes when clicking the backdrop without treating drawer content as backdrop", async () => {
    const user = userEvent.setup();
    const { container, router } = renderJobDetailDrawer("job-1");

    await waitFor(() => expect(screen.getByLabelText("Job details")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Job details"));
    expect(router.state.location.pathname).toBe("/jobs/job-1");

    const backdrop = container.querySelector(".drawer-backdrop");
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);

    await waitFor(() => expect(router.state.location.pathname).toBe("/jobs"));
  });

  it("renders user-facing audit history as the collapsed final drawer section", async () => {
    const user = userEvent.setup();
    renderJobDetailDrawer("job-1");

    const auditSummary = await screen.findByText("Audit history");
    const auditDisclosure = auditSummary.closest("details");
    expect(auditDisclosure).not.toBeNull();
    expect(auditDisclosure).not.toHaveAttribute("open");

    const drawer = screen.getByLabelText("Job details");
    const sections = Array.from(drawer.querySelectorAll("section.section"));
    expect(sections.at(-1)).toContainElement(auditDisclosure);
    expect(sections.at(-1)).toHaveTextContent("Audit history");
    expect(sections[1]).toHaveTextContent("Compensation");
    expect(sections[2]).toHaveTextContent("Description");

    await user.click(auditSummary);
    expect(auditDisclosure).toHaveAttribute("open");

    const history = within(auditDisclosure as HTMLElement).getByLabelText("Job audit history");
    expect(history).toHaveTextContent("Job discovered");
    expect(history).toHaveTextContent("Found via lever:acme.");
    expect(history).toHaveTextContent("Job scored");
    expect(history).toHaveTextContent("Apply review decision recorded");
    expect(history).not.toHaveTextContent("payload_json");
    expect(history).not.toHaveTextContent("ApplyReviewDecisionRecorded");
  });

  it("does not render raw next-action commands and keeps failed enrich retry visible", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) => {
        const detail = makeJobDetail({
          ...sampleJob,
          jobKey: String(params["jobKey"]),
          currentStage: "discover",
          currentSubstage: "enrich",
          currentState: "failed",
          nextAction: "jobhunter retry enrich https://example.com/jobs/1",
        });
        return HttpResponse.json({
          ...detail,
          stages: [
            detail.stages[0],
            {
              stage: "enrich",
              state: "failed",
              attemptCount: 1,
              maxAttempts: 3,
              startedAt: "2026-05-01T12:01:00Z",
              updatedAt: "2026-05-01T12:01:20Z",
              finishedAt: "2026-05-01T12:01:20Z",
              durationMs: 20_000,
              errorCode: "DETAIL_ERROR",
              errorMessage: "no data extracted",
              retryable: false,
              blockedBy: [],
              nextAction: "jobhunter retry enrich https://example.com/jobs/1",
            },
          ],
        });
      }),
    );

    renderJobDetailDrawer("https://example.com/jobs/1");

    await screen.findByText(sampleJob.title);
    const drawer = screen.getByLabelText("Job details");
    expect(drawer).not.toHaveTextContent("jobhunter retry enrich");
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
  });

  it("retries the failed internal substage when that stage is retryable", async () => {
    const user = userEvent.setup();
    const calls: Array<{ stage?: string; runAfter?: boolean }> = [];
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) => {
        const detail = makeJobDetail({
          ...sampleJob,
          jobKey: String(params["jobKey"]),
          currentStage: "discover",
          currentSubstage: "enrich",
          currentState: "failed",
        });
        return HttpResponse.json({
          ...detail,
          stages: [
            detail.stages[0],
            {
              stage: "enrich",
              state: "failed",
              attemptCount: 1,
              maxAttempts: 3,
              startedAt: "2026-05-01T12:01:00Z",
              updatedAt: "2026-05-01T12:01:20Z",
              finishedAt: "2026-05-01T12:01:20Z",
              durationMs: 20_000,
              errorCode: "DETAIL_ERROR",
              errorMessage: "no data extracted",
              retryable: true,
              blockedBy: [],
              nextAction: "jobhunter retry enrich https://example.com/jobs/1",
            },
          ],
        });
      }),
      http.post("*/v1/jobs/:jobKey/actions/retry-stage", async ({ request }) => {
        calls.push((await request.json()) as { stage?: string; runAfter?: boolean });
        return HttpResponse.json({
          ok: true,
          action: "retry_stage",
          status: "reset",
          command: { action: "retry_stage", jobKey: "https://example.com/jobs/1" },
        });
      }),
    );

    renderJobDetailDrawer("https://example.com/jobs/1");

    await user.click(await screen.findByRole("button", { name: "retry" }));

    await waitFor(() =>
      expect(calls).toEqual([expect.objectContaining({ stage: "enrich", runAfter: true })]),
    );
  });
});
