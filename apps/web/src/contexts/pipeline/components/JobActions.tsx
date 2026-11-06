import { JobPreparationActions } from "./PreparationControls.js";

export interface JobActionsProps { readonly jobId: string }

export function JobActions({ jobId }: JobActionsProps) {
  return <JobPreparationActions jobId={jobId} />;
}
