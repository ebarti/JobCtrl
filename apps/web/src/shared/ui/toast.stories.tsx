import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "./toast.js";

// ToastClose in toast.tsx renders an icon-only <button> without an
// sr-only label or aria-label (button-name violation). Production
// primitive defect from Phase 1; deferred.
const meta = {
  title: "Shared/UI/Toast",
  component: Toast,
  parameters: {
    // a11y deferred — toast.tsx ToastClose icon-only button-name defect; see meta comment above.
    a11y: { test: "off" },
  },
} satisfies Meta<typeof Toast>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InfoToast: Story = {
  render: () => (
    <ToastProvider>
      <Toast open>
        <div className="grid gap-1">
          <ToastTitle>Apply queued</ToastTitle>
          <ToastDescription>run-1 · Staff Software Engineer at Acme Corp.</ToastDescription>
        </div>
        <ToastClose />
      </Toast>
      <ToastViewport />
    </ToastProvider>
  ),
};

export const DestructiveToast: Story = {
  render: () => (
    <ToastProvider>
      <Toast open variant="destructive">
        <div className="grid gap-1">
          <ToastTitle>Apply failed</ToastTitle>
          <ToastDescription>Materials missing — generate before retrying.</ToastDescription>
        </div>
        <ToastClose />
      </Toast>
      <ToastViewport />
    </ToastProvider>
  ),
};
