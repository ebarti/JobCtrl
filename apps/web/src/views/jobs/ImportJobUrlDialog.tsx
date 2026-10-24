import { JobUrlImportRequestSchema } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useEffect, useId, useRef, useState, type JSX } from "react";

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

export function ImportJobUrlDialog({ onImported }: ImportJobUrlDialogProps): JSX.Element {
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(featureFlags, "importJobUrl");
  const mutation = useImportJobMutation();
  const execution = mutation.data?.status === "started" ? mutation.data : undefined;
  const progress = useJobUrlImportStatusQuery(execution);
  const outcome = progress.data;
  const pending = mutation.isPending || (execution !== undefined && (!outcome || outcome.status === "pending"));
  const handledExecution = useRef<string | undefined>(undefined);
  const inputId = useId();
  const availabilityId = useId();
  const [open, setOpen] = useState(false);
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
  useEffect(() => {
    if (!open || !execution || outcome?.status !== "imported" || handledExecution.current === execution.executionId) return;
    handledExecution.current = execution.executionId;
    form.reset();
    setOpen(false);
    onImported(outcome.jobKey);
  }, [open, execution, outcome, form, onImported]);
  const mutationError = mutation.error instanceof Error ? mutation.error.message : "";
  const terminalError = outcome && "message" in outcome ? outcome.message : "";
  const capture = outcome?.status === "manual_capture_required" ? outcome : manualCapture;

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
            Paste the public posting URL. JobCtrl will import it in the background and show its progress here.
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
          {terminalError ? <div className="banner inline" role="alert">{terminalError}</div> : null}
          {execution ? (
            <div className="banner inline" role="status">
              {pending ? "JobCtrl has accepted this import. It will continue if you close this dialog. " : terminalError ? "The import has stopped. " : "Import finished. "}
              <a href={`/runs/${encodeURIComponent(execution.workflowId)}`}>View import run</a>
            </div>
          ) : null}
          {execution && pending && progress.isError ? (
            <div className="banner inline" role="status">
              Progress is temporarily unavailable. The import may still be running; JobCtrl will check again automatically.
            </div>
          ) : null}
          {capture ? (
            <div className="banner inline" role="status">
              JobCtrl could not read that page automatically. It is waiting in Manual Capture so
              you can provide the posting content. {" "}
              <a href="/discovery">Open Manual Capture</a>
            </div>
          ) : null}
          {!availability.available ? (
            <p className="banner inline" id={availabilityId}>
              {availability.reason} <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a>.
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending || !availability.available}>
              {pending ? "Importing…" : "Import job"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
