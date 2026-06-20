---
phase: 17-source-registry-access-policy
status: planned
validation: nyquist
requirements:
  - SRC-01
  - SRC-04
  - SRC-05
  - SRC-06
---

# 17 Validation Plan

## Invariants

- The compensation source registry is a read-only policy surface, not a source ingestion surface.
- Europe-first public baselines and occupation references are available without credentials.
- Licensed/permissioned sources remain unavailable until explicit permitted access is configured.
- The registry response never exposes credentials, raw provider payloads, private-account state, local paths, or scraped salary data.
- Frontend reads go through the API port and Operations hook; the Scoring context owns only the read-only policy panel.

## Requirement Coverage

| Requirement | Automated Validation | Product Validation |
| --- | --- | --- |
| SRC-01 | `apps/api/test/compensation-source-policy.test.ts` asserts all safe registry fields; frontend hook/panel tests assert the same fields are rendered through the port. | Settings exposes a read-only compensation source policy panel. |
| SRC-04 | API tests assert Levels.fyi and Glassdoor default unavailable states and permitted-access gates. Panel tests assert unavailable reasons render clearly. | Licensed seams are visible but not callable by default. |
| SRC-05 | API safety tests assert Glassdoor policy data has no fetch/cache/raw payload fields; static grep stays limited to policy metadata/tests/docs. | No Glassdoor salary evidence can be displayed as imported data in this phase. |
| SRC-06 | API safety tests assert Levels.fyi policy data has no fetch/cache/raw payload fields; static grep stays limited to policy metadata/tests/docs. | No Levels.fyi salary evidence can be displayed as imported data in this phase. |

## Required Commands

- `corepack pnpm --filter @jobhunter/api test test/compensation-source-policy.test.ts`
- `corepack pnpm --filter @jobhunter/api check`
- `corepack pnpm --filter @jobhunter/web test src/contexts/operations/hooks/useCompensationSourcePolicyQuery.test.ts src/contexts/scoring/components/CompensationSourcePolicyPanel.test.tsx`
- `corepack pnpm --filter @jobhunter/web check`
- `rg -n "glassdoor|levels\\.fyi|levels_fyi" apps packages workers docs/local-ts-api.md`
- `git diff --check`

## Manual QA

- Open Settings and confirm the compensation source policy panel appears below the existing config panel.
- Confirm public Europe rows are distinguishable from unavailable licensed seams.
- Confirm no action, import, scrape, credential, or refresh control is offered for Levels.fyi or Glassdoor.
