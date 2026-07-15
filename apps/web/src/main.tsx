import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { EventStreamProvider } from "./contexts/operations/providers/EventStreamProvider.js";
import {
  DemoConsentClient,
  DemoConsentGate,
  DemoTelemetryAdapter,
  type DemoConsentChoice,
} from "./demo/consent/index.js";
import { createAppComposition, resolveAppMode } from "./demo/portFactory.js";
import { DemoWorkspaceProvider } from "./demo/workspace/DemoWorkspaceProvider.js";
import { router } from "./router.js";
import { createQueryClient } from "./shared/lib/queryClient.js";
import { DensityProvider } from "./shared/providers/DensityProvider.js";
import { PortsProvider } from "./shared/providers/PortsProvider.js";
import { QueryClientProvider } from "./shared/providers/QueryClientProvider.js";
import { TenantProvider } from "./shared/providers/TenantProvider.js";
import { ThemeProvider } from "./shared/providers/ThemeProvider.js";
import { ToasterProvider } from "./shared/providers/ToasterProvider.js";
import { TooltipProvider } from "./shared/ui/tooltip.js";
import "./styles/globals.css";
import "./styles/redesign-common.css";
import "./styles/redesign-overlays.css";
import "./styles/redesign-shell.css";
import "./styles/redesign-data.css";
import "./styles/redesign-analytics.css";
import "./styles/redesign-dashboard.css";
import "./styles/redesign-detail-surfaces.css";
import "./styles/redesign-job-detail.css";
import "./styles/redesign-configuration.css";
import "./styles/redesign-apply-review.css";
import "./styles/redesign-profile-import.css";
import "./styles/redesign-route-gaps.css";

const queryClient = createQueryClient();
const root = createRoot(document.getElementById("root")!);
let disposeComposition: () => void = () => undefined;
let demoAdmission: Promise<void> | undefined;
let demoChoiceStarted = false;

window.addEventListener("pagehide", () => disposeComposition(), { once: true });
if (import.meta.hot) {
  import.meta.hot.dispose(() => disposeComposition());
}

const appMode = resolveAppMode(import.meta.env.VITE_JOBCTRL_APP_MODE);
void bootstrap();

async function bootstrap(): Promise<void> {
  if (appMode !== "demo") {
    await mountApplication();
    return;
  }

  const client = new DemoConsentClient();
  renderConsentGate(client, "unknown");
  try {
    const state = await client.getChoice();
    if (demoChoiceStarted) return;
    if (state.choice === "granted") {
      await enterDemo(client);
      return;
    }
    if (state.choice === "denied") renderConsentGate(client, "denied");
  } catch {
    // The already-rendered static gate remains usable and acceptance stays retryable.
  }
}

function renderConsentGate(client: DemoConsentClient, initialChoice: DemoConsentChoice): void {
  root.render(
    <React.StrictMode>
      <DemoConsentGate
        client={client}
        initialChoice={initialChoice}
        onDecisionStarted={() => { demoChoiceStarted = true; }}
        onDeclined={() => window.location.assign("https://jobctrl.dev")}
        onGranted={() => enterDemo(client)}
      />
    </React.StrictMode>,
  );
}

function enterDemo(client: DemoConsentClient): Promise<void> {
  demoAdmission ??= mountApplication(client);
  return demoAdmission;
}

async function mountApplication(consentClient?: DemoConsentClient): Promise<void> {
  const demoTelemetry = appMode === "demo" ? new DemoTelemetryAdapter() : undefined;
  let composition: Awaited<ReturnType<typeof createAppComposition>>;
  try {
    composition = await createAppComposition({
      mode: appMode,
      apiBaseUrl: import.meta.env.VITE_JOBCTRL_API_BASE_URL ?? "",
      ...(demoTelemetry ? { demoTelemetry } : {}),
    });
  } catch {
    if (consentClient) {
      void consentClient.recordHealth("failure", "persistent").catch(() => undefined);
    }
    demoTelemetry?.error(undefined, { errorCode: "client_unexpected" });
    root.render(
      <main role="alert">
        <h1>Demo temporarily unavailable</h1>
        <p>Reload to try the browser-local demo again.</p>
      </main>,
    );
    return;
  }
  disposeComposition();
  const stopRouteTelemetry = demoTelemetry
    ? router.subscribe("onResolved", ({ pathChanged, toLocation }) => {
        if (pathChanged) demoTelemetry.routeViewed(toLocation.pathname);
      })
    : () => undefined;
  disposeComposition = () => {
    stopRouteTelemetry();
    composition.dispose();
  };
  if (
    composition.kind === "demo" &&
    composition.initialization.kind === "upgrade_required"
  ) {
    if (consentClient) {
      void consentClient.recordHealth("failure", "persistent").catch(() => undefined);
    }
    root.render(
      <main role="alert">
        <h1>Demo update required</h1>
        <p>{composition.initialization.message}</p>
      </main>,
    );
    return;
  }
  if (
    composition.kind === "demo" &&
    composition.initialization.kind === "ready" &&
    consentClient
  ) {
    const storageMode = composition.initialization.storageMode === "indexeddb"
      ? "persistent"
      : "memory";
    void consentClient.recordHealth("success", storageMode).catch(() => undefined);
    demoTelemetry?.sessionStarted(window.location.pathname);
  }
  const workspace = composition.kind === "demo" ? composition.workspace : null;
  root.render(
    <React.StrictMode>
      <DemoWorkspaceProvider workspace={workspace}>
        <PortsProvider ports={composition.ports}>
          <TenantProvider>
            <QueryClientProvider client={queryClient}>
              <EventStreamProvider>
                <ThemeProvider>
                  <DensityProvider>
                    <TooltipProvider>
                      <ToasterProvider>
                        <App queryClient={queryClient} />
                      </ToasterProvider>
                    </TooltipProvider>
                  </DensityProvider>
                </ThemeProvider>
              </EventStreamProvider>
            </QueryClientProvider>
          </TenantProvider>
        </PortsProvider>
      </DemoWorkspaceProvider>
    </React.StrictMode>,
  );
}
