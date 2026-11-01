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
import type { QueryClient } from "@tanstack/react-query";
import {
  fireEvent,
  act,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LOCAL_TENANT, createTenantId, type TenantId } from "@jobctrl/domain-types";

import { jobsKeys } from "../../contexts/operations/jobsKeys.js";
import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { useToastStore } from "../../shared/stores/toasts.js";
import { server } from "../../test/msw/server.js";
import { buildProviderHarness, createTestQueryClient } from "../../test/render.js";
import { FakeEventStreamPort, FakeSessionPort, buildTestPorts } from "../../test/testPorts.js";
import { observeRetryDetailConfirmation, retryStatusScope } from "../../contexts/pipeline/lib/retryStatusConfirmation.js";
import {
  blockedRequirementFitReport,
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

function renderJobDetailDrawer(jobId: string, eventStream?: FakeEventStreamPort, queryClient?: QueryClient, tenantId?: TenantId) {
  const ports = buildTestPorts(eventStream ? { eventStream } : {});
  if (tenantId) ports.session = new FakeSessionPort({ tenantId, userId: null });
  const harness = buildProviderHarness({
    ports,
    ...(eventStream ? { withEventStream: true } : {}),
    ...(queryClient ? { queryClient } : {}),
  });
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
    queryClient: harness.queryClient,
    ...render(<RouterProvider router={router} />, { wrapper: harness.Wrapper }),
  };
}

async function expandDetailSections() {
  fireEvent.click(await screen.findByRole("button", { name: "Sections" }));
  fireEvent.click(await screen.findByRole("button", { name: "Expand all" }));
}

