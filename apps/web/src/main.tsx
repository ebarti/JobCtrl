import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { EventStreamProvider } from "./contexts/operations/providers/EventStreamProvider.js";
import { createAppComposition, resolveAppMode } from "./demo/portFactory.js";
import { DemoWorkspaceProvider } from "./demo/workspace/DemoWorkspaceProvider.js";
import { createQueryClient } from "./shared/lib/queryClient.js";
import { DensityProvider } from "./shared/providers/DensityProvider.js";
import { PortsProvider } from "./shared/providers/PortsProvider.js";
import { QueryClientProvider } from "./shared/providers/QueryClientProvider.js";
import { TenantProvider } from "./shared/providers/TenantProvider.js";
import { ThemeProvider } from "./shared/providers/ThemeProvider.js";
import { ToasterProvider } from "./shared/providers/ToasterProvider.js";
import { TooltipProvider } from "./shared/ui/tooltip.js";
import "./styles/globals.css";

const queryClient = createQueryClient();
const root = createRoot(document.getElementById("root")!);

void mount();

async function mount(): Promise<void> {
  const composition = await createAppComposition({
    mode: resolveAppMode(import.meta.env.VITE_JOBCTRL_APP_MODE),
    apiBaseUrl: import.meta.env.VITE_JOBCTRL_API_BASE_URL ?? "",
  });
  if (
    composition.kind === "demo" &&
    composition.initialization.kind === "upgrade_required"
  ) {
    root.render(
      <main role="alert">
        <h1>Demo update required</h1>
        <p>{composition.initialization.message}</p>
      </main>,
    );
    return;
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
