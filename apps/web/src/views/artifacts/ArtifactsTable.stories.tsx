import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { useState } from "react";

import { makeArtifactsPage, sampleArtifact } from "../../test/fixtures/projections.js";
import { ArtifactsTable } from "./ArtifactsTable.js";

// Inherits the <DataTable> role-row / aria-sort defect (see
// data-table.stories.tsx) — production-code issue, deferred.
const meta = {
  title: "Views/Artifacts/ArtifactsTable",
  component: ArtifactsTable,
  parameters: {
    withRouter: true,
    initialPath: "/artifacts",
    // a11y deferred — DataTable role="row" / aria-sort defect; see data-table.stories.tsx.
    a11y: { test: "off" },
  },
  args: {
    data: makeArtifactsPage(),
    loading: false,
    sorting: [{ id: "created_at", desc: true }],
    onSortingChange: () => {},
    rowSelection: {},
    onRowSelectionChange: () => {},
    page: 1,
    pageSize: 50,
    onPageChange: () => {},
    onPageSizeChange: () => {},
    onOpenArtifact: () => {},
  },
} satisfies Meta<typeof ArtifactsTable>;

export default meta;
type Story = StoryObj<typeof meta>;

function Stateful({
  loading,
  empty,
  many,
}: {
  loading: boolean;
  empty: boolean;
  many: boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "created_at", desc: true }]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const data = loading
    ? null
    : empty
      ? makeArtifactsPage([])
      : many
        ? makeArtifactsPage(
            Array.from({ length: 12 }, (_, i) => ({
              ...sampleArtifact,
              artifactId: `artifact-${i + 10}`,
            })),
          )
        : makeArtifactsPage();
  return (
    <ArtifactsTable
      data={data}
      loading={loading}
      sorting={sorting}
      onSortingChange={setSorting}
      rowSelection={rowSelection}
      onRowSelectionChange={setRowSelection}
      page={page}
      pageSize={pageSize}
      onPageChange={setPage}
      onPageSizeChange={setPageSize}
      onOpenArtifact={() => {}}
    />
  );
}

export const Populated: Story = {
  render: () => <Stateful loading={false} empty={false} many={false} />,
};

export const Loading: Story = {
  render: () => <Stateful loading={true} empty={false} many={false} />,
};

export const Empty: Story = {
  render: () => <Stateful loading={false} empty={true} many={false} />,
};

export const ManyRows: Story = {
  render: () => <Stateful loading={false} empty={false} many={true} />,
};
