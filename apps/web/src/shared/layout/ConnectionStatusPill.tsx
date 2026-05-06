import { useEffect, useState } from "react";

import { useEventStreamStatus } from "../../contexts/operations/providers/EventStreamProvider.js";
import type { EventStreamStatus } from "../ports/EventStreamPort.js";

const STATUS_LABEL: Record<EventStreamStatus, string> = {
  connecting: "connecting",
  open: "live",
  closed: "reconnecting",
};

const CONNECTION_LOST_THRESHOLD_MS = 30_000;

export function ConnectionStatusPill() {
  const status = useEventStreamStatus();
  const lostForLong = useDisconnectedLongerThan(status, CONNECTION_LOST_THRESHOLD_MS);
  const label = lostForLong ? "offline" : STATUS_LABEL[status];
  return (
    <div className="connection-pill-group">
      <span
        className="connection-pill"
        data-status={lostForLong ? "lost" : status}
        aria-live="polite"
      >
        {label}
      </span>
      {lostForLong ? (
        <div className="connection-banner" role="status" aria-live="polite">
          Connection lost — events paused; data will refresh when reconnected.
        </div>
      ) : null}
    </div>
  );
}

function useDisconnectedLongerThan(status: EventStreamStatus, thresholdMs: number): boolean {
  const [tripped, setTripped] = useState(false);
  useEffect(() => {
    if (status === "open") {
      setTripped(false);
      return;
    }
    setTripped(false);
    const handle = setTimeout(() => {
      setTripped(true);
    }, thresholdMs);
    return () => {
      clearTimeout(handle);
    };
  }, [status, thresholdMs]);
  return tripped;
}
