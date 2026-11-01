import { JobUrlImportRequestSchema, type JobUrlImportExecution } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useId, useState, type JSX } from "react";

import { useImportJobMutation } from "../../contexts/discovery/hooks/useImportJobMutation.js";
import { useJobUrlImportStatusQuery } from "../../contexts/operations/hooks/useJobUrlImportStatusQuery.js";
import {
  getApiCapabilityAvailability,
  LOCAL_INSTALL_GUIDE_URL,
} from "../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { Button } from "../../shared/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../shared/ui/dialog.js";
import { Field, FieldLabel } from "../../shared/ui/field.js";
import { Input } from "../../shared/ui/input.js";

export interface ImportJobUrlDialogProps {
  onImported: (jobKey: string) => void;
}

interface StartedImport {
  execution: JobUrlImportExecution;
  url: string;
}

function ImportProgress({ execution, url, onImported }: StartedImport & ImportJobUrlDialogProps): JSX.Element {
  const progress = useJobUrlImportStatusQuery(execution);
  const outcome = progress.data;
  const pending = !outcome || outcome.status === "pending";
  const terminalError = outcome && "message" in outcome ? outcome.message : "";

  return (
    <div className="banner inline min-w-0 break-all" role="status">
      <div>{url}</div>
      {pending ? "Import accepted and running in the background. " : terminalError ? `Import stopped: ${terminalError} ` : outcome?.status === "manual_capture_required" ? "This posting needs Manual Capture. " : "Import finished. "}
      {outcome?.status === "imported" ? (
        <Button type="button" variant="link" size="content" onClick={() => onImported(outcome.jobKey)}>View job</Button>
      ) : null}
      {outcome?.status === "manual_capture_required" ? <a href="/discovery">Open Manual Capture</a> : null}{" "}
      <a href={`/runs/${encodeURIComponent(execution.workflowId)}`}>View import run</a>
      {pending && progress.isError ? (
        <div>Progress is temporarily unavailable. The import may still be running; JobCtrl will check again automatically.</div>
      ) : null}
    </div>
  );
}

export function ImportJobUrlDialog({ onImported }: ImportJobUrlDialogProps): JSX.Element {
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(featureFlags, "importJobUrl");
  const mutation = useImportJobMutation();
  const pending = mutation.isPending;
  const inputId = useId();
  const availabilityId = useId();
  const [open, setOpen] = useState(false);
  const [imports, setImports] = useState<StartedImport[]>([]);
  const [manualCapture, setManualCapture] = useState<{
    itemId: string;
    reason: string;
  } | null>(null);
  const form = useForm({
    defaultValues: { url: "" },
    validators: {
      onSubmit: ({ value }) => {
        const result = JobUrlImportRequestSchema.safeParse(value);
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Enter a valid job posting URL.");
      },
    },
    onSubmit: async ({ value }) => {
      if (!availability.available) return;
      const parsed = JobUrlImportRequestSchema.safeParse(value);
      if (!parsed.success) return;
      setManualCapture(null);
      try {
        const result = await mutation.mutateAsync(parsed.data);
        if (result.status === "started") {
          setImports((previous) => [
            { execution: result, url: parsed.data.url },
            ...previous.filter(({ execution }) => execution.workflowId !== result.workflowId || execution.executionId !== result.executionId),
          ]);
          form.reset();
          return;
        }
        if (result.status === "imported") {
          form.reset();
          setOpen(false);
          onImported(result.jobKey);
          return;
        }
        if (result.status === "manual_capture_required") {
          setManualCapture({ itemId: result.itemId, reason: result.reason });

        }
      } catch {
        // The mutation error is rendered inside the dialog.
      }
    },
  });
  const mutationError = mutation.error instanceof Error ? mutation.error.message : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {setManualCapture(null);}
      }}
    >
      <DialogTrigger render={<Button title={availability.reason ?? undefined} />}>
        Import job
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a job posting</DialogTitle>
          <DialogDescription>
            Paste a public posting URL. Once accepted, you can add another while it imports in the background.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.Field name="url">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={inputId}>Job posting URL</FieldLabel>
                <Input
                  id={inputId}
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  placeholder="https://company.example/jobs/role"
                  disabled={pending}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.errors}>
            {(errors) => {
              const message = errors
                .flat()
                .find((entry): entry is string => typeof entry === "string");
              return message ? <div className="banner inline">{message}</div> : null;
            }}
          </form.Subscribe>
          {mutationError ? <div className="banner inline">{mutationError}</div> : null}
          {manualCapture ? (
            <div className="banner inline" role="status">
              JobCtrl could not read that page automatically. It is waiting in Manual Capture so
              you can provide the posting content. {" "}
              <a href="/discovery">Open Manual Capture</a>
            </div>
          ) : null}
          {imports.length > 0 ? (
            <div className="grid max-h-64 gap-2 overflow-y-auto">
              {imports.map(({ execution, url }) => (
                <ImportProgress key={`${execution.workflowId}:${execution.executionId}`} execution={execution} url={url} onImported={onImported} />
              ))}
            </div>
          ) : null}
          {!availability.available ? (
            <p className="banner inline" id={availabilityId}>
              {availability.reason} <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a>.
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending || !availability.available}>
              {pending ? "Starting…" : "Import job"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
