import { BrowserRequestIdentityAdapter } from "../adapters/local/BrowserRequestIdentityAdapter.js";
import type { RequestIdentityPort } from "../ports/RequestIdentityPort.js";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import type {
  ApiClientPort,
  ArtifactDownloadPort,
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
  requestIdentity?: RequestIdentityPort;
  api: ApiClientPort;
  artifactDownload: ArtifactDownloadPort;
  eventStream: EventStreamPort;
  storage: StoragePort;
  session: SessionPort;
  clipboard: ClipboardPort;
  openInOs: OpenInOsPort;
  pdfExport: PdfExportPort;
  telemetry: TelemetryPort;
  featureFlags: FeatureFlagPort;
}

type ResolvedPorts = Ports & { requestIdentity: RequestIdentityPort };
const PortsContext = createContext<ResolvedPorts | null>(null);
const defaultRequestIdentity = new BrowserRequestIdentityAdapter();

export function PortsProvider({ ports, children }: { ports: Ports; children: ReactNode }) {
  const resolved = useMemo(() => ({
    ...ports,
    requestIdentity: ports.requestIdentity ?? defaultRequestIdentity,
  }), [ports]);
  return <PortsContext.Provider value={resolved}>{children}</PortsContext.Provider>;
}

export function usePorts(): ResolvedPorts {
  const ctx = useContext(PortsContext);
  if (!ctx) {
    throw new Error("usePorts must be called within <PortsProvider>.");
  }
  return ctx;
}
