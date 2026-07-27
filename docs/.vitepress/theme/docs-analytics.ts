import type { InjectionKey } from "vue";
import type { Router } from "vitepress";

export const DOCS_GOOGLE_ANALYTICS_MEASUREMENT_ID = "G-KB495KG6MS";
export const DOCS_ANALYTICS_CONSENT_STORAGE_KEY =
  "jobctrl-docs-analytics-consent-v1";

const GOOGLE_TAG_SCRIPT_ID = "jobctrl-docs-google-analytics";
const GOOGLE_ANALYTICS_COOKIE_MAX_AGE_SECONDS = 15_544_800;
const GOOGLE_ANALYTICS_COOKIE_PREFIXES = ["_ga", "_gid", "_gat"];

export type DocsAnalyticsConsentChoice = "granted" | "denied";

type GoogleTag = (...command: unknown[]) => void;

interface DocsAnalyticsWindow extends Window {
  dataLayer?: IArguments[];
  gtag?: GoogleTag;
}

export interface DocsAnalyticsController {
  getConsentChoice(): DocsAnalyticsConsentChoice | null;
  install(): void;
  grant(): void;
  deny(): boolean;
}

export const docsAnalyticsControllerKey: InjectionKey<DocsAnalyticsController> =
  Symbol("docsAnalyticsController");

function browserStorage(windowRef: Window): Storage | null {
  try {
    return windowRef.localStorage;
  } catch {
    return null;
  }
}

function readStoredChoice(
  storage: Storage | null,
): DocsAnalyticsConsentChoice | null {
  if (!storage) return null;
  try {
    const choice = storage.getItem(DOCS_ANALYTICS_CONSENT_STORAGE_KEY);
    return choice === "granted" || choice === "denied" ? choice : null;
  } catch {
    return null;
  }
}

function persistChoice(
  storage: Storage | null,
  choice: DocsAnalyticsConsentChoice,
): void {
  if (!storage) return;
  try {
    storage.setItem(DOCS_ANALYTICS_CONSENT_STORAGE_KEY, choice);
  } catch {
    // Storage can be unavailable in private or hardened browser modes. The
    // choice still applies to this page session through the controller state.
  }
}

function queueGoogleTag(windowRef: DocsAnalyticsWindow): GoogleTag {
  const dataLayer = windowRef.dataLayer ?? [];
  windowRef.dataLayer = dataLayer;
  const googleTag: GoogleTag =
    windowRef.gtag ??
    function googleTag() {
      // Google processes the `arguments` objects produced by its canonical
      // snippet. Plain arrays load the tag but are ignored by the library.
      dataLayer.push(arguments);
    };
  windowRef.gtag = googleTag;
  return googleTag;
}

function grantedConsent(): Record<string, "granted" | "denied"> {
  return {
    analytics_storage: "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  };
}

function deniedConsent(): Record<string, "denied"> {
  return {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  };
}

function currentPageLocation(windowRef: Window): string {
  // Query strings and fragments are unnecessary for documentation analytics
  // and can contain user-entered search or navigation text.
  return `${windowRef.location.origin}${windowRef.location.pathname}`;
}

function loadGoogleAnalytics(
  documentRef: Document,
  windowRef: DocsAnalyticsWindow,
): void {
  if (documentRef.getElementById(GOOGLE_TAG_SCRIPT_ID)) return;

  try {
    const googleTag = queueGoogleTag(windowRef);
    googleTag("consent", "default", grantedConsent());
    googleTag("js", new Date());
    // This theme emits sanitized manual views after VitePress route changes.
    // The matching GA4 stream must therefore disable Enhanced Measurement's
    // "Page changes based on browser history events" option; send_page_view
    // only suppresses the config command's automatic load-time view.
    googleTag("config", DOCS_GOOGLE_ANALYTICS_MEASUREMENT_ID, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      anonymize_ip: true,
      // Host-only cookies keep docs consent on jobctrl.dev from crossing into
      // demo.jobctrl.dev, which has its own independent consent contract.
      cookie_domain: "none",
      cookie_expires: GOOGLE_ANALYTICS_COOKIE_MAX_AGE_SECONDS,
      cookie_flags: "SameSite=Lax;Secure",
      cookie_update: false,
      send_page_view: false,
    });

    const script = documentRef.createElement("script");
    script.id = GOOGLE_TAG_SCRIPT_ID;
    script.async = true;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.src =
      `https://www.googletagmanager.com/gtag/js?id=` +
      encodeURIComponent(DOCS_GOOGLE_ANALYTICS_MEASUREMENT_ID);
    documentRef.head.append(script);
  } catch {
    // Optional third-party analytics must never break documentation access.
  }
}

