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
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import type {
  EvidenceMapEntry,
  EvidenceUsageRef,
} from "../../contexts/operations/types.js";
import { artifactsSearchSchema } from "../../routes/-artifacts.search.js";
import { evidenceMapSearchSchema } from "../../routes/-evidence-map.search.js";
import { jobsSearchSchema } from "../../routes/-jobs.search.js";
import { sampleEvidenceMapResponse } from "../../test/fixtures/projections.js";
import { buildProviderHarness } from "../../test/render.js";
import { server } from "../../test/msw/server.js";
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

function sparseLabelEntry(): EvidenceMapEntry {
  const entry = sampleEvidenceMapResponse.entries[0];
  const resumeUsage = entry?.resumeUsages[0];
  const requirementUsage = entry?.requirementUsages[0];
  const coverageUsage = sampleEvidenceMapResponse.entries[1]?.coverageUsages[0];
  if (!entry || !resumeUsage || !requirementUsage || !coverageUsage) {
    throw new Error("Evidence Map fixture must include every usage kind");
  }
  return {
    ...entry,
    resumeUsages: [
      {
        ...resumeUsage,
        jobKey: "job-storage-key-7",
        jobTitle: null,
        employer: "Acme Robotics",
        generatedTextPreview: null,
        bulletId: "experience:legacy#7",
      },
    ],
    requirementUsages: [
      {
        ...requirementUsage,
        jobKey: "job-storage-key-7",
        jobTitle: null,
        employer: null,
        requirementId: "req-storage-17",
        requirementText: null,
      },
    ],
    coverageUsages: [
      {
        ...coverageUsage,
        jobKey: "job-storage-key-7",
        jobTitle: null,
        employer: null,
        keyword: null,
      },
    ],
  };
}

describe("<EvidenceMapView>", () => {
  it("renders career evidence, gaps, and links usage back to artifacts and jobs", async () => {
    const { container } = renderEvidenceMap();

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
    expect(within(artifactLink).getByText("artifact")).not.toHaveAttribute(
      "data-slot",
      "status-badge",
    );

    const requirementLinks = screen.getAllByRole("link", {
      name: /Own platform reliability and observability programs/i,
    });
    const requirementLink = requirementLinks[0];
    expect(requirementLink).toBeDefined();
    if (!requirementLink) {
      throw new Error("Expected a requirement usage link");
    }
    expect(requirementLink).toHaveAttribute("href", "/jobs/job-1");
    expect(within(requirementLink).getByText("matched")).toHaveAttribute(
      "data-slot",
      "status-badge",
    );
    expect(screen.getByText("42% faster incident response")).not.toHaveAttribute(
      "data-slot",
      "status-badge",
    );
    expect(screen.getByText("2024-2025")).not.toHaveAttribute(
      "data-slot",
      "status-badge",
    );
    expect(container.querySelectorAll(".evidence-map-view .tag")).toHaveLength(0);
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

  it("renders transferable fit as a flat semantic status instead of a legacy pill", async () => {
    const entry = sampleEvidenceMapResponse.entries[0];
    const matchedUsage = entry?.requirementUsages[0];
    if (!entry || !matchedUsage) {
      throw new Error("Evidence Map fixture must include a requirement usage");
    }
    const transferableUsage: EvidenceUsageRef = {
      ...matchedUsage,
      requirementId: "req-transferable-platform-experience",
      requirementText: "Translate platform reliability experience",
      requirementFitKind: "transferable",
    };
    server.use(
      http.get("*/v1/evidence-map", () =>
        HttpResponse.json({
          ...sampleEvidenceMapResponse,
          entries: [
            { ...entry, requirementUsages: [...entry.requirementUsages, transferableUsage] },
            ...sampleEvidenceMapResponse.entries.slice(1),
          ],
        }),
      ),
    );

    const { container } = renderEvidenceMap();

    const transferableBadge = await screen.findByText("transferable");
    expect(transferableBadge).toHaveAttribute("data-slot", "status-badge");
    expect(transferableBadge).toHaveAttribute("data-status-tone", "info");
    expect(transferableBadge).not.toHaveClass("tag");
    expect(transferableBadge.closest("a")).toHaveAttribute("href", "/jobs/job-1");
    expect(container.querySelectorAll(".evidence-map-view .tag")).toHaveLength(0);
  });

  it("keeps sparse storage identifiers out of human labels while retaining technical access", async () => {
    server.use(
      http.get("*/v1/evidence-map", () =>
        HttpResponse.json({
          ...sampleEvidenceMapResponse,
          entries: [sparseLabelEntry()],
          gaps: [],
        }),
      ),
    );
    const user = userEvent.setup();
    renderEvidenceMap();

    const resumeLink = await screen.findByRole("link", {
      name: /Role at Acme Robotics · Resume bullet/i,
    });
    const requirementLink = screen.getByRole("link", {
      name: /Job · Requirement/i,
    });
    const coverageLink = screen.getByRole("link", {
      name: /Job · Skill coverage/i,
    });

    expect(resumeLink).toHaveAttribute("href", "/artifacts/artifact-resume-1");
    expect(requirementLink).toHaveAttribute("href", "/jobs/job-storage-key-7");
    expect(coverageLink).toHaveAttribute("href", "/jobs/job-storage-key-7");
    for (const link of [resumeLink, requirementLink, coverageLink]) {
      expect(link).not.toHaveAccessibleName(/job-storage-key-7|experience:legacy#7/i);
    }

    const resumeUsage = resumeLink.closest("li");
    expect(resumeUsage).not.toBeNull();
    if (!resumeUsage) {
      throw new Error("Expected resume usage row");
    }
    await user.click(within(resumeUsage).getByRole("button", { name: "Technical details" }));
    expect(within(resumeUsage).getByText("job-storage-key-7")).toBeInTheDocument();
    expect(within(resumeUsage).getByText("experience:legacy#7")).toBeInTheDocument();
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
