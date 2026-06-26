# Screenshot Playbook

Use this playbook whenever public screenshots need to be refreshed. Screenshots
must be generated from synthetic data only.

## Goal

Produce generic, reproducible screenshots for public documentation without
reading or mutating the user's real `~/.jobhunter` workspace.

## Data Source

The screenshot flow uses the same synthetic seed as local QA:

- seed script: `apps/api/test/qa-seed.ts`
- generated database: `$JOBHUNTER_E2E_APP_DIR/jobhunter.db`
- generated settings: `$JOBHUNTER_E2E_APP_DIR/dashboard.json`
- generated artifacts: `$JOBHUNTER_E2E_APP_DIR/artifacts/`

The seed creates a fake candidate, fake jobs, stage state, scores, materials,
requirement-fit evidence, employer analysis, artifacts, and worker heartbeat
rows. It does not need a real LLM provider, real job source, real Gmail account,
or real browser submission.

## Command

```bash
pnpm docs:screenshots
```

The command runs `apps/web/e2e/tests/docs-screenshots.spec.ts` through the
existing Playwright e2e harness. The harness starts:

- TypeScript API on an E2E port;
- Vite web app on an E2E port;
- a disposable E2E app directory;
- deterministic dispatch stubs where needed.

Output:

```text
docs/assets/screenshots/
```

## Manual Port Overrides

Use these when running multiple worktrees:

```bash
JOBHUNTER_E2E_APP_DIR=/tmp/jobhunter-docs-shots \
JOBHUNTER_E2E_API_PORT=8890 \
JOBHUNTER_E2E_WEB_PORT=5290 \
pnpm docs:screenshots
```

## Refresh Checklist

1. Confirm the checkout has no unrelated generated screenshots.
2. Run `pnpm docs:screenshots`.
3. Review each PNG for private data, broken layout, missing content, or local
   path leaks.
4. Update README or user docs if screenshot names changed.
5. Run `git diff --check`.

## Safety Rules

- Never point screenshot generation at `~/.jobhunter`.
- Never use real resumes, cover letters, job-search databases, logs, Gmail
  tokens, browser profiles, or generated application materials.
- Do not run apply automation, mailbox scans, real source crawling, or real LLM
  calls for screenshots.
- Keep screenshots deterministic: fixed viewport, synthetic database, seeded
  worker heartbeat, and no external provider calls.
