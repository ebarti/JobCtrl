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
        <CardTitle>Staff Software Engineer</CardTitle>
        <CardDescription>Acme Corp · Remote (US)</CardDescription>
      </CardHeader>
      <CardContent>Fit score 8 · queued for tailoring.</CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="ghost">Skip</Button>
        <Button>Open</Button>
      </CardFooter>
    </Card>
  ),
};

export const HeaderOnly: Story = {
  render: () => (
    <Card className="w-[280px]">
      <CardHeader>
        <CardTitle>Pipeline overview</CardTitle>
        <CardDescription>12 jobs · 3 applied this week</CardDescription>
      </CardHeader>
    </Card>
  ),
};
