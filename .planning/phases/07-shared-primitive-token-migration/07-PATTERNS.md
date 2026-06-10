# Phase 07: Shared Primitive Token Migration - Pattern Map

**Mapped:** 2026-06-10
**Files analyzed:** 21 target files or file groups
**Analogs found:** 21 / 21

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `apps/web/src/shared/ui/data-table.tsx` | component | event-driven | `apps/web/src/shared/ui/data-table.tsx` | exact |
| `apps/web/src/shared/ui/data-table.test.tsx` | test | event-driven | `apps/web/src/shared/ui/filterable-data-grid.test.tsx` | role-match |
| `apps/web/src/shared/ui/data-table.stories.tsx` | component story | event-driven | `apps/web/src/shared/ui/data-table.stories.tsx` | exact |
| `apps/web/src/shared/ui/toast.tsx` | component | event-driven | `apps/web/src/shared/ui/toast.tsx` | exact |
| `apps/web/src/shared/ui/toast.a11y.test.tsx` | test | transform | `apps/web/src/contexts/profile/forms/settings-form.a11y.test.tsx` | role-match |
| `apps/web/src/shared/ui/toast.stories.tsx` | component story | event-driven | `apps/web/src/shared/ui/toast.stories.tsx` | exact |
| `apps/web/src/shared/ui/toaster.stories.tsx` | component story | event-driven | `apps/web/src/shared/ui/toaster.stories.tsx` | exact |
| `apps/web/src/shared/ui/filterable-data-grid.tsx` | component | event-driven | `apps/web/src/shared/ui/data-table.tsx` | role-match |
| `apps/web/src/shared/ui/filterable-data-grid.test.tsx` | test | event-driven | `apps/web/src/shared/ui/filterable-data-grid.test.tsx` | exact |
| `apps/web/src/shared/ui/table-pager.tsx` | component | event-driven | `apps/web/src/shared/ui/table-pager.tsx` | exact |
| `apps/web/src/shared/ui/table-pager.stories.tsx` | component story | event-driven | `apps/web/src/shared/ui/table-pager.stories.tsx` | exact |
| `apps/web/src/shared/ui/dialog.stories.tsx` | component story | event-driven | `apps/web/src/shared/ui/dialog.stories.tsx` | exact |
| `apps/web/src/shared/ui/sheet.stories.tsx` | component story | event-driven | `apps/web/src/shared/ui/dialog.stories.tsx` | role-match |
| `apps/web/src/shared/ui/drawer.stories.tsx` | component story | event-driven | `apps/web/src/shared/ui/dialog.stories.tsx` | role-match |
| `apps/web/src/shared/ui/dropdown-menu.stories.tsx` | component story | event-driven | `apps/web/src/shared/ui/dropdown-menu.stories.tsx` | exact |
| `apps/web/src/shared/ui/select.stories.tsx` | component story | event-driven | `apps/web/src/shared/ui/dropdown-menu.stories.tsx` | role-match |
| `apps/web/src/shared/ui/popover.stories.tsx` | component story | event-driven | `apps/web/src/shared/ui/dropdown-menu.stories.tsx` | role-match |
| `apps/web/src/shared/ui/command.stories.tsx` | component story | event-driven | `apps/web/src/shared/ui/dropdown-menu.stories.tsx` | role-match |
| `apps/web/src/shared/ui/tooltip.stories.tsx` | component story | event-driven | `apps/web/src/shared/ui/dropdown-menu.stories.tsx` | role-match |
| `apps/web/src/shared/ui/{button,badge,input,textarea,checkbox,switch,tabs,card,skeleton,separator,scroll-area}.stories.tsx` | component story | event-driven | `apps/web/src/shared/ui/table-pager.stories.tsx` | role-match |
| `apps/web/e2e/tests/shared-primitive-token-migration.spec.ts` or equivalent targeted browser proof | test | request-response | `apps/web/e2e/tests/token-foundation.spec.ts` | role-match |

## Pattern Assignments

### `apps/web/src/shared/ui/data-table.tsx` (component, event-driven)

**Analog:** `apps/web/src/shared/ui/data-table.tsx`

