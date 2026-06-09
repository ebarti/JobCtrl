# Technology Stack: shadcn Standard-Token Migration

**Project:** JobHunter web app
**Researched:** 2026-06-09
**Scope:** Stack/package/config research only for migrating the existing React/Vite/Tailwind 4 UI from bespoke tokens to the current shadcn semantic CSS-variable token system using preset `b3F5kqmYd8`.
**Overall confidence:** HIGH for shadcn CLI/docs behavior; MEDIUM for exact final package delta because `shadcn apply` broadens scope if allowed to rewrite components.

## Summary

JobHunter already has the core framework needed for this milestone: React 19, Vite 7, Tailwind 4, `@tailwindcss/vite`, Radix primitives, `class-variance-authority`, `clsx`, and `tailwind-merge`. The migration does not need a framework change.

The required stack work is CSS/config/package alignment: introduce shadcn's semantic token names (`--background`, `--foreground`, `--card`, `--primary`, `--muted`, `--border`, `--ring`, `--chart-*`, `--sidebar-*`, `--radius`), expose them through Tailwind 4 `@theme inline`, and retire the bespoke `--bg` / `--paper` / `--ink` / `--rule` token vocabulary after callers are migrated.

Use `shadcn@latest` as a generator/probe, not as an uncontrolled rewrite tool. In a disposable probe, `shadcn@latest` was version `4.11.0`; `preset decode b3F5kqmYd8 --json` matched the milestone values and produced `https://ui.shadcn.com/create?preset=b3F5kqmYd8`. A full `apply` rewrote 22 local UI files and created 2 new files, which is broader than this token milestone. Prefer `apply --only theme` plus deliberate local edits.

## Current Repo State

- `apps/web/components.json` is already present with `cssVariables: true`, `baseColor: neutral`, `rsc: false`, `tsx: true`, aliases pointing at `@/shared/*`, `style: default`, and `iconLibrary: lucide`.
- `apps/web/package.json` already has Tailwind 4 packages and shadcn-adjacent runtime dependencies: `@tailwindcss/vite`, `tailwindcss`, `class-variance-authority`, `clsx`, `tailwind-merge`, Radix component packages, `cmdk`, `vaul`, and `lucide-react`.
- `apps/web/src/styles/tokens.css` owns bespoke variables: `--bg`, `--paper`, `--paper-2`, `--rule`, `--rule-2`, `--ink`, `--muted`, `--soft`, `--danger`, `--warn`, `--ok`, `--info`, `--font`, `--mono`, `--row`, with dark mode under `[data-theme="dark"]`.
- `apps/web/src/styles/globals.css` imports Tailwind, `@config "../../tailwind.config.ts"`, and `./tokens.css`, then uses bespoke variables directly across a large CSS surface.
- `apps/web/tailwind.config.ts` extends Tailwind with bespoke utility names (`bg`, `paper`, `ink`, `rule`, etc.) and uses `darkMode: ["selector", "[data-theme='dark']"]`.
- `apps/web/tsconfig.json` does not currently define `baseUrl` / `paths`, and `apps/web/vite.config.ts` does not define an `@` alias. The current shadcn CLI fails validation against this app until that alias contract is configured.

## Required Stack Changes

### Package changes

Add only the packages needed by the token/font/icon migration:

```bash
corepack pnpm --filter @jobhunter/web add shadcn tw-animate-css @fontsource-variable/geist @fontsource-variable/jetbrains-mono @tabler/icons-react
corepack pnpm --filter @jobhunter/web add -D @types/node
```

Rationale:

- `shadcn` is needed if `globals.css` imports `shadcn/tailwind.css`; official CLI docs say this import supplies shared Tailwind v4 utilities and animations, and `eject` can inline it later.
- `tw-animate-css` is the current shadcn/Tailwind 4 animation package; official docs say `tailwindcss-animate` is deprecated for shadcn's Tailwind v4 path.
- `@fontsource-variable/geist` and `@fontsource-variable/jetbrains-mono` match the preset fonts (`font: geist`, `fontHeading: jetbrains-mono`).
- `@tabler/icons-react` matches the preset icon library. Keep `lucide-react` until existing imports are migrated; remove it only after `rg "lucide-react" apps/web/src` is empty.
- `@types/node` is recommended by the official Vite install guide when adding the Vite `@` alias and Node path imports.

