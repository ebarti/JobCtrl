# Phase 8: Layout Chrome, Fonts, And Tabler Icons - Pattern Map

**Mapped:** 2026-06-10
**Files analyzed:** 15
**Analogs found:** 15 / 15

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `apps/web/src/shared/layout/AppShell.tsx` | component | request-response | same file | exact |
| `apps/web/src/shared/layout/Topbar.tsx` | component | event-driven navigation | same file | exact |
| `apps/web/src/shared/layout/NavBar.tsx` | component | request-response navigation | same file | exact |
| `apps/web/src/shared/layout/ThemeToggle.tsx` | component | event-driven preference update | same file | exact |
| `apps/web/src/shared/layout/ConnectionStatusPill.tsx` | component | streaming status read | same file | exact |
| `apps/web/src/shared/stores/ui-preferences.ts` | store | persisted client state | same file | exact |
| `apps/web/src/shared/providers/ThemeProvider.tsx` | provider | event-driven DOM sync | same file | exact |
| `apps/web/src/shared/providers/DensityProvider.tsx` | provider | pass-through context seam | same file | exact |
| `apps/web/index.html` | config | pre-paint file I/O | same file | exact |
| `apps/web/src/styles/globals.css` | config | transform/style cascade | same file | exact |
| `apps/web/src/styles/tokens.css` | config | token source | same file | exact |
| `apps/web/src/styles/token-contract.test.ts` | test | file I/O contract | same file | exact |
| `apps/web/e2e/tests/token-foundation.spec.ts` | test | browser proof | same file | exact |
| `apps/web/.storybook/preview.tsx` | config/provider | request-response story rendering | same file | exact |
| `apps/web/package.json` | config | dependency contract | same file | exact |

## Pattern Assignments

### `apps/web/src/shared/layout/AppShell.tsx` (component, request-response)

**Analog:** same file

**Imports and density seam** (lines 1-10):
```tsx
import { Outlet } from "@tanstack/react-router";

import { useDensity } from "../hooks/useDensity.js";
import { Topbar } from "./Topbar.js";

export function AppShell() {
  const { density } = useDensity();
  return (
    <div className="app-shell" data-density={density}>
      <Topbar />
```

**Pattern to preserve:** keep `.app-shell` and `data-density={density}` as the only density root. Do not move density to `<html>` or provider context.

### `apps/web/src/shared/layout/Topbar.tsx` (component, event-driven navigation)

**Analog:** same file

**Composition and route behavior** (lines 1-49):
```tsx
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useDensity } from "../hooks/useDensity.js";
import type { Density } from "../stores/ui-preferences.js";
import { ConnectionStatusPill } from "./ConnectionStatusPill.js";
import { NavBar } from "./NavBar.js";
import { ThemeToggle } from "./ThemeToggle.js";

const DENSITY_OPTIONS: ReadonlyArray<Density> = ["compact", "regular", "comfy"];
```

**Global search behavior** (lines 23-34):
```tsx
<input
  aria-label="Global search"
  className="global-search"
  placeholder="Filter jobs, errors, companies..."
  value={query}
  onChange={(event) => setQuery(event.target.value)}
  onKeyDown={(event) => {
    if (event.key === "Enter" && query.trim()) {
      void navigate({ to: "/jobs", search: { q: query.trim(), page: 1 } });
    }
  }}
/>
```

**Pattern to preserve:** topbar owns brand, nav, search, density, theme, and connection composition. Styling may change, but route labels, search target, density options, accessible names, and local state behavior must remain.

### `apps/web/src/shared/layout/NavBar.tsx` (component, request-response navigation)

**Analog:** same file

**Route labels and active state** (lines 1-39):
```tsx
import { Link } from "@tanstack/react-router";

const NAV_ITEMS: ReadonlyArray<{
  readonly label: string;
  readonly to:
    | "/dashboard"
    | "/apply-review"
    | "/jobs"
```

```tsx
<nav className="nav" aria-label="Main navigation">
  {NAV_ITEMS.map(({ label, to }) => (
    <Link key={to} to={to} activeProps={{ className: "on" }}>
      {label}
    </Link>
  ))}
</nav>
```

