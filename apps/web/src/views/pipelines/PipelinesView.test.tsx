import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { useStageTriggerStore } from "../../contexts/pipeline/stores/stage-trigger-store.js";
import { renderWithProviders } from "../../test/render.js";
import { PipelinesView } from "./PipelinesView.js";

describe("PipelinesView", () => {
  beforeEach(() => {
    window.localStorage.removeItem?.("jh:stage-trigger-config");
    useStageTriggerStore.getState().reset();
  });

  it("hosts the pipeline action controls", async () => {
    renderWithProviders(<PipelinesView />);

    expect(
      screen.getByRole("heading", { name: "Pipeline actions" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Run Discover" })).toBeEnabled();
  });

  it("shows the discovery page link only while the Discover pipeline stage is active", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PipelinesView />);

    expect(
      screen.getByRole("heading", { name: "Discovery" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open Discovery" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Discovery controls" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Apply" }));

    expect(await screen.findByRole("button", { name: "Run Apply" })).toBeEnabled();
    expect(
      screen.queryByRole("link", { name: "Open Discovery" }),
    ).not.toBeInTheDocument();
  });
});
