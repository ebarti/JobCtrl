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

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
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
});
