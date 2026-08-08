import { LOCAL_TENANT } from "@jobctrl/domain-types";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { routeTree } from "../routeTree.gen.js";
import { buildProviderHarness } from "../test/render.js";

vi.mock("../shared/ui/PdfPreviewViewer.js", () => ({
  PdfPreviewViewer: ({ title }: { title: string }) => <div>{title}</div>,
}));

function renderRoute(initialEntry: string) {
  const harness = buildProviderHarness({ withEventStream: true });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    context: {
      ports: harness.ports,
      queryClient: harness.queryClient,
      tenantId: LOCAL_TENANT,
    },
  });

  render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });
}

describe("list and detail route composition", () => {
  it.each([
    {
      initialEntry: "/jobs/job-1?stage=apply&page=2",
      workspaceName: "Job details",
      listHeading: "Jobs",
    },
    {
      initialEntry: "/artifacts/artifact-1?q=platform&page=2",
      workspaceName: "Artifact details",
      listHeading: "Artifacts",
    },
    {
      initialEntry: "/outreach/contact-1?employer=Acme",
      workspaceName: "Contact details",
      listHeading: "Contacts",
    },
    {
      initialEntry: "/runs/run-pipeline-1?status=failed&page=2",
      workspaceName: "Workflow run details",
      listHeading: "Workflow runs",
    },
    {
      initialEntry: "/jobs/job-1/run/run-pipeline-1?stage=apply&page=2",
      workspaceName: "Apply run details",
      listHeading: "Jobs",
    },
  ])(
    "renders only the $workspaceName workspace at its detail route",
    async ({ initialEntry, workspaceName, listHeading }) => {
      renderRoute(initialEntry);

      expect(
        await screen.findByRole("article", { name: workspaceName }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { level: 1, name: listHeading }),
      ).not.toBeInTheDocument();
    },
  );

  it.each([
    { initialEntry: "/jobs?stage=apply&page=2", listHeading: "Jobs" },
    {
      initialEntry: "/artifacts?q=platform&page=2",
      listHeading: "Artifacts",
    },
    {
      initialEntry: "/outreach?employer=Acme",
      listHeading: "Contacts",
    },
    {
      initialEntry: "/runs?status=failed&page=2",
      listHeading: "Workflow runs",
    },
  ])(
    "renders the $listHeading collection at its index route",
    async ({ initialEntry, listHeading }) => {
      renderRoute(initialEntry);

      expect(
        await screen.findByRole("heading", { level: 1, name: listHeading }),
      ).toBeInTheDocument();
    },
  );

  it("bypasses the job workspace when rendering a nested apply run", async () => {
    renderRoute("/jobs/job-1/run/run-pipeline-1?stage=apply&page=2");

    expect(
      await screen.findByRole("article", { name: "Apply run details" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("article", { name: "Job details" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a job-scoped activity route on event details with a separate job link", async () => {
    renderRoute("/activity/evt-1");

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Job scored 8/10",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open related job" }),
    ).toHaveAttribute("href", "/jobs/job-1");
    expect(
      screen.queryByRole("article", { name: "Job details" }),
    ).not.toBeInTheDocument();
  });
});
