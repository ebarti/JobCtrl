import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  FilterableDataGrid,
  type DataGridColumn,
} from "./filterable-data-grid.js";

interface Row {
  id: string;
  item: string;
  source: string;
  region: string;
  observed: number;
}

const ROWS: Row[] = [
  {
    id: "row-1",
    item: "Northstar Labs",
    source: "Registry import",
    region: "North",
    observed: 14,
  },
  {
    id: "row-2",
    item: "Sample Systems",
    source: "Manual review",
    region: "East",
    observed: 6,
  },
  {
    id: "row-3",
    item: "Demo Foundry",
    source: "Registry import",
    region: "West",
    observed: 21,
  },
  {
    id: "row-4",
    item: "Fixture Works",
    source: "Scheduled check",
    region: "South",
    observed: 3,
  },
];

const COLUMNS: Array<DataGridColumn<Row>> = [
  {
    id: "item",
    label: "Item",
    rowHeader: true,
    render: (row) => row.item,
    getSortValue: (row) => row.item,
    getFilterValue: (row) => row.item,
  },
  {
    id: "source",
    label: "Source",
    render: (row) => row.source,
    getSortValue: (row) => row.source,
    getFilterValue: (row) => row.source,
  },
  {
    id: "region",
    label: "Region",
    render: (row) => row.region,
    getSortValue: (row) => row.region,
    getFilterValue: (row) => row.region,
  },
  {
    id: "observed",
    label: "Observed",
    render: (row) => row.observed,
    getSortValue: (row) => row.observed,
    className: "mono",
  },
];

const meta = {
  title: "Shared/UI/FilterableDataGrid",
  component: FilterableDataGrid<Row>,
  args: {
    title: "Synthetic grid",
    data: ROWS,
    columns: COLUMNS,
    getRowId: (row) => row.id,
    loading: false,
    loadingMessage: "Loading rows.",
    emptyMessage: "No rows match the current filter.",
    initialSort: { columnId: "item", direction: "asc" },
  },
} satisfies Meta<typeof FilterableDataGrid<Row>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Loading: Story = {
  args: {
    data: [],
    loading: true,
  },
};

export const Empty: Story = {
  args: {
    data: [],
  },
};

export const FilteredNoMatch: Story = {
  args: {
    initialFilters: {
      item: {
        operator: "contains",
        text: "unlisted",
        selectedValues: [],
      },
    },
  },
};

export const Paginated: Story = {
  args: {
    paginate: true,
    initialPageSize: 2,
    pageSizeOptions: [2, 4],
  },
};

export const ActivatableRows: Story = {
  args: {
    onRowActivate: () => {},
    rowActivationLabel: (row) => `Open ${row.item}`,
    rowAriaSelected: (row) => row.id === "row-3",
    rowClassName: (row) => (row.id === "row-3" ? "selected" : undefined),
  },
};
