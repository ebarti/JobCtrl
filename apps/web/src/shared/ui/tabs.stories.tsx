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

export const ManualActivation: Story = {
  render: () => (
    <Tabs activationMode="manual" defaultValue="first" className="w-[360px]">
      <TabsList aria-label="Manual activation example">
        <TabsTrigger value="first">First</TabsTrigger>
        <TabsTrigger value="second">Second</TabsTrigger>
      </TabsList>
      <TabsContent value="first" className="text-sm">
        Arrow keys move focus; Enter or Space activates the focused tab.
      </TabsContent>
      <TabsContent value="second" className="text-sm">
        The second manually activated panel.
      </TabsContent>
    </Tabs>
  ),
};

export const RightToLeft: Story = {
  render: () => (
    <Tabs dir="rtl" defaultValue="first" className="w-[360px]">
      <TabsList aria-label="Right-to-left example">
        <TabsTrigger value="first">First</TabsTrigger>
        <TabsTrigger value="second">Second</TabsTrigger>
        <TabsTrigger value="third">Third</TabsTrigger>
      </TabsList>
      <TabsContent value="first" className="text-sm">
        Arrow Left moves focus to the second tab in right-to-left order.
      </TabsContent>
      <TabsContent value="second" className="text-sm">
        The second right-to-left panel.
      </TabsContent>
      <TabsContent value="third" className="text-sm">
        The third right-to-left panel.
      </TabsContent>
    </Tabs>
  ),
};
