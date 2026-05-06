import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { EventStreamProvider } from "./contexts/operations/providers/EventStreamProvider.js";
import { ConsoleTelemetryAdapter } from "./shared/adapters/local/ConsoleTelemetryAdapter.js";
import { FetchApiClientAdapter } from "./shared/adapters/local/FetchApiClientAdapter.js";
import { LocalSessionAdapter } from "./shared/adapters/local/LocalSessionAdapter.js";
import { LocalStorageAdapter } from "./shared/adapters/local/LocalStorageAdapter.js";
import { NavigatorClipboardAdapter } from "./shared/adapters/local/NavigatorClipboardAdapter.js";
import { OpenArtifactAdapter } from "./shared/adapters/local/OpenArtifactAdapter.js";
import { SseEventStreamAdapter } from "./shared/adapters/local/SseEventStreamAdapter.js";
import { StaticFeatureFlagAdapter } from "./shared/adapters/local/StaticFeatureFlagAdapter.js";
import { createQueryClient } from "./shared/lib/queryClient.js";
import { DensityProvider } from "./shared/providers/DensityProvider.js";
import { PortsProvider, type Ports } from "./shared/providers/PortsProvider.js";
import { QueryClientProvider } from "./shared/providers/QueryClientProvider.js";
import { TenantProvider } from "./shared/providers/TenantProvider.js";
import { ThemeProvider } from "./shared/providers/ThemeProvider.js";
import { ToasterProvider } from "./shared/providers/ToasterProvider.js";
import { TooltipProvider } from "./shared/ui/tooltip.js";
import "./styles/globals.css";

const apiBaseUrl = import.meta.env.VITE_JOBHUNTER_API_BASE_URL ?? "";
const api = new FetchApiClientAdapter(apiBaseUrl);

const ports: Ports = {
  api,
  eventStream: new SseEventStreamAdapter(apiBaseUrl),
  storage: new LocalStorageAdapter("jh:"),
  session: new LocalSessionAdapter(),
  clipboard: new NavigatorClipboardAdapter(),
  openInOs: new OpenArtifactAdapter(api),
  telemetry: new ConsoleTelemetryAdapter(),
  featureFlags: new StaticFeatureFlagAdapter(),
};

const queryClient = createQueryClient();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PortsProvider ports={ports}>
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
  </React.StrictMode>,
);
