import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DebugSearch } from "../../routes/-debug.search.js";
import { DebugFilterBar } from "./DebugFilterBar.js";

const EMPTY_SEARCH: DebugSearch = {
  q: "",
  level: "",
  stage: "",
  eventType: "",
  sort: "occurred_at",
  dir: "desc",
  page: 1,
  pageSize: 50,
};

describe("<DebugFilterBar>", () => {
  it("uses shared controls and submits a trimmed search", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <DebugFilterBar search={EMPTY_SEARCH} onChange={onChange} />,
    );

    expect(container.querySelectorAll('[data-slot="input"]')).toHaveLength(3);
    expect(screen.getByLabelText("Search activity")).toBeInTheDocument();
    expect(screen.getByLabelText("Level")).toBeInTheDocument();
    expect(screen.getByLabelText("Stage")).toBeInTheDocument();
    expect(screen.getByLabelText("Event type")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute(
      "data-slot",
      "button",
    );

    await user.type(
      screen.getByRole("textbox", { name: "Activity search" }),
      "  event  ",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(onChange).toHaveBeenLastCalledWith({ q: "event", page: 1 });
  });

  it("keeps immediate filters and clear behavior intact", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function ControlledFilterBar() {
      const [search, setSearch] = useState({
        ...EMPTY_SEARCH,
        q: "initial",
        stage: "score",
        eventType: "JobScored",
      });
      return (
        <DebugFilterBar
          search={search}
          onChange={(next) => {
            onChange(next);
            setSearch((current) => ({ ...current, ...next }));
          }}
        />
      );
    }
    render(<ControlledFilterBar />);

    await user.type(
      screen.getByRole("textbox", { name: "Activity stage" }),
      "ing",
    );
    expect(onChange).toHaveBeenLastCalledWith({ stage: "scoreing", page: 1 });

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith({
      q: "",
      level: "",
      stage: "",
      eventType: "",
      page: 1,
    });
  });
});
