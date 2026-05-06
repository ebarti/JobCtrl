import { usePorts } from "../providers/PortsProvider.js";

const STATUS_LABEL: Record<string, string> = {
  stub: "stub mode",
  connecting: "connecting",
  open: "live",
  closed: "offline",
};

export function ConnectionStatusPill() {
  const { eventStream } = usePorts();
  const status = eventStream.status;
  const label = STATUS_LABEL[status] ?? status;
  return (
    <span className="connection-pill" data-status={status} aria-live="polite">
      {label}
    </span>
  );
}
