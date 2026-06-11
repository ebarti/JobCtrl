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
import { makeApplyAudit, makeJobDetail, sampleJob } from "../../test/fixtures/projections.js";
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
          }),
        );
      }),
    );

    renderJobDetailDrawer("https://example.com/jobs/1");

    const triage = await screen.findByRole("region", { name: "Why this job is here" });
    expect(within(triage).getByText("Audit triage")).toBeInTheDocument();
    expect(within(triage).getByText("8/10")).toBeInTheDocument();
    expect(within(triage).getByText("strong")).toBeInTheDocument();
    expect(within(triage).getByText("high")).toBeInTheDocument();
    expect(within(triage).getByText("Strong fit on platform reliability.")).toBeInTheDocument();
    expect(within(triage).getAllByText("platform reliability").length).toBeGreaterThan(0);
    expect(within(triage).getByText("public company scale")).toBeInTheDocument();
    expect(within(triage).getByText("missing apply link")).toBeInTheDocument();
    expect(
      within(triage).getByText("Missing apply link: No application or posting URL is recorded, so apply review cannot proceed."),
    ).toBeInTheDocument();
    expect(
      within(triage).getByText("Eligibility warning: Sponsorship requirements need review."),
    ).toBeInTheDocument();
    expect(within(triage).getByRole("link", { name: "Open Apply Review for Staff Software Engineer" })).toHaveAttribute(
      "href",
      "/apply-review",
    );
    expect(screen.getByText("Preparation diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Score breakdown")).toBeInTheDocument();
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
    expect(sections.at(-2)).toHaveTextContent("Description");

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