Do not add `radix-ui` or run `shadcn migrate radix` for this milestone unless the implementation intentionally rewrites local UI primitives to the new shadcn Radix aggregate package. Current components already compile against individual `@radix-ui/react-*` packages.

### `components.json`

Target configuration:

```json
{
  "style": "radix-luma",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
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
  "iconLibrary": "tabler",
  "rtl": false,
  "menuColor": "default-translucent",
  "menuAccent": "subtle",
  "registries": {}
}
```

Notes:

- `luma` preset style resolves to schema value `radix-luma`.
- Official docs say `tailwind.config` should be blank for Tailwind v4. This should be the final target after legacy color/font utilities are moved from `tailwind.config.ts` into CSS `@theme inline`.
- If migration needs an interim state, keeping `"config": "tailwind.config.ts"` and `@config "../../tailwind.config.ts"` is workable because `shadcn@4.11.0 info` and `apply` detected Tailwind v4 with the current config, but it is not the final shadcn-standard configuration.

### Vite and TypeScript alias

Add the alias contract the shadcn CLI requires before running `apply`:

- `apps/web/tsconfig.json`: add `baseUrl: "."` and `paths: { "@/*": ["./src/*"] }`.
- `apps/web/vite.config.ts`: add `resolve.alias["@"]` pointing to `apps/web/src`.

Without this, `shadcn apply b3F5kqmYd8 -c apps/web` fails at "Validating import alias" with: "Could not find valid path aliases or package imports for init."

### Global CSS/token shape

Make `apps/web/src/styles/globals.css` the owning shadcn token file:

- Keep `@import "tailwindcss";`.
- Add `@import "tw-animate-css";` and `@import "shadcn/tailwind.css";` unless choosing the ejected inline path.
- Import the selected fontsource packages.
- Add `@custom-variant dark (&:is(.dark *));`.
- Define shadcn semantic tokens on `:root` and `.dark` using the decoded sky/neutral/amber preset values.
- Expose tokens with `@theme inline`, including `--color-*`, `--radius-*`, `--font-sans`, and `--font-heading`.

Migrate utilities/classes from bespoke names to shadcn names:

| Current | shadcn target |
| --- | --- |
| `bg-paper` / `var(--paper)` | `bg-card` or `bg-background` / `var(--card)` or `var(--background)` |
| `text-ink` / `var(--ink)` | `text-foreground` / `var(--foreground)` |
| `text-muted` | `text-muted-foreground` |
| `bg-paper-2` | `bg-muted` or `bg-secondary` |
| `border-rule` / `border-rule-2` | `border-border` / `border-input` |
| `ring-info` / focus `--info` | `ring-ring` |
| `bg-danger` | `bg-destructive` |
| `--ok`, `--warn`, `--info`, `--soft`, `--row` | keep as app-specific extension tokens only if still semantically needed; expose via `@theme inline` with explicit app names |

Switch dark-mode ownership from `[data-theme="dark"]` to shadcn's `.dark` class, or temporarily support both selectors while the theme toggle is migrated. Final standard should use `.dark`.

## Official shadcn Guidance

- Vite installation docs: existing projects should add Tailwind if missing, configure `@/*` aliases in TypeScript and Vite, run `pnpm dlx shadcn@latest init`, and add components with `pnpm dlx shadcn@latest add ...`. Source: https://ui.shadcn.com/docs/installation/vite
- `components.json` docs: the file drives CLI generation; `default` style is deprecated in favor of newer styles, `cssVariables: true` generates semantic tokens like `background`, `foreground`, and `primary`, and Tailwind v4 projects should leave `tailwind.config` blank. Source: https://ui.shadcn.com/docs/components-json
- Theming docs: shadcn's default Tailwind v4 theme is CSS-first: `@custom-variant dark`, semantic OKLCH variables under `:root` / `.dark`, and `@theme inline` mappings for color/radius/sidebar/chart tokens. Source: https://ui.shadcn.com/docs/theming
- Tailwind v4 docs: shadcn supports Tailwind 4 and React 19, recommends moving variables outside `@layer base`, using `@theme inline`, removing color wrappers in chart config, and replacing `tailwindcss-animate` with `tw-animate-css`. Source: https://ui.shadcn.com/docs/tailwind-v4
- CLI docs: `init` installs dependencies and configures CSS variables; `apply` applies presets and supports `--only theme` / `--only font`; `migrate icons` exists for icon-library migration; `eject` inlines `shadcn/tailwind.css` and removes the `shadcn` dependency. Source: https://ui.shadcn.com/docs/cli
- Schema: current accepted styles include `radix-luma`; `menuColor` accepts `default-translucent`; `menuAccent` accepts `subtle`; `iconLibrary` is a string field. Source: https://ui.shadcn.com/schema.json
- Preset URL verified by CLI decode: https://ui.shadcn.com/create?preset=b3F5kqmYd8

