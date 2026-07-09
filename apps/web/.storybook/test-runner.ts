import { getStoryContext, type TestRunnerConfig } from "@storybook/test-runner";
import { checkA11y, configureAxe, injectAxe } from "axe-playwright";

interface StoryA11yConfig {
  readonly disable?: boolean;
  readonly test?: "error" | "warn" | "off";
  readonly element?: string;
  readonly config?: { readonly rules?: ReadonlyArray<{ readonly id: string; readonly enabled?: boolean }> };
}

// Per docs/architecture/frontend/testing.md §10.7, the bar is "no critical
// or serious violations". `includedImpacts` constrains the axe report so a
// failing serious/critical finding fails the CI step while moderate and minor
// noise stays informational.
//
// A story may use either supported escape hatch (`a11y.test: "off"` or
// `a11y.disable: true`) only for a pre-existing production defect with a
// matching entry in docs/backlog.md. The backlog, not this policy comment,
// owns the live deferral inventory.
const config: TestRunnerConfig = {
  async preVisit(page) {
    await injectAxe(page);
  },
  async postVisit(page, context) {
    const storyContext = await getStoryContext(page, context);
    const a11y = (storyContext.parameters?.["a11y"] ?? {}) as StoryA11yConfig;
    if (a11y.disable || a11y.test === "off") return;

    // color-contrast shifts across themes and is informational only — see
    // preview.tsx config.rules. The rule disable goes through the
    // run-time axe config rather than via runOnly, because runOnly takes
    // precedence over rule-level disables.
    await configureAxe(page, {
      rules: [
        { id: "color-contrast", enabled: false },
        ...(a11y.config?.rules ?? []),
      ],
    });
    await checkA11y(page, a11y.element ?? "#storybook-root", {
      detailedReport: true,
      detailedReportOptions: { html: true },
      axeOptions: {
        resultTypes: ["violations"],
      },
      includedImpacts: ["critical", "serious"],
    });
  },
};

export default config;