**Pattern to preserve:** keep TanStack Router `Link` and `activeProps={{ className: "on" }}`. Do not redesign route groups or rename labels.

### `apps/web/src/shared/layout/ThemeToggle.tsx` (component, event-driven preference update)

**Analog:** same file

**Behavior and accessible name** (lines 1-17):
```tsx
import { Moon, Sun } from "lucide-react";

import { useTheme } from "../hooks/useTheme.js";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="tab"
      aria-label={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
```

**Icon migration guidance:** replace `Moon`/`Sun` with `IconMoon`/`IconSun` from `@tabler/icons-react`, keep `aria-hidden="true"`, current size intent, and the visible `theme` label. Installed exports confirmed in `tabler-icons-react.d.ts`: `IconMoon` line 27516 and `IconSun` line 36876.

### `apps/web/src/shared/layout/ConnectionStatusPill.tsx` (component, streaming status read)

**Analog:** same file

**Streaming/health status pattern** (lines 22-56):
```tsx
import { useHealthQuery } from "../../contexts/operations/hooks/useHealthQuery.js";
import { useEventStreamStatus } from "../../contexts/operations/providers/EventStreamProvider.js";
import type { EventStreamStatus } from "../ports/EventStreamPort.js";

const STATUS_LABEL: Record<EventStreamStatus, string> = {
  connecting: "connecting",
  open: "live",
  closed: "reconnecting",
};
```

```tsx
const status = useEventStreamStatus();
const health = useHealthQuery();
const workerStatus = health.data?.worker.status ?? "healthy";
const workerUnhealthy = workerStatus !== "healthy";
const lostForLong = useDisconnectedLongerThan(status, CONNECTION_LOST_THRESHOLD_MS);
const label = workerUnhealthy ? "worker" : lostForLong ? "offline" : STATUS_LABEL[status];
```

**Banner roles** (lines 50-57):
```tsx
{workerUnhealthy ? (
  <div className="connection-banner" role="alert" aria-live="assertive">
    {health.data?.worker.message ?? "JobHunter automation worker health is unavailable."}
  </div>
) : lostForLong ? (
  <div className="connection-banner" role="status" aria-live="polite">
    Connection lost — events paused; data will refresh when reconnected.
  </div>
) : null}
```

**Pattern to preserve:** styling can improve, but do not hide or soften worker/offline states. Keep event stream status, health query, `aria-live`, `role="alert"`, and `role="status"`.

### `apps/web/src/shared/stores/ui-preferences.ts` (store, persisted client state)

**Analog:** same file

**Persisted shape** (lines 1-26):
```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "light" | "dark";
export type Density = "compact" | "regular" | "comfy";
```

```ts
export const useUiPreferencesStore = create<UiPreferencesState>()(
  persist(
    (set) => ({
      theme: "light",
      density: "regular",
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
    }),
    {
      name: "jh:ui-preferences",
      version: 1,
    },
  ),
);
```

**Pattern to preserve:** do not change storage key, version, or serialized shape unless a migration test proves it is required.

### `apps/web/src/shared/providers/ThemeProvider.tsx`, `DensityProvider.tsx`, and `apps/web/index.html`

**Analogs:** same files

**Theme DOM sync** (`ThemeProvider.tsx` lines 5-10):
```tsx
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);
  return <>{children}</>;
}
```

**Density provider boundary** (`DensityProvider.tsx` lines 1-8):
```tsx
// Pass-through. The density attribute is rendered on the AppShell root
// (target §4.10, plan S-05/S-06), not on <html>, to keep portaled overlays
// out of its inheritance scope.
export function DensityProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
```

**Pre-paint script** (`index.html` lines 28-48):
```html
<script>
  // Pre-paint theme to avoid FOUC. Reads the Zustand `persist` middleware
  // serialization for `useUiPreferencesStore` (key `jh:ui-preferences`,
  // shape `{state: {theme, density, ...}, version: 1}`).
  (function () {
    try {
      var raw = window.localStorage.getItem("jh:ui-preferences");
      var theme = "light";
```

**Pattern to preserve:** Vite and Storybook should share theme/density semantics; do not introduce direct storage reads in shell components. The only accepted direct `localStorage` read is the pre-paint script.

