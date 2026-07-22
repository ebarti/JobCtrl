export const DEMO_GOOGLE_ANALYTICS_MEASUREMENT_ID = "G-6MJGD17JN0";

const GOOGLE_TAG_SCRIPT_ID = "jobctrl-google-analytics";
const GOOGLE_ANALYTICS_COOKIE_MAX_AGE_SECONDS = 15_544_800;

type GoogleTag = (...command: unknown[]) => void;

interface GoogleAnalyticsWindow extends Window {
  dataLayer?: IArguments[];
  gtag?: GoogleTag;
}

interface DemoGoogleAnalyticsOptions {
  readonly document?: Document;
  readonly window?: Window;
}

/** Load GA4 only after the demo consent service has confirmed acceptance. */
export function loadDemoGoogleAnalytics(
  options: DemoGoogleAnalyticsOptions = {},
): void {
  const documentRef = options.document ?? document;
  const windowRef = (options.window ?? window) as GoogleAnalyticsWindow;
  if (documentRef.getElementById(GOOGLE_TAG_SCRIPT_ID)) return;

  try {
    const dataLayer = windowRef.dataLayer ?? [];
    windowRef.dataLayer = dataLayer;
    const googleTag: GoogleTag =
      windowRef.gtag ??
      function googleTag() {
        // Google processes queued commands as the `arguments` objects produced
        // by its canonical snippet. Plain arrays load the tag but are ignored.
        dataLayer.push(arguments);
      };
    windowRef.gtag = googleTag;

    googleTag("consent", "default", {
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
    googleTag("js", new Date());
    googleTag("config", DEMO_GOOGLE_ANALYTICS_MEASUREMENT_ID, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      anonymize_ip: true,
      cookie_domain: windowRef.location.hostname,
      cookie_expires: GOOGLE_ANALYTICS_COOKIE_MAX_AGE_SECONDS,
      cookie_flags: "SameSite=Lax;Secure",
    });

    const script = documentRef.createElement("script");
    script.id = GOOGLE_TAG_SCRIPT_ID;
    script.async = true;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(DEMO_GOOGLE_ANALYTICS_MEASUREMENT_ID)}`;
    documentRef.head.append(script);
  } catch {
    // Third-party analytics must never block entry to the accepted demo.
  }
}
