import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArtifactsTable } from "./ArtifactsTable.js";

const meta = {
  title: "Views/Artifacts/ArtifactsTable",
  component: ArtifactsTable,
  parameters: { withRouter: true, initialPath: "/artifacts" },
  args: {
    items: [],
    loading: false,
    total: 0,
    page: 1,
    pages: 1,
    pageSize: 50,
    sort: "created_at",
    direction: "desc",
    onSort: () => {},
    onPageChange: () => {},
    onPageSizeChange: () => {},
  },
} satisfies Meta<typeof ArtifactsTable>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Loading: Story = { args: { loading: true } };
