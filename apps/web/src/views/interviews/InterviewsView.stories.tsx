import type { Meta, StoryObj } from "@storybook/react-vite";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { http, HttpResponse } from "msw";
import { useMemo } from "react";
import { interviewsSearchSchema } from "../../routes/-interviews.search.js";
import { makeQuestionPrep } from "../../test/fixtures/interviews.js";
import { makeJobDetail, sampleInterviewPrep } from "../../test/fixtures/projections.js";
import { handlers } from "../../test/msw/handlers.js";
import { InterviewsView } from "./InterviewsView.js";

const meta = {
  title: "Views/Interviews/InterviewsView",
  component: InterviewsView,
  tags: ["interview993"],
} satisfies Meta<typeof InterviewsView>;
export default meta;
type Story = StoryObj<typeof meta>;
function Host({ path = "/interviews?card=B11" }: { readonly path?: string }) {
  const router = useMemo(() => {
    const root = createRootRoute({ component: () => <main><Outlet /></main> });
    const interviews = createRoute({ getParentRoute: () => root, path: "/interviews", validateSearch: (search) => interviewsSearchSchema.parse(search), component: InterviewsView });
    const jobs = createRoute({ getParentRoute: () => root, path: "/jobs", component: () => <Outlet /> });
    const job = createRoute({ getParentRoute: () => jobs, path: "$jobId", component: () => null });
    const evidence = createRoute({ getParentRoute: () => root, path: "/evidence-map", component: () => null });
    return createRouter({ routeTree: root.addChildren([interviews, jobs.addChildren([job]), evidence]), history: createMemoryHistory({ initialEntries: [path] }) });
  }, [path]);
  return <RouterProvider router={router} />;
}
export const Library: Story = { render: () => <Host /> };
export const Graph: Story = { render: () => <Host path="/interviews?card=B11&mode=graph" /> };
export const RangeFirst: Story = { render: () => <Host path="/interviews?card=C07" /> };
export const Retired: Story = { render: () => <Host path="/interviews?card=C08" /> };
export const EmptySearch: Story = { render: () => <Host path="/interviews?q=no-question-matches-this-text" /> };
const prep = { ...makeQuestionPrep(), staleReasons: ["profile_changed" as const] };
export const PreparationAndStaleHistory: Story = {
  parameters: { msw: { handlers: [
    http.get("*/v1/jobs/job-1", () => HttpResponse.json(makeJobDetail(undefined, { interviewPrep: prep }))),
    http.get("*/v1/jobs/job-1/interview-prep/history", () => HttpResponse.json({ ok: true, jobId: "job-1", generations: [prep, { ...sampleInterviewPrep, status: "superseded" }], page: 1, pageSize: 20, total: 2 })),
    ...handlers,
  ] } }, render: () => <Host path="/interviews?card=B11&job=job-1" />,
};
export const CatalogError: Story = { parameters: { msw: { handlers: [http.get("*/v1/interviews/catalog", () => HttpResponse.json({ ok: false, error: "catalog_unavailable" }, { status: 503 })), ...handlers] } }, render: () => <Host /> };
