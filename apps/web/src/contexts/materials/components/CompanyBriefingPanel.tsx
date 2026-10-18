import type { CompanyBriefingView } from "@jobctrl/contracts";
import { formatDateTime } from "../../../shared/lib/formatters.js";

const headings = { company_fact: "Company facts", reported_event: "Reported events", hypothesis: "Hypotheses" } as const;
const staleLabels: Record<string, string> = {
  source_identity_needs_review: "The selected sources do not establish an unambiguous company identity. Review the company and source selection before refreshing.",
  identity_review_required: "The saved employer changed. Confirm the company link again before using this briefing.",
  sources_older_than_seven_days: "Sources were observed more than seven days ago.",
  sources_changed: "The selected sources changed after this briefing was accepted.",
  briefing_version_changed: "This briefing uses an earlier generation contract.",
};
export function CompanyBriefingPanel({ briefing }: { readonly briefing: CompanyBriefingView | null | undefined }) {
  if (!briefing) return null;
  if (briefing.status === "unavailable" || !briefing.company) return <section className="section" aria-label="Company briefing"><h3>Company briefing</h3><p role="alert">The saved briefing could not be verified. Its history is preserved; retry loading it.</p></section>;
  const { company, accepted, lastAttempt } = briefing;
  const sources = new Map(accepted?.sources.map((source) => [source.sourceId, source]));
  return <section className="section min-w-0" aria-label="Company briefing">
    <h3>Company briefing · {company.name}</h3>
    <p>{briefing.status === "current" ? "Within the seven-day freshness window" : briefing.status === "missing" ? "No accepted briefing yet" : briefing.status === "needs_review" ? "Company identity needs review" : "Stale briefing — review required"}</p>
    <a href={company.homepageUrl} target="_blank" rel="noreferrer" className="break-all">Company source identity</a>
    {briefing.staleReasons.map((reason) => <p key={reason}>{staleLabels[reason] ?? reason}</p>)}
    {lastAttempt?.failureCode ? <p role="status">Refresh failed ({lastAttempt.failureCode}). {accepted ? "The last accepted briefing remains below." : "No briefing has been accepted."}</p> : null}
    {lastAttempt?.identityReason ? <details><summary>Why identity needs review</summary><p>{lastAttempt.identityReason}</p><p className="break-all">Determination: {lastAttempt.determinationId}</p>{lastAttempt.sources.map((source) => <p key={source.sourceId}><a href={source.finalUrl} target="_blank" rel="noreferrer">{source.finalUrl}</a> · observed {formatDateTime(source.observedAt)}</p>)}</details> : null}
    {accepted ? <>
      <p>Sources observed {formatDateTime(accepted.observedAt)}. Observation dates do not establish when an event happened.</p>
      <p>Public company context. Role-specific implications remain in role analysis and interview preparation.</p>
      {(Object.keys(headings) as (keyof typeof headings)[]).map((kind) => {
        const claims = accepted.result.claims.filter((claim) => claim.kind === kind);
        return claims.length ? <section key={kind} aria-label={headings[kind]}><h4>{headings[kind]}</h4>
          <ul>{claims.map((claim, index) => <li key={index} className="mb-4 min-w-0">
            <p>{claim.text}</p><p>Uncertainty: {claim.uncertainty}</p>
            {claim.event_date ? <p>Reported date: {claim.event_date}</p> : null}
            <details><summary>Sources for this claim</summary>{claim.citations.map((citation, citationIndex) => {
              const source = sources.get(citation.source_id);
              return source ? <div key={citationIndex} className="mb-3 min-w-0">
                <a href={source.finalUrl} target="_blank" rel="noreferrer" className="break-all">{source.finalUrl}</a>
                <p>Observed {formatDateTime(source.observedAt)}</p><blockquote className="whitespace-pre-wrap break-words">{citation.quote}</blockquote>
                <details><summary>Source fingerprint</summary><code className="break-all">{source.contentHash}</code></details>
              </div> : <p key={citationIndex}>No recorded source</p>;
            })}</details>
          </li>)}</ul></section> : null;
      })}
      <details><summary>Briefing provenance</summary><p>{accepted.provider} · {accepted.model} · {accepted.promptVersion}</p><p className="break-all">Determination: {accepted.determinationId}</p><p>{accepted.result.identity_reason}</p></details>
    </> : <p>Refresh explicitly from the local CLI after confirming the company and selecting public sources.</p>}
    <p>Refreshes are optional. Use the local <code>company-briefing refresh</code> command with <code>--allow-public-fetch</code>.</p>
  </section>;
}
