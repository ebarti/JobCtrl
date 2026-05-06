import type { Meta, StoryObj } from "@storybook/react-vite";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";

const meta = {
  title: "Shared/UI/Tabs",
  component: Tabs,
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const JobDetailTabs: Story = {
  render: () => (
    <Tabs defaultValue="overview" className="w-[420px]">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="stages">Stages</TabsTrigger>
        <TabsTrigger value="apply">Apply</TabsTrigger>
        <TabsTrigger value="materials">Materials</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="text-sm">
        Acme Corp · Remote (US) · Fit score 8.
      </TabsContent>
      <TabsContent value="stages" className="text-sm">
        Pipeline overview lives here.
      </TabsContent>
      <TabsContent value="apply" className="text-sm">
        Apply history and dry-runs.
      </TabsContent>
      <TabsContent value="materials" className="text-sm">
        Tailored resume + cover letter PDFs.
      </TabsContent>
    </Tabs>
  ),
};
