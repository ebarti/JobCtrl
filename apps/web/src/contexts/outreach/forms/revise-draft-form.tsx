import { type OutreachPublicationConflict, ReviseOutreachDraftRequestSchema } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useId, useState, type JSX } from "react";

import {
  getApiCapabilityAvailability,
  LOCAL_INSTALL_GUIDE_URL,
} from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { RetainedOutreachSessions } from "../components/RetainedOutreachSessions.js";
import { UnpublishedOutreachProposal } from "../components/UnpublishedOutreachProposal.js";
import { readPublicationConflict } from "../lib/publication-conflict.js";
import { useReviseDraftMutation } from "../hooks/useReviseDraftMutation.js";

export interface ReviseDraftFormProps {
  threadId: string;
  contactId: string;
  jobId?: string;
  initialBodyText: string;
  onRevised?: () => void;
  onDiscard?: () => void;
}

// TanStack Form + Zod safeParse (no zod-form-adapter). Editing only the body; the
// server re-runs the full truthfulness gate stack against the edited text and
// returns a new gated candidate, so prior generations stay in the history (INV-5).
export function ReviseDraftForm(props: ReviseDraftFormProps): JSX.Element {
  const tenantId = useTenantId();
  return (
    <RetainedOutreachSessions key={tenantId} targetKey={JSON.stringify([props.contactId, props.jobId ?? null, props.threadId])}>
      <ReviseDraftSession {...props} />
    </RetainedOutreachSessions>
  );
}

function ReviseDraftSession({
  threadId,
  contactId,
  jobId,
  initialBodyText,
  onRevised,
  onDiscard,
}: ReviseDraftFormProps): JSX.Element {
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(
    featureFlags,
    "reviseOutreachDraft",
  );
  const [retainedConflict, setRetainedConflict] = useState<OutreachPublicationConflict | null>(null);
  const [reconciled, setReconciled] = useState(false);
  const [newerEditAfterSuccess, setNewerEditAfterSuccess] = useState(false);
  const formId = useId();
  const unavailableReasonId = useId();
  const mutation = useReviseDraftMutation(threadId, contactId, jobId);
  const mutationError = mutation.error instanceof Error ? mutation.error.message : "";
  const form = useForm({
    defaultValues: { editedBodyText: initialBodyText },
    validators: {
      onSubmit: ({ value }) => {
        const result = ReviseOutreachDraftRequestSchema.safeParse({
          editedBodyText: value.editedBodyText,
        });
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid message.");
      },
    },
    onSubmit: async ({ value, formApi }) => {
      if (!availability.available || (retainedConflict !== null && !reconciled)) {
        return;
      }
      const result = ReviseOutreachDraftRequestSchema.safeParse({
        editedBodyText: value.editedBodyText,
      });
      if (!result.success) {
        return;
      }
      // Validation trims the submitted body; compare the raw input snapshot so
      // normalization alone does not look like a later edit.
      const submittedText = value.editedBodyText;
      setNewerEditAfterSuccess(false);
      try {
        await mutation.mutateAsync(result.data);
      } catch (error) {
        const conflict = readPublicationConflict(error);
        if (conflict && conflict.threadId === threadId) {
          setRetainedConflict(conflict);
          setReconciled(false);
        }
        // The mutation error is rendered below; resolve the form submission so
        // a recoverable API failure cannot escape the event handler.
        return;
      }
      setRetainedConflict(null);
      setReconciled(false);
      if (formApi.getFieldValue("editedBodyText") !== submittedText) {
        setNewerEditAfterSuccess(true);
        return;
      }
      onRevised?.();
    },
  });

  return (
    <form
      className="revise-draft-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!availability.available || (retainedConflict !== null && !reconciled)) {
          return;
        }
        void form.handleSubmit();
      }}
    >
      <form.Field name="editedBodyText">
        {(field) => (
          <Field className="field">
            <FieldLabel htmlFor={`${formId}-message`}>Edit message</FieldLabel>
            <Textarea
              id={`${formId}-message`}
              aria-describedby={availability.available ? undefined : unavailableReasonId}
              disabled={!availability.available}
              rows={8}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </Field>
        )}
      </form.Field>
      {!availability.available ? (
        <span className="meta" id={unavailableReasonId}>
          Draft revision is available in the local app. This public demo keeps
          synthetic review history and does not process message edits. {" "}
          <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a>.
        </span>
      ) : null}
      {mutationError ? <div role="alert" className="banner inline">{mutationError}</div> : null}
      {newerEditAfterSuccess ? (
        <p role="status">Your submitted revision was saved for review. Your newer edits remain here and have not been verified.</p>
      ) : null}
      {retainedConflict ? (
        <UnpublishedOutreachProposal conflict={retainedConflict} mode="revision" reconciled={reconciled} onReconciled={setReconciled} disabled={mutation.isPending} />
      ) : null}
      <form.Subscribe selector={(state) => state.errors}>
        {(errors) => {
          const message = errors
            .flat()
            .filter((entry): entry is string => typeof entry === "string")
            .at(0);
          return message ? <div className="banner inline">{message}</div> : null;
        }}
      </form.Subscribe>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <div className="form-actions">
            <Button
              aria-describedby={availability.available ? undefined : unavailableReasonId}
              type="submit"
              disabled={mutation.isPending || isSubmitting || !availability.available || (retainedConflict !== null && !reconciled)}
            >
              {mutation.isPending || isSubmitting ? "Revising…" : "Revise draft"}
            </Button>
            {onDiscard ? (
              <Button type="button" variant="outline" disabled={mutation.isPending || isSubmitting} onClick={onDiscard}>
                Discard revision
              </Button>
            ) : null}
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