### `apps/web/src/styles/tokens.css` and `globals.css` (config, token/style cascade)

**Analogs:** same files

**Token source** (`tokens.css` lines 1-55):
```css
:root {
  color-scheme: light;
  --radius: 0.625rem;

  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
```

```css
  --jh-font-sans:
    "Geist Variable", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --jh-font-heading:
    "JetBrains Mono Variable", "Geist Variable", ui-sans-serif, system-ui, sans-serif;
  --jh-font-mono:
    "JetBrains Mono Variable", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
}
```

**Density contract** (`tokens.css` lines 105-117):
```css
:where(.app-shell) {
  --jh-row-height: 40px;
}

:where(.app-shell[data-density="compact"]) {
  --jh-row-height: 32px;
  font-size: 12px;
}

:where(.app-shell[data-density="comfy"]) {
  --jh-row-height: 48px;
  font-size: 14px;
}
```

**Shell chrome selectors** (`globals.css` lines 47-58, 117-150):
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
  background: var(--card);
  border-bottom: 1px solid var(--border);
}
```

```css
.nav a,
.nav button,
.tab {
  border: 0;
  border-radius: 5px;
  background: transparent;
  padding: 6px 10px;
  color: var(--muted-foreground);
  text-decoration: none;
}
```

**Connection chrome** (`globals.css` lines 3683-3718):
```css
.connection-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--muted);
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: 11px;
}
```

**Pattern to preserve:** use shadcn semantic tokens (`--card`, `--popover`, `--muted`, `--accent`, `--border`, `--ring`) and `.app-shell[data-density]`. Avoid viewport-based font scaling, decorative gradients/orbs, route redesign, or domain/status tone remapping.

### `apps/web/src/styles/token-contract.test.ts` (test, file I/O contract)

**Analog:** same file

**File-read contract pattern** (lines 1-25):
```ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styleDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(styleDir, "../..");
const repoRoot = resolve(webRoot, "../..");
```

**Existing icon/font/preset assertions** (lines 145-165):
```ts
expect(componentsJson.iconLibrary, "expected Tabler preset target").toBe("tabler");
expect(componentsJson.menuColor, "expected default translucent menu preset").toBe("default-translucent");
expect(componentsJson.menuAccent, "expected subtle menu preset").toBe("subtle");

expect(packageJson.dependencies["@fontsource-variable/geist"], "expected Geist font dependency").toBe("5.2.9");
expect(
  packageJson.dependencies["@fontsource-variable/jetbrains-mono"],
  "expected JetBrains Mono font dependency",
).toBe("5.2.8");
expect(packageJson.dependencies["@tabler/icons-react"], "expected Tabler icon dependency").toBe("3.44.0");
```

**Pattern to extend:** add narrow assertions here if token names, menu preset wiring, font imports, density selectors, or package icon dependencies change. Do not create a second token-contract test.

### `apps/web/e2e/tests/token-foundation.spec.ts` (test, browser proof)

**Analog:** same file

**Computed-style helpers** (lines 13-42):
```ts
async function readRootTokens(page: Page): Promise<Record<RootToken, string>> {
  return page.evaluate((tokens) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      tokens.map((token) => [token, style.getPropertyValue(token).trim()]),
    );
  }, ROOT_TOKENS) as Promise<Record<RootToken, string>>;
}
```

```ts
async function expectDensity(page: Page, density: "compact" | "regular" | "comfy", height: string) {
  await page.getByRole("combobox", { name: "Row density" }).selectOption(density);
  const shell = page.locator(".app-shell");

  await expect(shell).toHaveAttribute("data-density", density);
  await expect
    .poll(() => shell.evaluate((element) => getComputedStyle(element).getPropertyValue("--jh-row-height").trim()))
    .toBe(height);
}
```

**Browser proof pattern** (lines 95-143):
```ts
test("token foundation computes light/dark app-shell tokens and density values", async ({ page }) => {
  await page.goto("/dashboard");

  const themeButton = page.getByRole("button", { name: /Switch to dark theme/i });
  await expect(themeButton).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".topbar")).toBeVisible();
