---
phase: 09-domain-and-status-surface-migration
researched: 2026-06-10T12:51:53Z
status: complete
---

# Phase 09 Research

## Modern Web Guidance

Queried `modern-web-guidance` for CSS status badges, typed state tokens, contrast, and React dashboard usage.

Relevant guidance:

- Use ordinary selectors or data attributes for core behavior instead of relying on container style queries where browser support is not universal.
- Status should not be represented by color alone; pair color with visible text, shape, or iconography.
- Focus and component boundaries need visible contrast.
- Prefer semantic HTML and accessible names for interactive controls; keep decorative icons `aria-hidden`.

## Static Code Audit

Commands used:

- `rg "lucide-react|@tabler/icons-react" apps/web/src apps/web/package.json`
- `rg "chart-" apps/web/src`
- `rg "className=\\{`[^`]*\\$\\{|`tag \\$\\{|`fit \\$\\{|`stage-pill \\$\\{|`status-dot \\$\\{|tone-\\$\\{|source-table" apps/web/src/contexts apps/web/src/views apps/web/src/shared -g "*.tsx" -g "*.ts"`
- `rg "bg-paper|text-ink|border-rule|ring-info|--paper|--ink|--rule|--info|--danger|--warn|--ok" apps/web/src/contexts apps/web/src/views apps/web/src/shared`

Findings:

- Chart tokens are defined in `tokens.css`/`globals.css` and asserted in tests; status components are not using `chart-*` utilities.
- `shared/ui` and `shared/layout` have no `lucide-react` imports after Phase 8.
- Remaining `lucide-react` imports are domain/view controls deferred by Phase 8.
- Dynamic status classes are narrow but some helper APIs return `string` and some shared primitives accept arbitrary state names.
- Legacy token utility names are not present in the audited status component source.

## Candidate Fixes

- Add a shared status visual vocabulary for tag/dot/segment/timeline tones, or narrow the existing helpers in place if a shared abstraction would be too invasive.
- Replace arbitrary class construction in `StatusDot` and `SegmentBar` with typed accepted vocabularies.
- Tighten helper return types for `scoreTier`, `artifactStatusTone`, debug activity level tags, application outcome dots, KPI tones, and audit timeline tones.
- Convert remaining domain icons to Tabler equivalents where available.

