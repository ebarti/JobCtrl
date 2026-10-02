import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { axe } from "jest-axe";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useInterviewDraftStore } from "../../contexts/materials/stores/interview-drafts.js";
import { interviewsSearchSchema } from "../../routes/-interviews.search.js";
import { sampleInterviewCatalogResponse, makeQuestionPrep } from "../../test/fixtures/interviews.js";
import { makeJobDetail, sampleInterviewPrep } from "../../test/fixtures/projections.js";
import { buildProviderHarness } from "../../test/render.js";
import { buildTestPorts } from "../../test/testPorts.js";
import { server } from "../../test/msw/server.js";
import { InterviewsView } from "./InterviewsView.js";

function renderInterviews(initialEntry = "/interviews?card=B11", ports = buildTestPorts()) {
  const harness = buildProviderHarness({ ports });
  const root = createRootRoute({ component: () => <main><Outlet /></main> });
  const interviews = createRoute({ getParentRoute: () => root, path: "/interviews", validateSearch: (search) => interviewsSearchSchema.parse(search), component: InterviewsView });
  const jobs = createRoute({ getParentRoute: () => root, path: "/jobs", component: () => <Outlet /> });
  const job = createRoute({ getParentRoute: () => jobs, path: "$jobId", component: () => null });
  const evidence = createRoute({ getParentRoute: () => root, path: "/evidence-map", component: () => null });
  const router = createRouter({ routeTree: root.addChildren([interviews, jobs.addChildren([job]), evidence]), history: createMemoryHistory({ initialEntries: [initialEntry] }) });
  return { router, ...render(<RouterProvider router={router} />, { wrapper: harness.Wrapper }) };
}

beforeEach(() => useInterviewDraftStore.setState({ selections: new Map(), notes: new Map() }));

describe("native interview library", () => {
  it("browses all 121 authored questions with attribution and no job/provider read", async () => {
    const job = vi.fn(async () => { throw new Error("Offline library must not query a job"); });
    renderInterviews("/interviews?card=B11", buildTestPorts({ api: { job } }));
    const catalog = sampleInterviewCatalogResponse.catalog;
    await screen.findByRole("heading", { name: catalog.questions.find((card) => card.id === "B11")!.title });
    expect(within(screen.getByRole("navigation", { name: "Interview questions" })).getAllByRole("link")).toHaveLength(121);
    expect(screen.getAllByText(/B11 · .*principle/).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Acceptable alternatives" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sources and reading limits" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Draft answer criteria" })).toBeInTheDocument();
    expect(job).not.toHaveBeenCalled();
  });

  it("keeps filters and graph connections in the URL and exposes equal keyboard actions", async () => {
    const user = userEvent.setup();
    const { router } = renderInterviews();
    await screen.findByRole("heading", { name: "Draft answer criteria" });
    await user.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByRole("region", { name: "Question connections" })).toHaveTextContent("Author/source attribution");
    expect(router.state.location.search["mode"]).toBe("graph");
    await user.type(screen.getByRole("textbox", { name: "Search questions" }), "C07");
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Interview questions" })).getAllByRole("link")).toHaveLength(1));
    expect(router.state.location.search["q"]).toBe("C07");
    expect(screen.getByRole("heading", { name: "Answer guidance" }).parentElement).toHaveTextContent(/range/i);
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await user.click(within(screen.getByRole("navigation", { name: "Interview questions" })).getByRole("link", { name: /TS09/ }));
    expect(screen.getAllByText(/TS09 · .*principle/).length).toBeGreaterThan(0);
  });

  it("shows retired C08 explicitly and has no serious or critical accessibility violations", async () => {
    const view = renderInterviews("/interviews?card=C08");
    await screen.findByRole("heading", { name: "C08 is retired" });
    expect(screen.queryByRole("button", { name: "Generate selected preparation" })).not.toBeInTheDocument();
    const result = await axe(view.container);
    expect(result.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
  });

  it("preserves context, ordered selection and accepted prep during failed generation", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/v1/jobs/job-1", () => HttpResponse.json(makeJobDetail(undefined, { interviewPrep: sampleInterviewPrep }))),
      http.post("*/v1/jobs/job-1/actions/generate-interview-prep", () => HttpResponse.json({ ok: false, error: "provider_failed" }, { status: 503 })),
    );
    const view = renderInterviews("/interviews?card=B11&job=job-1");
    await screen.findByRole("button", { name: "Add question to preparation" });
    await user.click(screen.getByRole("button", { name: "Add question to preparation" }));
    await user.type(screen.getByRole("textbox", { name: "Known interview criteria (one per line)" }), "Explain tradeoffs");
    await user.click(within(screen.getByRole("navigation", { name: "Interview questions" })).getByRole("link", { name: /TS09/ }));
    await user.click(screen.getByRole("button", { name: "Add question to preparation" }));
    await user.click(screen.getByRole("button", { name: "Move TS09 earlier" }));
    await user.click(screen.getByRole("button", { name: "Generate selected preparation" }));
    await screen.findByText(/Preparation failed:/);
    expect(screen.getByRole("textbox", { name: "Known interview criteria (one per line)" })).toHaveValue("Explain tradeoffs");
    expect(screen.getAllByText(sampleInterviewPrep.items[0]!.generatedText)).not.toHaveLength(0);
    expect(within(screen.getByRole("list", { name: "Selected question order" })).getAllByRole("listitem")[0]).toHaveTextContent(sampleInterviewCatalogResponse.catalog.questions.find((card) => card.id === "TS09")!.title);
    const result = await axe(view.container);
    expect(result.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
  });

  it("renders format-appropriate outline, missing evidence and retained versions with stale history", async () => {
    const prep = { ...makeQuestionPrep(), staleReasons: ["profile_changed" as const] };
    server.use(
      http.get("*/v1/jobs/job-1", () => HttpResponse.json(makeJobDetail(undefined, { interviewPrep: prep }))),
      http.get("*/v1/jobs/job-1/interview-prep/history", () => HttpResponse.json({ ok: true, jobId: "job-1", generations: [prep, { ...sampleInterviewPrep, status: "superseded" }], page: 1, pageSize: 20, total: 2 })),
    );
    renderInterviews("/interviews?card=B11&job=job-1");
    await screen.findAllByText("What did you personally own?");
    expect(screen.getAllByText("principle answer", { exact: false })).not.toHaveLength(0);
    expect(screen.getAllByText(/Preparation inputs have changed/)).not.toHaveLength(0);
    expect(screen.getByText(/Generation 1 · superseded/)).toBeInTheDocument();
    expect(screen.getAllByText(/Generation-time inputs and versions/)).not.toHaveLength(0);
  });

  it("shows canonical accepted history when a job projection has not caught up", async () => {
    const prep = makeQuestionPrep();
    server.use(
      http.get("*/v1/jobs/job-1", () => HttpResponse.json(makeJobDetail(undefined, { interviewPrep: null }))),
      http.get("*/v1/jobs/job-1/interview-prep/history", () => HttpResponse.json({ ok: true, jobId: "job-1", generations: [{ ...sampleInterviewPrep, generation: 3, status: "failed" }, prep], page: 1, pageSize: 20, total: 2 })),
    );
    renderInterviews("/interviews?card=B11&job=job-1");
    await screen.findAllByText("What did you personally own?");
    expect(screen.queryByText("No interview prep generated.")).not.toBeInTheDocument();
    expect(screen.getByText(/Generation 3 · failed/)).toBeInTheDocument();
  });
});
