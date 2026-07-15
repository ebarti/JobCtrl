import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import {
  ToastPortal,
  ToastProvider,
  ToastViewport,
  useToastManager,
  type ToastManagerData,
} from "./toast.js";
import { ToastList } from "./toaster.js";

function ToastSeed({
  action,
  closeLabel,
  variant,
}: {
  action: boolean;
  closeLabel?: string;
  variant: "default" | "destructive";
}) {
  const { add, close } = useToastManager<ToastManagerData>();
  const destructive = variant === "destructive";

  useEffect(() => {
    add({
      id: "accessibility-toast",
      title: destructive ? "Sync failed" : "Sync complete",
      description: destructive
        ? "The synthetic report could not be refreshed."
        : "The synthetic report is ready for review.",
      type: destructive ? "error" : "info",
      timeout: 0,
      priority: "high",
      data: {
        ...(closeLabel ? { closeLabel } : {}),
        variant: destructive ? "error" : "info",
      },
      ...(action
        ? {
            actionProps: {
              "aria-label": "Undo sync",
              children: "Undo",
            },
          }
        : {}),
    });

    return () => close("accessibility-toast");
  }, [action, add, close, closeLabel, destructive]);

  return null;
}

function renderToast({
  action = false,
  closeLabel,
  variant = "default",
}: {
  action?: boolean;
  closeLabel?: string;
  variant?: "default" | "destructive";
} = {}) {
  return render(
    <ToastProvider>
      <ToastSeed
        action={action}
        variant={variant}
        {...(closeLabel ? { closeLabel } : {})}
      />
      <ToastPortal>
        <ToastViewport>
          <ToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>,
  );
}

describe("Toast accessibility", () => {
  it("has no axe violations for default toasts with a close control", async () => {
    const view = renderToast();
    expect(screen.getByLabelText("Close")).toBeInTheDocument();
    expect(await axe(view.baseElement)).toHaveNoViolations();
  });

  it("has no axe violations for destructive toasts with a close control", async () => {
    const view = renderToast({ variant: "destructive" });
    expect(screen.getByLabelText("Close")).toBeInTheDocument();
    expect(await axe(view.baseElement)).toHaveNoViolations();
  });

  it("keeps action and caller-provided close names accessible", async () => {
    const view = renderToast({
      action: true,
      closeLabel: "Dismiss sync notice",
    });
    const close = screen.getByLabelText("Dismiss sync notice");

    expect(
      screen.getByRole("button", { name: "Undo sync" }),
    ).toBeInTheDocument();
    expect(close).toHaveAttribute("toast-close", "");
    expect(await axe(view.baseElement)).toHaveNoViolations();
  });
});
