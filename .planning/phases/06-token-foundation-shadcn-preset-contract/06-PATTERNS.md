# Phase 06: Token Foundation + shadcn Preset Contract - Pattern Map

**Mapped:** 2026-06-09  
**Files analyzed:** 11  
**Analogs found:** 11 / 11

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `apps/web/src/styles/tokens.css` | config | transform | `apps/web/src/styles/tokens.css` | exact-self |
| `apps/web/src/styles/globals.css` | config | transform | `apps/web/src/styles/globals.css` | exact-self |
| `apps/web/components.json` | config | transform | `apps/web/components.json` | exact-self |
| `apps/web/vite.config.ts` | config | request-response/build | `apps/web/vite.config.ts` | exact-self |
| `apps/web/tsconfig.json` | config | transform/build | `apps/web/tsconfig.json` | exact-self |
| `apps/web/package.json` | config | batch/dependency-resolution | `apps/web/package.json` | exact-self |
| `pnpm-lock.yaml` | config | batch/dependency-resolution | `pnpm-lock.yaml` | exact-self |
| `apps/web/tailwind.config.ts` deletion | config | transform/build | `apps/web/tailwind.config.ts` | exact-self |
| `apps/web/src/styles/token-contract.test.ts` | test | transform/static | `apps/web/src/contexts/operations/every-event-has-handler.test.ts` | role-match |
| Browser smoke proof/checklist or spec | test | request-response/browser | `apps/web/e2e/tests/dashboard.spec.ts` | role-match |
| Minimal `apps/web/src/shared/ui/*` class edits | component | transform | `apps/web/src/shared/ui/button.tsx` + `input.tsx` + `dropdown-menu.tsx` | exact-role |

## Pattern Assignments

### `apps/web/src/styles/tokens.css` (config, transform)

**Analog:** `apps/web/src/styles/tokens.css`

**Current token ownership pattern** (lines 1-17):
```css
:root {
  --bg: #fafaf7;
  --paper: #fff;
  --paper-2: #f5f4ef;
  --rule: rgba(20, 18, 12, 0.1);
  --rule-2: rgba(20, 18, 12, 0.18);
  --ink: #1d1c18;
  --muted: #737067;
  --soft: #a09c90;
  --danger: #b5473a;
  --warn: #a97721;
  --ok: #397b57;
  --info: #617892;
  --font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: "SFMono-Regular", ui-monospace, Menlo, monospace;
  --row: 42px;
}
```

**Theme and density seam to preserve, with renamed tokens** (lines 19-42):
```css
[data-density="compact"] {
  --row: 34px;
  font-size: 12px;
}

[data-density="comfy"] {
  --row: 50px;
  font-size: 14px;
}

[data-theme="dark"] {
  --bg: #14130f;
  --paper: #1a1814;
  --paper-2: #221f1a;
  --rule: rgba(255, 255, 255, 0.08);
  --rule-2: rgba(255, 255, 255, 0.16);
  --ink: #f1eee5;
  --muted: #aaa69a;
  --soft: #777368;
  --danger: #d86c5d;
  --warn: #d0a34a;
  --ok: #69aa83;
  --info: #88a1bc;
}
```

**Copy pattern:** keep token definitions centralized in this file, but replace legacy public names with shadcn semantic variables and app-specific semantic status extensions. Preserve `[data-theme="dark"]` compatibility and move row-height density to clean names such as `--jh-row-height` or equivalent.

---

### `apps/web/src/styles/globals.css` (config, transform)

**Analog:** `apps/web/src/styles/globals.css`

**Import/base pattern to replace in place** (lines 1-34):
```css
@import "tailwindcss";
@config "../../tailwind.config.ts";
@import "./tokens.css";

@layer base {
  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font);
    font-size: 13px;
  }

  button,
  input,
  select,
  textarea {
    color: inherit;
    font: inherit;
  }

  button {
    cursor: pointer;
  }

  :focus-visible {
    outline: 2px solid var(--info);
    outline-offset: 2px;
  }
}
```

**App shell/nav token use** (lines 42-53, 112-131):
```css
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  padding: 14px 24px;
  background: var(--paper);
  border-bottom: 1px solid var(--rule);
}

.nav a,
.nav button,
.tab {
  border: 0;
  border-radius: 5px;
  background: transparent;
  padding: 6px 10px;
  color: var(--muted);
  text-decoration: none;
}

.nav a:hover,
.nav a.on,
.nav button:hover,
.nav button.on,
.tab:hover,
.tab.on {
  background: var(--paper-2);
  color: var(--ink);
}
```

