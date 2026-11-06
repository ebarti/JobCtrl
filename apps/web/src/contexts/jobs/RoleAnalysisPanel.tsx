import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { Button } from "../../shared/ui/button.js";
import { getApiCapabilityAvailability } from "../../shared/lib/apiCapabilityAvailability.js";
import { jobsKeys } from "./client.js";

const citation = z.object({ source_id: z.string(), quote: z.string() }).passthrough();
const statement = z.object({ text: z.string(), uncertainty: z.string(), citations: z.array(citation) }).passthrough();
const responseSchema = z.object({ job_id: z.string(), current: z.boolean(), revision: z.number().optional(), posting_revision: z.number().optional(),
  accepted: z.object({ analysis: z.object({ role_framing: statement, ideal_candidate_narrative: statement,
    inferred_seniority: z.object({ value: z.string(), rationale: z.string(), citations: z.array(citation) }).passthrough(),
    keywords: z.array(z.object({ keyword: z.string(), evidence_span: z.string(), rationale: z.string(), requirement_ref: z.string().nullable(), citations: z.array(citation) }).passthrough()),
  }).passthrough(), provenance: z.record(z.string(), z.unknown()), failures: z.array(z.unknown()) }).passthrough().nullable(),
}).passthrough();
function parse(value: unknown) {
  const result = responseSchema.safeParse(value);
  if (!result.success) throw new Error("The saved role analysis response is invalid. The accepted analysis was not replaced.");
  return result.data;
}
export function RoleAnalysisPanel({ jobId, postingRevision }: { jobId: string; postingRevision: number }) {
  const tenantId = useTenantId(); const { http, featureFlags } = usePorts(); const client = useQueryClient();
  const availability = getApiCapabilityAvailability(featureFlags, "runJobStage");
  const key = [...jobsKeys.all(tenantId), "analysis", jobId] as const;
  const query = useQuery({ queryKey: key, queryFn: async () => parse(await http.json<unknown>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/analysis`)), meta: { suppressGlobalErrorToast: true } });
  const run = useMutation({ mutationFn: async () => parse(await http.json<unknown>("POST", `/v1/jobs/${encodeURIComponent(jobId)}/analysis`, { body: { expectedRevision: postingRevision } })),
    onSuccess: (saved) => { client.setQueryData<z.infer<typeof responseSchema>>(key, (current) =>
      current && (current.revision ?? 0) > (saved.revision ?? 0) ? current : saved); } });
  const accepted = query.data?.accepted;
  return <section className="section" aria-labelledby="role-analysis-title"><h3 id="role-analysis-title">Role analysis</h3>
    <p>Employer-side interpretation of the captured posting. It does not determine your qualifications.</p>
    {query.isPending ? <p>Loading role analysis…</p> : null}
    {query.error ? <p role="alert">{query.error.message}</p> : null}
    {query.data && !query.data.current && accepted ? <p role="status">The analysis is from an earlier posting. The accepted result remains below.</p> : null}
    {accepted ? <>
      <h4>Role framing</h4><p>{accepted.analysis.role_framing.text}</p><p>Uncertainty: {accepted.analysis.role_framing.uncertainty}</p><Citations citations={accepted.analysis.role_framing.citations} />
      <h4>Seniority</h4><p>{accepted.analysis.inferred_seniority.value} — {accepted.analysis.inferred_seniority.rationale}</p><Citations citations={accepted.analysis.inferred_seniority.citations} />
      <h4>Ideal candidate</h4><p>{accepted.analysis.ideal_candidate_narrative.text}</p><p>Uncertainty: {accepted.analysis.ideal_candidate_narrative.uncertainty}</p><Citations citations={accepted.analysis.ideal_candidate_narrative.citations} />
      <h4>Posting keywords</h4><ul>{accepted.analysis.keywords.map((keyword, index) => <li key={`${keyword.keyword}:${index}`}><strong>{keyword.keyword}</strong>: {keyword.rationale}<blockquote>{keyword.evidence_span}</blockquote><Citations citations={keyword.citations} /></li>)}</ul>
      <details><summary>Analysis provenance</summary><p>Analysis revision {query.data?.revision}; posting revision {query.data?.posting_revision}.</p><p>Provider: {typeof accepted.provenance.provider === "string" ? accepted.provenance.provider : "not recorded"}; model: {typeof accepted.provenance.model === "string" ? accepted.provenance.model : "not recorded"}.</p>{accepted.failures.length ? <p>{accepted.failures.length} additional model observation(s) failed.</p> : null}</details>
    </> : query.data ? <p>No role analysis has been accepted.</p> : null}
    <Button type="button" variant="outline" disabled={!availability.available || run.isPending || query.isPending} onClick={() => run.mutate()}>{run.isPending ? "Analyzing…" : accepted ? "Refresh role analysis" : "Analyze role"}</Button>
    {!availability.available ? <p>{availability.reason}</p> : null}
    {run.error ? <p role="alert">{run.error.message} {accepted ? "The last accepted analysis remains above." : "No analysis was accepted."}</p> : null}
  </section>;
}
function Citations({ citations }: { citations: readonly z.infer<typeof citation>[] }) {
  return <details><summary>Posting citations</summary>{citations.map((item, index) => <blockquote key={`${item.source_id}:${index}`}>{item.quote}<footer>{item.source_id}</footer></blockquote>)}</details>;
}
