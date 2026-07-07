import type { OutreachThreadDetail } from "@jobctrl/contracts";
import type { JSX } from "react";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Empty } from "../../../shared/ui/empty.js";

export interface OutreachSendLogListProps {
  thread: OutreachThreadDetail;
}

// The user-attested send history for a thread. Each entry is a recorded fact
// ("you sent this"), never a transmission (INV-1). Empty-safe.
export function OutreachSendLogList({ thread }: OutreachSendLogListProps): JSX.Element {
  if (thread.sendLogs.length === 0) {
    return <Empty title="No sends recorded yet." />;
  }
  const generationOf = new Map(thread.drafts.map((draft) => [draft.draftId, draft.generation]));
  const ordered = [...thread.sendLogs].sort((first, second) =>
    second.loggedAt.localeCompare(first.loggedAt),
  );
  return (
    <ul className="outreach-send-log-list" aria-label="Recorded sends">
      {ordered.map((log) => {
        const generation = generationOf.get(log.draftId);
        return (
          <li key={log.sendLogId} className="outreach-send-log-item">
            <span className="tag">{log.channel}</span>
            <span>sent {formatDateTime(log.sentAt)}</span>
            <span className="mono">
              {generation ? `gen ${generation}` : `draft ${log.draftId}`}
            </span>
            <span className="muted">recorded {formatDateTime(log.loggedAt)}</span>
          </li>
        );
      })}
    </ul>
  );
}