**Density and status data examples** (lines 477-495, 529-543, 1703-1724):
```css
.funnel-row {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: inherit;
  grid-template-columns: subgrid;
  align-items: center;
  gap: 14px;
  min-height: var(--row);
  border: 0;
  border-radius: 5px;
  background: transparent;
  padding: 8px 10px;
  text-align: left;
}

.funnel-row:hover,
.data-row:hover {
  background: var(--paper-2);
}

.seg-done {
  background: var(--ink);
}

.seg-failed {
  background: var(--danger);
}

.seg-blocked {
  background: var(--warn);
}

.seg-running {
  background: var(--info);
}

.stage-progress-meter {
  flex: 0 1 180px;
  width: min(180px, 100%);
  height: 8px;
  border: 0;
  border-radius: 999px;
  accent-color: var(--ok);
}
```

**Copy pattern:** keep global styles in the single web CSS entrypoint. Replace `@config` with CSS-first `@theme inline` if `tailwind.config.ts` is deleted. Use semantic shadcn utilities/vars for surfaces and explicit semantic status extensions for lifecycle/status colors. Do not move route/view styling into bounded contexts in this phase.

---

### `apps/web/components.json` (config, transform)

**Analog:** `apps/web/components.json`

**Existing shadcn config shape** (lines 1-21):
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/styles/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/shared/ui",
    "utils": "@/shared/lib/cn",
    "ui": "@/shared/ui",
    "lib": "@/shared/lib",
    "hooks": "@/shared/hooks"
  },
  "iconLibrary": "lucide"
}
```

**Copy pattern:** preserve `rsc: false`, `tsx: true`, CSS file path, `baseColor: neutral`, `cssVariables: true`, and `@/shared/*` aliases. Change only target fields required by Phase 6: luma/radix-luma style/preset fields, Tabler icon target, menu fields, and blank/removed `tailwind.config` if CSS-first mode works.

---

### `apps/web/vite.config.ts` (config, request-response/build)

**Analog:** `apps/web/vite.config.ts`

**Imports and plugin/root pattern** (lines 1-17):
```ts
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  root: fileURLToPath(new URL(".", import.meta.url)),
  envPrefix: "VITE_",
```

**Server/build pattern to preserve** (lines 18-29):
```ts
server: {
  port: 5173,
  strictPort: false,
  proxy: {
    "/v1": process.env["VITE_DEV_API_PROXY_TARGET"] ?? "http://127.0.0.1:8766",
  },
},
build: {
  outDir: "../../dist/web",
  emptyOutDir: true,
},
```

**Copy pattern:** add `resolve.alias` using the existing `fileURLToPath(new URL(...))` style. Do not disturb TanStack Router, React, Tailwind Vite plugin, dev proxy, or build output settings.

---

### `apps/web/tsconfig.json` (config, transform/build)

**Analog:** `apps/web/tsconfig.json`

**Current compiler/include shape** (lines 1-21):
```json
{
  "extends": "../../packages/tsconfig/react.json",
  "compilerOptions": {
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true
  },
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "test/**/*.ts",
    "test/**/*.tsx",
    "e2e/**/*.ts",
    "e2e/**/*.tsx",
    ".storybook/**/*.ts",
    ".storybook/**/*.tsx",
    "vite.config.ts",
    "vitest.config.ts",
    "vitest.types.config.ts",
    "tailwind.config.ts"
  ]
}
```

**Copy pattern:** keep strict optional/index flags and existing include coverage. Add `baseUrl`/`paths` under `compilerOptions` for `@/* -> ./src/*`. If `tailwind.config.ts` is deleted, remove it from `include` in the same patch.

---

### `apps/web/package.json` and `pnpm-lock.yaml` (config, batch/dependency-resolution)

**Analog:** `apps/web/package.json`; lock analog `pnpm-lock.yaml`

**Package dependency grouping** (`apps/web/package.json` lines 21-55, 56-90):
```json
"dependencies": {
  "@jobhunter/api-client": "workspace:*",
  "@jobhunter/contracts": "workspace:*",
  "@jobhunter/domain-types": "workspace:*",
  "@radix-ui/react-checkbox": "^1.3.3",
  "...": "...",
  "lucide-react": "^1.14.0",
  "react": "^19.2.3",
  "react-dom": "^19.2.3",
  "tailwind-merge": "^3.5.0",
  "zod": "^4.4.3",
  "zustand": "^5.0.13"
},
"devDependencies": {
  "@jobhunter/tsconfig": "workspace:*",
  "@playwright/test": "^1.50.0",
  "@tailwindcss/vite": "^4.2.4",
  "tailwindcss": "^4.2.4",
  "typescript": "^6.0.3",
  "vite": "^7.3.0",
  "vitest": "^4.1.5"
}
```

**Lock importer pattern** (`pnpm-lock.yaml` lines 58-158, 159-258):
```yaml
apps/web:
  dependencies:
    '@jobhunter/api-client':
      specifier: workspace:*
      version: link:../../packages/api-client
    '@radix-ui/react-checkbox':
      specifier: ^1.3.3
      version: 1.3.3(...)
    lucide-react:
      specifier: ^1.14.0
      version: 1.14.0(react@19.2.5)
    react:
      specifier: ^19.2.3
      version: 19.2.5
  devDependencies:
    '@tailwindcss/vite':
      specifier: ^4.2.4
      version: 4.2.4(vite@7.3.2(...))
    tailwindcss:
      specifier: ^4.2.4
      version: 4.2.4
```

**Copy pattern:** add runtime style/preset packages under `apps/web.dependencies`: `shadcn`, `tw-animate-css`, `@fontsource-variable/geist`, `@fontsource-variable/jetbrains-mono`, `@tabler/icons-react`. Add `@types/node` under web `devDependencies` only if the Vite alias implementation needs it. Let pnpm update the importer and package snapshots; do not hand-edit integrity blocks.

---

### `apps/web/tailwind.config.ts` deletion (config, transform/build)

**Analog:** `apps/web/tailwind.config.ts`

**Legacy bridge to remove if CSS-first succeeds** (lines 1-28):
```ts
import type { Config } from "tailwindcss";

export default {
  darkMode: ["selector", "[data-theme='dark']"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        paper: "var(--paper)",
        "paper-2": "var(--paper-2)",
        rule: "var(--rule)",
        "rule-2": "var(--rule-2)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        soft: "var(--soft)",
        danger: "var(--danger)",
        warn: "var(--warn)",
        ok: "var(--ok)",
        info: "var(--info)",
      },
      fontFamily: {
        sans: ["var(--font)"],
        mono: ["var(--mono)"],
      },
    },
  },
} satisfies Config;
```

**Copy pattern:** do not preserve this file as a compatibility bridge unless implementation proves CSS-first mode cannot build. If deleted, also remove `@config "../../tailwind.config.ts"` from `globals.css`, blank/remove `components.json.tailwind.config`, and remove `tailwind.config.ts` from `tsconfig.json` includes.

---

### `apps/web/src/styles/token-contract.test.ts` (test, transform/static)

**Analog:** `apps/web/src/contexts/operations/every-event-has-handler.test.ts`

**Static contract test pattern** (lines 1-16, 18-38):
```ts
import { DOMAIN_EVENT_TYPES, LOCAL_TENANT, type DomainEventType } from "@jobhunter/domain-types";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { eventByType } from "../../test/fixtures/events.js";
import { dispatch, handlers, invalidationRouter } from "./invalidation-router.js";

const ALLOW_EMPTY_HANDLERS: ReadonlySet<DomainEventType> = new Set();

describe("event-handler parity (the most important test in the app)", () => {
  it("DOMAIN_EVENT_TYPES is the source of truth (frontend mirrors it 1:1)", () => {
    expect(DOMAIN_EVENT_TYPES.length).toBeGreaterThan(0);
    for (const eventType of DOMAIN_EVENT_TYPES) {
      expect(eventByType[eventType]).toBeDefined();
    }
  });

  for (const eventType of DOMAIN_EVENT_TYPES) {
    it(`registers a working handler for ${eventType}`, () => {
      const handler = handlers[eventType];
      expect(handler, `expected handlers["${eventType}"] to exist`).toBeDefined();
      const event = eventByType[eventType];
      const queryClient = new QueryClient();
      expect(() => invalidationRouter.handle(event, queryClient)).not.toThrow();
    });

    it(`returns at least one InvalidationItem for ${eventType}`, () => {
      if (ALLOW_EMPTY_HANDLERS.has(eventType)) {
        return;
      }
      const event = eventByType[eventType];
      const items = dispatch(event);
      expect(
        items.length,
        `${eventType} handler returned [] — looks like a stub. Add to ALLOW_EMPTY_HANDLERS only with a documented reason linking back to §8.4.`,
      ).toBeGreaterThan(0);
    });
  }
});
```

**Vitest include pattern** (`apps/web/vitest.config.ts` lines 13-19):
```ts
test: {
  environment: "jsdom",
  globals: true,
  setupFiles: ["./src/test/setup.ts"],
  css: false,
  include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
  exclude: ["node_modules", "dist", "e2e", "test/types"],
},
```

**Copy pattern:** create a colocated `src/**/*.test.ts` static contract test. Use arrays of required semantic token names, dark token selectors, required package/config values, and forbidden legacy names. Use explicit failure messages for missing tokens and forbidden bridge names. If reading CSS/package files is required, use Node fs/path imports and keep assertions deterministic.

---

### Browser smoke proof/checklist or spec (test, request-response/browser)

**Analog:** `apps/web/e2e/tests/dashboard.spec.ts`; config analog `apps/web/e2e/playwright.config.ts`

**Browser assertion pattern** (`dashboard.spec.ts` lines 1-14, 16-30, 44-49):
```ts
import { test, expect } from "@playwright/test";

