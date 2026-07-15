import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useActivityEventQuery } from "../../contexts/operations/hooks/useActivityEventQuery.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { DetailDrawer } from "../../shared/ui/detail-drawer-backdrop.js";
import { Empty } from "../../shared/ui/empty.js";
import { Section } from "../../shared/ui/section.js";
import { activityLevelTone } from "./activity-tone.js";

export interface ActivityDetailDrawerProps {
  eventId: string;
}

export function ActivityDetailDrawer({ eventId }: ActivityDetailDrawerProps) {
  const navigate = useNavigate();
  const close = useCallback(() => {
    void navigate({ to: "/debug" });
  }, [navigate]);

  const { data: activity } = useActivityEventQuery(eventId);

  return (
    <DetailDrawer
      description="Inspect the selected activity event and its lifecycle metadata."
      onDismiss={close}
      title="Activity details"
    >
      {!activity ? (
        <Empty
          title={`Activity event ${eventId} is no longer in the recent list.`}
        />
      ) : (
        <>
          <div className="drawer-head">
            <span className={`tag ${activityLevelTone(activity.level)}`}>
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
    </DetailDrawer>
  );
}
