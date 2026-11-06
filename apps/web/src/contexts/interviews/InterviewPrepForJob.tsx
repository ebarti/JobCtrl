import { Button } from "../../shared/ui/button.js";
import { InterviewPrepPanel } from "./components/InterviewPrepPanel.js";
import { useAcceptedInterviewPrepQuery } from "./hooks/useInterviewQueries.js";

export function InterviewPrepForJob({ jobId }: { readonly jobId: string }) {
  const query = useAcceptedInterviewPrepQuery(jobId);
  return <>
    {query.error ? <p role="alert">Preparation could not be refreshed. {query.data?.prep ? "The last loaded preparation remains below." : ""} <Button type="button" variant="outline" onClick={() => void query.refetch()}>Retry preparation</Button></p> : null}
    <InterviewPrepPanel jobId={jobId} prep={query.data?.prep ?? null} emptyContent={query.isPending ? <p>Loading saved preparation.</p> : undefined} />
  </>;
}
