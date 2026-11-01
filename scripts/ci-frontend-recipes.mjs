export const frontendRecipes = {
  "web": [
    {
      "name": "Lint web boundaries",
      "run": "corepack pnpm web:lint"
    },
    {
      "name": "Check web",
      "run": "corepack pnpm web:check"
    },
    {
      "name": "Test web",
      "run": "corepack pnpm web:test"
    },
    {
      "name": "Test public web types",
      "run": "corepack pnpm web:test-d"
    }
  ],
  "boundary": [
    {
      "name": "Test frontend boundary regression controls",
      "run": "corepack pnpm web:lint:test"
    }
  ],
  "storybook": [
    {
      "name": "Build Storybook",
      "run": "corepack pnpm web:storybook:build"
    },
    {
      "name": "Test Storybook",
      "run": "corepack pnpm web:storybook:test"
    }
  ],
  "e2e": [
    {
      "name": "Test web end-to-end",
      "run": "corepack pnpm web:e2e",
      "env": {
        "PLAYWRIGHT_JUNIT_OUTPUT_FILE": "${{ runner.temp }}/e2e-isolated.xml",
        "JOBCTRL_E2E_ISOLATED": "1",
        "JOBCTRL_E2E_PROFILE_SUGGESTIONS": "1"
      }
    },
    {
      "name": "Test real API and worker RPC boundaries",
      "run": "mkdir -p \"$JOBCTRL_E2E_APP_DIR\"\ncorepack pnpm --filter @jobctrl/web exec playwright test --config e2e/playwright.config.ts \\\n  e2e/tests/discovery-saved-views.spec.ts e2e/tests/repeat-application.spec.ts \\\n  e2e/tests/dry-run-completed.spec.ts e2e/tests/event-stream-first-open.spec.ts e2e/tests/accepted-material-exports.spec.ts \\\n  e2e/tests/offer-outcomes.spec.ts\n",
      "env": {
        "PLAYWRIGHT_JUNIT_OUTPUT_FILE": "${{ runner.temp }}/e2e-real-rpc.xml",
        "JOBCTRL_E2E_ISOLATED": "0",
        "JOBCTRL_E2E_PROFILE_SUGGESTIONS": "0",
        "JOBCTRL_E2E_WEB_SERVER": "dev",
        "JOBCTRL_E2E_APP_DIR": "/tmp/jobctrl-real-rpc-e2e"
      }
    }
  ],
  "extension": [
    {
      "name": "Check, test, and exercise extension",
      "run": "corepack pnpm extension:check\ncorepack pnpm extension:test\nxvfb-run --auto-servernum corepack pnpm extension:e2e\n"
    }
  ],
  "docs": [
    {
      "name": "Build docs site",
      "run": "corepack pnpm docs:build"
    },
    {
      "name": "Check rendered docs site",
      "run": "corepack pnpm docs:check:runtime"
    }
  ],
  "demo": [
    {
      "name": "Build browser-local demo",
      "run": "corepack pnpm demo:build"
    }
  ]
};
