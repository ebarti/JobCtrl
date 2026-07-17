import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./button.js";

describe("<Button>", () => {
  it("renders a native button with the default button type", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save changes</Button>);

    const button = screen.getByRole("button", { name: "Save changes" });
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("text-sm");

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("keeps compact controls on the same readable type scale", () => {
    render(<Button size="sm">Compact action</Button>);

    expect(screen.getByRole("button", { name: "Compact action" })).toHaveClass(
      "h-8",
      "text-sm",
    );
  });

  it("composes with a rendered non-native button target", () => {
    render(
      <Button nativeButton={false} render={<a href="/jobs" role="link" />}>
        Open jobs
      </Button>,
    );

    const linkButton = screen.getByRole("link", { name: "Open jobs" });
    expect(linkButton.tagName).toBe("A");
    expect(linkButton).toHaveAttribute("href", "/jobs");
    expect(linkButton).toHaveClass("inline-flex", "rounded-md");
  });

  it("provides semantic success and warning variants", () => {
    render(
      <>
        <Button variant="success">Approve</Button>
        <Button variant="warning">Defer</Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "Approve" })).toHaveClass(
      "bg-success",
      "text-success-foreground",
      "focus-visible:ring-success",
    );
    expect(screen.getByRole("button", { name: "Defer" })).toHaveClass(
      "bg-warning",
      "text-warning-foreground",
      "focus-visible:ring-warning",
    );
  });

  it("keeps the destructive variant red across interaction states", () => {
    render(
      <>
        <Button variant="destructive">Delete</Button>
        <Button variant="destructive" disabled>
          Delete disabled
        </Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass(
      "bg-destructive",
      "hover:bg-destructive/90",
      "focus-visible:ring-destructive",
    );
    expect(screen.getByRole("button", { name: "Delete disabled" })).toHaveClass(
      "disabled:bg-destructive/60",
      "disabled:text-white",
      "disabled:opacity-100",
    );
  });
});