**Imports pattern** (lines 1-12):
```typescript
import {
  flexRender,
  getCoreRowModel,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type Updater,
  useReactTable,
} from "@tanstack/react-table";
import type { ReactNode } from "react";

import { Empty } from "./empty.js";
```

**Core table pattern** (lines 56-75):
```tsx
const table = useReactTable<TData>({
  data: data as TData[],
  columns,
  state: { sorting, rowSelection },
  getRowId,
  enableRowSelection,
  enableMultiRowSelection: enableRowSelection,
  enableSortingRemoval: false,
  manualSorting: true,
  manualPagination: true,
  onSortingChange: (updater: Updater<SortingState>) => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    onSortingChange(next);
  },
  onRowSelectionChange: (updater: Updater<RowSelectionState>) => {
    const next = typeof updater === "function" ? updater(rowSelection) : updater;
    onRowSelectionChange(next);
  },
  getCoreRowModel: getCoreRowModel(),
});
```

**Keyboard/activation pattern to preserve** (lines 120-135):
```tsx
<div
  key={row.id}
  role={onRowActivate ? "button" : "row"}
  tabIndex={onRowActivate ? 0 : undefined}
  className={rowClassName}
  aria-selected={ariaSelected}
  onClick={() => onRowActivate?.(row.original)}
  onKeyDown={(event) => {
    if (!onRowActivate) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRowActivate(row.original);
    }
  }}
>
```

**Validation note:** Fix row/column semantics without changing public props or the Enter/Space activation contract. Add `data-table.test.tsx` before removing the Storybook a11y deferral.

---

### `apps/web/src/shared/ui/data-table.test.tsx` (test, event-driven)

**Analog:** `apps/web/src/shared/ui/filterable-data-grid.test.tsx`

**Imports pattern** (lines 1-8):
```typescript
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  FilterableDataGrid,
  type DataGridColumn,
} from "./filterable-data-grid.js";
```

**Synthetic fixture pattern** (lines 10-45):
```typescript
interface TestRow {
  id: string;
  company: string;
  provider: string;
  observed: number;
}

const rows: TestRow[] = [
  { id: "1", company: "Acme", provider: "Workday ATS", observed: 3 },
  { id: "2", company: "BoardCo", provider: "JobSpy board", observed: 8 },
  { id: "3", company: "Salesforce", provider: "Workday ATS", observed: 1 },
];

const columns: Array<DataGridColumn<TestRow>> = [
  {
    id: "company",
    label: "Company",
    rowHeader: true,
    render: (row) => row.company,
    getSortValue: (row) => row.company,
    getFilterValue: (row) => row.company,
  },
];
```

**Role/name interaction pattern** (lines 90-148):
```tsx
it("combines text predicates, multi-select values, and sortable columns", async () => {
  renderGrid();
  const user = userEvent.setup();
  const table = screen.getByRole("table");

  await user.click(screen.getByRole("button", { name: /filter company column/i }));
  await user.type(screen.getByLabelText("Company filter text"), "ac");

  expect(within(table).getByText("Acme")).toBeInTheDocument();
  expect(within(table).queryByText("BoardCo")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /sort by observed/i }));
  await user.click(screen.getByRole("button", { name: /sort by observed \(ascending\)/i }));

  const tableRows = screen.getAllByRole("row");
  expect(within(tableRows[1]!).getByText("BoardCo")).toBeInTheDocument();
});
```

**Apply to:** sortable header semantics, row role/parent semantics, `aria-sort`, click activation, Enter activation, Space activation, and `aria-selected`.

---

### `apps/web/src/shared/ui/toast.tsx` (component, event-driven)

**Analog:** `apps/web/src/shared/ui/toast.tsx`

**Imports pattern** (lines 1-11):
```typescript
import * as ToastPrimitive from "@radix-ui/react-toast";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type ReactElement,
} from "react";

import { cn } from "../lib/cn.js";
```

**Variant/token pattern** (lines 30-43):
```typescript
const toastVariants = cva(
  "group pointer-events-auto relative flex w-full items-center justify-between space-x-2 overflow-hidden rounded-md border p-4 pr-6 shadow-lg transition-all",
  {
    variants: {
      variant: {
        default: "border-border bg-background text-foreground",
        destructive: "destructive group border-destructive bg-destructive text-white",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);
```

