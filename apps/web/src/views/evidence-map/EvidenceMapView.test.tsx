import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { artifactsSearchSchema } from "../../routes/-artifacts.search.js";
import { evidenceMapSearchSchema } from "../../routes/-evidence-map.search.js";
import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { buildProviderHarness } from "../../test/render.js";
import { EvidenceMapView } from "./EvidenceMapView.js";

function renderEvidenceMap(initialEntry = "/evidence-map") {
  const harness = buildProviderHarness();
  const root = createRootRoute({ component: () => <Outlet /> });
  const evidenceMap = createRoute({
    getParentRoute: () => root,
    path: "/evidence-map",
    validateSearch: (search) => evidenceMapSearchSchema.parse(search),
    component: EvidenceMapView,
  });
  const artifacts = createRoute({
    getParentRoute: () => root,
    path: "/artifacts",
    validateSearch: (search) => artifactsSearchSchema.parse(search),
    component: () => <Outlet />,
  });
  const artifactDetail = createRoute({
    getParentRoute: () => artifacts,
    path: "$artifactId",
    component: () => null,
  });
  const jobs = createRoute({
    getParentRoute: () => root,
    path: "/jobs",
    validateSearch: (search) => jobsSearchSchema.parse(search),
    component: () => <Outlet />,
  });
  const jobDetail = createRoute({
    getParentRoute: () => jobs,
    path: "$jobId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      evidenceMap,
      artifacts.addChildren([artifactDetail]),
      jobs.addChildren([jobDetail]),
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return {
    router,
    ...render(<RouterProvider router={router} />, { wrapper: harness.Wrapper }),
  };
}

describe("<EvidenceMapView>", () => {
  it("renders career evidence, gaps, and links usage back to artifacts and jobs", async () => {
    renderEvidenceMap();

    expect(
      await screen.findByRole("heading", { name: "Career evidence map" }),
    ).toBeInTheDocument();
    expect(
      await screen.findAllByText("Reduced incident response time through platform automation"),
    ).not.toHaveLength(0);
    expect(await screen.findByText("Operate Kubernetes clusters in production")).toBeInTheDocument();

    const artifactLink = screen.getByRole("link", {
      name: /Led automation that reduced incident response time by 42%/i,
    });
    expect(artifactLink).toHaveAttribute("href", "/artifacts/artifact-resume-1");

    const requirementLinks = screen.getAllByRole("link", {
      name: /Own platform reliability and observability programs/i,
    });
    expect(requirementLinks[0]).toHaveAttribute("href", "/jobs/job-1");
  });

  it("filters entries through URL search while preserving the detail panel", async () => {
    const user = userEvent.setup();
    renderEvidenceMap();

    const searchInput = await screen.findByLabelText("Search evidence");
    await user.clear(searchInput);
    await user.type(searchInput, "backend");

    await waitFor(() => {
      expect(searchInput).toHaveValue("backend");
    });
    const entryList = screen.getByRole("navigation", { name: "Evidence entries" });
    expect(within(entryList).getByRole("link", { name: /Python/i })).toBeInTheDocument();
    expect(
      within(entryList).queryByRole("link", {
        name: /Reduced incident response time through platform automation/i,
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Python" })).toBeInTheDocument();
  });

  it("opens with a job filter from a job-detail deep link", async () => {
    renderEvidenceMap("/evidence-map?job=job-1");

    expect(await screen.findByRole("link", { name: "Clear job filter" })).toHaveAttribute(
      "href",
      "/evidence-map?job=&q=&entry=",
    );
    expect(await screen.findByText("Operate Kubernetes clusters in production")).toBeInTheDocument();
  });
});
