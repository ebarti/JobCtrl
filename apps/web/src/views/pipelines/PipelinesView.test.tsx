import { screen } from "@testing-library/react";
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

  it("does not show secondary discovery navigation inside pipeline actions", () => {
    renderWithProviders(<PipelinesView />);

    expect(
      screen.queryByRole("heading", { name: "Discovery" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open Discovery" }),
    ).not.toBeInTheDocument();
  });
});
