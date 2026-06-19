import type { CompensationSourcePolicySummary } from "../../operations/types.js";
import { useCompensationSourcePolicyQuery } from "../../operations/hooks/useCompensationSourcePolicyQuery.js";
import { CardHeader } from "../../../shared/ui/card-header.js";
import { Empty } from "../../../shared/ui/empty.js";

export function CompensationSourcePolicyPanel() {
  const query = useCompensationSourcePolicyQuery();
  const sources = query.data?.sources ?? [];

  return (
    <section className="card full compensation-source-policy-panel">
      <CardHeader title="Compensation sources" meta="source policy" />
      {query.error ? <div className="banner inline">{query.error.message}</div> : null}
      {query.isLoading ? <Empty title="Loading compensation sources." /> : null}
      {!query.isLoading && !query.error ? (
        <div className="source-registry-table-wrap">
          <table className="source-registry-table" aria-label="Compensation source policy">
            <caption>{sources.length} configured source policies</caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Policy</th>
                <th scope="col">Status</th>
                <th scope="col">Freshness</th>
                <th scope="col">Attribution</th>
                <th scope="col">Coverage</th>
                <th scope="col">Supported fields</th>
                <th scope="col">Access notes</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <CompensationSourcePolicyRow key={source.sourceId} source={source} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function CompensationSourcePolicyRow({ source }: { source: CompensationSourcePolicySummary }) {
  return (
    <tr>
      <th scope="row">
        <strong>{source.displayName}</strong>
        <div className="meta">{source.sourceId}</div>
        <div className="source-table-actions">
          {source.sourceUrl ? (
            <a href={source.sourceUrl} aria-label={`${source.displayName} source`}>
              source
            </a>
          ) : (
            <span className="meta">local posting</span>
          )}
          {source.termsUrl ? (
            <a href={source.termsUrl} aria-label={`${source.displayName} terms`}>
              terms
            </a>
          ) : null}
        </div>
      </th>
      <td>
        <div>{formatLabel(source.sourceType)}</div>
        <span className="tag muted">{formatLabel(source.accessMode)}</span>
      </td>
      <td>
        <div>
          <span className={availabilityClass(source.availability)}>
            {formatLabel(source.availability)}
          </span>
        </div>
        <div>
          <span className={licenseClass(source.licenseStatus)}>
            {formatLabel(source.licenseStatus)}
          </span>
        </div>
        <div className="meta">{source.configured ? "configured" : "not configured"}</div>
      </td>
      <td>{source.freshnessPolicy}</td>
      <td>{source.attributionRequirement}</td>
      <td>
        <div>{formatLabel(source.coverage.geography)}</div>
        <div className="meta">{source.coverage.regions.join(", ") || "none configured"}</div>
        <div className="meta">{source.coverage.notes}</div>
      </td>
      <td>{renderSupportedFields(source)}</td>
      <td>
        {source.disabledReason ? <div className="banner inline">{source.disabledReason}</div> : null}
        {source.notes.map((note) => (
          <div key={note} className="meta">
            {note}
          </div>
        ))}
      </td>
    </tr>
  );
}

function renderSupportedFields(source: CompensationSourcePolicySummary) {
  if (source.supportedFields.length === 0) {
    return <span className="tag muted">none until permitted</span>;
  }
  return (
    <div className="job-audit-tag-group" aria-label={`${source.displayName} supported fields`}>
      {source.supportedFields.map((field) => (
        <span key={field} className="tag info">
          {formatLabel(field)}
        </span>
      ))}
    </div>
  );
}

function formatLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function availabilityClass(availability: CompensationSourcePolicySummary["availability"]): string {
  return availability === "available" ? "tag ok" : "tag warn";
}

function licenseClass(status: CompensationSourcePolicySummary["licenseStatus"]): string {
  if (status === "permitted" || status === "not_required") {
    return "tag ok";
  }
  return "tag warn";
}