test("Dashboard renders KPIs, click 'Jobs' KPI navigates to /jobs and row count matches", async ({
  page,
}) => {
  await page.goto("/dashboard");

  const jobsKpi = page.getByRole("button", { name: /jobs/i }).first();
  await expect(jobsKpi).toBeVisible({ timeout: 30_000 });

  const jobsValueText = await jobsKpi.locator(".kpi-val").innerText();
  const totalJobs = Number.parseInt(jobsValueText.trim(), 10);
  expect(Number.isFinite(totalJobs)).toBe(true);
  expect(totalJobs).toBeGreaterThan(0);

  const overlappingLegendLabels = await page.evaluate(() => {
    function overlaps(a: DOMRect, b: DOMRect): boolean {
      return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    }
    return [...document.querySelectorAll(".funnel-row")].flatMap((row) => {
      const bar = row.querySelector(".bar");
      if (!bar) return [];
      const barRect = bar.getBoundingClientRect();
      return [...row.querySelectorAll(".legend > span")]
        .filter((label) => overlaps(barRect, label.getBoundingClientRect()))
        .map((label) => label.textContent?.trim() ?? "");
    });
  });
  expect(overlappingLegendLabels).toEqual([]);

  await jobsKpi.click();
  await expect(page).toHaveURL(/\/jobs\b/);
  const rows = page.locator("table.jobs-data-grid-table tbody tr");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => rows.count(), { timeout: 30_000 }).toBe(totalJobs);
});
```

**Safe E2E environment pattern** (`playwright.config.ts` lines 9-24, 53-85):
```ts
const E2E_DIR =
  process.env["JOBHUNTER_E2E_APP_DIR"] ?? path.join(os.tmpdir(), "jobhunter-e2e-current");
