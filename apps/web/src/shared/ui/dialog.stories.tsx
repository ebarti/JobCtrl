import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog.js";

const meta = {
  title: "Shared/UI/Dialog",
  component: Dialog,
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ClosedByDefault: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open confirmation</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete draft?</DialogTitle>
          <DialogDescription>
            This synthetic dialog shows destructive copy, muted helper text, and
            footer actions on the standard surface tokens.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          The preview item is local fixture content. It is included only to make
          the dialog background, border, and text contrast reviewable.
        </div>
        <DialogFooter>
          <Button variant="ghost">Cancel</Button>
          <Button variant="destructive">Delete draft</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

export const OpenByDefault: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save changes?</DialogTitle>
          <DialogDescription>
            Review the generic settings below before applying the changes to this
            synthetic fixture.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 rounded-md border border-border bg-muted p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="font-semibold text-foreground">Visibility</span>
            <span className="text-muted-foreground">Private preview</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="font-semibold text-foreground">Notifications</span>
            <span className="text-muted-foreground">Paused</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost">Cancel</Button>
          <Button>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};
