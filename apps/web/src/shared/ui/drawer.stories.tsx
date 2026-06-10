import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "./button.js";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer.js";

const meta = {
  title: "Shared/UI/Drawer",
  component: Drawer,
} satisfies Meta<typeof Drawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Confirmation: Story = {
  render: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button>Open confirmation</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Publish draft?</DrawerTitle>
          <DrawerDescription>
            This synthetic drawer uses primary and secondary actions without
            changing the underlying Vaul primitive behavior.
          </DrawerDescription>
        </DrawerHeader>
        <div className="mx-4 rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          The drawer body includes enough content to verify the surface, handle,
          border, and foreground tokens over the Storybook background.
        </div>
        <DrawerFooter>
          <Button>Publish draft</Button>
          <Button variant="ghost">Cancel</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};

export const OpenByDefault: Story = {
  render: () => (
    <Drawer defaultOpen>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Drawer details</DrawerTitle>
          <DrawerDescription>
            Open-by-default coverage keeps the title and description visible for
            Storybook visual and accessibility review.
          </DrawerDescription>
        </DrawerHeader>
        <div className="mx-4 grid gap-2 rounded-md border border-border bg-muted p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="font-semibold text-foreground">Mode</span>
            <span className="text-muted-foreground">Preview</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="font-semibold text-foreground">Items</span>
            <span className="text-muted-foreground">3 selected</span>
          </div>
        </div>
        <DrawerFooter>
          <Button>Save changes</Button>
          <Button variant="destructive">Delete draft</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};
