import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";

export interface RecordedDetermination {
  readonly determinationId: string;
  readonly available: boolean;
  readonly operation?: string;
  readonly createdAt?: string;
  readonly provenance?: unknown;
  readonly instructions?: string | null;
  readonly sources?: unknown;
  readonly responseSchema?: unknown;
  readonly context?: unknown;
  readonly result?: unknown;
  readonly accepted?: boolean;
  readonly verified?: boolean;
  readonly verificationFailure?: string | null;
}
interface DeterminationResponse {
  readonly ok: true;
  readonly threadId: string;
  readonly draftId: string;
  readonly complete: boolean;
  readonly authorityVerified: boolean;
  readonly records: RecordedDetermination[];
}

/** Loads source-bound review records only after the user opens the audit. */
export function OutreachDeterminations({ threadId, draftId, expectedIds }: { threadId: string; draftId: string; expectedIds: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const tenantId = useTenantId();
  const { http } = usePorts();
  const query = useQuery({
    queryKey: outreachKeys.determinations(tenantId, threadId, draftId, expectedIds),
    enabled: open,
    queryFn: async () => {
      const response = await http.json<DeterminationResponse>("GET", `/v1/outreach/threads/${encodeURIComponent(threadId)}/drafts/${encodeURIComponent(draftId)}/determinations`);
      if (response.ok !== true || response.threadId !== threadId || response.draftId !== draftId || typeof response.complete !== "boolean" || typeof response.authorityVerified !== "boolean" || !Array.isArray(response.records) || !recordsMatch(response.records, expectedIds)) {
        throw new Error("The recorded review identities do not match this draft.");
      }
      return response;
    },
  });
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Inspect prompts, model results and sources</summary>
    {query.isFetching ? <p role="status">Loading recorded reviews.</p> : null}
    {query.error ? <p role="alert">Recorded reviews could not be loaded: {query.error.message}</p> : null}
    {query.data ? <DeterminationRecords records={query.data.records} complete={query.data.complete} authorityVerified={query.data.authorityVerified} /> : null}
  </details>;
}

export function recordsMatch(records: readonly RecordedDetermination[], ids: readonly string[]): boolean {
  const expected = new Set(ids);
  return expected.size === ids.length && records.length === ids.length && records.every((record) =>
    typeof record.determinationId === "string" && typeof record.available === "boolean" && expected.delete(record.determinationId)) && expected.size === 0;
}

export function DeterminationRecords({ records, complete, authorityVerified }: { records: readonly RecordedDetermination[]; complete: boolean; authorityVerified: boolean }) {
  return <>
    {records.length === 0 ? <p>No model determinations were recorded.</p> : !complete ? <p role="status">Some recorded reviews are unavailable.</p> : null}
    {records.length > 0 ? <p role="status">{authorityVerified ? "Recorded model receipts and source bindings verified." : "Recorded model authority could not be verified."}</p> : null}
    {records.map((record) => <section key={record.determinationId} aria-label={`Review ${record.determinationId}`}>
      <p className="mono">{record.determinationId}{record.operation ? ` · ${record.operation}` : ""}</p>
      {!record.available ? <p role="status">This determination is unavailable.</p> : <>
        {record.verified === false ? <p role="status">Receipt verification failed{record.verificationFailure ? `: ${record.verificationFailure}` : "."}</p> : null}
        {record.accepted === false ? <p role="status">The model output was recorded but not accepted.</p> : null}
        {record.instructions == null ? <p>No original prompt was recorded for this determination.</p> : <><p>Instructions</p><pre className="whitespace-pre-wrap break-words">{record.instructions}</pre></>}
        <p>Sources, response schema, context, result and provenance</p>
        <pre className="whitespace-pre-wrap break-words">{JSON.stringify({ sources: record.sources, responseSchema: record.responseSchema, context: record.context, result: record.result, provenance: record.provenance }, null, 2)}</pre>
      </>}
    </section>)}
  </>;
}