function sendPageView(
  documentRef: Document,
  windowRef: DocsAnalyticsWindow,
  pageReferrer: string,
): string {
  const pageLocation = currentPageLocation(windowRef);
  try {
    windowRef.gtag?.("event", "page_view", {
      page_location: pageLocation,
      page_path: windowRef.location.pathname,
      page_referrer: pageReferrer,
      page_title: documentRef.title,
    });
  } catch {
    // Third-party analytics must not interfere with client-side navigation.
  }
  return pageLocation;
}

function cookieDomainCandidates(hostname: string): string[] {
  if (
    hostname === "localhost" ||
    /^[\d.]+$/.test(hostname) ||
    hostname.includes(":")
  ) {
    return [];
  }

  const labels = hostname.split(".");
  const candidates = new Set<string>([hostname]);
  if (labels.length > 2) {
    candidates.add(labels.slice(-2).join("."));
  }
  return [...candidates];
}

function deleteGoogleAnalyticsCookies(
  documentRef: Document,
  windowRef: Window,
): void {
  try {
    const secure =
      windowRef.location.protocol === "https:" ? "; Secure" : "";
    const cookieNames = documentRef.cookie
      .split(";")
      .map((cookie) => cookie.split("=", 1)[0]?.trim())
      .filter(
        (name): name is string =>
          Boolean(name) &&
          GOOGLE_ANALYTICS_COOKIE_PREFIXES.some((prefix) =>
            name.startsWith(prefix),
          ),
      );

    for (const name of cookieNames) {
      documentRef.cookie =
        `${name}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
      for (const domain of cookieDomainCandidates(
        windowRef.location.hostname,
      )) {
        documentRef.cookie =
          `${name}=; Max-Age=0; Path=/; Domain=${domain}; SameSite=Lax${secure}`;
      }
    }
  } catch {
    // Cookie access can be blocked. Consent remains denied in controller state,
    // so no further documentation page views are emitted.
  }
}

function disableGoogleAnalytics(
  documentRef: Document,
  windowRef: DocsAnalyticsWindow,
): void {
  try {
    windowRef.gtag?.("consent", "update", deniedConsent());
  } catch {
    // Continue with local cleanup even if a third-party script misbehaves.
  }

  documentRef.getElementById(GOOGLE_TAG_SCRIPT_ID)?.remove();
  deleteGoogleAnalyticsCookies(documentRef, windowRef);
  delete windowRef.gtag;
  delete windowRef.dataLayer;
}

export function createDocsAnalyticsController(
  router: Router,
): DocsAnalyticsController {
  let choice: DocsAnalyticsConsentChoice | null = null;
  let installed = false;
  let previousPageLocation: string | null = null;

  const recordPageView = (): void => {
    previousPageLocation = sendPageView(
      document,
      window as DocsAnalyticsWindow,
      previousPageLocation ?? document.referrer,
    );
  };

  const enable = (sendCurrentPageView: boolean): void => {
    loadGoogleAnalytics(document, window as DocsAnalyticsWindow);
    if (sendCurrentPageView) {
      recordPageView();
    }
  };

  return {
    getConsentChoice() {
      if (!installed) {
        choice = readStoredChoice(browserStorage(window));
      }
      return choice;
    },

    install() {
      if (installed) return;
      installed = true;
      choice = readStoredChoice(browserStorage(window));

      const prior = router.onAfterRouteChange;
      router.onAfterRouteChange = async (to) => {
        await prior?.(to);
        if (choice === "granted") {
          recordPageView();
        }
      };

      window.addEventListener("storage", (event) => {
        if (event.key !== DOCS_ANALYTICS_CONSENT_STORAGE_KEY) {
          return;
        }

        // Consent is origin-wide, so every open docs tab must reflect the same
        // stored choice. Reloading also cleanly installs a newly granted tag
        // or unloads a denied tag before it can emit from stale in-memory state.
        choice = event.newValue === "granted" ? "granted" : "denied";
        previousPageLocation = null;
        if (choice === "denied") {
          disableGoogleAnalytics(document, window as DocsAnalyticsWindow);
        }
        window.location.reload();
      });

      if (choice === "granted") {
        // VitePress invokes the route hook for the initial hydrated route.
        // Loading here and recording there avoids a duplicate hard-reload view.
        enable(false);
      }
    },

    grant() {
      choice = "granted";
      persistChoice(browserStorage(window), choice);
      // The current route has already settled when a visitor clicks Accept.
      enable(true);
    },

    deny() {
      const requiresReload = choice === "granted";
      choice = "denied";
      previousPageLocation = null;
      persistChoice(browserStorage(window), choice);
      disableGoogleAnalytics(document, window as DocsAnalyticsWindow);
      return requiresReload;
    },
  };
}
