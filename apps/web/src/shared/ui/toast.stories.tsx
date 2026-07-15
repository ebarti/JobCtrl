import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import {
  ToastPortal,
  ToastProvider,
  ToastViewport,
  useToastManager,
  type ToastManagerData,
} from "./toast.js";
import { ToastList } from "./toaster.js";

const meta = {
  title: "Shared/UI/Toast",
  component: ToastList,
} satisfies Meta<typeof ToastList>;

export default meta;
type Story = StoryObj<typeof meta>;

function ToastSeed({
  action = false,
  closeLabel,
  description,
  id,
  title,
  variant = "info",
}: {
  action?: boolean;
  closeLabel?: string;
  description: string;
  id: string;
  title: string;
  variant?: "info" | "error";
}) {
  const { add, close } = useToastManager<ToastManagerData>();

  useEffect(() => {
    add({
      id,
      title,
      description,
      type: variant,
      timeout: 0,
      priority: "high",
      data: {
        ...(closeLabel ? { closeLabel } : {}),
        variant,
      },
      ...(action
        ? {
            actionProps: {
              "aria-label": "Resume sync",
              children: "Resume",
            },
          }
        : {}),
    });

    return () => close(id);
  }, [action, add, close, closeLabel, description, id, title, variant]);

  return null;
}

function ToastFixture(props: Parameters<typeof ToastSeed>[0]) {
  return (
    <ToastProvider>
      <ToastSeed {...props} />
      <ToastPortal>
        <ToastViewport label="Toast story notifications ({hotkey})">
          <ToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  );
}

export const InfoToast: Story = {
  render: () => (
    <ToastFixture
      id="story-info"
      title="Apply queued"
      description="run-1 · Staff Software Engineer at Acme Corp."
    />
  ),
};

export const DestructiveToast: Story = {
  render: () => (
    <ToastFixture
      id="story-destructive"
      title="Apply failed"
      description="Materials missing — generate before retrying."
      variant="error"
    />
  ),
};

export const ActionToast: Story = {
  render: () => (
    <ToastFixture
      action
      id="story-action"
      title="Sync paused"
      description="Synthetic export paused before publishing."
    />
  ),
};

export const CustomCloseLabel: Story = {
  render: () => (
    <ToastFixture
      closeLabel="Dismiss review notice"
      id="story-custom-close"
      title="Review ready"
      description="Synthetic summary can be inspected."
    />
  ),
};
