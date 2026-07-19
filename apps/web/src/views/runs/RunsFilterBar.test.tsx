import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  RunsFilterBar,
  startOfNextUtcDay,
  startOfUtcDay,
} from "./RunsFilterBar.js";

describe("<RunsFilterBar>", () => {
  it("uses persistent labels and canonical UTC date boundaries", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RunsFilterBar
        status="all"
        workflowType=""
        startedSince=""
        startedBefore=""
        summary="2 runs shown"
        onChange={onChange}
      />,
    );

    await user.type(
      screen.getByLabelText("Workflow type"),
      " JobPipelineWorkflow ",
    );
    fireEvent.change(screen.getByLabelText("Started from"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("Started through"), {
      target: { value: "2026-07-18" },
    });
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(onChange).toHaveBeenLastCalledWith({
      workflowType: "JobPipelineWorkflow",
      startedSince: "2026-07-01T00:00:00.000Z",
      startedBefore: "2026-07-19T00:00:00.000Z",
    });
    expect(screen.getByRole("status")).toHaveTextContent("2 runs shown");
  });

  it("clears every server-side filter together", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RunsFilterBar
        status="failed"
        workflowType="ApplyWorkflow"
        startedSince="2026-07-01T00:00:00.000Z"
        startedBefore="2026-07-19T00:00:00.000Z"
        summary="1 failed run shown"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(onChange).toHaveBeenLastCalledWith({
      status: "all",
      workflowType: "",
      startedSince: "",
      startedBefore: "",
    });
  });
});

describe("run date boundary helpers", () => {
  it("uses an inclusive start and exclusive next-day end", () => {
    expect(startOfUtcDay("2026-07-18")).toBe("2026-07-18T00:00:00.000Z");
    expect(startOfNextUtcDay("2026-07-18")).toBe("2026-07-19T00:00:00.000Z");
  });
});
