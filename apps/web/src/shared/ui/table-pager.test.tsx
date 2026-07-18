import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TablePager } from "./table-pager.js";

function renderPager({
  page = 2,
  pageSize = 50,
  totalPages = 4,
  totalRows = 120,
  pageSizeOptions = [25, 50, 100],
}: {
  page?: number;
  pageSize?: number;
  totalPages?: number;
  totalRows?: number;
  pageSizeOptions?: readonly number[];
} = {}) {
  const onPageChange = vi.fn();
  const onPageSizeChange = vi.fn();

  const view = render(
    <TablePager
      page={page}
      pageSize={pageSize}
      totalPages={totalPages}
      totalRows={totalRows}
      pageSizeOptions={pageSizeOptions}
      onPageChange={onPageChange}
      onPageSizeChange={onPageSizeChange}
    />,
  );

  return { onPageChange, onPageSizeChange, unmount: view.unmount };
}

describe("TablePager", () => {
  it("keeps previous disabled on the first page and next disabled on the last page", async () => {
    const user = userEvent.setup();
    const firstPage = renderPager({ page: 1, totalPages: 3 });

    const previous = screen.getByRole("button", { name: "Previous" });
    expect(previous).toBeDisabled();
    await user.click(previous);
    expect(firstPage.onPageChange).not.toHaveBeenCalled();
    firstPage.unmount();

    const { onPageChange } = renderPager({ page: 3, totalPages: 3 });
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).toBeDisabled();
    await user.click(next!);
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("calls onPageChange with the previous and next page when controls are enabled", async () => {
    const { onPageChange } = renderPager({ page: 2, totalPages: 4 });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPageChange).toHaveBeenLastCalledWith(1);

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenLastCalledWith(3);
  });

  it("uses the shared Select and reports numeric page-size values", async () => {
    const { onPageSizeChange } = renderPager({
      pageSize: 50,
      pageSizeOptions: [25, 50, 100],
    });
    const user = userEvent.setup();
    const pageSize = screen.getByRole("combobox", { name: "Page size" });

    expect(pageSize).toHaveAttribute("data-slot", "select-trigger");
    await user.click(pageSize);
    await user.click(await screen.findByRole("option", { name: "100/page" }));
    expect(onPageSizeChange).toHaveBeenLastCalledWith(100);
  });

  it("keeps pager focus indicators tied to the standard ring token", () => {
    renderPager();
    const pageSize = screen.getByRole("combobox", { name: "Page size" });

    expect(pageSize).toHaveClass("focus-visible:ring-3");
    expect(pageSize).toHaveClass("focus-visible:ring-ring/30");
  });
});
