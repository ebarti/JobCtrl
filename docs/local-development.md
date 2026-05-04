# Local Development

JobHunter is a pnpm TypeScript workspace plus a uv-managed Python automation
worker.

## Install

```bash
corepack pnpm install
uv --project workers/automation sync --extra dev
```

## Run

```bash
pnpm api:dev
pnpm web:dev
uv --project workers/automation run jobhunter doctor
```

The Vite web dev server proxies `/v1/*` to the local API by default.

## Verify

```bash
pnpm check
pnpm test
uv --project workers/automation run --extra dev python -m build workers/automation
git diff --check
```

Use focused checks while iterating:

```bash
pnpm api:check
pnpm api:test
pnpm web:check
pnpm web:build
pnpm qa:test
```
