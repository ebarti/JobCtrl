import type { Meta, StoryObj } from "@storybook/react-vite";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";

const meta = {
  title: "Shared/UI/Tabs",
  component: Tabs,
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StateTabs: Story = {
  render: () => (
    <Tabs defaultValue="overview" className="w-[420px]">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="details">Details</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
        <TabsTrigger value="disabled" disabled>
          Disabled
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="text-sm">
        Overview content for the active tab.
      </TabsContent>
      <TabsContent value="details" className="text-sm">
        Detail content for an inactive tab until selected.
      </TabsContent>
      <TabsContent value="history" className="text-sm">
        Recent synthetic changes appear here.
      </TabsContent>
    </Tabs>
  ),
};

export const FocusVisible: Story = {
  render: () => (
    <Tabs defaultValue="first" className="w-[360px]">
      <TabsList>
        <TabsTrigger value="first" autoFocus>
          First
        </TabsTrigger>
        <TabsTrigger value="second">Second</TabsTrigger>
      </TabsList>
      <TabsContent value="first" className="text-sm">
        Focus starts on the active trigger for keyboard-ring review.
      </TabsContent>
      <TabsContent value="second" className="text-sm">
        Secondary panel content.
      </TabsContent>
    </Tabs>
  ),
};
