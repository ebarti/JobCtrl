# Add Root-Level Web Test Aliases

## Status

Proposed.

## Source

Backlog source: `docs/backlog.md`, under "Frontend Tooling + CI Backlog".

The backlog item says the frontend migration docs reference root-level web test
commands, but only `apps/web/package.json` currently defines the underlying
scripts. Today developers must run:

```bash
pnpm --filter @jobhunter/web test
pnpm --filter @jobhunter/web test:watch
pnpm --filter @jobhunter/web test:coverage
pnpm --filter @jobhunter/web test-d
pnpm --filter @jobhunter/web e2e
pnpm --filter @jobhunter/web e2e:headed
```

## Goal

Add root `package.json` aliases so developers can run the web test pyramid from
the repository root with the command names already referenced by project docs:

```bash
pnpm web:test
pnpm web:test:watch
pnpm web:test:coverage
pnpm web:test-d
pnpm web:e2e
pnpm web:e2e:headed
```

## Current State

- Root `package.json` already exposes web aliases for `check`, `dev`, `build`,
  `preview`, and Storybook.
- `apps/web/package.json` already owns the actual Vitest, type-test, and
  Playwright script definitions.
- `docs/local-development.md` currently documents the filtered commands and
  says these root aliases do not exist yet.

## Design

1. Add the six aliases to root `package.json` next to the existing web scripts:

   ```json
   "web:test": "corepack pnpm --filter @jobhunter/web test",
   "web:test:watch": "corepack pnpm --filter @jobhunter/web test:watch",
   "web:test:coverage": "corepack pnpm --filter @jobhunter/web test:coverage",
   "web:test-d": "corepack pnpm --filter @jobhunter/web test-d",
   "web:e2e": "corepack pnpm --filter @jobhunter/web e2e",
   "web:e2e:headed": "corepack pnpm --filter @jobhunter/web e2e:headed"
   ```

   This matches the existing root script convention and leaves execution
   details owned by `@jobhunter/web`.

2. Leave `apps/web/package.json` unchanged. The web package is already the
   canonical owner of the underlying commands.

3. Update only documentation that would become directly stale:

   - Rewrite `docs/local-development.md` to use the new root aliases and remove
     the statement that these commands are not root-aliased yet.
   - Remove the delivered backlog item from `docs/backlog.md`.
   - Update `AGENTS.md` command references to the new root aliases because it
     owns repository workflow and automation guidance.
   - Update `docs/local-reliability-qa.md` to use `pnpm web:test` for the
     colocated a11y suite reference.
   - Update the active type-level test command reference in `docs/architecture.md`.

4. Do not add CI jobs, ESLint setup, dependencies, or new test frameworks. Those
   are separate backlog entries and should remain out of scope.

## Rejected Alternatives

- Add `web:lint`: rejected because the backlog states there is no ESLint setup
  or web lint script yet; it belongs with the separate ESLint backlog item.
- Wire CI to run the new aliases: rejected because the CI backlog item is
  separate and has a wider validation surface.
- Duplicate the full Vitest or Playwright commands in root `package.json`:
  rejected because it would split command ownership between root and
  `@jobhunter/web`.
- Change the web package scripts: rejected because the existing scripts already
  provide the desired behavior.

## Validation Plan

For this scripts-only change, use package-manager-level validation after the
edit:

```bash
corepack pnpm run web:test --help
corepack pnpm run web:test:watch --help
corepack pnpm run web:test:coverage --help
corepack pnpm run web:test-d --help
corepack pnpm run web:e2e --help
corepack pnpm run web:e2e:headed --help
git diff --check
```

These commands verify that the new root aliases resolve through pnpm into the
web package command entry points without running the full unit, type, or E2E
suites. Vitest and Playwright both exit successfully for `--help`; pnpm exits
non-zero before reaching them if an alias is missing or mistyped. If a reviewer
wants stronger coverage before merge, run the actual root aliases without
`--help` for `web:test` and `web:test-d`; reserve full `web:e2e` for
environments with the local E2E prerequisites available.

## Acceptance Criteria

- Root `package.json` contains all six requested aliases.
- Each alias delegates to the matching existing `@jobhunter/web` script.
- No unrelated scripts, dependencies, CI workflows, or lint setup are added.
- Directly stale documentation is updated narrowly in `docs/local-development.md`,
  `docs/backlog.md`, `AGENTS.md`, `docs/local-reliability-qa.md`, and
  `docs/architecture.md`.
- Package-manager validation confirms the aliases resolve from the repository
  root.
