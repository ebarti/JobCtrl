import { createContext, useContext, type ReactNode } from "react";

import type {
  ApiClientPort,
  ClipboardPort,
  EventStreamPort,
  FeatureFlagPort,
  OpenInOsPort,
  PdfExportPort,
  SessionPort,
  StoragePort,
  TelemetryPort,
} from "../ports/index.js";

export interface Ports {
  api: ApiClientPort;
  eventStream: EventStreamPort;
  storage: StoragePort;
  session: SessionPort;
  clipboard: ClipboardPort;
  openInOs: OpenInOsPort;
  pdfExport: PdfExportPort;
  telemetry: TelemetryPort;
  featureFlags: FeatureFlagPort;
}

const PortsContext = createContext<Ports | null>(null);

export function PortsProvider({ ports, children }: { ports: Ports; children: ReactNode }) {
  return <PortsContext.Provider value={ports}>{children}</PortsContext.Provider>;
}

export function usePorts(): Ports {
  const ctx = useContext(PortsContext);
  if (!ctx) {
    throw new Error("usePorts must be called within <PortsProvider>.");
  }
  return ctx;
}