## Commands/Validation

Verified probe commands:

```bash
corepack pnpm dlx shadcn@latest --version
# observed: 4.11.0

corepack pnpm dlx shadcn@latest preset decode b3F5kqmYd8 --json
# observed: menuColor default-translucent, menuAccent subtle, radius medium,
# font geist, iconLibrary tabler, theme sky, baseColor neutral, style luma,
# chartColor amber, fontHeading jetbrains-mono

corepack pnpm dlx shadcn@latest info -c apps/web
# observed: Vite, Tailwind v4, style default, iconLibrary lucide, no preset
```

Recommended migration command sequence:

```bash
# 1. Add TS/Vite alias first, then verify the CLI can see the app.
corepack pnpm dlx shadcn@latest info -c apps/web

# 2. Apply only the preset theme. This avoids the broad component rewrite.
corepack pnpm dlx shadcn@latest apply b3F5kqmYd8 --only theme -y -c apps/web

# 3. Manually finish package/config/font/icon/token changes listed above.

# 4. Validate the touched web surface.
corepack pnpm web:check
corepack pnpm web:build
corepack pnpm --filter @jobhunter/web test
```

If icon imports are migrated in the same milestone, also run:

```bash
rg "lucide-react|@tabler/icons-react" apps/web/src apps/web/package.json
corepack pnpm --filter @jobhunter/web test-d
```

For user-visible theme changes, add a browser QA pass and at minimum inspect light/dark mode, focus rings, table/list surfaces, dialogs/popovers/dropdowns, Storybook/a11y coverage for changed components, and the materials/apply-review surfaces.

## Risks

- **Full CLI apply is too broad.** In a disposable probe, `corepack pnpm dlx shadcn@latest apply b3F5kqmYd8 -y -c apps/web` rewrote 22 `src/shared/ui/*` files, created `src/shared/lib/utils.ts` and `src/shared/ui/input-group.tsx`, and added packages including `radix-ui`. That should be avoided unless the milestone explicitly expands from token migration to component regeneration.
- **Alias config is a hard prerequisite.** The current app fails shadcn CLI alias validation. Add `@/*` TS/Vite resolution before relying on `apply`, `add`, or future generated components.
- **`--only theme` is partial.** It appends theme tokens and menu fields but does not fully update `style` / `iconLibrary` / font packages. The final config still needs deliberate edits.
- **`--only font` can fail in the current partial state.** In a probe after theme-only apply, `apply --only font` looked under the old `styles/default` registry path and failed to find `font-geist.json`. Set/verify the final `radix-luma` style or install font packages manually.
- **Dark mode selector mismatch.** Existing CSS uses `[data-theme="dark"]`; shadcn standard uses `.dark`. A half-migration can silently produce light/dark drift unless the theme toggle and CSS selectors move together.
- **Legacy utility churn is large.** Many app CSS rules and shared UI classes use bespoke utilities (`bg-paper`, `text-ink`, `border-rule`, etc.). Keep the migration mechanical and token-focused; do not redesign components while renaming tokens.
- **Removing `tailwind.config.ts` too early will break legacy classes.** Official shadcn Tailwind v4 config wants CSS-first `@theme inline`, but JobHunter currently depends on Tailwind config extensions. Blank `tailwind.config` only after all bespoke utilities are migrated.
- **Font and icon package removal must be last.** Do not remove `lucide-react`, old font variables, or `tokens.css` until references are gone and `web:check` / `web:build` pass.
