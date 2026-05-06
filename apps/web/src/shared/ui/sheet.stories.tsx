import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button.js";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet.js";

const meta = {
  title: "Shared/UI/Sheet",
  component: Sheet,
} satisfies Meta<typeof Sheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RightSide: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button>Open job detail</Button>
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Staff Software Engineer</SheetTitle>
          <SheetDescription>Acme Corp · queued for tailoring.</SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <Button variant="ghost">Close</Button>
          <Button>Apply</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
};

export const OpenByDefault: Story = {
  render: () => (
    <Sheet defaultOpen>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Job filters</SheetTitle>
          <SheetDescription>Refine the visible jobs.</SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  ),
};