const E2E_DB = process.env["JOBHUNTER_E2E_DB_PATH"] ?? path.join(E2E_DIR, "jobhunter.db");
process.env["JOBHUNTER_E2E_APP_DIR"] = E2E_DIR;
process.env["JOBHUNTER_E2E_DB_PATH"] = E2E_DB;

webServer: [
  {
    command: "corepack pnpm --filter @jobhunter/api dev",
    port: Number(API_PORT),
    cwd: repoRoot,
    env: {
      JOBHUNTER_API_PORT: API_PORT,
      JOBHUNTER_DIR: E2E_DIR,
      JOBHUNTER_DB_PATH: E2E_DB,
      JOBHUNTER_E2E_STUB_DISPATCH: "1",
    },
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
  {
    command: `corepack pnpm --filter @jobhunter/web exec vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
    port: Number(WEB_PORT),
    cwd: repoRoot,
    env: {
      VITE_JOBHUNTER_API_BASE_URL: "",
      VITE_DEV_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
    },
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
],
```

**Copy pattern:** browser proof should use `/dashboard` and `/jobs`, `page.evaluate` for computed styles, and existing safe E2E temp paths/stub dispatch. Assert light/dark computed colors, `data-density` row heights, visible focus ring, and at least one dropdown/popover surface. Do not trigger apply, mailbox, material generation, profile destruction, or worker-backed jobs.

---

### Minimal `apps/web/src/shared/ui/*` class edits (component, transform)

**Analogs:** `apps/web/src/shared/ui/button.tsx`, `input.tsx`, `dropdown-menu.tsx`, `cn.ts`

**Class composition helper** (`cn.ts` lines 1-6):
```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

**Variant primitive pattern** (`button.tsx` lines 1-18, 39-49):
```tsx
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../lib/cn.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-ink text-paper hover:bg-ink/90",
        destructive: "bg-danger text-paper hover:bg-danger/90",
        outline: "border border-rule-2 bg-paper hover:bg-paper-2",
        secondary: "bg-paper-2 text-ink hover:bg-paper-2/80",
        ghost: "hover:bg-paper-2",
        link: "text-info underline-offset-4 hover:underline",
      },
```

**Non-variant primitive pattern** (`input.tsx` lines 1-20):
```tsx
import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "../lib/cn.js";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-rule-2 bg-paper px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = "Input";
```

**Overlay primitive pattern** (`dropdown-menu.tsx` lines 1-10, 53-68, 71-85):
```tsx
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type HTMLAttributes,
} from "react";

import { cn } from "../lib/cn.js";

export const DropdownMenuContent = forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-[8rem] overflow-hidden rounded-md border border-rule bg-paper p-1 text-ink shadow-md",
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));

