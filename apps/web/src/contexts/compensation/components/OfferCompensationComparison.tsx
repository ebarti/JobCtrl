import { formatDateTime } from "../../../shared/lib/formatters.js";
import { Button } from "../../../shared/ui/button.js";
import { useCompensationComparisonQuery } from "../hooks/useCompensationComparisonQuery.js";

const label = (value: string) => value.replaceAll("_", " ");

export function OfferCompensationComparison({ jobId }: { jobId: string }) {
  const query = useCompensationComparisonQuery(jobId);
  const posted = query.data?.posted;
  const market = query.data?.market;
  const fact = posted?.recordStatus === "recorded" ? posted.fact : null;
  const estimate = market?.recordStatus === "recorded" ? market.estimate : null;
  return (
    <details>
      <summary>Compare with existing compensation evidence</summary>
      <p>
        Actual terms above remain separate from posting evidence and market
        estimates. Amounts are shown in their recorded currency, component and
        time base; no conversion, equity valuation or total is inferred.
      </p>
      {query.error ? (
        <p role="alert">
          Compensation evidence could not be read: {query.error.message}
          {" "}<Button type="button" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Retry comparison</Button>
        </p>
      ) : null}
      {posted?.sourceCurrent === false ? <p role="status">Posting evidence refers to an earlier posting revision.</p> : null}
      {market?.sourceCurrent === false ? <p role="status">Market evidence refers to an earlier posting revision.</p> : null}
      {market?.evidenceFresh === false ? <p role="status">The recorded market inputs have passed their refresh window.</p> : null}
      <p>
        Posting evidence:{" "}
        {fact?.parseState === "parsed_range"
          ? `${fact.minimumAmount ?? "Unknown"}–${fact.maximumAmount ?? "Unknown"} ${fact.currency ?? "currency unknown"} / ${fact.period} (${label(fact.component)})`
          : (fact?.parseState ?? posted?.recordStatus ?? (query.error ? "Unavailable" : "Loading"))}
      </p>
      {fact ? (
        <p className="whitespace-pre-wrap">
          Source: {fact.sourceText ?? "Unknown"}
        </p>
      ) : null}
      <p>
        Market estimate:{" "}
        {estimate?.estimateState === "estimated_range"
          ? `${estimate.minimumAmount}–${estimate.maximumAmount} ${estimate.currency} / ${estimate.period} (${label(estimate.component)})`
          : (estimate?.estimateState ?? market?.recordStatus ?? (query.error ? "Unavailable" : "Loading"))}
      </p>
      {estimate ? (
        <>
          <p>
            Estimated {formatDateTime(estimate.estimatedAt)} ·{" "}
            {estimate.confidenceBand === "none" ? "Reliability not assessed" : `Confidence ${estimate.confidenceBand}`}
          </p>
          <ul>
            {estimate.sources.map((source, index) => (
              <li key={index}>
                {source.displayName} · {source.snapshotVersion}
              </li>
            ))}
          </ul>
          <ul>
            {estimate.warnings.map((warning, index) => (
              <li key={index}>{warning.message}</li>
            ))}
          </ul>
        </>
      ) : null}
    </details>
  );
}
