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
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  makeResumeTemplateState,
  sampleArtifact,
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
  it("keeps contextual help available across the detail workspace when records are absent", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) =>
        HttpResponse.json(makeJobDetail({ ...sampleJob, jobKey: String(params["jobKey"]) })),
      ),
    );
    renderJobDetailDrawer("https://example.com/jobs/1");

    await screen.findByRole("heading", { name: "Artifacts" });
    for (const label of [
      "Fit score", "Apply readiness", "Workflow", "Fit and evidence",
      "Band", "Confidence", "Eligibility", "Requirement fit", "Must-haves",
      "Compensation", "Description", "Role analysis", "Interview prep",
      "Preparation diagnostics", "Artifacts", "Apply history",
      "Application outcomes", "Contacts",
    ]) {
      expect(screen.getAllByRole("button", { name: `Help for ${label}` }).length).toBeGreaterThan(0);
    }
  });

  it("attributes a corrected fit score to the manual record while retaining the original band and confidence", async () => {
    const user = userEvent.setup();
    const correction = {
      originalScore: 6,
      correctedScore: 9,
      rationale: "Reviewed the candidate evidence",
      correctedBy: "local-user",
      correctedAt: "2026-05-06T09:30:00Z",
    };
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) =>
        HttpResponse.json(makeJobDetail({
          ...sampleJob,
          jobKey: String(params["jobKey"]),
          fitScore: 9,
          scoreBreakdown: { ...sampleJob.scoreBreakdown!, fitBand: "stretch", confidence: "low" },
          scoreCorrection: correction,
          scoreTrace: { ...sampleJob.scoreTrace!, correctionHistory: [correction] },
        })),
      ),
    );
    renderJobDetailDrawer("https://example.com/jobs/corrected");

    expect(await screen.findByText("9/10")).toBeInTheDocument();
    expect(screen.getByText("stretch")).toBeInTheDocument();
    expect(screen.getByText("low")).toBeInTheDocument();
    const fitHelp = screen.getAllByRole("button", { name: "Help for Fit score" });
    expect(fitHelp).toHaveLength(2);
    for (const trigger of fitHelp) {
      await user.click(trigger);
      const explanation = await screen.findByRole("dialog", { name: "Fit score explanation" });
      expect(explanation).toHaveTextContent("latest saved manual correction");
      expect(explanation).toHaveTextContent("Reviewed the candidate evidence");
      expect(explanation).toHaveTextContent("does not recompute");
      await user.keyboard("{Escape}");
    }
    await user.click(screen.getByRole("button", { name: "Help for Band" }));
    expect(await screen.findByRole("dialog", { name: "Band explanation" })).toHaveTextContent("retained original scoring breakdown");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Help for Confidence" }));
    expect(await screen.findByRole("dialog", { name: "Confidence explanation" })).toHaveTextContent("not confidence in the corrected score");
  });

  it("shows accepted artifacts before superseded versions while retaining the full audit list", async () => {
    const user = userEvent.setup();
    const superseded = Array.from({ length: 4 }, (_, index) => ({
      ...sampleArtifact,
      artifactId: `old-${index}`,
      type: `older_version_${index}`,
      status: "superseded",
    }));
    const approved = Array.from({ length: 4 }, (_, index) => ({
      ...sampleArtifact,
      artifactId: `current-${index}`,
      type: `accepted_version_${index}`,
      status: index === 0 ? "active" : "approved",
    }));
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) =>
        HttpResponse.json(
          makeJobDetail(
            { ...sampleJob, jobKey: String(params["jobKey"]) },
            { artifacts: [...superseded, ...approved] },
          ),
        ),
      ),
    );

    renderJobDetailDrawer("https://example.com/jobs/1");

    const section = (await screen.findByRole("heading", { name: "Artifacts" })).closest("section");
    expect(section).not.toBeNull();
    const foregroundRows = section!.querySelectorAll(":scope > .job-artifact-row");
    expect(foregroundRows).toHaveLength(4);
    foregroundRows.forEach((row, index) => {
      expect(row).toHaveTextContent(`accepted_version_${index}`);
      expect(within(row as HTMLElement).getByRole("button", { name: "Open" })).toBeEnabled();
    });

    const history = section!.querySelector(".job-artifact-history");
    expect(history).not.toBeNull();
    expect(history).not.toHaveAttribute("open");
    expect(history!.querySelectorAll(".job-artifact-row")).toHaveLength(4);
    await user.click(within(history as HTMLElement).getByText("Superseded artifacts (4)"));
    expect(history).toHaveAttribute("open");
    superseded.forEach((artifact) => {
      expect(within(history as HTMLElement).getByText(artifact.type)).toBeInTheDocument();
    });
  });

  it("keeps every approved generation visible ahead of newer candidates and failed materials", async () => {
    const artifacts = [
      { ...sampleArtifact, artifactId: "draft-4", type: "cover_letter", generation: 4, status: "candidate" },
      { ...sampleArtifact, artifactId: "old-resume", type: "tailored_resume", generation: 1, status: "approved", resumeTemplate: makeResumeTemplateState("classic", "Classic") },
      { ...sampleArtifact, artifactId: "failed-4", type: "cover_letter_pdf", generation: 4, status: "rejected" },
      { ...sampleArtifact, artifactId: "new-resume", type: "tailored_resume", generation: 3, status: "approved", createdAt: "2026-05-03T10:00:00Z", resumeTemplate: makeResumeTemplateState("modern", "Modern") },
      { ...sampleArtifact, artifactId: "old-pdf", type: "resume_pdf", generation: 1, status: "approved" },
      { ...sampleArtifact, artifactId: "new-pdf", type: "resume_pdf", generation: 3, status: "approved", createdAt: "2026-05-03T11:00:00Z" },
      { ...sampleArtifact, artifactId: "legacy-cover", type: "cover_letter", status: "approved" },
      { ...sampleArtifact, artifactId: "superseded-pdf", type: "resume_pdf", generation: 0, status: "superseded" },
    ];
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) =>
        HttpResponse.json(
          makeJobDetail(
            { ...sampleJob, jobKey: String(params["jobKey"]) },
            { artifacts },
          ),
        ),
      ),
    );

    renderJobDetailDrawer("https://example.com/jobs/1");

    const section = (await screen.findByRole("heading", { name: "Artifacts" })).closest("section");
    expect(section).not.toBeNull();
    const foregroundRows = [...section!.querySelectorAll(":scope > .job-artifact-row")];
    expect(foregroundRows).toHaveLength(7);
    expect(foregroundRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("resume_pdf · Generation 3"),
      expect.stringContaining("tailored_resume · Generation 3"),
      expect.stringContaining("tailored_resume · Generation 1"),
      expect.stringContaining("resume_pdf · Generation 1"),
      expect.stringContaining("cover_letter"),
      expect.stringContaining("cover_letter · Generation 4"),
      expect.stringContaining("cover_letter_pdf · Generation 4"),
    ]);
    expect(foregroundRows.slice(0, 5).every((row) => row.textContent?.includes("approved"))).toBe(true);
    const history = section!.querySelector(".job-artifact-history");
    expect(history).not.toHaveAttribute("open");
    expect(history).toHaveTextContent("superseded");
    expect(history!.querySelectorAll(".job-artifact-row")).toHaveLength(1);
  });

  it("renders source-conflict compensation warnings only inside compensation evidence", async () => {
    if (sampleCompensationAudit.market.recordStatus !== "recorded") {
      throw new Error(
        "sample compensation audit must include recorded market evidence",
      );
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
              message:
                "The estimate uses reported compensation rows for the job company and role.",
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
    expect(JSON.stringify(sourceConflictAudit)).toContain(
      "source_conflict_with_posted_salary",
    );
    expect(JSON.stringify(sourceConflictAudit)).toContain(
      "reported_compensation_sample",
    );
    expect(JSON.stringify(sourceConflictAudit)).not.toMatch(
      /~\/\.jobctrl|\/Users\/|api[_-]?key|oauth|resume|cover letter/i,
    );

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
                summary:
                  "Application review is blocked until the posting URL is confirmed.",
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

    const compensation = await screen.findByRole("region", {
      name: "Compensation evidence",
    });
    fireEvent.click(within(compensation).getByText("How this was assessed"));
    expect(
      within(compensation).getByText(
        "Market estimate is above the posted range.",
      ),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(
        "The estimate uses reported compensation rows for the job company and role.",
      ),
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
    expect(
      within(triage).getByText("Missing apply link").closest("li"),
    ).toHaveTextContent("Missing apply link: No application URL is recorded.");
    expect(
      within(triage).getByText("Submit-ready PDF missing").closest("li"),
    ).toHaveTextContent(
      "Submit-ready PDF missing: A submit-ready PDF is still missing.",
    );
    expect(
      within(triage).getByText("Eligibility warning").closest("li"),
    ).toHaveTextContent(
      "Eligibility warning: Sponsorship requirements need review.",
    );
    expect(
      within(workspace).getByLabelText("Apply readiness"),
    ).toHaveTextContent("missing apply link");
    expect(
      within(workspace).getByLabelText("Apply readiness"),
    ).not.toHaveTextContent(/compensation|salary|source conflict/i);
    expect(
      within(workspace).getByRole("link", {
        name: "Open Apply Review for Compensated Platform Role",
      }),
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
      http.post(
        "*/v1/jobs/:jobKey/actions/refresh-compensation",
        async ({ request }) => {
          calls.push(await request.json());
          return HttpResponse.json({
            ok: true,
            action: "refresh_compensation",
            status: "succeeded",
            command: {
              action: "refresh_compensation",
              jobKey: "https://example.com/jobs/1",
            },
          });
        },
      ),
    );

    renderJobDetailDrawer("https://example.com/jobs/1");

    await screen.findByRole("region", { name: "Compensation evidence" });
    expect(
      screen.queryByText("Observation JSON path (optional)"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("/path/to/reported-compensation.json"),
    ).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: "Refresh this job" }),
    );

    await waitFor(() => expect(calls).toEqual([{}]));
  });

  it("summarizes ranking, readiness, blockers, eligibility, and Apply Review handoff", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) => {
        return HttpResponse.json(
          makeJobDetail(
            {
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
            },
            {
              applyAudit: makeApplyAudit({
                state: "blocked",
                label: "missing apply link",
                summary:
                  "No application or posting URL is recorded, so apply review cannot proceed.",
                missingPrerequisites: [
                  {
                    code: "missing_resume_pdf",
                    label: "Submit-ready PDF missing",
                    detail:
                      "Reviewable resume text may be available, but the submit-ready PDF is still missing.",
                    severity: "warning",
                    source: "materials.pdf",
                  },
                ],
                hardBlockers: [
                  {
                    code: "missing_application_url",
                    label: "Missing apply link",
                    detail:
                      "No application or posting URL is recorded, so apply review cannot proceed.",
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
              artifacts: [sampleArtifact],
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
            },
          ),
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

    const triage = await screen.findByRole("region", {
      name: "Job audit triage",
    });
    const workspace = screen.getByRole("article", { name: "Job details" });
    expect(
      within(workspace).getByRole("navigation", {
        name: "Related job workspaces",
      }),
    ).toBeInTheDocument();
    expect(workspace).toHaveClass("route-workspace", "job-detail-workspace");
    expect(
      workspace.querySelector(".job-detail-workspace__content"),
    ).not.toBeNull();
    expect(
      workspace.querySelector(".job-detail-workspace__inspector"),
    ).not.toBeNull();
    const mobileSections = within(workspace).getByRole("group", {
      name: "Job detail section",
      hidden: true,
    });
    const summarySection = within(mobileSections).getByRole("button", {
      name: "Summary and evidence",
      hidden: true,
    });
    const diagnosticSection = within(mobileSections).getByRole("button", {
      name: "Progress and history",
      hidden: true,
    });
    expect(summarySection).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(diagnosticSection);
    expect(diagnosticSection).toHaveAttribute("aria-pressed", "true");
    expect(
      workspace.querySelector("#job-detail-diagnostics-panel"),
    ).toHaveAttribute("data-mobile-active", "true");
    const commandTrigger = within(workspace).getByRole("button", {
      name: "More job actions",
    });
    expect(commandTrigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(commandTrigger);
    expect(commandTrigger).toHaveAttribute("aria-expanded", "true");
    const toolbar = screen.getByRole("toolbar", { name: "Job actions" });
    expect(
      within(toolbar).getByRole("button", { name: "Stop current stage" }),
    ).toBeInTheDocument();
    expect(
      within(toolbar).getByRole("button", { name: "Mark as applied" }),
    ).toBeInTheDocument();
    expect(
      document.querySelector("#job-detail-workflow-commands"),
    ).toBeInTheDocument();
    expect(workspace.querySelector(".job-artifact-row")).not.toBeNull();
    expect(
      within(workspace).queryByText("Audit triage"),
    ).not.toBeInTheDocument();
    expect(
      within(workspace).queryByText("Why this job is here"),
    ).not.toBeInTheDocument();
    expect(
      commandTrigger.compareDocumentPosition(triage) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(triage).getByText("8/10")).toBeInTheDocument();
    expect(within(triage).getByText("strong")).toBeInTheDocument();
    expect(within(triage).getByText("high")).toBeInTheDocument();
    expect(within(triage).getByText("Requirement fit")).toBeInTheDocument();
    expect(within(triage).getByText("78%")).toBeInTheDocument();
    expect(within(triage).getByText("Must-haves")).toBeInTheDocument();
    expect(within(triage).getByText("100%")).toBeInTheDocument();
    expect(
      within(triage)
        .getByLabelText("Ranking summary")
        .querySelectorAll(":scope > div"),
    ).toHaveLength(6);
    expect(
      within(triage).getByText("Strong fit on platform reliability."),
    ).toBeInTheDocument();
    expect(
      within(triage).getAllByText("platform reliability").length,
    ).toBeGreaterThan(0);
    expect(
      within(triage).getByText("Matched requirements"),
    ).toBeInTheDocument();
    expect(
      within(triage).getByText(
        "Lead platform reliability programs across multiple teams",
      ),
    ).toBeInTheDocument();
    expect(
      within(triage).getByText("Transferable requirements"),
    ).toBeInTheDocument();
    expect(
      within(triage).getByText(
        "Experience with Kubernetes-based developer platforms",
      ),
    ).toBeInTheDocument();
    const readiness = within(workspace).getByLabelText("Apply readiness");
    expect(
      within(readiness).getByText("missing apply link"),
    ).toBeInTheDocument();
    expect(within(triage).getByText("Apply concerns")).toBeInTheDocument();
    expect(
      within(triage).getByText("Missing apply link").closest("li"),
    ).toHaveTextContent(
      "Missing apply link: No application or posting URL is recorded, so apply review cannot proceed.",
    );
    expect(
      within(triage).getByText("Eligibility warning").closest("li"),
    ).toHaveTextContent(
      "Eligibility warning: Sponsorship requirements need review.",
    );
    const handoff = within(workspace).getByRole("link", {
      name: "Open Apply Review for Staff Software Engineer",
    });
    const handoffGroup = within(workspace).getByLabelText(
      "Related job workspaces",
    );
    expect(
      handoffGroup.compareDocumentPosition(toolbar) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const handoffUrl = new URL(
      handoff.getAttribute("href") ?? "",
      "http://localhost",
    );
    expect(handoffUrl.pathname).toBe("/apply-review");
    expect(handoffUrl.searchParams.get("jobKey")).toBe(
      "https://example.com/jobs/1",
    );
    expect(
      within(toolbar).queryByRole("link", { name: /apply review/i }),
    ).not.toBeInTheDocument();
    expect(
      within(toolbar).getByRole("group", { name: "Preparation actions" }),
    ).toBeInTheDocument();
    expect(
      within(toolbar).getByRole("group", { name: "Application actions" }),
    ).toBeInTheDocument();
    expect(
      within(toolbar).getByRole("button", { name: "Generate materials" }),
    ).toHaveClass("border-border", "bg-card", "text-foreground");
    expect(screen.getByText("Preparation diagnostics")).toBeInTheDocument();
    expect(screen.queryByText("Score breakdown")).not.toBeInTheDocument();
    expect(screen.queryByText("Tailoring rationale")).not.toBeInTheDocument();
    const roleAnalysis = screen.getByRole("region", { name: "Role Analysis" });
    expect(roleAnalysis).toHaveClass("job-detail-role-analysis");
    const matchedRequirement = within(roleAnalysis).getByRole("article", {
      name: "Requirement: Lead platform reliability programs across multiple teams",
    });
    const disclosure = within(matchedRequirement).getByRole("button", {
      name: /^Hide evidence/,
    });
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(
      within(matchedRequirement).getByRole("group", { name: "Fit summary" }),
    ).toBeVisible();
    await userEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(
      within(matchedRequirement).queryByRole("group", { name: "Fit summary" }),
    ).not.toBeInTheDocument();
    await userEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(
      within(matchedRequirement).getByText(
        "Led a platform reliability transformation",
      ),
    ).toBeInTheDocument();
    expect(
      within(matchedRequirement).getByText(
        "Reduced incident response time by 42%.",
      ),
    ).toBeInTheDocument();
    expect(
      within(matchedRequirement).queryByText("ev-platform"),
    ).not.toBeInTheDocument();
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
    expect(
      within(interviewPrep).queryByText("ev-platform"),
    ).not.toBeInTheDocument();
    expect(within(interviewPrep).queryByText("req-1")).not.toBeInTheDocument();
    const description = screen.getByText("Description").closest("section");
    expect(description).not.toBeNull();
    expect(description).toHaveClass("job-detail-description");
    expect(
      triage.compareDocumentPosition(description as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows a not-found state instead of the raw API 404 for missing jobs", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", () =>
        HttpResponse.json(
          { ok: false, error: "job_not_found" },
          { status: 404 },
        ),
      ),
    );

    renderJobDetailDrawer("https://example.com/jobs/missing-parent");

    await waitFor(() =>
      expect(screen.getByText("Job not found.")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/JobCtrl API request failed: 404/i),
    ).not.toBeInTheDocument();
  });

  it("leads with salary outcomes and keeps benchmark calculations expandable", async () => {
    if (
      sampleCompensationAudit.market.recordStatus !== "recorded" ||
      sampleCompensationAudit.market.estimate.benchmarkLineage?.kind !==
        "extrapolated"
    ) {
      throw new Error(
        "sample compensation audit must include extrapolated benchmark lineage",
      );
    }
    const benchmarkLineage =
      sampleCompensationAudit.market.estimate.benchmarkLineage;
    const compensationAudit = {
      ...sampleCompensationAudit,
      market: {
        ...sampleCompensationAudit.market,
        estimate: {
          ...sampleCompensationAudit.market.estimate,
          benchmarkLineage: {
            ...benchmarkLineage,
            rawFactor: 20,
            factorBoundState: "above_upper_bound" as const,
            matchedCompanyCount: 0,
            priceLevelInputs: benchmarkLineage.priceLevelInputs.map((input) =>
              input.inputRole === "target_price_level"
                ? { ...input, indexValue: 2000 }
                : input,
            ),
          },
        },
      },
    };
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) => {
        return HttpResponse.json(
          makeJobDetail(
            {
              ...sampleSecondaryJob,
              jobKey: String(params["jobKey"]),
            },
            {
              compensationAudit,
            },
          ),
        );
      }),
    );

    renderJobDetailDrawer("https://example.com/jobs/compensation");

    const compensation = await screen.findByRole("region", {
      name: "Compensation evidence",
    });
    expect(within(compensation).getByText("Compensation")).toBeInTheDocument();
    expect(
      within(compensation).getByText("EUR 112000-142000/year"),
    ).toBeInTheDocument();
    expect(
      within(compensation).getAllByText("EUR 70000-90000/year").length,
    ).toBeGreaterThan(0);
    expect(
      within(compensation).getByText("Employer posted"),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText("Market salary estimate"),
    ).toBeInTheDocument();
    expect(
      within(compensation).getAllByText(/medium reliability/i).length,
    ).toBeGreaterThan(0);
    expect(
      within(compensation).queryByText(/market confidence medium/i),
    ).not.toBeInTheDocument();
    expect(
      within(compensation).queryByText(/posted confidence/i),
    ).not.toBeInTheDocument();

    const evidenceSummary = within(compensation).getByText("Evidence reviewed");
    const evidenceDisclosure = evidenceSummary.closest("details");
    expect(evidenceDisclosure).not.toBeNull();
    expect(evidenceDisclosure).not.toHaveAttribute("open");
    expect(evidenceDisclosure).toHaveTextContent("1 evidence record");
    expect(evidenceDisclosure).toHaveTextContent("2 providers");
    expect(evidenceDisclosure).toHaveTextContent("7 reported samples");

    const assessmentSummary = within(compensation).getByText(
      "How this was assessed",
    );
    const assessmentDisclosure = assessmentSummary.closest("details");
    expect(assessmentDisclosure).not.toBeNull();
    expect(assessmentDisclosure).not.toHaveAttribute("open");
    fireEvent.click(assessmentSummary);
    expect(assessmentDisclosure).toHaveAttribute("open");
    const lineage = within(compensation).getByRole("region", {
      name: "Geographic extrapolation lineage",
    });
    expect(lineage).toHaveTextContent("Geographic extrapolation bridge");
    expect(lineage).toHaveTextContent("DE→ES");
    expect(lineage).toHaveTextContent("20x raw factor");
    expect(lineage).toHaveTextContent("software engineering");
    expect(lineage).toHaveTextContent("jobctrl-role-family-v1");
    expect(within(lineage).getByText("Matched companies")).toBeInTheDocument();
    expect(within(lineage).getByText("0 companies")).toBeInTheDocument();
    expect(lineage).toHaveTextContent("0.1x-10x · above upper bound");
    expect(lineage).toHaveTextContent("geo-shrinkage-v1");
    expect(lineage).toHaveTextContent("EUR 100,000-127,000/year");
    expect(lineage).toHaveTextContent("DE index 100");
    expect(lineage).toHaveTextContent("ES index 2000");
    expect(
      within(compensation).getAllByText("Levels.fyi").length,
    ).toBeGreaterThan(0);
    expect(within(compensation).getByText("Glassdoor")).toBeInTheDocument();
    expect(
      within(compensation).getByText("exact company role"),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText("Reliability factors"),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(
        "Direct reported salary evidence matched Globex; company support is 96%.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(evidenceSummary);
    expect(evidenceDisclosure).toHaveAttribute("open");
    expect(
      within(evidenceDisclosure as HTMLElement).getByText(
        "Principal Platform Engineer",
      ),
    ).toBeInTheDocument();
    expect(
      within(evidenceDisclosure as HTMLElement).getByText(
        "EUR 112,000-142,000/year",
      ),
    ).toBeInTheDocument();
    expect(
      within(evidenceDisclosure as HTMLElement).getByRole("link", {
        name: "Open source",
      }),
    ).toHaveAttribute(
      "href",
      "https://www.levels.fyi/companies/globex/salaries/software-engineer",
    );
  });

  it("explains a posted cash amount and a withheld director market range without raw audit markers", async () => {
    if (sampleCompensationAudit.market.recordStatus !== "recorded") {
      throw new Error(
        "sample compensation audit must include recorded market evidence",
      );
    }
    if (sampleCompensationAudit.posted.recordStatus !== "recorded") {
      throw new Error(
        "sample compensation audit must include recorded posted evidence",
      );
    }
    const baseEvidence = sampleCompensationAudit.market.estimate.evidence[0];
    if (!baseEvidence) {
      throw new Error(
        "sample compensation audit must include one evidence row",
      );
    }
    const evidence = Array.from({ length: 93 }, (_, index) => {
      const isAggregate = index === 0;
      return {
        ...baseEvidence,
        sourceId: isAggregate
          ? ("levels_fyi" as const)
          : ("euro_top_tech" as const),
        displayName: isAggregate ? "Levels.fyi" : "Euro Top Tech",
        sourceUrl: isAggregate
          ? "https://www.levels.fyi/t/software-engineer/locations/spain"
          : "https://www.eurotoptech.com/data",
        companyName: isAggregate
          ? "Levels.fyi market aggregate"
          : `European company ${index}`,
        roleTitle: isAggregate ? "Software Engineer" : "Engineering Director",
        location: "Spain",
        levelLabel: isAggregate ? "All levels" : "Principal / Director",
        minimumAmount: 38_645 + index * 500,
        maximumAmount: 120_000 + index * 3_000,
        sampleCount: isAggregate ? null : 1,
      };
    });
    const postedFact = {
      ...sampleCompensationAudit.posted.fact,
      parseState: "parsed_range" as const,
      sourceField: "jobs.full_description",
      sourceText: "Compensation: USD 243,800 annually and stock options.",
      currency: "USD",
      period: "year" as const,
      component: "unknown" as const,
      minimumAmount: 243_800,
      maximumAmount: 243_800,
      annualizedMinimumAmount: 243_800,
      annualizedMaximumAmount: 243_800,
      annualizationAssumption: "Source text states annual compensation.",
      confidence: "high" as const,
      parserVersion: "posted-compensation-v2",
      warnings: [
        {
          code: "source_text_truncated" as const,
          message:
            "Only a bounded posting excerpt is stored; the excerpt below shows exactly what was parsed.",
        },
        {
          code: "equity_component" as const,
          message:
            "The posting also mentions stock or equity; unpriced equity is not added to the displayed amount.",
        },
      ],
    };
    const estimate = {
      ...sampleCompensationAudit.market.estimate,
      estimateState: "insufficient_evidence" as const,
      confidenceBand: "low" as const,
      confidenceScore: 0.4,
      sourceCount: 2,
      sampleCount: null,
      seniorityLabel: "director",
      companyName: "DuckDuckGo",
      normalizedCompany: "duckduckgo",
      roleTitle: "Privacy Engineering Director",
      normalizedRole: "privacy engineering director",
      estimatorVersion: "company-role-reported-compensation-v3",
      matchScope: "same_location_role_fallback" as const,
      benchmarkLineage: null,
      evidence,
      sources: [
        sampleCompensationAudit.market.estimate.sources[0]!,
        {
          ...sampleCompensationAudit.market.estimate.sources[1]!,
          sourceId: "euro_top_tech" as const,
          provenance: "public" as const,
          displayName: "Euro Top Tech",
          snapshotVersion: "euro-top-tech-2026",
          sampleCount: 92,
        },
      ],
      factors: [
        {
          name: "company" as const,
          score: 0.45,
          band: "low" as const,
          reason: "Reported rows matched company DuckDuckGo.",
        },
        {
          name: "role" as const,
          score: 0.55,
          band: "low" as const,
          reason: "Reported rows matched role Privacy Engineering Director.",
        },
        {
          name: "level" as const,
          score: 0.75,
          band: "medium" as const,
          reason: "Level support: staff_plus.",
        },
      ],
      insufficientReasons: [
        {
          code: "source_dispersion_too_high" as const,
          message:
            "Reported compensation rows diverged too much to emit a precise range.",
        },
        {
          code: "weak_company_match" as const,
          message: "Company match support was too weak for a range.",
        },
      ],
    };
    const compensationSummary = {
      ...sampleCompensationSummary,
      posted: {
        ...sampleCompensationSummary.posted,
        confidence: "high" as const,
        warningCount: 2,
        range: {
          ...sampleCompensationSummary.posted.range!,
          currency: "USD",
          component: "unknown" as const,
          minimumAmount: 243_800,
          maximumAmount: 243_800,
          annualizedMinimumAmount: 243_800,
          annualizedMaximumAmount: 243_800,
          displayRange: "USD 243800/year",
        },
        displayRange: "USD 243800/year",
      },
      market: {
        ...sampleCompensationSummary.market,
        benchmarkKind: null,
        estimateState: "insufficient_evidence" as const,
        confidenceBand: "low" as const,
        confidenceScore: 0.4,
        sourceCount: 2,
        sampleCount: null,
        range: null,
        displayRange: null,
        confidenceInterval: null,
        displayConfidenceInterval: null,
      },
    };

    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) =>
        HttpResponse.json(
          makeJobDetail(
            {
              ...sampleSecondaryJob,
              jobKey: String(params["jobKey"]),
              title: "Privacy Engineering Director",
              company: "DuckDuckGo",
              location: "Spain",
              compensationSummary,
            },
            {
              compensationAudit: {
                ...sampleCompensationAudit,
                posted: {
                  ok: true,
                  recordStatus: "recorded",
                  fact: postedFact,
                },
                market: { ok: true, recordStatus: "recorded", estimate },
              },
            },
          ),
        ),
      ),
    );

    renderJobDetailDrawer("job-privacy-director");

    const compensation = await screen.findByRole("region", {
      name: "Compensation evidence",
    });
    expect(
      within(compensation).getByText("USD 243800/year"),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText("No reliable market range yet"),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(
        /93 evidence records were reviewed across 2 providers/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText("Why no range is shown"),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(/diverged too much/i),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(/too weak for a range/i),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(
        /stock or equity is mentioned separately/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(compensation).queryByText(/posted confidence/i),
    ).not.toBeInTheDocument();
    expect(
      within(compensation).queryByText("source_text_truncated"),
    ).not.toBeInTheDocument();
    expect(
      within(compensation).queryByText("staff plus"),
    ).not.toBeInTheDocument();
    expect(
      within(compensation).queryByText("Observation JSON path (optional)"),
    ).not.toBeInTheDocument();

    const evidenceSummary = within(compensation).getByText("Evidence reviewed");
    expect(evidenceSummary.closest("details")).toHaveTextContent(
      "93 evidence records · 2 providers",
    );
    fireEvent.click(evidenceSummary);
    expect(
      within(compensation).getAllByText("Euro Top Tech").length,
    ).toBeGreaterThan(0);

    const assessmentSummary = within(compensation).getByText(
      "How this was assessed",
    );
    expect(assessmentSummary.closest("details")).toHaveTextContent("director");
    fireEvent.click(assessmentSummary);
    expect(
      within(compensation).getByText("Benchmark level").closest("div"),
    ).toHaveTextContent("director");
    expect(
      within(compensation).getByText(
        "No direct DuckDuckGo salary record matched; same-location role evidence provides 45% support.",
      ),
    ).toBeInTheDocument();
    expect(
      within(compensation).getByText(
        /not a probability that the salary is correct/i,
      ),
    ).toBeInTheDocument();
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
    const disclosure = within(requirement).getByRole("button", {
      name: /^Hide evidence/,
    });
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(
      within(requirement).getByRole("group", { name: "Fit summary" }),
    ).toBeVisible();
    expect(
      within(requirement).getByText("Requirement fit"),
    ).toBeInTheDocument();
    expect(within(requirement).getByText("matched")).toBeInTheDocument();
    expect(
      within(requirement).getByText("Score contribution"),
    ).toBeInTheDocument();
    expect(
      within(requirement).getByText("Double Down · priority 90%"),
    ).toBeInTheDocument();

    const transferableRequirement = screen.getByRole("article", {
      name: "Requirement: Experience with Kubernetes-based developer platforms",
    });
    expect(
      within(transferableRequirement).getByText("transferable"),
    ).toBeInTheDocument();
    expect(
      within(transferableRequirement).getByText("Bridge Gap · priority 55%"),
    ).toBeInTheDocument();
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

    const callout = await screen.findByRole("region", {
      name: "Requirement fit not assessed",
    });
    expect(
      within(callout).getByText("Requirement fit not assessed"),
    ).toBeInTheDocument();
    expect(
      within(callout).getByText(/stored score predates requirement-level fit/i),
    ).toBeInTheDocument();
    expect(
      within(callout).getByRole("button", { name: "re-score requirement fit" }),
    ).toBeInTheDocument();

    const ranking = screen.getByLabelText("Ranking summary");
    expect(ranking.querySelectorAll(":scope > div")).toHaveLength(6);
    expect(within(ranking).getAllByText("not assessed")).toHaveLength(2);

    const requirement = screen.getByRole("article", {
      name: "Requirement: Lead platform reliability programs across multiple teams",
    });
    expect(
      within(requirement).getByText("Requirement fit"),
    ).toBeInTheDocument();
    expect(within(requirement).getByText("not assessed")).toBeInTheDocument();
    expect(
      within(requirement).getByText(
        "Re-score this job with the current policy to produce requirement-level candidate fit.",
      ),
    ).toBeInTheDocument();
    expect(
      within(requirement).queryByText("Legacy score signals"),
    ).not.toBeInTheDocument();
    expect(
      within(requirement).queryByText("Matched score signal"),
    ).not.toBeInTheDocument();
  });

  it("marks fit outdated when the saved report belongs to an earlier analysis", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) =>
        HttpResponse.json(makeJobDetail(
          {
            ...sampleJob,
            jobKey: String(params["jobKey"]),
            scoreAnalysisFreshness: {
              status: "outdated",
              currentAnalysisGeneration: 2,
              assessedAnalysisGeneration: 1,
              assessedScoreVersion: 1,
            },
          },
          { employerAnalysis: populatedEmployerAnalysis, requirementFitReport: null },
        )),
      ),
    );
    renderJobDetailDrawer("https://example.com/jobs/outdated-fit");
    const callout = await screen.findByRole("region", { name: "Requirement fit is outdated" });
    expect(within(callout).getByText(/different employer-analysis generation or score version/i)).toBeInTheDocument();
    expect(within(callout).getByRole("button", { name: "re-score requirement fit" })).toBeInTheDocument();
  });

  it("does not attribute score-correction divergence to an analysis change", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) =>
        HttpResponse.json(makeJobDetail(
          {
            ...sampleJob,
            jobKey: String(params["jobKey"]),
            scoreVersion: 2,
            scoreAnalysisFreshness: {
              status: "outdated",
              currentAnalysisGeneration: 1,
              assessedAnalysisGeneration: 1,
              assessedScoreVersion: 1,
            },
          },
          { employerAnalysis: populatedEmployerAnalysis, requirementFitReport: null },
        )),
      ),
    );
    renderJobDetailDrawer("https://example.com/jobs/corrected-score");
    const callout = await screen.findByRole("region", { name: "Requirement fit is outdated" });
    expect(within(callout).getByText(/different employer-analysis generation or score version/i)).toBeInTheDocument();
    expect(within(callout).queryByText(/earlier employer analysis/i)).not.toBeInTheDocument();
  });

  it("offers a preserving application-target refresh for an accepted LinkedIn job", async () => {
    const user = userEvent.setup();
    const jobUrl = "https://www.linkedin.com/jobs/view/synthetic-target";
    const calls: Array<Record<string, unknown>> = [];
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) => {
        const detail = makeJobDetail({
          ...sampleJob,
          jobKey: String(params["jobKey"]),
          url: jobUrl,
          applicationUrl: null,
        });
        return HttpResponse.json({
          ...detail,
          stages: [
            ...detail.stages,
            {
              ...detail.stages[0],
              stage: "enrich",
              state: "succeeded",
            },
          ],
        });
      }),
      http.post("*/v1/jobs/:jobKey/actions/retry-stage", async ({ request }) => {
        calls.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true, action: "retry_stage", status: "queued" }, { status: 202 });
      }),
    );
    renderJobDetailDrawer(jobUrl);
    const callout = await screen.findByRole("region", { name: "Application target refresh" });
    expect(within(callout).getByText(/saved description, score, and materials stay available/i)).toBeInTheDocument();
    await user.click(within(callout).getByRole("button", { name: "Refresh application target" }));
    await waitFor(() => expect(calls).toEqual([
      expect.objectContaining({ stage: "enrich", runAfter: true, refreshApplyUrl: true }),
    ]));
  });

  it("does not offer target refresh for a LinkedIn locator the worker cannot inspect", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) => {
        const detail = makeJobDetail({
          ...sampleJob,
          jobKey: String(params["jobKey"]),
          url: "https://m.linkedin.com/jobs/view/synthetic-mobile",
          applicationUrl: null,
        });
        return HttpResponse.json({
          ...detail,
          stages: [...detail.stages, { ...detail.stages[0], stage: "enrich", state: "succeeded" }],
        });
      }),
    );
    renderJobDetailDrawer("https://m.linkedin.com/jobs/view/synthetic-mobile");
    await screen.findByRole("article", { name: "Job details" });
    expect(screen.queryByRole("button", { name: "Refresh application target" })).not.toBeInTheDocument();
  });

  it("returns to the jobs list from the route-level workspace", async () => {
    const user = userEvent.setup();
    const { container, router } = renderJobDetailDrawer("job-1");

    await waitFor(() =>
      expect(
        screen.getByRole("article", { name: "Job details" }),
      ).toBeInTheDocument(),
    );
    expect(router.state.location.pathname).toBe("/jobs/job-1");
    expect(container.querySelector(".drawer-backdrop")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Back to jobs" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/jobs"));
  });

  it("renders user-facing audit history as the collapsed final drawer section", async () => {
    const user = userEvent.setup();
    renderJobDetailDrawer("job-1");

    const auditSummary = await screen.findByText("Technical details");
    const auditDisclosure = auditSummary.closest("details");
    expect(auditDisclosure).not.toBeNull();
    expect(auditDisclosure).not.toHaveAttribute("open");

    const workspace = screen.getByRole("article", { name: "Job details" });
    const sections = Array.from(workspace.querySelectorAll("section.section"));
    expect(sections.at(-1)).toContainElement(auditDisclosure);
    expect(sections.at(-1)).toHaveTextContent("Technical details");
    expect(sections[1]).toHaveTextContent("Compensation");
    expect(sections[2]).toHaveTextContent("Description");

    await user.click(auditSummary);
    expect(auditDisclosure).toHaveAttribute("open");

    const history = within(auditDisclosure as HTMLElement).getByLabelText(
      "Job audit history",
    );
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
    fireEvent.click(screen.getByRole("button", { name: "More job actions" }));
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
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
      http.post(
        "*/v1/jobs/:jobKey/actions/retry-stage",
        async ({ request }) => {
          calls.push(
            (await request.json()) as { stage?: string; runAfter?: boolean },
          );
          return HttpResponse.json({
            ok: true,
            action: "retry_stage",
            status: "reset",
            command: {
              action: "retry_stage",
              jobKey: "https://example.com/jobs/1",
            },
          });
        },
      ),
    );

    renderJobDetailDrawer("https://example.com/jobs/1");

    await user.click(
      await screen.findByRole("button", { name: "More job actions" }),
    );
    await user.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(calls).toEqual([
        expect.objectContaining({ stage: "enrich", runAfter: true }),
      ]),
    );
  });
});