**Close-control pattern needing accessible-name hardening** (lines 68-84):
```tsx
export const ToastClose = forwardRef<
  ComponentRef<typeof ToastPrimitive.Close>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Close
    ref={ref}
    className={cn(
      "absolute right-1 top-1 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring group-hover:opacity-100",
      className,
    )}
    toast-close=""
    {...props}
  >
    <X className="h-4 w-4" />
  </ToastPrimitive.Close>
));
```

**Apply to:** add an accessible name such as `aria-label="Close"` while preserving refs, exports, Radix `Close`, `toast-close`, icon rendering, and semantic utility classes.

---

### `apps/web/src/shared/ui/toast.a11y.test.tsx` (test, transform)

**Analog:** `apps/web/src/contexts/profile/forms/settings-form.a11y.test.tsx`

**A11y imports/test pattern** (lines 1-13):
```tsx
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { SettingsForm } from "./settings-form.js";

describe("<SettingsForm> a11y", () => {
  it("has no critical axe violations on initial render", async () => {
    const view = renderWithProviders(<SettingsForm initial={sampleSettingsResponse.settings} />);
    const results = await axe(view.container);
    expect(results).toHaveNoViolations();
  });
});
```

**Apply to:** colocated `shared/ui` a11y tests should import `axe`, render synthetic primitive markup, and assert `toHaveNoViolations()`. Use plain RTL `render` unless the primitive truly needs app providers.

---

### `apps/web/src/shared/ui/filterable-data-grid.test.tsx` (test, event-driven)

**Analog:** `apps/web/src/shared/ui/filterable-data-grid.test.tsx`

**Pagination interaction pattern** (lines 63-88):
```tsx
it("paginates local rows after filtering and sorting", async () => {
  render(
    <FilterableDataGrid
      title="Grid view"
      data={rows}
      columns={columns}
      getRowId={(row) => row.id}
      loading={false}
      loadingMessage="Loading rows."
      emptyMessage="No rows."
      initialSort={{ columnId: "company", direction: "asc" }}
      paginate
      initialPageSize={2}
      pageSizeOptions={[2, 3]}
    />,
  );
  const user = userEvent.setup();

  expect(screen.getByText("Acme")).toBeInTheDocument();
  expect(screen.queryByText("Salesforce")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "next" }));
  expect(screen.queryByText("Acme")).not.toBeInTheDocument();
  expect(screen.getByText("Salesforce")).toBeInTheDocument();
});
```

**Apply to:** extend this file rather than creating duplicate grid tests. New checks should cover row activation/focus, page-size selection, disabled pager buttons, active filter chips, and dialog close/focus where changed.

---

### `apps/web/src/shared/ui/table-pager.tsx` (component, event-driven)

**Analog:** `apps/web/src/shared/ui/table-pager.tsx`

**Core control pattern** (lines 25-58):
```tsx
return (
  <div className="pager">
    <button
      className="tab"
      type="button"
      disabled={page <= 1}
      onClick={() => onPageChange(page - 1)}
    >
      previous
    </button>
    <span className="meta">
      page {page} / {pages}
      {typeof totalRows === "number" ? ` · ${totalRows} rows` : ""}
    </span>
    <button
      className="tab"
      type="button"
      disabled={page >= pages}
      onClick={() => onPageChange(page + 1)}
    >
      next
    </button>
    <select
      aria-label="Page size"
      value={pageSize}
      onChange={(event) => onPageSizeChange(Number(event.target.value))}
    >
```

**Apply to:** keep labels `previous`, `next`, and `Page size`; preserve native disabled and select behavior while migrating any classes to semantic shadcn utilities.

---

### Shared UI Story Files (component story, event-driven)

**Analogs:** `data-table.stories.tsx`, `table-pager.stories.tsx`, `dialog.stories.tsx`, `dropdown-menu.stories.tsx`

