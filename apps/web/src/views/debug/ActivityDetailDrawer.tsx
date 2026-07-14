import { IconArrowLeft } from "@tabler/icons-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useActivityEventQuery } from "../../contexts/operations/hooks/useActivityEventQuery.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { Button } from "../../shared/ui/button.js";
import { Empty } from "../../shared/ui/empty.js";
import {
  InspectorLedger,
  InspectorLedgerItem,
} from "../../shared/ui/inspector-ledger.js";
import { RouteWorkspace } from "../../shared/ui/route-workspace.js";
import { Section } from "../../shared/ui/section.js";
import { SectionTabs, SectionTabsList } from "../../shared/ui/section-tabs.js";
import { StatusLabel } from "../../shared/ui/status-label.js";
import { TabsContent, TabsTrigger } from "../../shared/ui/tabs.js";
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
  const stateTitle = errorMessage
    ? errorMessage
    : isLoading
      ? "Loading activity event."
      : `Activity event ${eventId} is no longer in the recent list.`;

  return (
    <div className="route-page route-page--activity-detail">
      {!activity ? (
        <section
          className="detail-route-state"
          aria-label="Activity event state"
        >
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
          <Empty title={stateTitle} />
        </section>
      ) : null}
      {activity ? (
        <SectionTabs className="activity-detail-tabs" defaultValue="payload">
          <RouteWorkspace
            aria-labelledby="activity-detail-heading"
            className="activity-detail-workspace"
            contentLabel="Activity workspace panels"
            inspectorLabel="Activity event facts"
            tabs={
              <nav aria-label="Activity detail panels">
                <SectionTabsList>
                  <TabsTrigger value="payload">Payload</TabsTrigger>
                  <TabsTrigger value="timeline">Timeline</TabsTrigger>
                </SectionTabsList>
              </nav>
            }
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
                <span className="activity-detail-workspace__status">
                  <StatusLabel tone={activityLevelTone(activity.level)}>
                    {activity.level}
                  </StatusLabel>
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
                    <Button asChild size="sm" variant="outline">
                      <Link to="/jobs/$jobId" params={{ jobId: activity.jobKey }}>
                        Open related job
                      </Link>
                    </Button>
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
                      <StatusLabel tone={activityLevelTone(activity.level)}>
                        {activity.level}
                      </StatusLabel>
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
            <TabsContent
              className="activity-detail-workspace__panel"
              forceMount
              value="payload"
            >
              <Section
                aria-label="Projected event payload"
                title="Projected event payload"
                description="The complete activity detail returned by the local read model."
              >
                <pre className="activity-detail-workspace__payload">
                  <code>{JSON.stringify(activity, null, 2)}</code>
                </pre>
              </Section>
            </TabsContent>
            <TabsContent
              className="activity-detail-workspace__panel"
              forceMount
              value="timeline"
            >
              <Section
                aria-label="Activity event timeline"
                title="Timeline"
                description="The selected event at its recorded timestamp."
              >
                <ol className="timeline activity-detail-workspace__timeline">
                  <li className="timeline-row activity-detail-workspace__timeline-entry">
                    <span className="timeline-row-head">
                      <StatusLabel tone={activityLevelTone(activity.level)}>
                        {activity.level}
                      </StatusLabel>
                      <span className="activity-stage-label">
                        {activity.stage}
                      </span>
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
            </TabsContent>
          </RouteWorkspace>
        </SectionTabs>
      ) : null}
    </div>
  );
}
