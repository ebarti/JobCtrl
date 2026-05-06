import { getStoryContext, type TestRunnerConfig } from "@storybook/test-runner";
import { checkA11y, configureAxe, injectAxe } from "axe-playwright";

interface StoryA11yConfig {
  readonly disable?: boolean;
  readonly test?: "error" | "warn" | "off";
  readonly element?: string;
  readonly config?: { readonly rules?: ReadonlyArray<{ readonly id: string; readonly enabled?: boolean }> };
}

// Per docs/frontend-target.md §10.7, the bar for forms / dialogs is "no
// critical violations". `includedImpacts` constrains the axe report so a
// failing serious/critical finding fails the CI step while moderate and
// minor noise stays informational.
//
// Stories that surface known production-code a11y bugs from earlier
// phases (e.g., role="row" divs in DataTable, missing aria-label on a
// raw <select>, icon-only close buttons inside Radix Dialog/Sheet/Drawer
// primitives) opt out by setting `parameters: { a11y: { test: "off" } }`
// — those defects are tracked separately and out of Phase 7 scope.
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
