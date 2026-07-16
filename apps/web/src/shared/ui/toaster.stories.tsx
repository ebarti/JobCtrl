import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import { useToastStore } from "../stores/toasts.js";
import { Toaster } from "./toaster.js";
import { Button } from "./button.js";

const meta = {
  title: "Shared/UI/Toaster",
  component: Toaster,
  tags: ["a11y-regression"],
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

function ToastSeed({ kind }: { kind: "info" | "error" | "both" | "trigger" }) {
  const toast = useToastStore((state) => state.toast);
  const clear = useToastStore((state) => state.clear);

  useEffect(() => {
    if (kind === "trigger") return;
    clear();
    if (kind === "info" || kind === "both") {
      toast({
        title: "Apply queued",
        message: "run-1 · Staff SWE at Acme Corp",
        variant: "info",
      });
    }
    if (kind === "error" || kind === "both") {
      toast({
        title: "Materials missing",
        message: "Generate before retrying the apply stage.",
        variant: "error",
      });
    }
    return () => {
      clear();
    };
  }, [kind, toast, clear]);

  if (kind !== "trigger") return null;
  return (
    <div className="flex gap-2">
      <Button
        onClick={() => toast({ message: "Job restored.", variant: "info" })}
      >
        Push info
      </Button>
      <Button
        variant="destructive"
        onClick={() =>
          toast({
            title: "Apply failed",
            message: "Network error.",
            variant: "error",
          })
        }
      >
        Push error
      </Button>
    </div>
  );
}

export const InfoQueued: Story = {
  render: () => (
    <>
      <ToastSeed kind="info" />
      <Toaster viewportLabel="Toaster story notifications ({hotkey})" />
    </>
  ),
};

export const ErrorQueued: Story = {
  render: () => (
    <>
      <ToastSeed kind="error" />
      <Toaster viewportLabel="Toaster story notifications ({hotkey})" />
    </>
  ),
};

export const Stacked: Story = {
  render: () => (
    <>
      <ToastSeed kind="both" />
      <Toaster viewportLabel="Toaster story notifications ({hotkey})" />
    </>
  ),
};

export const ManualTrigger: Story = {
  render: () => (
    <>
      <ToastSeed kind="trigger" />
      <Toaster viewportLabel="Toaster story notifications ({hotkey})" />
    </>
  ),
};
