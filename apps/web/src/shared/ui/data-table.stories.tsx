import type { ColumnDef, RowSelectionState, SortingState } from "@tanstack/react-table";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { DataTable, type DataTableProps } from "./data-table.js";

interface Row {
  id: string;
  title: string;
  company: string;
  fitScore: number;
}

const COLUMNS: ColumnDef<Row>[] = [
  { accessorKey: "title", header: "Title" },
  { accessorKey: "company", header: "Company" },
  { accessorKey: "fitScore", header: "Fit", enableSorting: true },
];

const ROWS: Row[] = [
  { id: "job-1", title: "Staff Software Engineer", company: "Acme Corp", fitScore: 8 },
  { id: "job-2", title: "Principal Platform Engineer", company: "Globex", fitScore: 9 },
];

const COMMON_ARGS: DataTableProps<Row> = {
  data: ROWS,
  columns: COLUMNS,
  getRowId: (row) => row.id,
  loading: false,
  loaded: true,
  loadingMessage: "Loading…",
  emptyMessage: "No jobs.",
  rowClassName: "row",
  headerClassName: "head",
  sorting: [],
  onSortingChange: () => {},
  rowSelection: {},
  onRowSelectionChange: () => {},
};

const meta = {
  title: "Shared/UI/DataTable",
  component: DataTable<Row>,
  args: COMMON_ARGS,
} satisfies Meta<typeof DataTable<Row>>;

export default meta;
type Story = StoryObj<typeof meta>;

function Wrapper({
  data,
  initialSorting = [],
  loading,
  loaded,
  onRowActivate,
}: {
  data: readonly Row[];
  initialSorting?: SortingState;
  loading: boolean;
  loaded: boolean;
  onRowActivate?: (row: Row) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [selection, setSelection] = useState<RowSelectionState>({});
  return (
    <DataTable<Row>
      {...COMMON_ARGS}
      data={data}
      loading={loading}
      loaded={loaded}
      sorting={sorting}
      onSortingChange={setSorting}
      rowSelection={selection}
      onRowSelectionChange={setSelection}
      rowAriaSelected={(row) => row.id === "job-2"}
      {...(onRowActivate ? { onRowActivate } : {})}
    />
  );
}

export const Populated: Story = {
  render: () => <Wrapper data={ROWS} loading={false} loaded={true} />,
};

export const Loading: Story = {
  render: () => <Wrapper data={[]} loading={true} loaded={false} />,
};

export const Empty: Story = {
  render: () => <Wrapper data={[]} loading={false} loaded={true} />,
};

export const SortedActivatable: Story = {
  render: () => (
    <Wrapper
      data={ROWS}
      initialSorting={[{ id: "fitScore", desc: true }]}
      loading={false}
      loaded={true}
      onRowActivate={() => {}}
    />
  ),
};