**Story imports/args pattern** from `data-table.stories.tsx` (lines 1-18, 25-39):
```tsx
import type { ColumnDef, RowSelectionState, SortingState } from "@tanstack/react-table";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { DataTable, type DataTableProps } from "./data-table.js";

const COMMON_ARGS: DataTableProps<Row> = {
  data: ROWS,
  columns: COLUMNS,
  getRowId: (row) => row.id,
  loading: false,
  loaded: true,
  loadingMessage: "Loading…",
  emptyMessage: "No jobs.",
  rowClassName: "row",
  headerClassName: "head",
  sorting: [],
  onSortingChange: () => {},
  rowSelection: {},
  onRowSelectionChange: () => {},
};
```

**Stateful story wrapper pattern** from `table-pager.stories.tsx` (lines 22-45):
```tsx
function Stateful({
  initialPage,
  initialPageSize,
  totalPages,
  totalRows,
}: {
  initialPage: number;
  initialPageSize: number;
  totalPages: number;
  totalRows: number;
}) {
  const [page, setPage] = useState(initialPage);
  const [pageSize, setPageSize] = useState(initialPageSize);
  return (
    <TablePager
      page={page}
      pageSize={pageSize}
      totalPages={totalPages}
      totalRows={totalRows}
      onPageChange={setPage}
      onPageSizeChange={setPageSize}
    />
  );
}
```

**Open overlay story pattern** from `dialog.stories.tsx` (lines 44-60):
```tsx
export const OpenByDefault: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore this job?</DialogTitle>
          <DialogDescription>
            The job will return to the pipeline and resume from its last successful stage.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost">Cancel</Button>
          <Button>Restore</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};
```

**Menu open-state pattern** from `dropdown-menu.stories.tsx` (lines 46-58):
```tsx
export const OpenByDefault: Story = {
  render: () => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem>Open in browser</DropdownMenuItem>
        <DropdownMenuItem>Open application URL</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};
```

**Apply to:** add default, disabled, focus/open, destructive, loading, empty, selected, dense, and dark-readable states only for changed primitives. Use synthetic fixture text; avoid product workflows and real data.

---

### `apps/web/e2e/tests/shared-primitive-token-migration.spec.ts` or equivalent targeted browser proof (test, request-response)

**Analog:** `apps/web/e2e/tests/token-foundation.spec.ts`

**Computed-token helper pattern** (lines 13-25):
```typescript
async function readRootTokens(page: Page): Promise<Record<RootToken, string>> {
  return page.evaluate((tokens) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      tokens.map((token) => [token, style.getPropertyValue(token).trim()]),
    );
  }, ROOT_TOKENS) as Promise<Record<RootToken, string>>;
}

function expectRootTokens(tokens: Record<RootToken, string>): void {
  for (const token of ROOT_TOKENS) {
    expect(tokens[token], `${token} should compute to a non-empty value`).not.toBe("");
  }
}
```

**Focus proof pattern** (lines 66-93):
```typescript
async function focusByKeyboard(page: Page, target: Locator): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const isFocused = await target.evaluate((element) => element === document.activeElement);
    if (isFocused) {
      return;
    }
    await page.keyboard.press("Tab");
  }

  throw new Error("Expected to reach the theme toggle via keyboard navigation.");
}

async function expectVisibleFocusIndicator(locator: Locator): Promise<void> {
  const focus = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });

  const outlineWidth = Number.parseFloat(focus.outlineWidth);
  const hasOutline = focus.outlineStyle !== "none" && Number.isFinite(outlineWidth) && outlineWidth >= 1;
  const hasShadow = focus.boxShadow !== "none";

  expect(hasOutline || hasShadow, "focused theme control should expose a visible indicator").toBe(true);
}
```

**Density/surface proof pattern** (lines 34-42, 122-138):
```typescript
async function expectDensity(page: Page, density: "compact" | "regular" | "comfy", height: string) {
  await page.getByRole("combobox", { name: "Row density" }).selectOption(density);
  const shell = page.locator(".app-shell");

  await expect(shell).toHaveAttribute("data-density", density);
  await expect
    .poll(() => shell.evaluate((element) => getComputedStyle(element).getPropertyValue("--jh-row-height").trim()))
    .toBe(height);
}

const densityStyles = await readSurfaceStyles(page.getByRole("combobox", { name: "Row density" }));
expectPainted(densityStyles.backgroundColor, "row density select background");
expectPainted(densityStyles.borderTopColor, "row density select border");
expectPainted(densityStyles.color, "row density select foreground");
expect(densityStyles.colorScheme).toContain("dark");
```

