import type { DashboardSummary } from "../../contexts/operations/types.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Empty } from "../../shared/ui/empty.js";
import { SegmentBar } from "../../shared/ui/segment-bar.js";
import type { SegmentBarTone } from "../../shared/ui/status-tokens.js";

type ConversionFunnel = DashboardSummary["conversion"]["totals"];

const FUNNEL_STAGES: ReadonlyArray<{
  readonly key: "applied" | "reply" | "interview" | "offer";
  readonly label: string;
  readonly tone: SegmentBarTone;
  readonly rate: (funnel: ConversionFunnel) => number | null;
}> = [
  { key: "applied", label: "Applied", tone: "running", rate: (funnel) => (funnel.applied > 0 ? 1 : null) },
  { key: "reply", label: "Reply", tone: "done", rate: (funnel) => funnel.replyRate },
  { key: "interview", label: "Interview", tone: "done", rate: (funnel) => funnel.interviewRate },
  { key: "offer", label: "Offer", tone: "done", rate: (funnel) => funnel.offerRate },
];

function formatRate(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

function formatCost(cost: number | null): string {
  return cost === null ? "not available" : cost.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function ConversionFunnelView({ funnel }: { funnel: ConversionFunnel }) {
  return (
    <div className="conversion-funnel">
      {FUNNEL_STAGES.map((stage) => (
        <div className="conversion-stage" key={stage.key}>
          <span className="conversion-stage-lbl">{stage.label}</span>
          <SegmentBar total={funnel.applied} values={[[stage.tone, funnel[stage.key]]]} />
          <span className="conversion-stage-val">
            <b>{funnel[stage.key]}</b>
            <span>{formatRate(stage.rate(funnel))}</span>
          </span>
        </div>
      ))}
      <p className="conversion-note">
        {funnel.rejection} rejected ({formatRate(funnel.rejectionRate)}) · Cost / interview:{" "}
        {formatCost(funnel.costPerInterview)}
      </p>
      {funnel.applied > 0 && funnel.replyRate === null ? (
        <p className="conversion-note">Not enough applications yet for reliable conversion rates.</p>
      ) : null}
    </div>
  );
}

function ConversionBreakdown({
  title,
  emptyLabel,
  rows,
}: {
  title: string;
  emptyLabel: string;
  rows: ReadonlyArray<{ key: string; label: string; funnel: ConversionFunnel }>;
}) {
  return (
    <div className="conversion-breakdown">
      <h3 className="conversion-breakdown-title">{title}</h3>
      {rows.length ? (
        <div className="conversion-rows">
          {rows.map((row) => (
            <div className="conversion-row" key={row.key}>
              <span className="title-stack">
                <b>{row.label}</b>
                <span>
                  applied {row.funnel.applied} · reply {formatRate(row.funnel.replyRate)} · offer{" "}
                  {formatRate(row.funnel.offerRate)}
                </span>
              </span>
              <SegmentBar total={row.funnel.applied} values={[["done", row.funnel.interview]]} />
              <span className="conversion-row-metric">
                <b>{formatRate(row.funnel.interviewRate)}</b>
                <span>interview</span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <Empty title={emptyLabel} />
      )}
    </div>
  );
}

export interface ConversionPanelProps {
  summary: DashboardSummary;
}

export function ConversionPanel({ summary }: ConversionPanelProps) {
  const { totals, bySource, byBand } = summary.conversion;
  const hasOutcomes = totals.applied > 0;
  return (
    <section className="card">
      <CardHeader
        title="Conversion"
        meta={hasOutcomes ? `${totals.applied} applied` : "no outcomes yet"}
      />
      {hasOutcomes ? (
        <div className="conversion-body">
          <ConversionFunnelView funnel={totals} />
          <div className="conversion-breakdowns">
            <ConversionBreakdown
              title="By source"
              emptyLabel="No source data."
              rows={bySource.map((group) => ({ key: group.source, label: group.source, funnel: group }))}
            />
            <ConversionBreakdown
              title="By score band"
              emptyLabel="No score band data."
              rows={byBand.map((group) => ({ key: group.band, label: group.band, funnel: group }))}
            />
          </div>
        </div>
      ) : (
        <Empty title="No applications yet. Conversion appears once you apply and record outcomes." />
      )}
    </section>
  );
}
