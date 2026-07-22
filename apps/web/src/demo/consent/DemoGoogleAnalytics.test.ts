import { afterEach, describe, expect, it } from "vitest";

import {
  DEMO_GOOGLE_ANALYTICS_MEASUREMENT_ID,
  loadDemoGoogleAnalytics,
} from "./DemoGoogleAnalytics.js";

interface GoogleAnalyticsWindow extends Window {
  dataLayer?: unknown[][];
  gtag?: (...command: unknown[]) => void;
}

const SCRIPT_ID = "jobctrl-google-analytics";

describe("loadDemoGoogleAnalytics", () => {
  afterEach(() => {
    document.getElementById(SCRIPT_ID)?.remove();
    const analyticsWindow = window as GoogleAnalyticsWindow;
    delete analyticsWindow.dataLayer;
    delete analyticsWindow.gtag;
  });

  it("loads the configured Google tag once with ads disabled and bounded cookies", () => {
    loadDemoGoogleAnalytics();
    loadDemoGoogleAnalytics();

    const scripts = document.querySelectorAll(`#${SCRIPT_ID}`);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toHaveAttribute(
      "src",
      `https://www.googletagmanager.com/gtag/js?id=${DEMO_GOOGLE_ANALYTICS_MEASUREMENT_ID}`,
    );
    expect((scripts[0] as HTMLScriptElement).async).toBe(true);

    const commands = (window as GoogleAnalyticsWindow).dataLayer;
    expect(commands?.[0]).toEqual([
      "consent",
      "default",
      {
        analytics_storage: "granted",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      },
    ]);
    expect(commands?.[2]).toEqual([
      "config",
      DEMO_GOOGLE_ANALYTICS_MEASUREMENT_ID,
      expect.objectContaining({
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        anonymize_ip: true,
        cookie_expires: 15_544_800,
      }),
    ]);
  });
});
