import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "./toast.js";

const meta = {
  title: "Shared/UI/Toast",
  component: Toast,
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
      <ToastViewport label="Toast story notifications ({hotkey})" />
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
      <ToastViewport label="Toast story notifications ({hotkey})" />
    </ToastProvider>
  ),
};

export const ActionToast: Story = {
  render: () => (
    <ToastProvider>
      <Toast open>
        <div className="grid gap-1">
          <ToastTitle>Sync paused</ToastTitle>
          <ToastDescription>Synthetic export paused before publishing.</ToastDescription>
        </div>
        <ToastAction altText="Resume sync">Resume</ToastAction>
        <ToastClose />
      </Toast>
      <ToastViewport label="Toast story notifications ({hotkey})" />
    </ToastProvider>
  ),
};

export const CustomCloseLabel: Story = {
  render: () => (
    <ToastProvider>
      <Toast open>
        <div className="grid gap-1">
          <ToastTitle>Review ready</ToastTitle>
          <ToastDescription>Synthetic summary can be inspected.</ToastDescription>
        </div>
        <ToastClose aria-label="Dismiss review notice" />
      </Toast>
      <ToastViewport label="Toast story notifications ({hotkey})" />
    </ToastProvider>
  ),
};
