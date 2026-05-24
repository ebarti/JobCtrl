import type { Meta, StoryObj } from "@storybook/react-vite";
import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { useState } from "react";

import {
  makeJobsPage,
  sampleJob,
  sampleSecondaryJob,
} from "../../test/fixtures/projections.js";
import { JobsTable } from "./JobsTable.js";

const meta = {
  title: "Views/Jobs/JobsTable",
  component: JobsTable,
  parameters: {
    withRouter: true,
    initialPath: "/jobs",
  },
  args: {
    data: makeJobsPage(),
    loading: false,
    sorting: [{ id: "discovered_at", desc: true }],
    onSortingChange: () => {},
    rowSelection: {},
    onRowSelectionChange: () => {},
    allMatchingSelected: false,
    page: 1,
    pageSize: 50,
    onPageChange: () => {},
    onPageSizeChange: () => {},
    onOpenJob: () => {},
  },
} satisfies Meta<typeof JobsTable>;

export default meta;
type Story = StoryObj<typeof meta>;

function Stateful({
  loading,
  empty,
  large,
}: {
  loading: boolean;
  empty: boolean;
  large: boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "discovered_at", desc: true },
  ]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const data = loading
    ? null
    : empty
      ? makeJobsPage([])
      : large
        ? makeJobsPage(
            Array.from({ length: 8 }, (_, i) =>
              i % 2 === 0
                ? { ...sampleJob, jobKey: `job-${i + 10}` }
                : { ...sampleSecondaryJob, jobKey: `job-${i + 10}` },
            ),
          )
        : makeJobsPage();
  return (
    <JobsTable
      data={data}
      loading={loading}
      sorting={sorting}
      onSortingChange={setSorting}
      rowSelection={rowSelection}
      onRowSelectionChange={setRowSelection}
      allMatchingSelected={false}
      page={page}
      pageSize={pageSize}
      onPageChange={setPage}
      onPageSizeChange={setPageSize}
      onOpenJob={() => {}}
    />
  );
}

export const Populated: Story = {
  render: () => <Stateful loading={false} empty={false} large={false} />,
};

export const Loading: Story = {
  render: () => <Stateful loading={true} empty={false} large={false} />,
};

export const Empty: Story = {
  render: () => <Stateful loading={false} empty={true} large={false} />,
};

export const ManyRows: Story = {
  render: () => <Stateful loading={false} empty={false} large={true} />,
};
