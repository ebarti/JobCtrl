import type { Meta, StoryObj } from "@storybook/react-vite";

import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card.js";
import { Button } from "./button.js";

const meta = {
  title: "Shared/UI/Card",
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Basic: Story = {
  render: () => (
    <Card className="w-[360px]">
      <CardHeader>
        <CardTitle>Workspace summary</CardTitle>
        <CardDescription>Generic card header and muted description.</CardDescription>
      </CardHeader>
      <CardContent>Three checks complete and one item needs review.</CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="ghost">Cancel</Button>
        <Button>Save changes</Button>
      </CardFooter>
    </Card>
  ),
};

export const HeaderOnly: Story = {
  render: () => (
    <Card className="w-[280px]">
      <CardHeader>
        <CardTitle>Section overview</CardTitle>
        <CardDescription>12 items · 3 updated this week</CardDescription>
      </CardHeader>
    </Card>
  ),
};

export const DenseContent: Story = {
  render: () => (
    <Card className="w-[360px]">
      <CardHeader className="p-4 pb-2">
        <CardTitle>Compact list</CardTitle>
        <CardDescription>Dense card content with muted metadata.</CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0">
        <dl className="grid gap-2 text-sm">
          {[
            ["Ready", "8"],
            ["Needs review", "2"],
            ["Paused", "1"],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-xs">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  ),
};
