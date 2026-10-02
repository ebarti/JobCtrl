import type { InterviewCatalog, InterviewQuestionCard } from "../../operations/types.js";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Empty } from "../../../shared/ui/empty.js";
import { Button } from "../../../shared/ui/button.js";
import { useJobDetailQuery } from "../../operations/hooks/useJobDetailQuery.js";
import { useInterviewPrepHistoryQuery } from "../../operations/hooks/useInterviewQueries.js";
import { useEvidenceMapQuery } from "../../operations/hooks/useEvidenceMapQuery.js";
import { InterviewContextForm } from "../forms/interview-context-form.js";
import { InterviewNoteForm } from "../forms/interview-note-form.js";
import { InterviewPrepPanel } from "./InterviewPrepPanel.js";

// Mount only for an explicit canonical job. The offline catalog path never
// creates a job query or passes an empty job ID into a job-backed hook.
export function InterviewJobPreparation({ jobId, catalog, question }: {
  readonly jobId: string; readonly catalog: InterviewCatalog; readonly question: InterviewQuestionCard | null;
}) {
  const detail = useJobDetailQuery(jobId);
  const evidence = useEvidenceMapQuery();
  const [historyPage, setHistoryPage] = useState(1);
  const history = useInterviewPrepHistoryQuery(jobId, historyPage);
  if (!detail.data) return <Empty title={detail.error ? "Job unavailable. Open a canonical job from Jobs to prepare." : "Loading selected job."} />;
  const job = detail.data;
  const prep = history.data?.generations.find((generation) => generation.generation === job.interviewPrep?.generation) ?? job.interviewPrep;
  const selectedIsBound = Boolean(question && prep?.generationContext?.selectedQuestionIds.includes(question.id));
  const resolveEvidenceReference = (evidenceId: string) => {
    if (!evidence.data) return evidence.isPending ? undefined : null;
    const entry = evidence.data.entries.find((item) => item.entryId === evidenceId || item.evidenceId === evidenceId);
    return entry ? { entryId: entry.entryId, title: entry.title, excerpt: entry.story?.outcome ?? entry.story?.action ?? null } : null;
  };
  return (
    <section className="card full" aria-label="Job interview preparation">
      <h2 data-typography="section-title">Preparation for {job.job.title}</h2>
      <Link to="/jobs/$jobId" params={{ jobId: job.job.jobKey }}>Open canonical job</Link>
      <InterviewContextForm jobId={job.job.jobKey} catalog={catalog} questionId={question?.id ?? ""} context={prep?.generationContext} />
      {question ? <InterviewNoteForm key={`${jobId}:${question.id}`} jobId={job.job.jobKey} questionId={question.id} sourceGeneration={selectedIsBound ? prep?.generation ?? null : null} bindings={{ catalogBinding: { catalogRevision: catalog.catalogRevision, catalogDigest: catalog.catalogDigest }, cardRevision: question.cardRevision, cardDigest: question.cardDigest, contextDigest: selectedIsBound ? prep?.generationContext?.contextDigest ?? null : null }} /> : null}
      <InterviewPrepPanel jobId={job.job.jobKey} prep={prep} requirements={job.employerAnalysis?.requirements ?? []} resolveEvidenceReference={resolveEvidenceReference} generationAction={null} />
      <section className="section" aria-label="Preparation history"><h3 data-typography="component-title">Preparation history</h3>
        {history.error ? <p role="alert">Preparation history unavailable; the last accepted preparation remains above.</p> : null}
        {history.data?.generations.map((generation) => <details key={generation.generation}><summary>Generation {generation.generation} · {generation.status} · {generation.generatedAt}</summary>{generation.status === "failed" ? <><p>Failed attempt; the accepted generation remains available.</p><pre className="whitespace-pre-wrap break-all">{JSON.stringify(generation, null, 2)}</pre></> : <InterviewPrepPanel jobId={jobId} prep={generation} requirements={job.employerAnalysis?.requirements ?? []} resolveEvidenceReference={resolveEvidenceReference} generationAction={null} />}</details>)}
        {history.data ? <div className="flex flex-wrap gap-2"><span>Page {historyPage}; {history.data.total} generations</span><Button type="button" variant="outline" disabled={historyPage === 1} onClick={() => setHistoryPage((page) => page - 1)}>Previous generations</Button><Button type="button" variant="outline" disabled={historyPage * history.data.pageSize >= history.data.total} onClick={() => setHistoryPage((page) => page + 1)}>Older generations</Button></div> : null}
      </section>
    </section>
  );
}
