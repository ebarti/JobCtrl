import { IconArrowLeft } from "@tabler/icons-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useActivityEventQuery } from "../../contexts/operations/hooks/useActivityEventQuery.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { Button, buttonVariants } from "../../shared/ui/button.js";
import { Empty } from "../../shared/ui/empty.js";
import {
  InspectorLedger,
  InspectorLedgerItem,
} from "../../shared/ui/inspector-ledger.js";
import { RouteWorkspace } from "../../shared/ui/route-workspace.js";
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

  const { data: activity, error, isLoading } = useActivityEventQuery(eventId);
  const errorMessage = error instanceof Error ? error.message : null;

  return (
    <div className="route-page route-page--activity-detail">
      {errorMessage ? <Empty title={errorMessage} /> : null}
      {!errorMessage && isLoading ? (
        <Empty title="Loading activity event." />
      ) : null}
      {!errorMessage && !isLoading && !activity ? (
        <Empty
          title={`Activity event ${eventId} is no longer in the recent list.`}
        />
      ) : null}
      {activity ? (
        <RouteWorkspace
          aria-labelledby="activity-detail-heading"
          className="activity-detail-workspace"
          contentLabel="Activity payload and timeline"
          inspectorLabel="Activity event facts"
          header={
            <div className="activity-detail-workspace__header">
              <Button
                aria-label="Back to Debug"
                className="workspace-back"
                size="sm"
                type="button"
                variant="ghost"
                onClick={close}
              >
                <IconArrowLeft aria-hidden="true" size={16} stroke={1.9} />
                Debug
              </Button>
              <span className={`tag ${activityLevelTone(activity.level)}`}>
                {activity.level}
              </span>
              <div className="activity-detail-workspace__title">
                <small>
                  {activity.stage} · {activity.eventType}
                </small>
                <h1 id="activity-detail-heading">{activity.message}</h1>
                <p>
                  <time dateTime={activity.at ?? undefined}>
                    {formatDateTime(activity.at)}
                  </time>
                  {activity.title ? ` · ${activity.title}` : ""}
                  {activity.company ? ` at ${activity.company}` : ""}
                </p>
              </div>
              {activity.jobKey ? (
                <div className="activity-detail-workspace__actions">
                  <Link
                    className={buttonVariants({
                      size: "sm",
                      variant: "outline",
                    })}
                    to="/jobs/$jobId"
                    params={{ jobId: activity.jobKey }}
                  >
                    Open related job
                  </Link>
                </div>
              ) : null}
            </div>
          }
          inspector={
            <div className="activity-detail-workspace__inspector">
              <h2>Event facts</h2>
              <InspectorLedger>
                <InspectorLedgerItem
                  label="Event id"
                  value={<span className="mono">{activity.eventId}</span>}
                  source="Activity projection"
                />
                <InspectorLedgerItem
                  label="Event type"
                  value={<span className="mono">{activity.eventType}</span>}
                  source="Activity projection"
                />
                <InspectorLedgerItem label="Stage" value={activity.stage} />
                <InspectorLedgerItem
                  label="Level"
                  value={
                    <span className={`tag ${activityLevelTone(activity.level)}`}>
                      {activity.level}
                    </span>
                  }
                />
                <InspectorLedgerItem
                  label="Timestamp"
                  value={
                    <time dateTime={activity.at ?? undefined}>
                      {formatDateTime(activity.at)}
                    </time>
                  }
                />
                <InspectorLedgerItem
                  label="Job key"
                  value={
                    activity.jobKey ? (
                      <span className="mono">{activity.jobKey}</span>
                    ) : undefined
                  }
                />
                <InspectorLedgerItem
                  label="Job title"
                  value={activity.title ?? undefined}
                />
                <InspectorLedgerItem
                  label="Company"
                  value={activity.company ?? undefined}
                />
                <InspectorLedgerItem
                  label="Run reference"
                  source="Not exposed by the activity projection"
                />
              </InspectorLedger>
            </div>
          }
        >
          <div className="activity-detail-workspace__content">
            <h2 className="sr-only">Activity event evidence</h2>
            <div aria-label="Projected event payload" role="region">
              <Section title="Projected event payload">
                <pre className="activity-detail-workspace__payload">
                  <code>{JSON.stringify(activity, null, 2)}</code>
                </pre>
              </Section>
            </div>
            <div aria-label="Activity event timeline" role="region">
              <Section title="Timeline">
                <ol className="timeline activity-detail-workspace__timeline">
                  <li className="timeline-row activity-detail-workspace__timeline-entry">
                    <span className="timeline-row-head">
                      <span
                        className={`tag ${activityLevelTone(activity.level)}`}
                      >
                        {activity.level}
                      </span>
                      <span className="stage-pill">{activity.stage}</span>
                    </span>
                    <span className="activity-detail-workspace__timeline-copy">
                      <strong className="mono">{activity.eventType}</strong>
                      <span>{activity.message}</span>
                      <time dateTime={activity.at ?? undefined}>
                        {formatDateTime(activity.at)}
                      </time>
                    </span>
                  </li>
                </ol>
              </Section>
            </div>
          </div>
        </RouteWorkspace>
      ) : null}
    </div>
  );
}
