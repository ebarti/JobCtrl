import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { TablePager } from "./table-pager.js";

const meta = {
  title: "Shared/UI/TablePager",
  component: TablePager,
  args: {
    page: 1,
    pageSize: 50,
    totalPages: 6,
    totalRows: 257,
    onPageChange: () => {},
    onPageSizeChange: () => {},
  },
} satisfies Meta<typeof TablePager>;

export default meta;
type Story = StoryObj<typeof meta>;

function Stateful({
  initialPage,
  initialPageSize,
  totalPages,
  totalRows,
}: {
  initialPage: number;
  initialPageSize: number;
  totalPages: number;
  totalRows: number;
}) {
  const [page, setPage] = useState(initialPage);
  const [pageSize, setPageSize] = useState(initialPageSize);
  return (
    <TablePager
      page={page}
      pageSize={pageSize}
      totalPages={totalPages}
      totalRows={totalRows}
      onPageChange={setPage}
      onPageSizeChange={setPageSize}
    />
  );
}

export const FirstPage: Story = {
  render: () => <Stateful initialPage={1} initialPageSize={50} totalPages={6} totalRows={257} />,
};

export const MidPage: Story = {
  render: () => <Stateful initialPage={3} initialPageSize={50} totalPages={6} totalRows={257} />,
};

export const LastPage: Story = {
  render: () => <Stateful initialPage={6} initialPageSize={50} totalPages={6} totalRows={257} />,
};

export const SinglePage: Story = {
  render: () => <Stateful initialPage={1} initialPageSize={25} totalPages={1} totalRows={4} />,
};

export const CompactWidth: Story = {
  render: () => (
    <div style={{ maxWidth: 320 }}>
      <Stateful
        initialPage={2}
        initialPageSize={25}
        totalPages={4}
        totalRows={86}
      />
    </div>
  ),
};