export const DropdownMenuItem = forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-paper-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
```

**Copy pattern:** keep the Radix/forwardRef/cn/cva structure. Only mechanically replace legacy classes (`bg-paper`, `text-ink`, `border-rule`, `ring-info`, etc.) with standard semantic utilities (`bg-background`, `text-foreground`, `bg-card`, `bg-popover`, `border-border`, `ring-ring`, `bg-primary`, `text-primary-foreground`, etc.) as needed for grep-clean Phase 6. Do not do broad primitive redesign or icon migration except where the preset contract requires package/config alignment.

## Shared Patterns

### Theme Selector
**Source:** `apps/web/src/shared/providers/ThemeProvider.tsx` lines 5-10  
**Apply to:** `tokens.css`, `globals.css`, browser smoke
```tsx
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);
  return <>{children}</>;
}
```

Use `[data-theme="dark"]` / `:root[data-theme="dark"]` token overrides and `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));`. Do not leave a `.dark`-only theme contract.

### Density Scope
**Source:** `apps/web/src/shared/layout/AppShell.tsx` lines 6-15  
**Apply to:** `tokens.css`, `globals.css`, browser smoke
```tsx
export function AppShell() {
  const { density } = useDensity();
  return (
    <div className="app-shell" data-density={density}>
      <Topbar />
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
```

Keep density app-shell scoped. Prefer low-specificity selectors such as `:where(.app-shell[data-density="compact"])` and explicit final row-height variables over global `<html>` density behavior.

### Storybook Global CSS Wrapper
**Source:** `apps/web/.storybook/preview.tsx` lines 1, 91-105, 123-130  
**Apply to:** Storybook token cleanup and primitive stories
```tsx
import "../src/styles/globals.css";

return (
  <PortsProvider ports={ports}>
    <TenantProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeBridge theme={theme}>
          <ThemeProvider>
            <DensityProvider>
              <TooltipProvider>
                <ToasterProvider>
                  <div className="min-h-[80vh] bg-bg p-6 text-ink">{inner}</div>
                </ToasterProvider>
              </TooltipProvider>
            </DensityProvider>
          </ThemeProvider>
        </ThemeBridge>
      </QueryClientProvider>
    </TenantProvider>
  </PortsProvider>
);
```

This wrapper imports `globals.css` and currently contains legacy utility classes. Include Storybook preview in the grep-clean mechanical token replacement if production/story surfaces are in the exit gate.

### Verification Commands
**Source:** `06-VALIDATION.md` and existing scripts in `apps/web/package.json` lines 6-19  
**Apply to:** plan verification
```json
"scripts": {
  "dev": "vite --host 127.0.0.1",
  "check": "tsc --noEmit --project tsconfig.json",
  "build": "vite build",
  "preview": "vite preview --host 127.0.0.1",
  "test": "vitest run",
  "test-d": "vitest run --config vitest.types.config.ts",
  "e2e": "playwright test --config=e2e/playwright.config.ts"
}
```

Required exit proof: `corepack pnpm web:check`, `corepack pnpm web:build`, `corepack pnpm dlx shadcn@latest info -c apps/web`, legacy token grep, CSS output grep for semantic utilities, browser smoke, and `git diff --check`.

## No Analog Found

None. Every Phase 6 planning-relevant file has an existing exact or role-match analog in the codebase.

## Metadata

**Analog search scope:** `apps/web/src/styles`, `apps/web/src/shared/ui`, `apps/web/src/shared/providers`, `apps/web/src/shared/layout`, `apps/web/e2e`, `apps/web/.storybook`, web config files, `pnpm-lock.yaml`  
**Files scanned:** 100+ web source/config/test paths via `rg --files`; 11 primary analogs read  
**Pattern extraction date:** 2026-06-09
