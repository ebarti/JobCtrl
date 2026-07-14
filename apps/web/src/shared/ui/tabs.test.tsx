import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";

function TestTabs({
  activationMode,
  activateOnFocus,
  forceMount = false,
}: {
  activationMode?: "automatic" | "manual";
  activateOnFocus?: boolean;
  forceMount?: boolean;
}) {
  return (
    <Tabs activationMode={activationMode} defaultValue="overview">
      <TabsList activateOnFocus={activateOnFocus} aria-label="Account sections">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="details">Details</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">Overview panel</TabsContent>
      <TabsContent value="details" forceMount={forceMount || undefined}>
        Details panel
      </TabsContent>
    </Tabs>
  );
}

describe("<Tabs>", () => {
  it("keeps an uncontrolled root inactive when no default value is supplied", () => {
    render(
      <Tabs>
        <TabsList aria-label="Optional sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Overview panel</TabsContent>
        <TabsContent value="details">Details panel</TabsContent>
      </Tabs>,
    );

    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
  });

  it("changes an uncontrolled value when a tab is clicked", async () => {
    const user = userEvent.setup();
    render(<TestTabs />);

    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Overview panel");

    await user.click(screen.getByRole("tab", { name: "Details" }));

    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Details panel");
  });

  it("reports controlled changes without replacing the supplied value", () => {
    const onValueChange = vi.fn();
    const renderTabs = (value: string) => (
      <Tabs value={value} onValueChange={onValueChange}>
        <TabsList aria-label="Controlled sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Overview panel</TabsContent>
        <TabsContent value="details">Details panel</TabsContent>
      </Tabs>
    );
    const { rerender } = render(renderTabs("overview"));

    fireEvent.click(screen.getByRole("tab", { name: "Details" }));

    expect(onValueChange).toHaveBeenCalledWith("details");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    rerender(renderTabs("details"));
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("activates focused tabs during arrow-key navigation by default", async () => {
    const user = userEvent.setup();
    render(<TestTabs />);
    const overview = screen.getByRole("tab", { name: "Overview" });
    const details = screen.getByRole("tab", { name: "Details" });

    overview.focus();
    await user.keyboard("{ArrowRight}");

    expect(details).toHaveFocus();
    expect(details).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Details panel");
  });

  it("uses right-to-left arrow navigation when dir is rtl", async () => {
    const user = userEvent.setup();
    render(
      <Tabs dir="rtl" defaultValue="first" data-testid="rtl-tabs">
        <TabsList aria-label="Right-to-left sections">
          <TabsTrigger value="first">First</TabsTrigger>
          <TabsTrigger value="second">Second</TabsTrigger>
          <TabsTrigger value="third">Third</TabsTrigger>
        </TabsList>
        <TabsContent value="first">First panel</TabsContent>
        <TabsContent value="second">Second panel</TabsContent>
        <TabsContent value="third">Third panel</TabsContent>
      </Tabs>,
    );
    const first = screen.getByRole("tab", { name: "First" });
    const second = screen.getByRole("tab", { name: "Second" });

    expect(screen.getByTestId("rtl-tabs")).toHaveAttribute("dir", "rtl");
    first.focus();
    await user.keyboard("{ArrowLeft}");

    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Second panel");
  });

  it("preserves manual activation configured on the Radix-compatible root prop", async () => {
    const user = userEvent.setup();
    render(<TestTabs activationMode="manual" />);
    const overview = screen.getByRole("tab", { name: "Overview" });
    const details = screen.getByRole("tab", { name: "Details" });

    overview.focus();
    await user.keyboard("{ArrowRight}");

    expect(details).toHaveFocus();
    expect(overview).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Enter}");
    expect(details).toHaveAttribute("aria-selected", "true");
  });

  it("honors an explicit activateOnFocus override on the list", async () => {
    const user = userEvent.setup();
    render(<TestTabs activateOnFocus={false} />);
    const overview = screen.getByRole("tab", { name: "Overview" });
    const details = screen.getByRole("tab", { name: "Details" });

    overview.focus();
    await user.keyboard("{ArrowRight}");

    expect(details).toHaveFocus();
    expect(overview).toHaveAttribute("aria-selected", "true");
  });

  it("marks disabled tabs and does not activate them", async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="overview">
        <TabsList aria-label="Disabled sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="details" disabled>
            Details
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Overview panel</TabsContent>
        <TabsContent value="details">Details panel</TabsContent>
      </Tabs>,
    );
    const disabledTab = screen.getByRole("tab", { name: "Details" });

    expect(disabledTab).toHaveAttribute("aria-disabled", "true");
    expect(disabledTab).toHaveAttribute("data-disabled");
    expect(disabledTab).toHaveClass("aria-disabled:pointer-events-none");

    await user.click(disabledTab);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("keeps disabled Base UI tabs focusable without activating them", async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="first">
        <TabsList aria-label="Focusable disabled sections">
          <TabsTrigger value="first">First</TabsTrigger>
          <TabsTrigger value="second" disabled>
            Second
          </TabsTrigger>
          <TabsTrigger value="third">Third</TabsTrigger>
        </TabsList>
        <TabsContent value="first">First panel</TabsContent>
        <TabsContent value="second">Second panel</TabsContent>
        <TabsContent value="third">Third panel</TabsContent>
      </Tabs>,
    );
    const first = screen.getByRole("tab", { name: "First" });
    const second = screen.getByRole("tab", { name: "Second" });
    const third = screen.getByRole("tab", { name: "Third" });

    first.focus();
    await user.keyboard("{ArrowRight}");

    expect(second).toHaveFocus();
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveAttribute("aria-selected", "false");

    await user.keyboard("{ArrowRight}");
    expect(third).toHaveFocus();
    expect(third).toHaveAttribute("aria-selected", "true");
  });

  it("maps forceMount to a kept, hidden Base UI panel", async () => {
    const user = userEvent.setup();
    render(<TestTabs forceMount />);
    const hiddenPanel = screen
      .getByText("Details panel")
      .closest("[role=tabpanel]");

    expect(hiddenPanel).toHaveAttribute("hidden");
    expect(hiddenPanel).toHaveAttribute("data-hidden");

    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(hiddenPanel).not.toHaveAttribute("hidden");
    expect(hiddenPanel).not.toHaveAttribute("data-hidden");
  });
});
