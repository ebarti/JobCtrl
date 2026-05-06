import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table.js";

const meta = {
  title: "Shared/UI/Table",
  component: Table,
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

export const JobsList: Story = {
  render: () => (
    <Table>
      <TableCaption>Open jobs · 2 of 12</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Company</TableHead>
          <TableHead>Stage</TableHead>
          <TableHead className="text-right">Fit</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Staff Software Engineer</TableCell>
          <TableCell>Acme Corp</TableCell>
          <TableCell>tailor · running</TableCell>
          <TableCell className="text-right">8</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Principal Platform Engineer</TableCell>
          <TableCell>Globex</TableCell>
          <TableCell>apply · succeeded</TableCell>
          <TableCell className="text-right">9</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};
