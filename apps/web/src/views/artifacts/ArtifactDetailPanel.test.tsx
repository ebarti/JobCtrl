import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { artifactsSearchSchema } from "../../routes/-artifacts.search.js";
import { buildProviderHarness } from "../../test/render.js";
import { sampleArtifact } from "../../test/fixtures/projections.js";
import { ArtifactDetailPanel } from "./ArtifactDetailPanel.js";

vi.mock("../../shared/ui/PdfPreviewViewer.js", () => ({
  PdfPreviewViewer: ({ title, url }: { title: string; url: string }) => (
    <div>
      <span>{title}</span>
      <span>{url}</span>
    </div>
  ),
}));

function renderArtifactRoute(children: ReactNode, status = "approved") {
  const artifact = {
    ...sampleArtifact,
    artifactId: "artifact-preview",
    type: "resume_pdf",
    status,
    localPath: "/tmp/artifact-preview.pdf",
    sizeBytes: 1234,
  };
  const ports = buildProviderHarness().ports;
  const artifactPreviewPdfUrl = vi.fn(() => "/v1/artifacts/artifact-preview/preview.pdf?v=test");
  const harness = buildProviderHarness({
    ports: {
      ...ports,
      api: Object.assign(Object.create(Object.getPrototypeOf(ports.api)), ports.api, {
        artifact: vi.fn(async () => ({ ok: true as const, artifact })),
        artifactPreviewPdfUrl,
      }),
    },
  });

  const root = createRootRoute({ component: () => <Outlet /> });
  const artifacts = createRoute({
    getParentRoute: () => root,
    path: "/artifacts",
    validateSearch: (search) => artifactsSearchSchema.parse(search),
    component: () => <Outlet />,
  });
  const artifactDetail = createRoute({
    getParentRoute: () => artifacts,
    path: "$artifactId",
    component: () => <>{children}</>,
  });
  const router = createRouter({
    routeTree: root.addChildren([artifacts.addChildren([artifactDetail])]),
    history: createMemoryHistory({ initialEntries: ["/artifacts/artifact-preview"] }),
  });

  render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });
  return { artifactPreviewPdfUrl };
}

describe("<ArtifactDetailPanel>", () => {
  it("explains approved status and renders PDF artifacts in the detail drawer", async () => {
    const { artifactPreviewPdfUrl } = renderArtifactRoute(
      <ArtifactDetailPanel artifactId="artifact-preview" />,
    );

    expect(
      await screen.findByText(
        "Approved means this generated material passed validation and is the accepted version for this job.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Artifact PDF preview")).toHaveTextContent("Artifact preview");
    expect(screen.getByLabelText("Artifact PDF preview")).toHaveTextContent(
      "/v1/artifacts/artifact-preview/preview.pdf?v=test",
    );
    expect(artifactPreviewPdfUrl).toHaveBeenCalledWith(
      "artifact-preview",
      expect.stringContaining("1234"),
    );
  });

  it("marks suppressed artifacts as historical audit material", async () => {
    renderArtifactRoute(<ArtifactDetailPanel artifactId="artifact-preview" />, "suppressed");

    expect(
      await screen.findByText(
        "This artifact is historical audit material and is not active apply-ready material.",
      ),
    ).toBeInTheDocument();
  });
});
