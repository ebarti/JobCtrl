import { Button } from "../../../shared/ui/button.js";
import { useCancelApplyMutation } from "../hooks/useCancelApplyMutation.js";
import { useApplicationQuery } from "../readQueries.js";

export const ACTIVE_APPLY_RUN_STATUSES = new Set([
  "pending",
  "queued",
  "running",
  "sending",
]);
export interface CancelApplyButtonProps {
  jobId: string;
  runId?: string;
  className?: string;
  label?: string;
  ariaLabel?: string;
}
export function CancelApplyButton({
  jobId,
  runId,
  className,
  label = "Stop application",
  ariaLabel,
}: CancelApplyButtonProps) {
  const cancel = useCancelApplyMutation();
  const query = useApplicationQuery(jobId);
  return (
    <span>
      <Button
        type="button"
        {...(className ? { className } : {})}
        size="sm"
        variant="warning"
        disabled={
          cancel.isPending || query.isError || !query.data || query.data.stopped
        }
        aria-label={ariaLabel}
        onClick={() => cancel.mutate({ jobId, ...(runId ? { runId } : {}) })}
      >
        {cancel.isPending ? "Stopping application…" : label}
      </Button>
      {cancel.error ? <span role="alert">{cancel.error.message}</span> : null}
    </span>
  );
}
