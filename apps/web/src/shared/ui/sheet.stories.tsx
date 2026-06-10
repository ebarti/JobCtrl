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
        <Button>Open details</Button>
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Panel details</SheetTitle>
          <SheetDescription>
            Synthetic detail rows demonstrate the sheet surface, divider, and
            muted text token pairs.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-3 py-4 text-sm">
          <div className="rounded-md border border-border bg-muted p-3">
            <div className="font-semibold text-foreground">Status</div>
            <div className="text-muted-foreground">Ready for review</div>
          </div>
          <div className="rounded-md border border-border bg-background p-3">
            <div className="font-semibold text-foreground">Owner</div>
            <div className="text-muted-foreground">Synthetic workspace</div>
          </div>
        </div>
        <SheetFooter>
          <Button variant="ghost">Close</Button>
          <Button>Save changes</Button>
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
          <SheetTitle>Filter options</SheetTitle>
          <SheetDescription>
            The open sheet keeps title and description association visible while
            dense controls sit on the background surface.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-2 py-4 text-sm">
          {["Updated recently", "Has owner", "Needs review"].map((label) => (
            <button
              key={label}
              className="rounded-md border border-border bg-muted px-3 py-2 text-left text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  ),
};
