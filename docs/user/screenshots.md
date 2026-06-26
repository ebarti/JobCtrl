# Screenshots

Public screenshots are generated from synthetic data only. They are useful for
README previews, release notes, and visual QA, but they must never contain real
profile data, real resumes, real company targets from a private search, API
keys, logs, browser state, or local paths.

## Generate Screenshots

```bash
pnpm docs:screenshots
```

The command runs a Playwright spec against a disposable E2E workspace. The E2E
global setup calls the existing QA seed, starts the local API and Vite app on
test ports, and saves PNGs under:

```text
docs/assets/screenshots/
```

## Covered Surfaces

The screenshot flow captures:

| Surface | File |
| --- | --- |
| Dashboard | ![Dashboard](../assets/screenshots/dashboard.png) |
| Jobs table | ![Jobs table](../assets/screenshots/jobs.png) |
| Job detail drawer | ![Job detail drawer](../assets/screenshots/job-detail.png) |
| Apply Review | ![Apply Review](../assets/screenshots/apply-review.png) |
| Profile | ![Profile](../assets/screenshots/profile.png) |
| Discovery | ![Discovery](../assets/screenshots/discovery.png) |
| Pipelines | ![Pipelines](../assets/screenshots/pipelines.png) |
| Runs | ![Runs](../assets/screenshots/runs.png) |

See [docs/developer/screenshot-playbook.md](../developer/screenshot-playbook.md)
for the implementation details and refresh checklist.
