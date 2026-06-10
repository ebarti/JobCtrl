---
phase: 08-layout-chrome-fonts-and-tabler-icons
audited: 2026-06-10T12:23:42Z
status: passed
scope: shell-and-shared-chrome
---

# Phase 08 Icon Audit

## Result

Shell and shared primitive affordance icons have moved to `@tabler/icons-react`. `apps/web/src/shared/ui` and `apps/web/src/shared/layout` have zero `lucide-react` imports.

`lucide-react` remains in `apps/web/package.json` because domain and view components still import it. Dependency removal is owned by Phase 11 after Phase 9 migrates status/domain icon semantics.

## Migrated Icons

| File | Previous | Tabler |
|------|----------|--------|
| `apps/web/src/shared/layout/ThemeToggle.tsx` | `Moon`, `Sun` | `IconMoon`, `IconSun` |
| `apps/web/src/shared/ui/command.tsx` | `Search` | `IconSearch` |
| `apps/web/src/shared/ui/copyable-command.tsx` | `Check`, `Copy` | `IconCheck`, `IconCopy` |
| `apps/web/src/shared/ui/select.tsx` | `Check`, `ChevronDown`, `ChevronUp` | `IconCheck`, `IconChevronDown`, `IconChevronUp` |
| `apps/web/src/shared/ui/dropdown-menu.tsx` | `Check`, `ChevronRight`, `Circle` | `IconCheck`, `IconChevronRight`, `IconCircle` |
| `apps/web/src/shared/ui/checkbox.tsx` | `Check` | `IconCheck` |
| `apps/web/src/shared/ui/dialog.tsx` | `X` | `IconX` |
| `apps/web/src/shared/ui/sheet.tsx` | `X` | `IconX` |
| `apps/web/src/shared/ui/toast.tsx` | `X` | `IconX` |
| `apps/web/src/shared/ui/filterable-data-grid.tsx` | `Filter`, `SortAsc`, `SortDesc`, `Table`, `X` | `IconFilter`, `IconSortAscending`, `IconSortDescending`, `IconTable`, `IconX` |

## Remaining Lucide Imports

| File | Icons | Category | Deferral |
|------|-------|----------|----------|
| `apps/web/src/views/apply-review/ApplyReviewView.tsx` | `ExternalLink` | View/domain action | Defer to Phase 9 or Phase 11 with apply-review route QA. |
| `apps/web/src/contexts/pipeline/components/StageTriggerPanel.tsx` | `Play` | Pipeline status/action | Defer to Phase 9 because stage-trigger semantics are domain-owned. |
| `apps/web/src/contexts/scoring/components/RescoreCurrentPolicyButton.tsx` | `RefreshCw` | Scoring action | Defer to Phase 9 scoring/domain surface migration. |
| `apps/web/src/contexts/scoring/components/ResetStaleScoresButton.tsx` | `RotateCcw` | Scoring warning/action | Defer to Phase 9 stale-score status migration. |
| `apps/web/src/contexts/scoring/components/ScoreCorrectionControl.tsx` | `Check` | Scoring correction control | Defer to Phase 9 scoring control QA. |
| `apps/web/src/contexts/discovery/components/DiscoveryProductControls.tsx` | `AlertTriangle`, `Ban`, `Check`, `ExternalLink`, `Eye`, `Plus`, `ThumbsUp`, `Upload`, `X` | Discovery product/domain controls | Defer to Phase 9 because these icons encode source health, quarantine, preview, import, and feedback actions. |
| `apps/web/src/contexts/materials/components/GenerateMaterialsButton.tsx` | `WandSparkles` | Materials generation action | Defer to Phase 9 or Phase 11 with generated-materials safety QA. |
| `apps/web/src/contexts/materials/components/RetailorCurrentPolicyButton.tsx` | `WandSparkles` | Materials re-tailor action | Defer to Phase 9 or Phase 11 with re-tailor safety QA. |
| `apps/web/src/contexts/profile/components/StructuredProfileEditor.tsx` | `Plus`, `Trash2` | Profile editor control | Defer to Phase 9 or Phase 11 with profile editor form QA. |
| `apps/web/package.json` | `lucide-react` dependency | Dependency | Retain until imports reach zero, then remove in Phase 11 cleanup. |

## Verification

- `corepack pnpm --dir apps/web exec node -e "const icons=require('@tabler/icons-react'); for (const n of ['IconMoon','IconSun','IconSearch','IconCheck','IconChevronDown','IconChevronUp','IconChevronRight','IconCircle','IconCopy','IconX','IconFilter','IconSortAscending','IconSortDescending','IconTable']) if (!icons[n]) throw new Error(n)"` - PASS.
- `! rg -n "lucide-react" apps/web/src/shared/ui apps/web/src/shared/layout` - PASS, zero matches.
- `rg "lucide-react|@tabler/icons-react" apps/web/src apps/web/package.json` - PASS, produced only expected Tabler imports plus the deferred lucide imports above.
- `corepack pnpm web:check` - PASS.
