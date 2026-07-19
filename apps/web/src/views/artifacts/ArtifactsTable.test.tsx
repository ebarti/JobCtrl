import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactSummary } from "../../contexts/operations/types.js";
import {
  makeArtifactsPage,
  sampleArtifact,
} from "../../test/fixtures/projections.js";
import { buildProviderHarness } from "../../test/render.js";
import { ArtifactsTable } from "./ArtifactsTable.js";

function StatefulArtifactsTable({
  artifacts,
  onOpenArtifact = () => {},
}: {
  artifacts: readonly ArtifactSummary[];
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const sorting: SortingState = [{ id: "created_at", desc: true }];

  return (
    <ArtifactsTable
      data={makeArtifactsPage(artifacts)}
      loading={false}
      sorting={sorting}
      onSortingChange={() => {}}
      rowSelection={rowSelection}
      onRowSelectionChange={setRowSelection}
      page={1}
      pageSize={50}
      onPageChange={() => {}}
      onPageSizeChange={() => {}}
      onOpenArtifact={onOpenArtifact}
    />
  );
}

function renderArtifactsTable({
  artifacts = [sampleArtifact],
  onOpenArtifact = () => {},
}: {
  artifacts?: readonly ArtifactSummary[];
  onOpenArtifact?: (artifactId: string) => void;
} = {}) {
  const harness = buildProviderHarness();
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const artifactsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/artifacts",
    component: () => (
      <StatefulArtifactsTable
        artifacts={artifacts}
        onOpenArtifact={onOpenArtifact}
      />
    ),
  });
  const artifactDetailRoute = createRoute({
    getParentRoute: () => artifactsRoute,
    path: "$artifactId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      artifactsRoute.addChildren([artifactDetailRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/artifacts"] }),
  });

  return render(<RouterProvider router={router} />, {
    wrapper: harness.Wrapper,
  });
}

function rowForTitle(title: string): HTMLTableRowElement {
  const row = screen.getByText(title).closest("tr");
  expect(row).not.toBeNull();
  return row as HTMLTableRowElement;
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

async function hitboxForTitle(title: string): Promise<HTMLElement> {
  const checkbox = await screen.findByLabelText(`Select ${title}`);
  const hitbox = checkbox.closest(".row-check-hitbox");
  expect(hitbox).not.toBeNull();
  return hitbox as HTMLElement;
}

describe("<ArtifactsTable>", () => {
  afterEach(() => setViewportWidth(1024));

  it("selects a row when clicking the checkbox cell hit area", async () => {
    const user = userEvent.setup();
    const openCalls: string[] = [];

    renderArtifactsTable({
      onOpenArtifact: (artifactId) => openCalls.push(artifactId),
    });

    await user.click(await hitboxForTitle(sampleArtifact.title));

    expect(rowForTitle(sampleArtifact.title)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(openCalls).toEqual([]);
  });

  it("uses a concise task-oriented record on mobile", async () => {
    setViewportWidth(390);
    renderArtifactsTable();

    const list = await screen.findByRole("list", { name: "Artifacts" });
    expect(within(list).getByText(sampleArtifact.title)).toBeInTheDocument();
    expect(within(list).getByText(sampleArtifact.company)).toBeInTheDocument();
    expect(
      within(list).getByRole("checkbox", {
        name: `Select artifact ${sampleArtifact.title}`,
      }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", { name: "Open" }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", {
        name: `Open artifact ${sampleArtifact.title}`,
      }),
    ).not.toHaveClass("row-activation-focus-only");
  });
});
