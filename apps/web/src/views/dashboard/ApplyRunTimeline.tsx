import { Empty } from "../../shared/ui/empty.js";

export interface ApplyRunTimelineProps {
  runId: string;
}

export function ApplyRunTimeline({ runId }: ApplyRunTimelineProps) {
  return (
    <div className="apply-run-timeline" data-run-id={runId}>
      <Empty title="Timeline streams from the SSE consumer landing in Phase 5." />
    </div>
  );
}
