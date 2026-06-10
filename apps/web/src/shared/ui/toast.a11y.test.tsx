import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "./toast.js";

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
      <Toast open variant={variant}>
        <div className="grid gap-1">
          <ToastTitle>{variant === "destructive" ? "Sync failed" : "Sync complete"}</ToastTitle>
          <ToastDescription>
            {variant === "destructive"
              ? "The synthetic report could not be refreshed."
              : "The synthetic report is ready for review."}
          </ToastDescription>
        </div>
        {action ? <ToastAction altText="Undo sync">Undo</ToastAction> : null}
        <ToastClose {...(closeLabel ? { "aria-label": closeLabel } : {})} />
      </Toast>
      <ToastViewport />
    </ToastProvider>,
  );
}

describe("Toast accessibility", () => {
  it("has no axe violations for default toasts with a close control", async () => {
    const view = renderToast();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("has no axe violations for destructive toasts with a close control", async () => {
    const view = renderToast({ variant: "destructive" });
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("keeps action and caller-provided close names accessible", async () => {
    const view = renderToast({ action: true, closeLabel: "Dismiss sync notice" });
    const close = screen.getByRole("button", { name: "Dismiss sync notice" });

    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(close).toHaveAttribute("toast-close", "");
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