**Apply to:** use this only when Storybook/Vitest cannot prove open overlay readability, focus return, or density behavior. Keep proof synthetic/seeded and avoid worker-backed product flows.

## Shared Patterns

### Semantic Token Utilities
**Source:** `apps/web/src/shared/ui/button.tsx`
**Apply to:** all changed shared primitive source and stories
```tsx
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
  },
);
```

### Storybook A11y Gate
**Source:** `apps/web/.storybook/preview.tsx` lines 123-139
**Apply to:** all changed shared UI stories
```typescript
a11y: {
  // Storybook 9+ a11y addon: "error" turns critical/serious axe
  // violations into a red badge on the toolbar AND fails CI when
  // run via `storybook test` or the addon-vitest integration.
  test: "error",
  config: {
    rules: [
      { id: "color-contrast", reviewOnFail: true },
    ],
  },
},
```

### Existing A11y Deferral Accounting
**Source:** `docs/backlog.md` lines 287-309 and `data-table.stories.tsx` lines 41-54
**Apply to:** `data-table.stories.tsx`, `toast.stories.tsx`, `toaster.stories.tsx`, overlay stories with existing `a11y: { test: "off" }`
```tsx
// data-table.tsx renders divs with role="row" without a role="table"
// container, and column headers carry aria-sort directly on raw <button>
// elements rather than on role="columnheader". axe flags this as a
// critical aria-allowed-attr / aria-required-parent / aria-required-children
// violation.
const meta = {
  title: "Shared/UI/DataTable",
  component: DataTable<Row>,
  parameters: {
    // a11y deferred — data-table.tsx role="row" / aria-sort defect; see meta comment above.
    a11y: { test: "off" },
  },
} satisfies Meta<typeof DataTable<Row>>;
```

Remove a deferral only after the production primitive and automated proof are updated. Add no new serious/critical deferral without a `docs/backlog.md` entry.

### Boundary Scan
**Source:** `07-RESEARCH.md` Code Examples
**Apply to:** all shared UI source, tests, and stories
```bash
rg -n 'from "(@/contexts|@/views|@/api|@/routes|@tanstack/react-query|../contexts|../views)|apiClient|useQuery|useMutation|EventSource|localStorage|navigator\.clipboard' apps/web/src/shared/ui
```

Known exception to audit but not expand: `apps/web/src/shared/ui/MarkdownDocument.tsx` imports an operations selector.

### Legacy Token Scanner
**Source:** `07-RESEARCH.md` Code Examples
**Apply to:** shared UI source/stories and Storybook config
```bash
node -e 'const fs=require("fs"); const files=process.argv.slice(1); const bad=[/\bbg-paper\b/,/\btext-ink\b/,/\bborder-rule\b/,/\bring-info\b/,/\bring-offset-paper\b/,/\bbg-bg\b/,/\btext-muted(?!-foreground)\b/,/var\(--(?:bg|paper|ink|rule|info|danger|warn|ok|font|mono|row)\)/]; let matches=[]; for (const file of files) { const text=fs.readFileSync(file,"utf8"); text.split(/\n/).forEach((line,i)=>{ if (bad.some((re)=>re.test(line))) matches.push(`${file}:${i+1}:${line.trim()}`); }); } console.log(`legacy token matches: ${matches.length}`); if (matches.length) console.log(matches.join("\n")); process.exit(matches.length?1:0);' apps/web/src/shared/ui/*.tsx apps/web/src/shared/ui/*.stories.tsx apps/web/.storybook/*.ts apps/web/components.json
```

## No Analog Found

No target file is without an analog. The weakest match is the optional targeted browser proof file, which should copy `apps/web/e2e/tests/token-foundation.spec.ts` helpers only if browser proof is required.

## Metadata

**Analog search scope:** `apps/web/src/shared/ui`, `apps/web/src/contexts/**`, `apps/web/src/views/**`, `apps/web/e2e/tests`, `apps/web/.storybook`, `docs/backlog.md`
**Files scanned:** 71 shared UI files plus targeted a11y/E2E/Storybook/backlog files
**Pattern extraction date:** 2026-06-10