describe("<JobDetailDrawer>", () => {
  it("shows requirement coverage and the recorded blocker beside a capped score with sections collapsed", async () => {
    server.use(http.get("*/v1/jobs/:jobKey", () => HttpResponse.json(makeJobDetail(
      { ...sampleJob, jobKey: "job-1", scoreVersion: 4, fitScore: 4 },
      { requirementFitReport: blockedRequirementFitReport },
    ))));
    const user = userEvent.setup();
    renderJobDetailDrawer("job-1");
    const context = await screen.findByRole("note", { name: "Requirement score context" });
    expect(context).toBeVisible();
    expect(context).toHaveTextContent("80% weighted requirement coverage");
    expect(context).toHaveTextContent("The posting requires a current clearance.");
    expect(context).toHaveTextContent("caps scores with blocked requirements at 4/10");
    expect(screen.getByRole("button", { name: /01 · Description/ })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "Help for Fit score" }));
    expect(await screen.findByRole("dialog", { name: "Fit score explanation" })).toHaveTextContent(context.textContent!);
  });

  it("keeps a score-correction draft mounted across collapse and detail refetch", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderJobDetailDrawer("job-1");
    await expandDetailSections();
    const fitSection = await waitFor(() => {
      const section = document.getElementById("job-detail-fit-evidence");
      expect(section).not.toBeNull();
      return section as HTMLElement;
    });
    await user.click(within(fitSection).getByText("Score evidence and controls"));
    const reason = within(fitSection).getByRole("textbox", { name: "Reason" });
    await user.type(reason, "Keep this local draft");
    const trigger = within(fitSection).getByRole("button", { name: /02 · Fit & evidence/ });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(reason).toBeInTheDocument();
    expect(reason).not.toBeVisible();
    await queryClient.invalidateQueries();
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(reason).toHaveValue("Keep this local draft");
  });

  it("keeps contextual help available across the detail workspace when records are absent", async () => {
    server.use(
      http.get("*/v1/jobs/:jobKey", ({ params }) =>
        HttpResponse.json(makeJobDetail({ ...sampleJob, jobKey: String(params["jobKey"]) })),
      ),
    );
    renderJobDetailDrawer("https://example.com/jobs/1");
    await expandDetailSections();

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
    await expandDetailSections();

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
    await expandDetailSections();

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
    await expandDetailSections();

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
    await expandDetailSections();

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
    await expandDetailSections();

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
    const initialWorkspace = await screen.findByRole("article", { name: "Job details" });
    const initialSections = initialWorkspace.querySelectorAll(".job-detail-major-section");
    expect(initialSections[0]).toHaveAttribute("id", "job-detail-description");
    expect(within(initialSections[0] as HTMLElement).getByRole("button", { name: /01 · Description/ })).toHaveAttribute("aria-expanded", "false");
    for (const section of initialSections) {
      expect(section.querySelector("[data-slot='collapsible-trigger']")).toHaveAttribute("aria-expanded", "false");
    }
    fireEvent.click(within(initialWorkspace).getByRole("button", { name: "Sections" }));
    const initialMenu = await screen.findByRole("navigation", { name: "Job detail sections" });
    for (const button of within(initialMenu).getAllByRole("button")) {
      expect(button).toHaveAttribute("aria-expanded", "false");
    }
    fireEvent.click(within(initialMenu).getByRole("button", { name: "Description" }));
    const descriptionTrigger = within(initialSections[0] as HTMLElement).getByRole("button", { name: /01 · Description/ });
    await waitFor(() => expect(descriptionTrigger).toHaveFocus());
    expect(descriptionTrigger).toHaveAttribute("aria-expanded", "true");
    expect(initialWorkspace.querySelectorAll(".job-detail-major-section > .configuration-section__header [aria-expanded='true']")).toHaveLength(1);
    await expandDetailSections();

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
    expect(workspace.querySelector(".route-workspace__inspector")).toBeNull();
    expect(workspace.querySelector("#job-detail-locales")).toHaveTextContent("Locale variants");
    expect(workspace.querySelectorAll(".job-detail-major-section")).toHaveLength(13);
    const sectionsTrigger = within(workspace).getByRole("button", { name: "Sections" });
    fireEvent.click(sectionsTrigger);
    const sectionsMenu = await screen.findByRole("navigation", { name: "Job detail sections" });
    expect(within(sectionsMenu).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Description", "Fit & evidence", "Preparation diagnostics", "Artifacts", "Compensation",
      "Locale variants", "Role Analysis", "Screening answers", "Interview prep", "Apply history",
      "Application outcomes", "Contacts", "Audit history",
    ]);
    fireEvent.click(within(sectionsMenu).getByRole("button", { name: "Artifacts" }));
    expect(within(workspace.querySelector("#job-detail-artifacts") as HTMLElement).getByRole("button", { name: /04 · Artifacts/ })).toHaveAttribute("aria-expanded", "true");
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
      (description as HTMLElement).compareDocumentPosition(triage) &
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
    await expandDetailSections();

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
                  determination: sampleCompensationAudit.posted.recordStatus === "recorded" ? sampleCompensationAudit.posted.determination : (() => {throw new Error("Expected fixture decision");})(),
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
    await expandDetailSections();

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
    await expandDetailSections();

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
    await expandDetailSections();

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
    await expandDetailSections();
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
    await expandDetailSections();
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
    await expandDetailSections();
    const callout = await screen.findByRole("region", { name: "Application target refresh" });
    expect(within(callout).getByText(/saved description, score, and materials stay available/i)).toBeInTheDocument();
    await user.click(within(callout).getByRole("button", { name: "Refresh application target" }));
    await waitFor(() => expect(calls).toEqual([
      expect.objectContaining({ stage: "enrich", runAfter: true, refreshApplyUrl: true }),
    ]));
  });

  it("does not report stage retry uncertainty when application-target refresh is rejected", async () => {
    const alias = "https://www.linkedin.com/jobs/view/synthetic-rejected-target";
    const canonical = "88888888-8888-4888-8888-888888888888";
    const queryClient = createTestQueryClient();
    queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 30_000, gcTime: Infinity, refetchOnMount: true,
        refetchOnReconnect: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    });
    const detail = makeJobDetail({ ...sampleJob, jobKey: canonical, url: alias, applicationUrl: null });
    const enriched = { ...detail, stages: [...detail.stages,
      { ...detail.stages[0]!, stage: "enrich" as const, state: "succeeded" as const }] };
    const aliasKey = jobsKeys.detail(LOCAL_TENANT, alias);
    const canonicalKey = jobsKeys.detail(LOCAL_TENANT, canonical);
    queryClient.setQueryData(aliasKey, enriched);
    queryClient.setQueryData(canonicalKey, enriched);
    let requested = false;
    server.use(
      http.get("*/v1/jobs/:jobKey", () => HttpResponse.json(enriched)),
      http.post("*/v1/jobs/:jobKey/actions/retry-stage", async ({ params, request }) => {
        expect(String(params.jobKey)).toBe(canonical);
        expect(await request.json()).toMatchObject({ stage: "enrich", runAfter: true, refreshApplyUrl: true });
        requested = true;
        return HttpResponse.json({ ok: false, error: "apply_url_refresh_not_eligible" }, { status: 409 });
      }),
    );
    const user = userEvent.setup();
    try {
      const first = renderJobDetailDrawer(alias, undefined, queryClient);
      await expandDetailSections();
      const callout = await screen.findByRole("region", { name: "Application target refresh" });
      await user.click(within(callout).getByRole("button", { name: "Refresh application target" }));
      await waitFor(() => expect(requested).toBe(true));
      await waitFor(() => expect(queryClient.getQueryState(canonicalKey)?.isInvalidated).toBe(true));
      expect(queryClient.getQueryData(canonicalKey)).toBe(enriched);
      expect(useToastStore.getState().toasts).not.toContainEqual(expect.objectContaining({
        scope: retryStatusScope(LOCAL_TENANT, canonical, canonical),
      }));
      expect(useToastStore.getState().toasts).not.toContainEqual(expect.objectContaining({
        scope: retryStatusScope(LOCAL_TENANT, canonical, alias),
      }));
      first.unmount();
      renderJobDetailDrawer(canonical, undefined, queryClient);
      await screen.findByRole("article", { name: "Job details" });
      expect(screen.queryByText(/stage status may be out of date after this retry/i)).not.toBeInTheDocument();
    } finally {
      act(() => useToastStore.getState().clear());
    }
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
    await expandDetailSections();
    await screen.findByRole("article", { name: "Job details" });
    expect(screen.queryByRole("button", { name: "Refresh application target" })).not.toBeInTheDocument();
  });

  it("returns to the jobs list from the route-level workspace", async () => {
    const user = userEvent.setup();
    const { container, router } = renderJobDetailDrawer("job-1");
    await expandDetailSections();

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
    await expandDetailSections();

    const auditSummary = await screen.findByText("Technical details");
    const auditDisclosure = auditSummary.closest("details");
    expect(auditDisclosure).not.toBeNull();
    expect(auditDisclosure).not.toHaveAttribute("open");

    const workspace = screen.getByRole("article", { name: "Job details" });
    const sections = Array.from(workspace.querySelectorAll(".job-detail-major-section"));
    expect(workspace.querySelector("#job-detail-locales")).toHaveTextContent("Locale variants");
    expect(sections).toHaveLength(13);
    expect(sections.at(-1)).toContainElement(auditDisclosure);
    expect(sections.at(-1)).toHaveTextContent("Technical details");
    expect(sections[4]).toHaveTextContent("Compensation");
    expect(workspace.querySelector("#job-detail-description")).toHaveTextContent("Description");

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
    await expandDetailSections();

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
    await expandDetailSections();

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

  it("does not start another read after a held sibling read confirms the retry", async () => {
    const alias = "https://example.com/jobs/confirmed-sibling";
    const canonical = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const queryClient = createTestQueryClient();
    queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 30_000, gcTime: Infinity, refetchOnMount: true,
        refetchOnReconnect: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    });
    const detail = makeJobDetail({ ...sampleJob, jobKey: canonical,
      currentStage: "discover", currentSubstage: "discover", currentState: "failed" });
    const stage = { ...detail.stages[0]!, stage: "discover" as const, state: "failed" as const, retryable: true };
    const failedDetail = { ...detail, stages: [stage] };
    const pendingDetail = { ...failedDetail, job: { ...detail.job, currentState: "pending" as const },
      stages: [{ ...stage, state: "pending" as const }] };
    const aliasKey = jobsKeys.detail(LOCAL_TENANT, alias);
    const canonicalKey = jobsKeys.detail(LOCAL_TENANT, canonical);
    queryClient.setQueryData(aliasKey, failedDetail);
    queryClient.setQueryData(canonicalKey, failedDetail);
    let releaseResponse!: () => void;
    let releaseRead!: () => void;
    const responseHeld = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
    let requested = false;
    let canonicalReads = 0;
    server.use(
      http.post("*/v1/jobs/:jobKey/material-locales", () => HttpResponse.json({
        supportedLocales: [], variants: [], profileVersion: null, sources: [],
      })),
      http.get("*/v1/jobs/:jobKey", async ({ params }) => {
        if (String(params.jobKey) !== canonical) return HttpResponse.json(pendingDetail);
        canonicalReads += 1;
        if (canonicalReads > 1) return HttpResponse.json({ ok: false, error: "unexpected_extra_read" }, { status: 503 });
        await readHeld;
        return HttpResponse.json(pendingDetail);
      }),
      http.post("*/v1/jobs/:jobKey/actions/retry-stage", async ({ params, request }) => {
        expect(String(params.jobKey)).toBe(canonical);
        expect(await request.json()).toMatchObject({ stage: "discover", runAfter: false });
        requested = true;
        await responseHeld;
        return HttpResponse.json({ ok: true, action: "retry_stage", status: "reset",
          command: { action: "retry_stage", jobKey: canonical }, stage: { ...stage, state: "pending" } });
      }),
    );
    const user = userEvent.setup();
    try {
      renderJobDetailDrawer(alias, undefined, queryClient);
      await expandDetailSections();
      await user.click(await screen.findByRole("button", { name: "More job actions" }));
      await user.click(await screen.findByRole("button", { name: "Retry" }));
      await waitFor(() => expect(requested).toBe(true));
      const alternate = renderJobDetailDrawer(canonical, undefined, queryClient);
      releaseResponse();
      await waitFor(() => expect(canonicalReads).toBe(1));
      expect(await within(alternate.container).findByRole("button", { name: "Refreshing stage status" })).toBeDisabled();
      const pending = queryClient.getQueryCache().find({ queryKey: canonicalKey, exact: true })?.promise;
      expect(pending).toBeDefined();
      await act(async () => {
        releaseRead();
        await pending;
        await Promise.resolve();
        await Promise.resolve();
      });
      const scope = retryStatusScope(LOCAL_TENANT, canonical, canonical);
      await waitFor(() => expect(useToastStore.getState().toasts).not.toContainEqual(expect.objectContaining({ scope })));
      expect(canonicalReads).toBe(1);
      expect(queryClient.getQueryState(canonicalKey)?.status).toBe("success");
      expect(within(alternate.container).getByRole("group", { name: "Workflow state" })).toHaveTextContent("Pending");
    } finally {
      releaseResponse();
      releaseRead();
      act(() => useToastStore.getState().clear());
    }
  });

  it("does not continue a closed drawer's confirmation while Screening Answers stays subscribed", async () => {
    const alias = "https://example.com/jobs/closed-confirmation";
    const canonical = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const queryClient = createTestQueryClient();
    queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 30_000, gcTime: Infinity, refetchOnMount: true,
        refetchOnReconnect: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    });
    const detail = makeJobDetail({ ...sampleJob, jobKey: canonical, title: "Synthetic closed drawer",
      currentStage: "discover", currentSubstage: "discover", currentState: "failed" });
    const stage = { ...detail.stages[0]!, stage: "discover" as const, state: "failed" as const, retryable: true };
    const failedDetail = { ...detail, stages: [stage] };
    const pendingDetail = { ...failedDetail, job: { ...detail.job, currentState: "pending" as const },
      stages: [{ ...stage, state: "pending" as const }] };
    const canonicalKey = jobsKeys.detail(LOCAL_TENANT, canonical);
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, alias), failedDetail);
    queryClient.setQueryData(canonicalKey, failedDetail);
    let releaseOldRead!: () => void;
    const oldReadHeld = new Promise<void>((resolve) => { releaseOldRead = resolve; });
    let canonicalReads = 0;
    server.use(
      http.post("*/v1/jobs/:jobKey/material-locales", () => HttpResponse.json({
        supportedLocales: [], variants: [], profileVersion: null, sources: [],
      })),
      http.get("*/v1/jobs/:jobKey/screening-answers", () => HttpResponse.json({
        ok: true, jobId: canonical, questions: [], history: [], library: [], facts: [], sourceBinding: null,
        sourceFailure: null, determinations: [], failures: [],
      })),
      http.get("*/v1/jobs/:jobKey", async ({ params }) => {
        if (String(params.jobKey) !== canonical) return HttpResponse.json(failedDetail);
        canonicalReads += 1;
        if (canonicalReads === 1) {
          await oldReadHeld;
          return HttpResponse.json(failedDetail);
        }
        if (canonicalReads === 2) return HttpResponse.json(pendingDetail);
        return HttpResponse.json({ ok: false, error: "unexpected_extra_read" }, { status: 503 });
      }),
    );
    const user = userEvent.setup();
    let oldRead: Promise<void> | undefined;
    try {
      renderJobDetailDrawer(alias, undefined, queryClient);
      await expandDetailSections();
      await user.click(await screen.findByRole("button", { name: "Open screening answers" }));
      expect(await screen.findByText("Application: Synthetic closed drawer")).toBeVisible();
      oldRead = queryClient.invalidateQueries({ queryKey: canonicalKey, exact: true });
      await waitFor(() => expect(canonicalReads).toBe(1));
      const scope = retryStatusScope(LOCAL_TENANT, canonical, canonical);
      const noticeId = useToastStore.getState().toast({
        variant: "warning", message: "Synthetic retry needs confirmation.", durationMs: 0, scope,
      });
      observeRetryDetailConfirmation(queryClient, canonicalKey, noticeId, canonical);
      const closed = renderJobDetailDrawer(canonical, undefined, queryClient);
      expect(await within(closed.container).findByRole("button", { name: "Refreshing stage status" })).toBeDisabled();
      closed.unmount();
      expect(queryClient.getQueryCache().find({ queryKey: canonicalKey, exact: true })?.isActive()).toBe(true);
      await act(async () => {
        releaseOldRead();
        await oldRead;
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(canonicalReads).toBe(1);
      expect(useToastStore.getState().toasts.some((entry) => entry.id === noticeId)).toBe(true);
      const reopened = renderJobDetailDrawer(canonical, undefined, queryClient);
      await waitFor(() => expect(useToastStore.getState().toasts.some((entry) => entry.id === noticeId)).toBe(false));
      expect(canonicalReads).toBe(2);
      expect(within(reopened.container).getByRole("group", { name: "Workflow state" })).toHaveTextContent("Pending");
    } finally {
      releaseOldRead();
      await oldRead?.catch(() => {});
      act(() => useToastStore.getState().clear());
    }
  });

  it.each([
    { stage: "discover", runAfter: false, expectedState: "pending", acceptedState: "pending", status: "reset", readbackFails: false, message: null },
    { stage: "tailor", runAfter: true, expectedState: "running", acceptedState: "running", status: "queued", readbackFails: false, message: null },
    { stage: "tailor", runAfter: true, expectedState: "running", acceptedState: "pending", status: "reset", readbackFails: false, message: null },
    { stage: "tailor", runAfter: true, expectedState: "running", acceptedState: "pending", status: "failed", readbackFails: true, message: "Synthetic dispatch failure." },
    { stage: "tailor", runAfter: true, expectedState: "running", acceptedState: "pending", status: "unsupported", readbackFails: true, message: null },
  ] as const)(
    "shows $expectedState while retrying $stage and accepts $acceptedState after a $status response",
    async ({ stage, runAfter, expectedState, acceptedState, status, readbackFails, message }) => {
      useToastStore.getState().clear();
      const user = userEvent.setup();
      const calls: Array<{ stage?: string; runAfter?: boolean }> = [];
      let releaseResponse!: () => void;
      let releaseReadback!: () => void;
      const responseHeld = new Promise<void>((resolve) => { releaseResponse = resolve; });
      const readbackHeld = new Promise<void>((resolve) => { releaseReadback = resolve; });
      let reads = 0;
      const jobId = `job-retry-${stage}`;
      const detail = makeJobDetail({
        ...sampleJob,
        jobKey: jobId,
        currentStage: stage,
        currentSubstage: stage,
        currentState: "failed",
      });
      const failedStage = {
        ...detail.stages[0]!,
        stage,
        state: "failed" as const,
        retryable: true,
      };
      server.use(
        http.post("*/v1/jobs/:jobKey/material-locales", () => HttpResponse.json({
          supportedLocales: [], variants: [], profileVersion: null, sources: [],
        })),
        http.get("*/v1/jobs/:jobKey", async () => {
          reads += 1;
          if (reads > 1) await readbackHeld;
          if (reads > 1 && readbackFails) {
            return HttpResponse.json({ ok: false, error: "synthetic_readback_failure" }, { status: 503 });
          }
          return HttpResponse.json({
            ...detail,
            job: { ...detail.job, currentState: reads === 1 ? "failed" : acceptedState },
            stages: [{
              ...failedStage,
              state: reads === 1 ? "failed" : acceptedState,
              updatedAt: reads === 1 ? failedStage.updatedAt : "2026-05-02T12:00:00Z",
            }],
          });
        }),
        http.post("*/v1/jobs/:jobKey/actions/retry-stage", async ({ request }) => {
          calls.push((await request.json()) as { stage?: string; runAfter?: boolean });
          await responseHeld;
          return HttpResponse.json({
            ok: true,
            action: "retry_stage",
            status,
            command: { action: "retry_stage", jobKey: jobId },
            stage: { ...failedStage, state: status === "queued" ? "pending" : acceptedState },
            ...(message ? { message } : {}),
          }, { status: status === "reset" ? 200 : 202 });
        }),
      );

      try {
        const { queryClient } = renderJobDetailDrawer(jobId);
        await expandDetailSections();
        await user.click(await screen.findByRole("button", { name: "More job actions" }));
        await user.click(await screen.findByRole("button", { name: "Retry" }));
        await waitFor(() => expect(calls).toEqual([expect.objectContaining({ stage, runAfter })]));

        const timeline = screen.getByRole("list", { name: "Preparation stages" });
        const row = within(timeline).getByText(stage === "discover" ? "Discover" : "Tailor").closest("li");
        expect(row).toHaveAttribute("data-stage-state", expectedState);
        const workflowState = screen.getByRole("group", { name: "Workflow state" });
        expect(workflowState).toHaveTextContent(new RegExp(`\\b${expectedState}\\b`, "i"));

        releaseResponse();
        await waitFor(() => expect(reads).toBeGreaterThan(1));
        expect(row).toHaveAttribute("data-stage-state", acceptedState);
        expect(workflowState).toHaveTextContent(new RegExp(`\\b${acceptedState}\\b`, "i"));
        if (readbackFails) {
          const text = `The stage was reset, but the retry could not start.${message ? ` ${message}` : ""}`;
          expect(await screen.findByText(text)).toBeVisible();
        }
        releaseReadback();
        if (readbackFails) {
          await waitFor(() => expect(queryClient.getQueryState(jobsKeys.detail(LOCAL_TENANT, jobId))?.status).toBe("error"));
          expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, jobId))).toMatchObject({
            job: { currentState: "pending" },
            stages: [{ state: "pending" }],
          });
        } else {
          await waitFor(() => expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, jobId))).toMatchObject({
            stages: [{ state: acceptedState, updatedAt: "2026-05-02T12:00:00Z" }],
          }));
        }
        expect(row).toHaveAttribute("data-stage-state", acceptedState);
        expect(workflowState).toHaveTextContent(new RegExp(`\\b${acceptedState}\\b`, "i"));
      } finally {
        releaseResponse();
        releaseReadback();
        act(() => useToastStore.getState().clear());
      }
    },
  );

  it("patches the mounted URL-alias detail while retrying the canonical job", async () => {
    const alias = "https://example.com/jobs/alias-discover";
    const canonical = "11111111-1111-4111-8111-111111111111";
    const unrelated = "22222222-2222-4222-8222-222222222222";
    const user = userEvent.setup();
    let releaseResponse!: () => void;
    let releaseReadback!: () => void;
    const responseHeld = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const readbackHeld = new Promise<void>((resolve) => { releaseReadback = resolve; });
    let reads = 0;
    const requests: Array<{ jobKey: string; body: unknown }> = [];
    const detail = makeJobDetail({
      ...sampleJob, jobKey: canonical, currentStage: "discover", currentSubstage: "discover", currentState: "failed",
    });
    const failed = { ...detail.stages[0]!, stage: "discover" as const, state: "failed" as const, retryable: true };
    server.use(
      http.post("*/v1/jobs/:jobKey/material-locales", () => HttpResponse.json({
        supportedLocales: [], variants: [], profileVersion: null, sources: [],
      })),
      http.get("*/v1/jobs/:jobKey", async ({ params }) => {
        expect(String(params.jobKey)).toBe(alias);
        reads += 1;
        if (reads > 1) await readbackHeld;
        return HttpResponse.json({
          ...detail, job: { ...detail.job, currentState: reads === 1 ? "failed" : "pending" },
          stages: [{ ...failed, state: reads === 1 ? "failed" : "pending",
            updatedAt: reads === 1 ? failed.updatedAt : "2026-05-02T12:00:00Z" }],
        });
      }),
      http.post("*/v1/jobs/:jobKey/actions/retry-stage", async ({ params, request }) => {
        requests.push({ jobKey: String(params.jobKey), body: await request.json() });
        await responseHeld;
        return HttpResponse.json({ ok: true, action: "retry_stage", status: "reset",
          command: { action: "retry_stage", jobKey: canonical }, stage: { ...failed, state: "pending" } });
      }),
    );
    try {
      const { queryClient } = renderJobDetailDrawer(alias);
      const otherDetail = makeJobDetail({ ...sampleJob, jobKey: unrelated });
      queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, unrelated), otherDetail);
      await expandDetailSections();
      await user.click(await screen.findByRole("button", { name: "More job actions" }));
      await user.click(await screen.findByRole("button", { name: "Retry" }));
      await waitFor(() => expect(requests).toEqual([{
        jobKey: canonical, body: expect.objectContaining({ stage: "discover", runAfter: false }),
      }]));
      const timeline = screen.getByRole("list", { name: "Preparation stages" });
      expect(within(timeline).getByText("Discover").closest("li")).toHaveAttribute("data-stage-state", "pending");
      expect(screen.getByRole("group", { name: "Workflow state" })).toHaveTextContent(/pending/i);
      expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, unrelated))).toBe(otherDetail);
      releaseResponse();
      await waitFor(() => expect(reads).toBeGreaterThan(1));
      expect(within(timeline).getByText("Discover").closest("li")).toHaveAttribute("data-stage-state", "pending");
      expect(screen.getByRole("group", { name: "Workflow state" })).toHaveTextContent(/pending/i);
      releaseReadback();
      await waitFor(() => expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, alias))).toMatchObject({
        job: { currentState: "pending" }, stages: [{ state: "pending", updatedAt: "2026-05-02T12:00:00Z" }],
      }));
      expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, unrelated))).toBe(otherDetail);
    } finally {
      releaseResponse();
      releaseReadback();
    }
  });

  it("keeps a newer alias detail and its scoped recovery after a delayed reset", async () => {
    useToastStore.getState().clear();
    const alias = "https://example.com/jobs/alias-race";
    const canonical = "33333333-3333-4333-8333-333333333333";
    const user = userEvent.setup();
    let releaseResponse!: () => void;
    const responseHeld = new Promise<void>((resolve) => { releaseResponse = resolve; });
    let requested = false;
    let mode: "failed" | "running" | "read-failed" = "failed";
    const detail = makeJobDetail({
      ...sampleJob, jobKey: canonical, currentStage: "discover", currentSubstage: "discover", currentState: "failed",
    });
    const stage = { ...detail.stages[0]!, stage: "discover" as const, state: "failed" as const, retryable: true };
    server.use(
      http.post("*/v1/jobs/:jobKey/material-locales", () => HttpResponse.json({
        supportedLocales: [], variants: [], profileVersion: null, sources: [],
      })),
      http.get("*/v1/jobs/:jobKey", () => mode === "read-failed"
        ? HttpResponse.json({ ok: false, error: "synthetic_readback_failure" }, { status: 503 })
        : HttpResponse.json({ ...detail,
          job: { ...detail.job, currentState: mode },
          stages: [{ ...stage, state: mode, updatedAt: mode === "running" ? "2026-05-03T12:00:00Z" : stage.updatedAt }],
        })),
      http.post("*/v1/jobs/:jobKey/actions/retry-stage", async ({ params, request }) => {
        expect(String(params.jobKey)).toBe(canonical);
        expect(await request.json()).toMatchObject({ stage: "discover", runAfter: false });
        requested = true;
        await responseHeld;
        return HttpResponse.json({ ok: true, action: "retry_stage", status: "reset",
          command: { action: "retry_stage", jobKey: canonical }, stage: { ...stage, state: "pending" } });
      }),
    );
    try {
      const { queryClient } = renderJobDetailDrawer(alias);
      const key = jobsKeys.detail(LOCAL_TENANT, alias);
      await expandDetailSections();
      await user.click(await screen.findByRole("button", { name: "More job actions" }));
      await user.click(await screen.findByRole("button", { name: "Retry" }));
      await waitFor(() => expect(requested).toBe(true));
      mode = "running";
      await act(async () => { await queryClient.invalidateQueries({ queryKey: key, exact: true }); });
      expect(queryClient.getQueryData(key)).toMatchObject({
        job: { currentState: "running" }, stages: [{ state: "running", updatedAt: "2026-05-03T12:00:00Z" }],
      });
      mode = "read-failed";
      releaseResponse();
      const warning = "The displayed stage status may be out of date after this retry. Refresh Job Detail to confirm the current state.";
      expect(await screen.findByText(warning)).toBeVisible();
      await waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe("error"));
      expect(queryClient.getQueryData(key)).toMatchObject({
        job: { currentState: "running" }, stages: [{ state: "running" }],
      });
      expect(useToastStore.getState().toasts).toContainEqual(expect.objectContaining({
        scope: retryStatusScope(LOCAL_TENANT, canonical, alias), message: warning,
      }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Refresh stage status" })).toBeEnabled());
      mode = "running";
      await user.click(screen.getByRole("button", { name: "Refresh stage status" }));
      await waitFor(() => expect(useToastStore.getState().toasts).not.toContainEqual(expect.objectContaining({ message: warning })));
    } finally {
      releaseResponse();
      act(() => useToastStore.getState().clear());
    }
  });

  it.each([
    { direction: "alias-first", active: false },
    { direction: "canonical-first", active: false },
    { direction: "alias-first", active: true },
    { direction: "canonical-first", active: true },
  ] as const)(
    "keeps an alternate locator uncertain until its own read succeeds ($direction, active=$active)",
    async ({ direction, active }) => {
      const alias = "https://example.com/jobs/navigation-alias";
      const canonical = "44444444-4444-4444-8444-444444444444";
      const unrelated = "55555555-5555-4555-8555-555555555555";
      const otherTenant = createTenantId("synthetic-other-tenant");
      const routeId = direction === "alias-first" ? alias : canonical;
      const nextId = direction === "alias-first" ? canonical : alias;
      const queryClient = createTestQueryClient();
      queryClient.setDefaultOptions({
        queries: { retry: false, staleTime: 30_000, gcTime: Infinity, refetchOnMount: true,
          refetchOnReconnect: false, refetchOnWindowFocus: false },
        mutations: { retry: false },
      });
      const detail = makeJobDetail({
        ...sampleJob, jobKey: canonical, currentStage: "discover", currentSubstage: "discover", currentState: "failed",
      });
      const stage = { ...detail.stages[0]!, stage: "discover" as const, state: "failed" as const, retryable: true };
      const failedDetail = { ...detail, stages: [stage] };
      const newerDetail = { ...detail, job: { ...detail.job, currentState: "running" as const },
        stages: [{ ...stage, state: "running" as const, updatedAt: "2026-05-03T12:00:00Z" }] };
      const otherDetail = makeJobDetail({ ...sampleJob, jobKey: unrelated });
      const routeKey = jobsKeys.detail(LOCAL_TENANT, routeId);
      const nextKey = jobsKeys.detail(LOCAL_TENANT, nextId);
      const otherKey = jobsKeys.detail(LOCAL_TENANT, unrelated);
      const foreignKey = jobsKeys.detail(otherTenant, nextId);
      queryClient.setQueryData(routeKey, failedDetail);
      queryClient.setQueryData(nextKey, newerDetail);
      queryClient.setQueryData(otherKey, otherDetail);
      queryClient.setQueryData(foreignKey, failedDetail);
      const reads: string[] = [];
      let releaseResponse!: () => void;
      const responseHeld = new Promise<void>((resolve) => { releaseResponse = resolve; });
      let releaseNextRead!: () => void;
      const nextReadHeld = new Promise<void>((resolve) => { releaseNextRead = resolve; });
      let nextMode: "held-failure" | "failure" | "success" = "held-failure";
      let requested = false;
      server.use(
        http.post("*/v1/jobs/:jobKey/material-locales", () => HttpResponse.json({
          supportedLocales: [], variants: [], profileVersion: null, sources: [],
        })),
        http.get("*/v1/jobs/:jobKey", async ({ params }) => {
          const key = String(params.jobKey);
          reads.push(key);
          if (key === nextId) {
            if (nextMode === "held-failure") await nextReadHeld;
            if (nextMode !== "success") {
              return HttpResponse.json({ ok: false, error: "synthetic_readback_failure" }, { status: 503 });
            }
            return HttpResponse.json({ ...newerDetail,
              stages: [{ ...newerDetail.stages[0]!, updatedAt: "2026-05-04T12:00:00Z" }] });
          }
          return HttpResponse.json({ ...failedDetail, job: { ...detail.job, currentState: "pending" },
            stages: [{ ...stage, state: "pending" }] });
        }),
        http.post("*/v1/jobs/:jobKey/actions/retry-stage", async ({ params, request }) => {
          expect(String(params.jobKey)).toBe(canonical);
          expect(await request.json()).toMatchObject({ stage: "discover", runAfter: false });
          requested = true;
          await responseHeld;
          return HttpResponse.json({ ok: true, action: "retry_stage", status: "reset",
            command: { action: "retry_stage", jobKey: canonical }, stage: { ...stage, state: "pending" } });
        }),
      );
      const user = userEvent.setup();
      try {
        const first = renderJobDetailDrawer(routeId, undefined, queryClient);
        await expandDetailSections();
        await user.click(await screen.findByRole("button", { name: "More job actions" }));
        await user.click(await screen.findByRole("button", { name: "Retry" }));
        await waitFor(() => expect(requested).toBe(true));
        let alternate = active ? renderJobDetailDrawer(nextId, undefined, queryClient) : undefined;
        releaseResponse();
        await waitFor(() => expect(queryClient.getQueryState(nextKey)?.isInvalidated).toBe(true));
        expect(queryClient.getQueryData(nextKey)).toBe(newerDetail);
        expect(queryClient.getQueryData(otherKey)).toBe(otherDetail);
        expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
        expect(queryClient.getQueryData(foreignKey)).toBe(failedDetail);
        expect(queryClient.getQueryState(foreignKey)?.isInvalidated).toBe(false);
        await waitFor(() => expect(reads).toContain(routeId));
        const scope = retryStatusScope(LOCAL_TENANT, canonical, nextId);
        expect(useToastStore.getState().toasts).toContainEqual(expect.objectContaining({ scope }));
        if (!alternate) {
          first.unmount();
          alternate = renderJobDetailDrawer(nextId, undefined, queryClient);
        }
        await waitFor(() => expect(reads).toContain(nextId));
        const warning = "The displayed stage status may be out of date after this retry. Refresh Job Detail to confirm the current state.";
        expect(await within(alternate.container).findByText(warning)).toBeVisible();
        expect(within(alternate.container).getByRole("group", { name: "Workflow state" })).toHaveTextContent("Running");
        if (active) expect(within(first.container).queryByText(warning)).not.toBeInTheDocument();
        expect(queryClient.getQueryData(nextKey)).toBe(newerDetail);
        nextMode = "failure";
        releaseNextRead();
        await waitFor(() => expect(queryClient.getQueryState(nextKey)?.status).toBe("error"));
        expect(within(alternate.container).getByText(warning)).toBeVisible();
        await waitFor(() => expect(within(alternate!.container).getByRole("button", { name: "Refresh stage status" })).toBeEnabled());
        nextMode = "success";
        await user.click(within(alternate.container).getByRole("button", { name: "Refresh stage status" }));
        await waitFor(() => expect(queryClient.getQueryData(nextKey)).toMatchObject({
          job: { currentState: "running" }, stages: [{ state: "running", updatedAt: "2026-05-04T12:00:00Z" }],
        }));
        await waitFor(() => expect(useToastStore.getState().toasts).not.toContainEqual(expect.objectContaining({ scope })));
        expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
        expect(queryClient.getQueryState(foreignKey)?.isInvalidated).toBe(false);
      } finally {
        releaseResponse();
        releaseNextRead();
        act(() => useToastStore.getState().clear());
      }
    },
  );

  it("confirms a canonical sibling through Screening Answers before opening its detail", async () => {
    const alias = "https://example.com/jobs/screening-alias";
    const canonical = "99999999-9999-4999-8999-999999999999";
    const queryClient = createTestQueryClient();
    queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 30_000, gcTime: Infinity, refetchOnMount: true,
        refetchOnReconnect: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    });
    const detail = makeJobDetail({
      ...sampleJob, jobKey: canonical, title: "Synthetic screening role",
      currentStage: "discover", currentSubstage: "discover", currentState: "failed",
    });
    const stage = { ...detail.stages[0]!, stage: "discover" as const, state: "failed" as const, retryable: true };
    const failedDetail = { ...detail, stages: [stage] };
    const pendingDetail = { ...failedDetail, job: { ...detail.job, currentState: "pending" as const },
      stages: [{ ...stage, state: "pending" as const }] };
    const aliasKey = jobsKeys.detail(LOCAL_TENANT, alias);
    const canonicalKey = jobsKeys.detail(LOCAL_TENANT, canonical);
    queryClient.setQueryData(aliasKey, failedDetail);
    queryClient.setQueryData(canonicalKey, failedDetail);
    let releaseResponse!: () => void;
    let releaseOldRead!: () => void;
    let releaseConfirmation!: () => void;
    const responseHeld = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const oldReadHeld = new Promise<void>((resolve) => { releaseOldRead = resolve; });
    const confirmationHeld = new Promise<void>((resolve) => { releaseConfirmation = resolve; });
    let requested = false;
    let canonicalReads = 0;
    server.use(
      http.post("*/v1/jobs/:jobKey/material-locales", () => HttpResponse.json({
        supportedLocales: [], variants: [], profileVersion: null, sources: [],
      })),
      http.get("*/v1/jobs/:jobKey/screening-answers", () => HttpResponse.json({
        ok: true, jobId: canonical, questions: [], history: [], library: [], facts: [], sourceBinding: null,
        sourceFailure: null, determinations: [], failures: [],
      })),
      http.get("*/v1/jobs/:jobKey", async ({ params }) => {
        if (String(params.jobKey) !== canonical) return HttpResponse.json(pendingDetail);
        canonicalReads += 1;
        if (canonicalReads === 1) {
          await oldReadHeld;
          return HttpResponse.json(failedDetail);
        }
        await confirmationHeld;
        return HttpResponse.json(pendingDetail);
      }),
      http.post("*/v1/jobs/:jobKey/actions/retry-stage", async ({ params, request }) => {
        expect(String(params.jobKey)).toBe(canonical);
        expect(await request.json()).toMatchObject({ stage: "discover", runAfter: false });
        requested = true;
        await responseHeld;
        return HttpResponse.json({ ok: true, action: "retry_stage", status: "reset",
          command: { action: "retry_stage", jobKey: canonical }, stage: { ...stage, state: "pending" } });
      }),
    );
    const user = userEvent.setup();
    let oldRead: Promise<void> | undefined;
    try {
      const first = renderJobDetailDrawer(alias, undefined, queryClient);
      await expandDetailSections();
      await user.click(await screen.findByRole("button", { name: "Open screening answers" }));
      expect(await screen.findByText("Application: Synthetic screening role")).toBeVisible();
      expect(queryClient.getQueryCache().find({ queryKey: canonicalKey, exact: true })?.isActive()).toBe(true);
      oldRead = queryClient.invalidateQueries({ queryKey: canonicalKey, exact: true });
      await waitFor(() => expect(canonicalReads).toBe(1));
      await user.click(await screen.findByRole("button", { name: "More job actions" }));
      await user.click(await screen.findByRole("button", { name: "Retry" }));
      await waitFor(() => expect(requested).toBe(true));
      releaseResponse();
      const scope = retryStatusScope(LOCAL_TENANT, canonical, canonical);
      await waitFor(() => expect(useToastStore.getState().toasts).toContainEqual(expect.objectContaining({ scope })));
      releaseOldRead();
      await oldRead;
      await waitFor(() => expect(canonicalReads).toBeGreaterThan(1));
      expect(useToastStore.getState().toasts).toContainEqual(expect.objectContaining({ scope }));
      expect(queryClient.getQueryData(canonicalKey)).toMatchObject({ job: { currentState: "failed" } });
      releaseConfirmation();
      await waitFor(() => expect(queryClient.getQueryData(canonicalKey)).toMatchObject({ job: { currentState: "pending" } }));
      await waitFor(() => expect(useToastStore.getState().toasts).not.toContainEqual(expect.objectContaining({ scope })));
      first.unmount();
      renderJobDetailDrawer(canonical, undefined, queryClient);
      expect(await screen.findByRole("group", { name: "Workflow state" })).toHaveTextContent("Pending");
      expect(screen.queryByText(/stage status may be out of date after this retry/i)).not.toBeInTheDocument();
    } finally {
      releaseResponse();
      releaseOldRead();
      releaseConfirmation();
      await oldRead?.catch(() => {});
      act(() => useToastStore.getState().clear());
    }
  });

  it.each(["same-earlier-read", "different-earlier-reads"] as const)(
    "confirms overlapping retries through the Screening Answers subscriber (%s)",
    async (ordering) => {
      const firstAlias = "https://example.com/jobs/overlap-first";
      const secondAlias = "https://example.com/jobs/overlap-second";
      const canonical = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const queryClient = createTestQueryClient();
      queryClient.setDefaultOptions({
        queries: { retry: false, staleTime: 30_000, gcTime: Infinity, refetchOnMount: true,
          refetchOnReconnect: false, refetchOnWindowFocus: false },
        mutations: { retry: false },
      });
      const detail = makeJobDetail({ ...sampleJob, jobKey: canonical, title: "Synthetic overlap role",
        currentStage: "discover", currentSubstage: "discover", currentState: "failed" });
      const stage = { ...detail.stages[0]!, stage: "discover" as const, state: "failed" as const, retryable: true };
      const failedDetail = { ...detail, stages: [stage] };
      const pendingDetail = { ...failedDetail, job: { ...detail.job, currentState: "pending" as const },
        stages: [{ ...stage, state: "pending" as const }] };
      const canonicalKey = jobsKeys.detail(LOCAL_TENANT, canonical);
      queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, firstAlias), failedDetail);
      queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, secondAlias), failedDetail);
      let releaseFirstRetry!: () => void;
      let releaseSecondRetry!: () => void;
      let releaseOldRead!: () => void;
      let releaseFirstConfirmation!: () => void;
      let releaseSecondConfirmation!: () => void;
      const firstRetryHeld = new Promise<void>((resolve) => { releaseFirstRetry = resolve; });
      const secondRetryHeld = new Promise<void>((resolve) => { releaseSecondRetry = resolve; });
      const oldReadHeld = new Promise<void>((resolve) => { releaseOldRead = resolve; });
      const firstConfirmationHeld = new Promise<void>((resolve) => { releaseFirstConfirmation = resolve; });
      const secondConfirmationHeld = new Promise<void>((resolve) => { releaseSecondConfirmation = resolve; });
      let retryRequests = 0;
      let canonicalReads = 0;
      server.use(
        http.post("*/v1/jobs/:jobKey/material-locales", () => HttpResponse.json({
          supportedLocales: [], variants: [], profileVersion: null, sources: [],
        })),
        http.get("*/v1/jobs/:jobKey/screening-answers", () => HttpResponse.json({
          ok: true, jobId: canonical, questions: [], history: [], library: [], facts: [], sourceBinding: null,
          sourceFailure: null, determinations: [], failures: [],
        })),
        http.get("*/v1/jobs/:jobKey", async ({ params }) => {
          if (String(params.jobKey) !== canonical) return HttpResponse.json(pendingDetail);
          const read = ++canonicalReads;
          if (read === 1) {
            await oldReadHeld;
            return HttpResponse.json(failedDetail);
          }
          if (read === 2) await firstConfirmationHeld;
          if (read >= 3) await secondConfirmationHeld;
          return HttpResponse.json(pendingDetail);
        }),
        http.post("*/v1/jobs/:jobKey/actions/retry-stage", async ({ params, request }) => {
          expect(String(params.jobKey)).toBe(canonical);
          expect(await request.json()).toMatchObject({ stage: "discover", runAfter: false });
          const retry = ++retryRequests;
          await (retry === 1 ? firstRetryHeld : secondRetryHeld);
          return HttpResponse.json({ ok: true, action: "retry_stage", status: "reset",
            command: { action: "retry_stage", jobKey: canonical }, stage: { ...stage, state: "pending" } });
        }),
      );
      const user = userEvent.setup();
      const scope = retryStatusScope(LOCAL_TENANT, canonical, canonical);
      const notices = () => useToastStore.getState().toasts.filter((entry) => entry.scope === scope);
      const settledRetries = () => queryClient.getMutationCache().getAll().filter((mutation) => mutation.state.status === "success").length;
      const retryFrom = async (container: HTMLElement) => {
        await user.click(await within(container).findByRole("button", { name: "More job actions" }));
        const toolbar = await screen.findByRole("toolbar", { name: "Job actions" });
        await user.click(within(toolbar).getByRole("button", { name: "Retry" }));
      };
      try {
        const first = renderJobDetailDrawer(firstAlias, undefined, queryClient);
        await expandDetailSections();
        await user.click(await screen.findByRole("button", { name: "Open screening answers" }));
        await screen.findByRole("region", { name: "Private screening answer library" });
        await waitFor(() => expect(canonicalReads).toBe(1));
        expect(queryClient.getQueryData(canonicalKey)).toBeUndefined();
        const second = renderJobDetailDrawer(secondAlias, undefined, queryClient);
        await retryFrom(first.container);
        await retryFrom(second.container);
        await waitFor(() => expect(retryRequests).toBe(2));
        releaseFirstRetry();
        await waitFor(() => expect(settledRetries()).toBe(1));
        if (ordering === "same-earlier-read") {
          releaseSecondRetry();
          await waitFor(() => expect(settledRetries()).toBe(2));
          expect(queryClient.getQueryData(canonicalKey)).toBeUndefined();
        }
        releaseOldRead();
        await waitFor(() => expect(canonicalReads).toBe(2));
        await waitFor(() => expect(notices()).toHaveLength(1));
        if (ordering === "different-earlier-reads") {
          releaseSecondRetry();
          await waitFor(() => expect(settledRetries()).toBe(2));
          await waitFor(() => expect(notices()).toHaveLength(2));
        }
        releaseFirstConfirmation();
        if (ordering === "different-earlier-reads") {
          await waitFor(() => expect(canonicalReads).toBe(3));
          expect(notices()).toHaveLength(1);
          releaseSecondConfirmation();
        }
        await waitFor(() => expect(notices()).toHaveLength(0));
        first.unmount();
        second.unmount();
        renderJobDetailDrawer(canonical, undefined, queryClient);
        expect(await screen.findByRole("group", { name: "Workflow state" })).toHaveTextContent("Pending");
        expect(screen.queryByText(/stage status may be out of date after this retry/i)).not.toBeInTheDocument();
      } finally {
        releaseFirstRetry();
        releaseSecondRetry();
        releaseOldRead();
        releaseFirstConfirmation();
        releaseSecondConfirmation();
        act(() => useToastStore.getState().clear());
      }
    },
  );

  it.each(["alias-first", "canonical-first"] as const)(
    "rechecks an initially empty active alternate after its earlier read (%s)",
    async (direction) => {
      const alias = "https://example.com/jobs/inflight-alias";
      const canonical = "66666666-6666-4666-8666-666666666666";
      const unrelated = "77777777-7777-4777-8777-777777777777";
      const otherTenant = createTenantId("synthetic-inflight-other-tenant");
      const routeId = direction === "alias-first" ? alias : canonical;
      const nextId = direction === "alias-first" ? canonical : alias;
      const queryClient = createTestQueryClient();
      queryClient.setDefaultOptions({
        queries: { retry: false, staleTime: 30_000, gcTime: Infinity, refetchOnMount: true,
          refetchOnReconnect: false, refetchOnWindowFocus: false },
        mutations: { retry: false },
      });
      const detail = makeJobDetail({
        ...sampleJob, jobKey: canonical, currentStage: "discover", currentSubstage: "discover", currentState: "failed",
      });
      const stage = { ...detail.stages[0]!, stage: "discover" as const, state: "failed" as const, retryable: true };
      const failedDetail = { ...detail, stages: [stage] };
      const pendingDetail = { ...failedDetail, job: { ...detail.job, currentState: "pending" as const },
        stages: [{ ...stage, state: "pending" as const }] };
      const otherDetail = makeJobDetail({ ...sampleJob, jobKey: unrelated });
      const routeKey = jobsKeys.detail(LOCAL_TENANT, routeId);
      const nextKey = jobsKeys.detail(LOCAL_TENANT, nextId);
      const otherKey = jobsKeys.detail(LOCAL_TENANT, unrelated);
      const foreignKey = jobsKeys.detail(otherTenant, nextId);
      queryClient.setQueryData(routeKey, failedDetail);
      queryClient.setQueryData(otherKey, otherDetail);
      queryClient.setQueryData(foreignKey, failedDetail);
      let releaseResponse!: () => void;
      let releaseOldRead!: () => void;
      let releaseConfirmation!: () => void;
      const responseHeld = new Promise<void>((resolve) => { releaseResponse = resolve; });
      const oldReadHeld = new Promise<void>((resolve) => { releaseOldRead = resolve; });
      const confirmationHeld = new Promise<void>((resolve) => { releaseConfirmation = resolve; });
      let requested = false;
      let siblingReads = 0;
      let routeReads = 0;
      let confirmationMode: "held-failure" | "failure" | "success" = "held-failure";
      server.use(
        http.post("*/v1/jobs/:jobKey/material-locales", () => HttpResponse.json({
          supportedLocales: [], variants: [], profileVersion: null, sources: [],
        })),
        http.get("*/v1/jobs/:jobKey", async ({ params }) => {
          if (String(params.jobKey) !== nextId) {
            routeReads += 1;
            return HttpResponse.json(pendingDetail);
          }
          siblingReads += 1;
          if (siblingReads === 1) {
            await oldReadHeld;
            return HttpResponse.json(failedDetail);
          }
          if (confirmationMode === "held-failure") await confirmationHeld;
          return confirmationMode === "success"
            ? HttpResponse.json(pendingDetail)
            : HttpResponse.json({ ok: false, error: "synthetic_readback_failure" }, { status: 503 });
        }),
        http.post("*/v1/jobs/:jobKey/actions/retry-stage", async ({ params, request }) => {
          expect(String(params.jobKey)).toBe(canonical);
          expect(await request.json()).toMatchObject({ stage: "discover", runAfter: false });
          requested = true;
          await responseHeld;
          return HttpResponse.json({ ok: true, action: "retry_stage", status: "reset",
            command: { action: "retry_stage", jobKey: canonical }, stage: { ...stage, state: "pending" } });
        }),
      );
      const user = userEvent.setup();
      try {
        renderJobDetailDrawer(routeId, undefined, queryClient);
        await expandDetailSections();
        await user.click(await screen.findByRole("button", { name: "More job actions" }));
        await user.click(await screen.findByRole("button", { name: "Retry" }));
        await waitFor(() => expect(requested).toBe(true));
        const alternate = renderJobDetailDrawer(nextId, undefined, queryClient);
        await waitFor(() => expect(siblingReads).toBe(1));
        expect(queryClient.getQueryData(nextKey)).toBeUndefined();
        expect(queryClient.getQueryState(nextKey)?.fetchStatus).toBe("fetching");
        releaseResponse();
        await waitFor(() => expect(routeReads).toBeGreaterThan(0));
        releaseOldRead();
        const warning = "The displayed stage status may be out of date after this retry. Refresh Job Detail to confirm the current state.";
        expect(await within(alternate.container).findByText(warning)).toBeVisible();
        await waitFor(() => expect(siblingReads).toBeGreaterThan(1));
        const scope = retryStatusScope(LOCAL_TENANT, canonical, nextId);
        expect(useToastStore.getState().toasts).toContainEqual(expect.objectContaining({ scope }));
        expect(queryClient.getQueryData(nextKey)).toMatchObject({ job: { currentState: "failed" } });
        expect(within(alternate.container).getByRole("group", { name: "Workflow state" })).toHaveTextContent("Failed");
        confirmationMode = "failure";
        releaseConfirmation();
        await waitFor(() => expect(queryClient.getQueryState(nextKey)?.status).toBe("error"));
        expect(within(alternate.container).getByText(warning)).toBeVisible();
        await waitFor(() => expect(within(alternate.container).getByRole("button", { name: "Refresh stage status" })).toBeEnabled());
        confirmationMode = "success";
        await user.click(within(alternate.container).getByRole("button", { name: "Refresh stage status" }));
        await waitFor(() => expect(queryClient.getQueryData(nextKey)).toMatchObject({ job: { currentState: "pending" } }));
        await waitFor(() => expect(useToastStore.getState().toasts).not.toContainEqual(expect.objectContaining({ scope })));
        expect(queryClient.getQueryData(otherKey)).toBe(otherDetail);
        expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
        expect(queryClient.getQueryData(foreignKey)).toBe(failedDetail);
        expect(queryClient.getQueryState(foreignKey)?.isInvalidated).toBe(false);
      } finally {
        releaseResponse();
        releaseOldRead();
        releaseConfirmation();
        act(() => useToastStore.getState().clear());
      }
    },
  );

  it.each([
    { status: "reset", samePublication: false },
    { status: "failed", samePublication: false },
    { status: "unsupported", samePublication: false },
    { status: "failed", samePublication: true },
    { status: "http-error", samePublication: false },
  ] as const)(
    "preserves newer StageStarted state after $status and failed readback (same=$samePublication)",
    async ({ status, samePublication }) => {
      useToastStore.getState().clear();
      const jobId = `job-newer-retry-${status}`;
      const eventStream = new FakeEventStreamPort();
      const user = userEvent.setup();
      let releaseResponse!: () => void;
      const responseHeld = new Promise<void>((resolve) => { releaseResponse = resolve; });
      let mode: "initial" | "newer" | "failed" = "initial";
      let retryRequests = 0;
      const detail = makeJobDetail({
        ...sampleJob,
        jobKey: jobId,
        currentStage: "tailor",
        currentSubstage: "tailor",
        currentState: "failed",
      });
      const stage = { ...detail.stages[0]!, stage: "tailor" as const, state: "failed" as const, retryable: true };
      const newerAttempt = samePublication ? 1 : 4;
      const newerUpdatedAt = samePublication ? stage.updatedAt : "2026-05-03T12:00:00Z";
      server.use(
        http.post("*/v1/jobs/:jobKey/material-locales", () => HttpResponse.json({
          supportedLocales: [], variants: [], profileVersion: null, sources: [],
        })),
        http.get("*/v1/jobs/:jobKey", () => {
          if (mode === "failed") {
            return HttpResponse.json({ ok: false, error: "synthetic_readback_failure" }, { status: 503 });
          }
          const running = mode === "newer";
          return HttpResponse.json({
            ...detail,
            job: { ...detail.job, currentState: running ? "running" : "failed" },
            stages: [{ ...stage, state: running ? "running" : "failed", attemptCount: running ? newerAttempt : 1,
              updatedAt: running ? newerUpdatedAt : stage.updatedAt }],
          });
        }),
        http.post("*/v1/jobs/:jobKey/actions/retry-stage", async ({ request }) => {
          const body = await request.json() as { stage?: string; runAfter?: boolean };
          expect(body).toMatchObject({ stage: "tailor", runAfter: true });
          retryRequests += 1;
          await responseHeld;
          if (status === "http-error") {
            return HttpResponse.json({ ok: false, error: "synthetic_retry_failure" }, { status: 500 });
          }
          return HttpResponse.json({
            ok: true, action: "retry_stage", status,
            command: { action: "retry_stage", jobKey: jobId },
            stage: { ...stage, state: "pending", updatedAt: "2026-05-02T12:00:00Z" },
            ...(status === "reset" ? {} : { message: "Synthetic dispatch failure." }),
          }, { status: status === "reset" ? 200 : 202 });
        }),
      );

      try {
        const { queryClient } = renderJobDetailDrawer(jobId, eventStream);
        await waitFor(() => expect(eventStream.subscriptions).toHaveLength(1));
        await expandDetailSections();
        await user.click(await screen.findByRole("button", { name: "More job actions" }));
        await user.click(await screen.findByRole("button", { name: "Retry" }));
        await waitFor(() => expect(retryRequests).toBe(1));

        const key = jobsKeys.detail(LOCAL_TENANT, jobId);
        const optimistic = queryClient.getQueryData(key);
        const optimisticRevision = queryClient.getQueryState(key)!.dataUpdateCount;
        mode = "newer";
        act(() => eventStream.emit({
          eventType: "StageStarted", tenantId: LOCAL_TENANT,
          payload: { jobId, stage: "tailor", attemptNumber: newerAttempt, startedAt: "2026-05-03T12:00:00Z" },
        }));
        await waitFor(() => expect(queryClient.getQueryState(key)!.dataUpdateCount).toBeGreaterThan(optimisticRevision));
        expect(queryClient.getQueryData(key)).toMatchObject({
          job: { currentState: "running" },
          stages: [{ state: "running", attemptCount: newerAttempt, updatedAt: newerUpdatedAt }],
        });
        if (samePublication) expect(queryClient.getQueryData(key)).toBe(optimistic);
        mode = "failed";
        releaseResponse();
        await waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe("error"));
        expect(queryClient.getQueryData(key)).toMatchObject({
          job: { currentState: "running" },
          stages: [{ state: "running", attemptCount: newerAttempt, updatedAt: newerUpdatedAt }],
        });
        const timeline = screen.getByRole("list", { name: "Preparation stages" });
        expect(within(timeline).getByText("Tailor").closest("li")).toHaveAttribute("data-stage-state", "running");
        expect(screen.getByRole("group", { name: "Workflow state" })).toHaveTextContent(/running/i);
        expect(await screen.findByText("The displayed stage status may be out of date after this retry. Refresh Job Detail to confirm the current state."))
          .toBeVisible();
        if (status === "failed" || status === "unsupported") {
          expect(await screen.findByText("The stage was reset, but the retry could not start. Synthetic dispatch failure."))
            .toBeVisible();
        }
      } finally {
        releaseResponse();
        act(() => useToastStore.getState().clear());
      }
    },
  );

  it.each([
    { recreateQuery: false, finalReadFails: true, precommitInFlight: false },
    { recreateQuery: true, finalReadFails: true, precommitInFlight: false },
    { recreateQuery: false, finalReadFails: false, precommitInFlight: false },
    { recreateQuery: false, finalReadFails: true, precommitInFlight: true },
  ])(
    "shows uncertainty after a pre-commit read (recreated=$recreateQuery, final failure=$finalReadFails, in flight=$precommitInFlight)",
    async ({ recreateQuery, finalReadFails, precommitInFlight }) => {
      useToastStore.getState().clear();
      const jobId = `job-pre-commit-${recreateQuery}`;
      const eventStream = new FakeEventStreamPort();
      const user = userEvent.setup();
      let releaseResponse!: () => void;
      const responseHeld = new Promise<void>((resolve) => { releaseResponse = resolve; });
      let releaseFinalRead!: () => void;
      const finalReadHeld = new Promise<void>((resolve) => { releaseFinalRead = resolve; });
      let releaseOldRead!: () => void;
      const oldReadHeld = new Promise<void>((resolve) => { releaseOldRead = resolve; });
      let mode: "old" | "held-old" | "failed" | "pending" = "old";
      let oldReadStarts = 0;
      let finalReadStarts = 0;
      let retryRequests = 0;
      const detail = makeJobDetail({
        ...sampleJob, jobKey: jobId, currentStage: "discover", currentSubstage: "discover", currentState: "failed",
      });
      const failed = { ...detail.stages[0]!, stage: "discover" as const, state: "failed" as const, retryable: true };
      server.use(
        http.post("*/v1/jobs/:jobKey/material-locales", () => HttpResponse.json({
          supportedLocales: [], variants: [], profileVersion: null, sources: [],
        })),
        http.get("*/v1/jobs/:jobKey", async () => {
          if (mode === "held-old") {
            oldReadStarts += 1;
            await oldReadHeld;
            return HttpResponse.json({ ...detail, stages: [failed] });
          }
          if (mode === "failed") {
            finalReadStarts += 1;
            if (precommitInFlight) await finalReadHeld;
            return HttpResponse.json({ ok: false, error: "synthetic_readback_failure" }, { status: 503 });
          }
          if (mode === "pending") {
            await finalReadHeld;
            return HttpResponse.json({
              ...detail, job: { ...detail.job, currentState: "pending" }, stages: [{ ...failed, state: "pending" }],
            });
          }
          return HttpResponse.json({ ...detail, stages: [failed] });
        }),
        http.post("*/v1/jobs/:jobKey/actions/retry-stage", async ({ request }) => {
          expect(await request.json()).toMatchObject({ stage: "discover", runAfter: false });
          retryRequests += 1;
          await responseHeld;
          return HttpResponse.json({
            ok: true, action: "retry_stage", status: "reset",
            command: { action: "retry_stage", jobKey: jobId },
            stage: { ...failed, state: "pending" },
          });
        }),
      );
      try {
        const view = renderJobDetailDrawer(jobId, eventStream);
        const key = jobsKeys.detail(LOCAL_TENANT, jobId);
        await waitFor(() => expect(eventStream.subscriptions).toHaveLength(1));
        await expandDetailSections();
        await user.click(await screen.findByRole("button", { name: "More job actions" }));
        await user.click(await screen.findByRole("button", { name: "Retry" }));
        await waitFor(() => expect(retryRequests).toBe(1));
        const oldQuery = view.queryClient.getQueryCache().find({ queryKey: key, exact: true });
        if (recreateQuery) {
          view.unmount();
          view.queryClient.removeQueries({ queryKey: key, exact: true });
          renderJobDetailDrawer(jobId, eventStream, view.queryClient);
          await expandDetailSections();
          await waitFor(() => expect(view.queryClient.getQueryCache().find({ queryKey: key, exact: true })).not.toBe(oldQuery));
        } else {
          const revision = view.queryClient.getQueryState(key)!.dataUpdateCount;
          if (precommitInFlight) mode = "held-old";
          act(() => eventStream.emit({
            eventType: "StageFailed", tenantId: LOCAL_TENANT,
            payload: { jobId, stage: "discover", errorCode: "SYNTHETIC", errorMessage: "Old failure", retryable: true, attemptNumber: 1 },
          }));
          if (precommitInFlight) {
            await waitFor(() => expect(oldReadStarts).toBeGreaterThan(0));
          } else {
            await waitFor(() => expect(view.queryClient.getQueryState(key)!.dataUpdateCount).toBeGreaterThan(revision));
          }
        }
        if (!precommitInFlight) {
          await waitFor(() => expect(view.queryClient.getQueryData(key)).toMatchObject({
            job: { currentState: "failed" }, stages: [{ state: "failed" }],
          }));
        }
        mode = finalReadFails ? "failed" : "pending";
        releaseResponse();
        const warning = "The displayed stage status may be out of date after this retry. Refresh Job Detail to confirm the current state.";
        expect(await screen.findByText(warning)).toBeVisible();
        expect(useToastStore.getState().toasts).toContainEqual(expect.objectContaining({ message: warning, durationMs: 0 }));
        if (finalReadFails) {
          if (precommitInFlight) {
            releaseOldRead();
            await waitFor(() => expect(finalReadStarts).toBeGreaterThan(0));
            expect(screen.getByText(warning)).toBeVisible();
            releaseFinalRead();
          }
          await waitFor(() => expect(view.queryClient.getQueryState(key)?.status).toBe("error"));
          const timeline = screen.getByRole("list", { name: "Preparation stages" });
          expect(within(timeline).getByText("Discover").closest("li")).toHaveAttribute("data-stage-state", "failed");
          expect(screen.getByRole("group", { name: "Workflow state" })).toHaveTextContent(/failed/i);
          const refresh = screen.getByRole("button", { name: "Refresh stage status" });
          await waitFor(() => expect(refresh).toBeEnabled());
          const failedReads = finalReadStarts;
          await user.click(refresh);
          await waitFor(() => expect(finalReadStarts).toBeGreaterThan(failedReads));
          await waitFor(() => expect(screen.getByRole("button", { name: "Refresh stage status" })).toBeEnabled());
          expect(screen.getByText(warning)).toBeVisible();
          mode = "pending";
          releaseFinalRead();
          await user.click(screen.getByRole("button", { name: "Refresh stage status" }));
          await waitFor(() => expect(view.queryClient.getQueryData(key)).toMatchObject({
            job: { currentState: "pending" }, stages: [{ state: "pending" }],
          }));
          await waitFor(() => expect(useToastStore.getState().toasts).not.toContainEqual(expect.objectContaining({ message: warning })));
        } else {
          releaseFinalRead();
          await waitFor(() => expect(view.queryClient.getQueryData(key)).toMatchObject({
            job: { currentState: "pending" }, stages: [{ state: "pending" }],
          }));
          await waitFor(() => expect(useToastStore.getState().toasts).not.toContainEqual(expect.objectContaining({ message: warning })));
        }
      } finally {
        releaseResponse();
        releaseOldRead();
        releaseFinalRead();
        act(() => useToastStore.getState().clear());
      }
    },
  );

  it("retains an inactive job's uncertainty until reopening confirms its stage", async () => {
    useToastStore.getState().clear();
    const jobId = "job-inactive-retry";
    const eventStream = new FakeEventStreamPort();
    const user = userEvent.setup();
    let releaseResponse!: () => void;
    const responseHeld = new Promise<void>((resolve) => { releaseResponse = resolve; });
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
    let mode: "old" | "pending" = "old";
    let requests = 0;
    const detail = makeJobDetail({
      ...sampleJob, jobKey: jobId, currentStage: "discover", currentSubstage: "discover", currentState: "failed",
    });
    const stage = { ...detail.stages[0]!, stage: "discover" as const, state: "failed" as const, retryable: true };
    server.use(
      http.post("*/v1/jobs/:jobKey/material-locales", () => HttpResponse.json({
        supportedLocales: [], variants: [], profileVersion: null, sources: [],
      })),
      http.get("*/v1/jobs/:jobKey", async () => {
        if (mode === "pending") {
          await readHeld;
          return HttpResponse.json({ ...detail, job: { ...detail.job, currentState: "pending" }, stages: [{ ...stage, state: "pending" }] });
        }
        return HttpResponse.json({ ...detail, stages: [stage] });
      }),
      http.post("*/v1/jobs/:jobKey/actions/retry-stage", async () => {
        requests += 1;
        await responseHeld;
        return HttpResponse.json({ ok: true, action: "retry_stage", status: "reset",
          command: { action: "retry_stage", jobKey: jobId }, stage: { ...stage, state: "pending" } });
      }),
    );
    try {
      const view = renderJobDetailDrawer(jobId, eventStream);
      const key = jobsKeys.detail(LOCAL_TENANT, jobId);
      await waitFor(() => expect(eventStream.subscriptions).toHaveLength(1));
      await expandDetailSections();
      await user.click(await screen.findByRole("button", { name: "More job actions" }));
      await user.click(await screen.findByRole("button", { name: "Retry" }));
      await waitFor(() => expect(requests).toBe(1));
      const revision = view.queryClient.getQueryState(key)!.dataUpdateCount;
      act(() => eventStream.emit({ eventType: "StageFailed", tenantId: LOCAL_TENANT,
        payload: { jobId, stage: "discover", errorCode: "SYNTHETIC", errorMessage: "Old failure", retryable: true, attemptNumber: 1 } }));
      await waitFor(() => expect(view.queryClient.getQueryState(key)!.dataUpdateCount).toBeGreaterThan(revision));
      view.unmount();
      releaseResponse();
      const warning = "The displayed stage status may be out of date after this retry. Refresh Job Detail to confirm the current state.";
      await waitFor(() => expect(useToastStore.getState().toasts).toContainEqual(expect.objectContaining({ message: warning })));
      mode = "pending";
      renderJobDetailDrawer(jobId, eventStream, view.queryClient);
      expect(await screen.findByText(warning)).toBeVisible();
      releaseRead();
      await waitFor(() => expect(view.queryClient.getQueryData(key)).toMatchObject({
        job: { currentState: "pending" }, stages: [{ state: "pending" }],
      }));
      await waitFor(() => expect(useToastStore.getState().toasts).not.toContainEqual(expect.objectContaining({ message: warning })));
    } finally {
      releaseResponse();
      releaseRead();
      act(() => useToastStore.getState().clear());
    }
  });

  it("keeps retry notices scoped to their job and tenant across navigation", async () => {
    useToastStore.getState().clear();
    const otherTenant = createTenantId("synthetic-other");
    const jobA = "job-scope-a";
    const jobB = "job-scope-b";
    const queryClient = createTestQueryClient();
    const user = userEvent.setup();
    const detailFor = (jobId: string) => makeJobDetail({ ...sampleJob, jobKey: jobId });
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, jobA), detailFor(jobA));
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, jobB), detailFor(jobB));
    queryClient.setQueryData(jobsKeys.detail(otherTenant, jobA), detailFor(jobA));
    const addNotice = (tenantId: TenantId, jobId: string, message: string) => useToastStore.getState().toast({
      variant: "warning", message, durationMs: 0, scope: retryStatusScope(tenantId, jobId),
    });
    const noticeA = addNotice(LOCAL_TENANT, jobA, "Synthetic job A needs confirmation.");
    const noticeB = addNotice(LOCAL_TENANT, jobB, "Synthetic job B needs confirmation.");
    const noticeOther = addNotice(otherTenant, jobA, "Synthetic other tenant needs confirmation.");
    let mode: "fail" | "success" = "fail";
    server.use(http.get("*/v1/jobs/:jobKey", ({ params }) => mode === "fail"
      ? HttpResponse.json({ ok: false, error: "synthetic_readback_failure" }, { status: 503 })
      : HttpResponse.json(detailFor(String(params.jobKey)))));
    try {
      const first = renderJobDetailDrawer(jobA, undefined, queryClient);
      expect(await screen.findByText("Synthetic job A needs confirmation.")).toBeVisible();
      expect(screen.queryByText("Synthetic job B needs confirmation.")).not.toBeInTheDocument();
      expect(screen.queryByText("Synthetic other tenant needs confirmation.")).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "Refresh stage status" })).toBeEnabled());
      first.unmount();

      const second = renderJobDetailDrawer(jobB, undefined, queryClient);
      expect(await screen.findByText("Synthetic job B needs confirmation.")).toBeVisible();
      expect(screen.queryByText("Synthetic job A needs confirmation.")).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "Refresh stage status" })).toBeEnabled());
      mode = "success";
      await user.click(screen.getByRole("button", { name: "Refresh stage status" }));
      await waitFor(() => expect(useToastStore.getState().toasts.some((entry) => entry.id === noticeB)).toBe(false));
      expect(useToastStore.getState().toasts.map((entry) => entry.id)).toEqual(expect.arrayContaining([noticeA, noticeOther]));
      second.unmount();

      mode = "fail";
      const third = renderJobDetailDrawer(jobA, undefined, queryClient, otherTenant);
      expect(await screen.findByText("Synthetic other tenant needs confirmation.")).toBeVisible();
      expect(screen.queryByText("Synthetic job A needs confirmation.")).not.toBeInTheDocument();
      third.unmount();
      renderJobDetailDrawer(jobA, undefined, queryClient);
      expect(await screen.findByText("Synthetic job A needs confirmation.")).toBeVisible();
      expect(useToastStore.getState().toasts.some((entry) => entry.id === noticeOther)).toBe(true);
    } finally {
      act(() => useToastStore.getState().clear());
      queryClient.clear();
    }
  });

  it("does not confirm a retry when the locator resolves to a different canonical job", async () => {
    const alias = "https://example.com/jobs/reassigned-alias";
    const canonical = "job-original";
    const otherJob = "job-reassigned";
    const queryClient = createTestQueryClient();
    const key = jobsKeys.detail(LOCAL_TENANT, alias);
    const detailFor = (jobKey: string) => makeJobDetail({ ...sampleJob, jobKey });
    queryClient.setQueryData(key, detailFor(canonical));
    const scope = retryStatusScope(LOCAL_TENANT, canonical, alias);
    const noticeId = useToastStore.getState().toast({
      variant: "warning", message: "Synthetic retry needs confirmation.", durationMs: 0, scope,
    });
    let resolvedJob = otherJob;
    server.use(http.get("*/v1/jobs/:jobKey", () => HttpResponse.json(detailFor(resolvedJob))));
    try {
      renderJobDetailDrawer(alias, undefined, queryClient);
      await waitFor(() => expect(queryClient.getQueryData(key)).toMatchObject({ job: { jobKey: otherJob } }));
      expect(useToastStore.getState().toasts.some((entry) => entry.id === noticeId)).toBe(true);
      resolvedJob = canonical;
      await act(async () => { await queryClient.invalidateQueries({ queryKey: key, exact: true }); });
      await waitFor(() => expect(useToastStore.getState().toasts.some((entry) => entry.id === noticeId)).toBe(false));
    } finally {
      act(() => useToastStore.getState().clear());
      queryClient.clear();
    }
  });
});
