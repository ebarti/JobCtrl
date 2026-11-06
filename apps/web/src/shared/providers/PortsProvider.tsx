import { BrowserRequestIdentityAdapter } from "../adapters/local/BrowserRequestIdentityAdapter.js";
import { BrowserBlobDownloadAdapter } from "../adapters/local/BrowserBlobDownloadAdapter.js";
import { BrowserSessionStorageAdapter } from "../adapters/local/BrowserSessionStorageAdapter.js";
import type { RequestIdentityPort } from "../ports/RequestIdentityPort.js";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import type {
  BlobDownloadPort,
  ClipboardPort,
  EventStreamPort,
  FeatureFlagPort,
  HttpPort,
  ProfileTransferPort,
  PdfExportPort,
  SessionPort,
  SessionStoragePort,
  StoragePort,
  TelemetryPort,
} from "../ports/index.js";

export interface Ports {
  requestIdentity?: RequestIdentityPort;
  http: HttpPort;
  blobDownload?: BlobDownloadPort;
  profileTransfer?: ProfileTransferPort;
  eventStream: EventStreamPort;
  storage: StoragePort;
  sessionStorage?: SessionStoragePort;
  session: SessionPort;
  clipboard: ClipboardPort;
  pdfExport: PdfExportPort;
  telemetry: TelemetryPort;
  featureFlags: FeatureFlagPort;
}

export type ResolvedPorts = Ports & { requestIdentity: RequestIdentityPort; http: HttpPort; blobDownload: BlobDownloadPort; profileTransfer: ProfileTransferPort; sessionStorage: SessionStoragePort };
const PortsContext = createContext<ResolvedPorts | null>(null);
const defaultRequestIdentity = new BrowserRequestIdentityAdapter();
const defaultBlobDownload = new BrowserBlobDownloadAdapter();
const defaultSessionStorage = new BrowserSessionStorageAdapter();
const unavailableProfileTransfer: ProfileTransferPort = {
  async inspect() { return { selectedRaw: null, legacyRaw: null, reviewsRaw: null, errors: ["Profile transfer is unavailable in this workspace."] }; },
  async digestPdf() { throw new Error("Profile transfer is unavailable in this workspace."); },
};

export function PortsProvider({ ports, children }: { ports: Ports; children: ReactNode }) {
  const resolved = useMemo(() => ({
    ...ports,
    requestIdentity: ports.requestIdentity ?? defaultRequestIdentity,
    blobDownload: ports.blobDownload ?? defaultBlobDownload,
    profileTransfer: ports.profileTransfer ?? unavailableProfileTransfer,
    sessionStorage: ports.sessionStorage ?? defaultSessionStorage,
  }), [
    ports,
    ports.http,
    ports.blobDownload,
    ports.profileTransfer,
    ports.eventStream,
    ports.storage,
    ports.sessionStorage,
    ports.session,
    ports.clipboard,
    ports.pdfExport,
    ports.telemetry,
    ports.featureFlags,
    ports.requestIdentity,
  ]);
  return <PortsContext.Provider value={resolved}>{children}</PortsContext.Provider>;
}

export function usePorts(): ResolvedPorts {
  const ctx = useContext(PortsContext);
  if (!ctx) {
    throw new Error("usePorts must be called within <PortsProvider>.");
  }
  return ctx;
}
