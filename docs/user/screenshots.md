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

The screenshot flow captures these eight surfaces.

![JobHunter dashboard showing pipeline progress, job counts, and apply runs](../assets/screenshots/dashboard.png)
*Dashboard: pipeline progress, job counts, source health, and recent apply runs.*

![JobHunter Jobs table with fit scores, companies, and triage actions](../assets/screenshots/jobs.png)
*Jobs table: fit-score ranking, compensation columns, and bulk triage actions.*

![JobHunter job detail drawer showing score, requirement fit, keywords, and compensation](../assets/screenshots/job-detail.png)
*Job detail drawer: ranking, requirement fit, keywords, and compensation evidence.*

![JobHunter Apply Review with tailored resume preview, requirement evidence, and approval controls](../assets/screenshots/apply-review.png)
*Apply Review: requirement evidence, tailored resume preview, line comments, and approval controls.*

![JobHunter Profile page with personal information, resume baseline, experience, and skills](../assets/screenshots/profile.png)
*Profile: personal information, resume baseline, experience, skills, and the baseline resume editor.*

![JobHunter Discovery page with target search, seniority floors, job boards, and source registry](../assets/screenshots/discovery.png)
*Discovery: target search, seniority floors, locations and work models, job boards, and the source registry.*

![JobHunter Pipelines page configuring a Discover run with dry-run enabled](../assets/screenshots/pipelines.png)
*Pipelines: start a Discover run with limit, worker count, and a dry-run toggle.*

![JobHunter Runs page listing workflow runs with status and mode](../assets/screenshots/runs.png)
*Runs: workflow run history with status, mode, timing, and a Temporal web UI link.*

See [docs/developer/screenshot-playbook.md](../developer/screenshot-playbook.md)
for the implementation details and refresh checklist.