```

**Pattern to extend:** add Phase 8 shell assertions here or in a sibling Playwright spec: global search Enter to `/jobs?q=...&page=1`, active nav styling, connection pill/banner styles, light/dark shell surfaces, density persistence across navigation/reload, and stable icon control dimensions.

### `apps/web/.storybook/preview.tsx` (config/provider, request-response story rendering)

**Analog:** same file

**Provider parity** (lines 48-109):
```tsx
function ThemeBridge({ theme, children }: { theme: "light" | "dark"; children: ReactNode }): ReactElement {
  const setTheme = useUiPreferencesStore((state) => state.setTheme);
  useEffect(() => {
    setTheme(theme);
  }, [theme, setTheme]);
  return <>{children}</>;
}
```

```tsx
return (
  <PortsProvider ports={ports}>
    <TenantProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeBridge theme={theme}>
          <ThemeProvider>
            <DensityProvider>
              <TooltipProvider>
                <ToasterProvider>
                  <div className="min-h-[80vh] bg-background p-6 text-foreground">{inner}</div>
```

**Pattern to preserve:** Storybook must import `globals.css`, use the same providers, and drive theme through the UI preference store. If density globals are added, bridge them through `useUiPreferencesStore` here instead of creating story-only CSS behavior.

### `apps/web/package.json` and icon imports (config, dependency contract)

**Analog:** same file plus current import audit

**Dependencies** (`apps/web/package.json` lines 40-50):
```json
"@tabler/icons-react": "3.44.0",
"lucide-react": "^1.14.0",
```

**Current lucide import inventory:**

| File | Current icons | Guidance |
|------|---------------|----------|
| `apps/web/src/shared/layout/ThemeToggle.tsx` | `Moon`, `Sun` | Phase 8 priority: `IconMoon`, `IconSun` |
| `apps/web/src/shared/ui/select.tsx` | `Check`, `ChevronDown`, `ChevronUp` | Shared primitive affordance: `IconCheck`, `IconChevronDown`, `IconChevronUp` |
| `apps/web/src/shared/ui/dropdown-menu.tsx` | `Check`, `ChevronRight`, `Circle` | Shared primitive affordance: `IconCheck`, `IconChevronRight`, `IconCircle` |
| `apps/web/src/shared/ui/command.tsx` | `Search` | Shared primitive affordance: `IconSearch` |
| `apps/web/src/shared/ui/copyable-command.tsx` | `Check`, `Copy` | Shared primitive affordance: `IconCheck`, `IconCopy` |
| `apps/web/src/shared/ui/dialog.tsx`, `sheet.tsx`, `toast.tsx` | `X` | Shared close affordance: `IconX` |
| `apps/web/src/shared/ui/filterable-data-grid.tsx` | `Filter`, `SortAsc`, `SortDesc`, `TableProperties`, `X` | Use confirmed exports where obvious: `IconFilter`, `IconSortAscending`, `IconSortDescending`, `IconTable`, `IconX`; verify `TableProperties` meaning before replacing |
| Domain/view controls under `contexts/*` and `views/*` | external link, play, refresh, wand, plus/trash, etc. | Only migrate if user-visible control meaning is obvious and behavior/tests remain unchanged; otherwise document deferral |

**Confirmed local Tabler exports:** `IconCheck`, `IconChevronDown`, `IconChevronRight`, `IconChevronUp`, `IconCircle`, `IconCopy`, `IconExternalLink`, `IconFilter`, `IconMoon`, `IconPlayerPlay`, `IconPlus`, `IconRefresh`, `IconRotateClockwise`, `IconSearch`, `IconSortAscending`, `IconSortDescending`, `IconSparkles`, `IconSun`, `IconTable`, `IconTrash`, `IconWand`, and `IconX` exist in `node_modules/.pnpm/@tabler+icons-react@3.44.0_react@19.2.5/node_modules/@tabler/icons-react/dist/tabler-icons-react.d.ts`.

## Shared Patterns

### Accessibility
**Source:** `Topbar.tsx`, `ThemeToggle.tsx`, `NavBar.tsx`, `ConnectionStatusPill.tsx`

Apply to all shell/chrome changes:

- Preserve `aria-label="Global search"`, `aria-label="Row density"`, and `aria-label={`Switch to ${next} theme`}`.
- Decorative icons remain `aria-hidden="true"`.
- `ConnectionStatusPill` keeps `aria-live` plus `role="alert"` for worker health and `role="status"` for long disconnection.
- Keep stable control dimensions for icon-only or icon+label controls.

### Persistence
**Source:** `ui-preferences.ts`, `ThemeProvider.tsx`, `DensityProvider.tsx`, `index.html`

Apply to theme/density work:

- `jh:ui-preferences` and `version: 1` remain canonical.
- `<html data-theme>` is driven by `ThemeProvider` after hydration and by the pre-paint script before hydration.
- Density is rendered on `.app-shell[data-density]` and consumed through `--jh-row-height`.

### Styling
**Source:** `tokens.css`, `globals.css`

Apply to shell/nav/menu/tab/chrome work:

- Use semantic tokens, not one-off colors.
- Keep Geist body and JetBrains Mono heading/technical/mono variables.
- Keep app shell dense and operational.
- Prefer more opaque semantic surfaces if translucent chrome loses readability.

### Verification
**Source:** `token-contract.test.ts`, `token-foundation.spec.ts`, `.storybook/preview.tsx`

Apply to Phase 8 plans:

- Extend token contract tests for static token/config/dependency assertions.
- Extend Playwright browser proof for computed surfaces, density, theme, search, nav active state, and icon dimensions.
- Run Storybook build/test when provider, story, or shared primitive story behavior changes.

## Likely Write Surfaces

| Surface | Why |
|---------|-----|
| `apps/web/src/shared/layout/*.tsx` | App shell chrome, topbar/nav/theme/status icon and class updates |
| `apps/web/src/shared/stores/ui-preferences.ts` | Only if a tested migration is unavoidable; otherwise do not change |
| `apps/web/src/shared/providers/ThemeProvider.tsx`, `DensityProvider.tsx` | Only for provider parity fixes; preserve current API |
| `apps/web/index.html` | Only if pre-paint proof requires a narrow script adjustment |
| `apps/web/src/styles/globals.css` | Main shell/nav/topbar/tab/control chrome styling |
| `apps/web/src/styles/tokens.css` | Token source, font variables, density variables |
| `apps/web/src/styles/token-contract.test.ts` | Static token/package/config contract |
| `apps/web/e2e/tests/token-foundation.spec.ts` | Browser proof for Phase 8 shell behavior |
| `apps/web/.storybook/preview.tsx` | Storybook theme/density parity if globals change |
| `apps/web/src/shared/ui/*.tsx` | Optional shared primitive icon migration only; do not rewrite behavior |
| `apps/web/package.json` | Do not remove `lucide-react` in Phase 8 unless imports are truly zero and the plan explicitly includes cleanup |

## Boundary Rules And Anti-Patterns

- Do not change route structure, route labels, loaders, search contracts, mutations, query keys, SSE invalidation, API behavior, or worker behavior.
- Do not move shell behavior into bounded contexts; shell remains under `shared/layout`.
- Do not add direct `localStorage`, `EventSource`, `apiClient`, `queryClient`, or platform calls in shell components.
- Do not infer or remap domain/status tones for scoring, pipeline, apply, materials, discovery, audit, stale, missing, or blocked states; Phase 9 owns that.
- Do not hide connection/worker warnings or rename them into less operational copy.
- Do not use viewport-width font scaling, experimental style-query-only density behavior, decorative gradients, orb backgrounds, or marketing/hero chrome.
- Do not silently leave mixed user-visible icon libraries; migrate or record explicit deferrals.

## No Analog Found

No unmatched files. Phase 8 work maps directly to existing shell, provider, token, Storybook, and browser-proof surfaces.

## Metadata

**Analog search scope:** `apps/web/src/shared`, `apps/web/src/styles`, `apps/web/e2e/tests`, `apps/web/.storybook`, `apps/web/package.json`, `package.json`, local `@tabler/icons-react` type declarations
**Files scanned:** 15 focused files plus lucide/Tabler import audit
**Pattern extraction date:** 2026-06-10
