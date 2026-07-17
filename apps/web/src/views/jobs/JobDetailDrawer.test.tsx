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
  makeApplyAudit,
  makeJobDetail,
  sampleCompensationAudit,
  sampleCompensationSummary,
  sampleEvidenceMapResponse,
  sampleInterviewPrep,
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
  it("renders source-conflict compensation warnings only inside compensation evidence", async () => {
    if (sampleCompensationAudit.market.recordStatus !== "recorded") {
      throw new Error("sample compensation audit must include recorded market evidence");
    }
    const market = sampleCompensationAudit.market;
    const sourceConflictAudit = {
      ...sampleCompensationAudit,
      market: {
        ...market,
        estimate: {
          ...market.estimate,
          confidenceBand: "medium" as const,
          confidenceScore: 0.74,
          sourceCount: 2,
          sampleCount: 7,
          warnings: [
            {
              code: "reported_compensation_sample" as const,
              message: "The estimate uses reported compensation rows for the job company and role.",
            },
            {
              code: "source_conflict_with_posted_salary" as const,
              message: "Market estimate is above the posted range.",
            },
          ],
        },
      },
    };
    const sourceConflictSummary = {
      ...sampleCompensationSummary,
      warningCount: 2,
      market: {
        ...sampleCompensationSummary.market,
        confidenceBand: "medium" as const,
        confidenceScore: 0.74,
        sourceCount: 2,
        sampleCount: 7,
        warningCount: 2,
      },
    };
    expect(JSON.stringify(sourceConflictAudit)).toContain("source_conflict_with_posted_salary");
    expect(JSON.stringify(sourceConflictAudit)).toContain("reported_compensation_sample");
    expect(JSON.stringify(sourceConflictAudit)).not.toMatch(/~\/\.jobctrl|\/Users\/|api[_-]?key|oauth|resume|cover letter/i);

    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) =>
        HttpResponse.json(
          makeJobDetail(
            {
              ...sampleJob,
              jobKey: String(params["jobKey"]),
              title: "Compensated Platform Role",
              currentStage: "apply",
              currentSubstage: "apply",
              currentState: "pending",
              compensationSummary: sourceConflictSummary,
            },
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
              compensationAudit: sourceConflictAudit,
            },
          ),
        ),
      ),
    );

    renderJobDetailDrawer("job-source-conflict");

    const compensation = await screen.findByRole("region", { name: "Compensation evidence" });
    expect(within(compensation).getByText("source_conflict_with_posted_salary")).toBeInTheDocument();
    expect(within(compensation).getByText("Market estimate is above the posted range.")).toBeInTheDocument();
    expect(within(compensation).getByText("reported_compensation_sample")).toBeInTheDocument();
    expect(
      within(compensation).getByText("The estimate uses reported compensation rows for the job company and role."),
    ).toBeInTheDocument();

    const triage = screen.getByRole("region", { name: "Job audit triage" });
    const workspace = screen.getByRole("article", { name: "Job details" });
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
    expect(within(workspace).getByLabelText("Apply readiness")).toHaveTextContent("missing apply link");
    expect(within(workspace).getByLabelText("Apply readiness")).not.toHaveTextContent(/compensation|salary|source conflict/i);
    expect(
      within(workspace).getByRole("link", { name: "Open Apply Review for Compensated Platform Role" }),
    ).not.toHaveTextContent(/compensation|salary|source conflict/i);
  });

  it("posts a focused compensation refresh from the compensation evidence section", async () => {
    const user = userEvent.setup();
    const calls: unknown[] = [];

    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) =>
        HttpResponse.json(
          makeJobDetail(
            {
              ...sampleSecondaryJob,
              jobKey: String(params["jobKey"]),
              compensationSummary: sampleCompensationSummary,
            },
            { compensationAudit: sampleCompensationAudit },
          ),
        ),
      ),
      http.post("*/v1/jobs/:jobKey/actions/refresh-compensation", async ({ request }) => {
        calls.push(await request.json());
        return HttpResponse.json({
          ok: true,
          action: "refresh_compensation",
          status: "succeeded",
          command: { action: "refresh_compensation", jobKey: "https://example.com/jobs/1" },
        });
      }),
    );

    renderJobDetailDrawer("https://example.com/jobs/1");

    await user.click(await screen.findByRole("button", { name: "refresh compensation" }));

    await waitFor(() => expect(calls).toEqual([{}]));
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
            employerAnalysis: populatedEmployerAnalysis,
            interviewPrep: {
              ...sampleInterviewPrep,
              items: sampleInterviewPrep.items.map((item) => ({
                ...item,
                evidenceIds: ["ev-platform"],
                requirementIds: ["req-1"],
              })),
            },
            requirementFitReport: populatedRequirementFitReport,
          }),
        );
      }),
      http.get("*/v1/evidence-map", () => {
        const entry = sampleEvidenceMapResponse.entries[0]!;
        return HttpResponse.json({
          ...sampleEvidenceMapResponse,
          entries: [
            {
              ...entry,
              entryId: "ev-platform",
              evidenceId: "ev-platform",
              title: "Led a platform reliability transformation",
              story: {
                ...entry.story!,
                outcome: "Reduced incident response time by 42%.",
              },
            },
          ],
        });
      }),
    );

    renderJobDetailDrawer("https://example.com/jobs/1");

    const triage = await screen.findByRole("region", { name: "Job audit triage" });
    const workspace = screen.getByRole("article", { name: "Job details" });
    const toolbar = within(workspace).getByRole("toolbar", { name: "Job actions" });
    expect(workspace).toHaveClass("route-workspace", "job-detail-workspace");
    expect(workspace.querySelector(".job-detail-workspace__content")).not.toBeNull();
    expect(workspace.querySelector(".job-detail-workspace__inspector")).not.toBeNull();
    expect(within(workspace).queryByText("Audit triage")).not.toBeInTheDocument();
    expect(within(workspace).queryByText("Why this job is here")).not.toBeInTheDocument();
    expect(toolbar.compareDocumentPosition(triage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    const readiness = within(workspace).getByLabelText("Apply readiness");
    expect(within(readiness).getByText("missing apply link")).toBeInTheDocument();
    expect(within(triage).getByText("Apply concerns")).toBeInTheDocument();
    expect(
      within(triage).getByText("Missing apply link: No application or posting URL is recorded, so apply review cannot proceed."),
    ).toBeInTheDocument();
    expect(
      within(triage).getByText("Eligibility warning: Sponsorship requirements need review."),
    ).toBeInTheDocument();
    const handoff = within(workspace).getByRole("link", { name: "Open Apply Review for Staff Software Engineer" });
    const handoffUrl = new URL(handoff.getAttribute("href") ?? "", "http://localhost");
    expect(handoffUrl.pathname).toBe("/apply-review");
    expect(handoffUrl.searchParams.get("jobKey")).toBe("https://example.com/jobs/1");
    expect(screen.getByText("Preparation diagnostics")).toBeInTheDocument();
    expect(screen.queryByText("Score breakdown")).not.toBeInTheDocument();
    expect(screen.queryByText("Tailoring rationale")).not.toBeInTheDocument();
    const roleAnalysis = screen.getByRole("region", { name: "Role Analysis" });
    expect(roleAnalysis).toHaveClass("job-detail-role-analysis");
    const matchedRequirement = within(roleAnalysis).getByRole("article", {
      name: "Requirement: Lead platform reliability programs across multiple teams",
    });
    expect(
      within(matchedRequirement).getByText("Led a platform reliability transformation"),
    ).toBeInTheDocument();
    expect(
      within(matchedRequirement).getByText("Reduced incident response time by 42%."),
    ).toBeInTheDocument();
    expect(within(matchedRequirement).queryByText("ev-platform")).not.toBeInTheDocument();
    const interviewPrep = screen.getByRole("region", {
      name: "Interview preparation",
    });
    expect(
      within(interviewPrep).getByRole("link", {
        name: "Led a platform reliability transformation",
      }),
    ).toBeInTheDocument();
    expect(
      within(interviewPrep).getByText(
        "Lead platform reliability programs across multiple teams",
      ),
    ).toBeInTheDocument();
    expect(within(interviewPrep).queryByText("ev-platform")).not.toBeInTheDocument();
    expect(within(interviewPrep).queryByText("req-1")).not.toBeInTheDocument();
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
    expect(screen.queryByText(/JobCtrl API request failed: 404/i)).not.toBeInTheDocument();
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
    expect(within(compensation).getAllByText("Levels.fyi").length).toBeGreaterThan(0);
    expect(within(compensation).getByText("Glassdoor")).toBeInTheDocument();
    expect(within(compensation).getByText("exact company role")).toBeInTheDocument();
    expect(within(compensation).getByText("Confidence factors")).toBeInTheDocument();
    expect(within(compensation).getByText("Reported rows match Globex directly.")).toBeInTheDocument();
    const evidenceSummary = within(compensation).getByText("Evidence rows");
    const evidenceDisclosure = evidenceSummary.closest("details");
    expect(evidenceDisclosure).not.toBeNull();
    expect(evidenceDisclosure).not.toHaveAttribute("open");
    expect(within(evidenceDisclosure as HTMLElement).getByText("1 row")).toBeInTheDocument();
    expect(within(evidenceDisclosure as HTMLElement).getByText("Principal Platform Engineer")).toBeInTheDocument();
    expect(within(evidenceDisclosure as HTMLElement).getByText("EUR 112,000-142,000/year")).toBeInTheDocument();
    expect(within(evidenceDisclosure as HTMLElement).getByRole("link", { name: "Open source" })).toHaveAttribute(
      "href",
      "https://www.levels.fyi/companies/globex/salaries/software-engineer",
    );
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

  it("returns to the jobs list from the route-level workspace", async () => {
    const user = userEvent.setup();
    const { container, router } = renderJobDetailDrawer("job-1");

    await waitFor(() =>
      expect(screen.getByRole("article", { name: "Job details" })).toBeInTheDocument(),
    );
    expect(router.state.location.pathname).toBe("/jobs/job-1");
    expect(container.querySelector(".drawer-backdrop")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Back to jobs" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/jobs"));
  });

  it("renders user-facing audit history as the collapsed final drawer section", async () => {
    const user = userEvent.setup();
    renderJobDetailDrawer("job-1");

    const auditSummary = await screen.findByText("Audit history");
    const auditDisclosure = auditSummary.closest("details");
    expect(auditDisclosure).not.toBeNull();
    expect(auditDisclosure).not.toHaveAttribute("open");

    const workspace = screen.getByRole("article", { name: "Job details" });
    const sections = Array.from(workspace.querySelectorAll("section.section"));
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
          nextAction: "jobctrl retry enrich https://example.com/jobs/1",
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
              nextAction: "jobctrl retry enrich https://example.com/jobs/1",
            },
          ],
        });
      }),
    );

    renderJobDetailDrawer("https://example.com/jobs/1");

    await screen.findByText(sampleJob.title);
    const workspace = screen.getByRole("article", { name: "Job details" });
    expect(workspace).not.toHaveTextContent("jobctrl retry enrich");
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
              nextAction: "jobctrl retry enrich https://example.com/jobs/1",
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
