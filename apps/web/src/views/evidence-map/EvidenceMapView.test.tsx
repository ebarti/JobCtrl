import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

function longExcerptEntry(): EvidenceMapEntry {
  const entry = sampleEvidenceMapResponse.entries[0];
  const requirementUsage = entry?.requirementUsages[0];
  if (!entry || !requirementUsage) {
    throw new Error("Evidence Map fixture must include a requirement usage");
  }
  const excerpt = [
    "Own platform reliability and observability programs across a multi-region estate,",
    "including incident response, service ownership, operational readiness, and",
    "measured resilience improvements for every critical customer-facing workflow.",
  ].join(" ");
  return {
    ...entry,
    requirementUsages: [{ ...requirementUsage, requirementText: excerpt }],
  };
}

describe("<EvidenceMapView>", () => {
  it("renders career evidence, gaps, and links usage back to artifacts and jobs", async () => {
    const { container } = renderEvidenceMap();

    expect(
      await screen.findByRole("heading", { name: "Career evidence map" }),
    ).toBeInTheDocument();
    expect(
      await screen.findAllByText(
        "Reduced incident response time through platform automation",
      ),
    ).not.toHaveLength(0);
    expect(
      await screen.findByText("Operate Kubernetes clusters in production"),
    ).toBeInTheDocument();

    const artifactLink = screen.getByRole("link", {
      name: /Led automation that reduced incident response time by 42%/i,
    });
    expect(artifactLink).toHaveAttribute(
      "href",
      "/artifacts/artifact-resume-1",
    );
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
    expect(
      screen.getByText("42% faster incident response"),
    ).not.toHaveAttribute("data-slot", "status-badge");
    expect(screen.getByText("2024-2025")).not.toHaveAttribute(
      "data-slot",
      "status-badge",
    );
    expect(container.querySelectorAll(".evidence-map-view .tag")).toHaveLength(
      0,
    );
    expect(container.querySelectorAll(".evidence-map-view .tab")).toHaveLength(
      0,
    );
    expect(screen.getByLabelText("Search evidence")).toHaveAttribute(
      "data-slot",
      "input",
    );
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
    const entryList = screen.getByRole("navigation", {
      name: "Evidence entries",
    });
    expect(
      within(entryList).getByRole("link", { name: /Python/i }),
    ).toBeInTheDocument();
    expect(
      within(entryList).queryByRole("link", {
        name: /Reduced incident response time through platform automation/i,
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Python" })).toBeInTheDocument();
  });

  it("provides an accessible mobile drill-in and opens details when evidence is selected", async () => {
    renderEvidenceMap();

    const switcher = await screen.findByRole("group", {
      name: "Evidence map view",
      hidden: true,
    });
    const evidenceButton = within(switcher).getByRole("button", {
      name: /Evidence \(/,
      hidden: true,
    });
    const detailsButton = within(switcher).getByRole("button", {
      name: "Details",
      hidden: true,
    });
    const gapsButton = within(switcher).getByRole("button", {
      name: /Gaps \(/,
      hidden: true,
    });

    expect(evidenceButton).toHaveAttribute("aria-pressed", "true");
    expect(detailsButton).toHaveAttribute("aria-pressed", "false");

    const entry = await within(
      screen.getByRole("navigation", { name: "Evidence entries" }),
    ).findByRole("link", {
      name: /Reduced incident response time through platform automation/i,
    });
    fireEvent.click(entry);

    await waitFor(() =>
      expect(detailsButton).toHaveAttribute("aria-pressed", "true"),
    );
    expect(
      document.querySelector(".evidence-entry-link[aria-current='page']"),
    ).not.toBeNull();
    expect(
      document.querySelector("#evidence-map-details-panel"),
    ).toHaveAttribute("data-mobile-active", "true");

    fireEvent.click(gapsButton);
    expect(gapsButton).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector("#evidence-map-gaps-panel")).toHaveAttribute(
      "data-mobile-active",
      "true",
    );
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
            {
              ...entry,
              requirementUsages: [
                ...entry.requirementUsages,
                transferableUsage,
              ],
            },
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
    expect(transferableBadge.closest("a")).toHaveAttribute(
      "href",
      "/jobs/job-1",
    );
    expect(container.querySelectorAll(".evidence-map-view .tag")).toHaveLength(
      0,
    );
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
      expect(link).not.toHaveAccessibleName(
        /job-storage-key-7|experience:legacy#7/i,
      );
    }

    const resumeUsage = resumeLink.closest("li");
    expect(resumeUsage).not.toBeNull();
    if (!resumeUsage) {
      throw new Error("Expected resume usage row");
    }
    await user.click(
      within(resumeUsage).getByRole("button", { name: "Technical details" }),
    );
    expect(
      within(resumeUsage).getByText("job-storage-key-7"),
    ).toBeInTheDocument();
    expect(
      within(resumeUsage).getByText("experience:legacy#7"),
    ).toBeInTheDocument();
  });

  it("keeps the visible evidence summary to decision-relevant statuses and discloses audit metadata", async () => {
    renderEvidenceMap();

    const detail = await screen.findByRole("complementary", {
      name: "Reduced incident response time through platform automation",
    });
    const summary = detail.querySelector("header");
    expect(summary).not.toBeNull();
    if (!summary) {
      throw new Error("Expected evidence detail summary");
    }
    expect(summary.querySelectorAll("[data-slot='status-badge']")).toHaveLength(
      2,
    );
    expect(summary).not.toHaveTextContent("96%");

    await userEvent
      .setup()
      .click(within(detail).getByRole("button", { name: "Technical details" }));
    expect(within(detail).getByText("Claim confidence")).toBeInTheDocument();
    expect(within(detail).getByText("96%")).toBeInTheDocument();
    for (const identifier of within(detail).getAllByText(
      "ev-platform-reliability",
    )) {
      expect(identifier.parentElement).toHaveAttribute(
        "data-typography",
        "code",
      );
    }
  });

  it("clamps long evidence excerpts while retaining an explicit full-text disclosure", async () => {
    const entry = longExcerptEntry();
    const excerpt = entry.requirementUsages[0]?.requirementText;
    if (!excerpt) {
      throw new Error("Long evidence fixture must include an excerpt");
    }
    server.use(
      http.get("*/v1/evidence-map", () =>
        HttpResponse.json({ ...sampleEvidenceMapResponse, entries: [entry] }),
      ),
    );
    const user = userEvent.setup();
    renderEvidenceMap();

    const detail = await screen.findByRole("complementary", {
      name: "Reduced incident response time through platform automation",
    });
    const clampedSubject = Array.from(
      detail.querySelectorAll(".evidence-usage-subject"),
    ).find((element) => element.textContent?.includes("multi-region estate"));
    expect(clampedSubject).toHaveAttribute("data-clamped", "true");

    const discloseExcerpt = within(detail).getByRole("button", {
      name: "View full excerpt",
    });
    await user.click(discloseExcerpt);
    expect(
      within(
        discloseExcerpt.closest("[data-slot='collapsible']") as HTMLElement,
      ).getByText(excerpt),
    ).toBeInTheDocument();
  });

  it("opens with a job filter from a job-detail deep link", async () => {
    renderEvidenceMap("/evidence-map?job=job-1");

    expect(
      await screen.findByRole("link", { name: "Clear job filter" }),
    ).toHaveAttribute("href", "/evidence-map?job=&q=&entry=");
    expect(
      await screen.findByText("Operate Kubernetes clusters in production"),
    ).toBeInTheDocument();
  });
});
