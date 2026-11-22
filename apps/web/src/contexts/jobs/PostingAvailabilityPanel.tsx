import { useEffect, useState } from "react";
import { z } from "zod";

import { Button } from "../../shared/ui/button.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { getApiCapabilityAvailability } from "../../shared/lib/apiCapabilityAvailability.js";
import { useJobActions, usePostingAvailability, type PostingSnapshot } from "./client.js";

const availabilitySchema = z.object({ observedAt: z.string(), metadata: z.record(z.string(), z.unknown()),
  value: z.record(z.string(), z.unknown()), provenance: z.record(z.string(), z.unknown()),
  sources: z.array(z.object({ source_id: z.string(), text: z.string() }).passthrough()),
}).passthrough();
export function PostingAvailabilityPanel({ posting }: { posting: PostingSnapshot }) {
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(featureFlags, "checkPostingAvailability");
  const { checkAvailability } = useJobActions(posting.job_id);
  const read = usePostingAvailability(posting.job_id, availability.available);
  const confirmed = read.data?.last_confirmed;
  const latest = read.data?.last_attempt;
  const staleAt = confirmed ? Date.parse(confirmed.at) + 24 * 60 * 60 * 1000 : 0;
  const [, updateClock] = useState(0);
  useEffect(() => {
    const remaining = staleAt - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => updateClock(value => value + 1), Math.min(remaining + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [staleAt]);
  const parsed = availabilitySchema.safeParse(read.data?.availability);
  return <section className="section" aria-labelledby="availability-title"><h3 id="availability-title">Posting availability</h3>
    {confirmed ? <p role="status">Last confirmed {confirmed.state} on <time dateTime={confirmed.at}>{new Date(confirmed.at).toLocaleString()}</time>.
      {Date.now() >= staleAt ? " This check is stale. Check again for the current status." : null}</p>
      : <p role="status">{availability.available && read.isPending ? "Reading saved availability…" : read.isError ? "Could not read saved availability." : "Availability is unverified."}</p>}
    {latest && (latest.outcome === "unknown" || latest.outcome === "failed") ? <p role="status">The latest check on <time dateTime={latest.at}>{new Date(latest.at).toLocaleString()}</time> was inconclusive.</p> : null}
    {parsed.success ? <details><summary>Availability evidence</summary>
      <p>Observed {parsed.data.observedAt}. Provider: {typeof parsed.data.provenance.provider === "string" ? parsed.data.provenance.provider : "not recorded"}; model: {typeof parsed.data.provenance.model === "string" ? parsed.data.provenance.model : "not recorded"}.</p>
      {Object.entries(parsed.data.value).map(([name, item]) => {
        if (!item || typeof item !== "object" || !("value" in item)) return null;
        const part = item as { value: unknown; rationale?: unknown; citations?: unknown };
        return <div key={name}><p>{name.replaceAll("_", " ")}: {String(part.value)}{typeof part.rationale === "string" ? ` — ${part.rationale}` : ""}</p>
          {Array.isArray(part.citations) ? part.citations.map((value, index) => { const citation = value as { source_id?: unknown; quote?: unknown }; return typeof citation.quote === "string" ? <blockquote key={index}>{citation.quote}<footer>{typeof citation.source_id === "string" ? citation.source_id : ""}</footer></blockquote> : null; }) : null}</div>;
      })}
    </details> : null}
    <Button type="button" variant="outline" disabled={!availability.available || checkAvailability.isPending} onClick={() => checkAvailability.mutate(posting.revision)}>{checkAvailability.isPending ? "Checking…" : "Check availability"}</Button>
    {!availability.available ? <p>{availability.reason}</p> : null}
    {checkAvailability.error ? <p role="alert">{checkAvailability.error.message} The last saved posting and availability remain available.</p> : null}
  </section>;
}
