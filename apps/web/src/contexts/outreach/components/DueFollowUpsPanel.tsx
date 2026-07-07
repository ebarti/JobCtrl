import type { JSX } from "react";

import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Empty } from "../../../shared/ui/empty.js";
import { useDueFollowUpsQuery } from "../hooks/useDueFollowUpsQuery.js";

// Context-owned surface listing the outreach follow-ups that are due. These are
// surfaced-only reminders for the user to act on — JobCtrl never sends them
// (INV-1). Empty-safe and loading-safe.
export function DueFollowUpsPanel(): JSX.Element {
  const query = useDueFollowUpsQuery();
  const followUps = query.data ?? [];
  const errorMessage = query.error instanceof Error ? query.error.message : "";

  return (
    <section className="card full outreach-due-follow-ups" aria-label="Follow-ups due">
      <header className="card-hd">
        <h2>Follow-ups due</h2>
        <span className="meta">{query.isPending ? "loading" : `${followUps.length} shown`}</span>
      </header>
      <p className="muted">Reminders surfaced for you to act on. JobCtrl never sends them.</p>
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {query.isPending && !errorMessage ? <Empty title="Loading follow-ups." /> : null}
      {!query.isPending && followUps.length === 0 && !errorMessage ? (
        <Empty title="No follow-ups due." />
      ) : null}
      {followUps.length > 0 ? (
        <ul className="outreach-due-follow-ups-list">
          {followUps.map((item) => (
            <li key={item.threadId} className="outreach-due-follow-up-item">
              <span className="tag">{item.isDue ? "due" : "scheduled"}</span>
              <span>due {formatDateTime(item.dueAt)}</span>
              {item.basis ? <span className="muted">{item.basis}</span> : null}
              <span className="mono">{item.jobId ?? item.contactId}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
