import type { DashboardSummary } from "@jobhunter/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useEscapeKey } from "../../shared/hooks/useEscapeKey.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { Empty } from "../../shared/ui/empty.js";
import { Section } from "../../shared/ui/section.js";

type ActivityEvent = DashboardSummary["activity"][number];

export interface ActivityDetailDrawerProps {
  eventId: string;
  activity: ActivityEvent | null;
}

export function ActivityDetailDrawer({ eventId, activity }: ActivityDetailDrawerProps) {
  const navigate = useNavigate();
  const close = useCallback(() => {
    void navigate({ to: "/dashboard" });
  }, [navigate]);
  useEscapeKey(true, close);

  return (
    <div className="drawer-backdrop">
      <aside className="drawer detail-drawer">
        <button
          aria-label="Close activity details"
          className="drawer-close"
          type="button"
          onClick={close}
        >
          x
        </button>
        {!activity ? (
          <Empty title={`Activity event ${eventId} is no longer in the recent list.`} />
        ) : (
          <>
            <div className="drawer-head">
              <span className={`tag ${activity.level === "error" ? "danger" : "muted"}`}>
                {activity.level}
              </span>
              <span>
                <small>{activity.stage}</small>
                <h2>{activity.message}</h2>
                <p>{formatDateTime(activity.at)}</p>
              </span>
            </div>
            <Section title="Event details">
              <dl className="detail-list">
                <div>
                  <dt>Event id</dt>
                  <dd className="mono">{activity.eventId}</dd>
                </div>
                <div>
                  <dt>Stage</dt>
                  <dd>{activity.stage}</dd>
                </div>
                <div>
                  <dt>Level</dt>
                  <dd>{activity.level}</dd>
                </div>
                <div>
                  <dt>Timestamp</dt>
                  <dd>{formatDateTime(activity.at)}</dd>
                </div>
                <div>
                  <dt>Message</dt>
                  <dd>{activity.message}</dd>
                </div>
              </dl>
            </Section>
          </>
        )}
      </aside>
    </div>
  );
}
