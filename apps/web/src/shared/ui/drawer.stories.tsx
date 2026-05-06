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

export const ApplyConfirmation: Story = {
  render: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button>Open apply confirmation</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Submit apply for 1 job?</DrawerTitle>
          <DrawerDescription>
            Materials will be uploaded and the run can be cancelled while it is queued.
          </DrawerDescription>
        </DrawerHeader>
        <DrawerFooter>
          <Button>Apply</Button>
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
          <DrawerTitle>Apply run #run-1</DrawerTitle>
          <DrawerDescription>Live progress for the running apply.</DrawerDescription>
        </DrawerHeader>
        <DrawerFooter>
          <Button>Cancel apply</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};
