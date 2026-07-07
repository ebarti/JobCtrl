import { ReviseOutreachDraftRequestSchema } from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import type { JSX } from "react";

import { useReviseDraftMutation } from "../hooks/useReviseDraftMutation.js";

export interface ReviseDraftFormProps {
  threadId: string;
  contactId: string;
  jobId?: string;
  initialBodyText: string;
  onRevised?: () => void;
}

// TanStack Form + Zod safeParse (no zod-form-adapter). Editing only the body; the
// server re-runs the full truthfulness gate stack against the edited text and
// returns a new gated candidate, so prior generations stay in the history (INV-5).
export function ReviseDraftForm({
  threadId,
  contactId,
  jobId,
  initialBodyText,
  onRevised,
}: ReviseDraftFormProps): JSX.Element {
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
    onSubmit: async ({ value }) => {
      const result = ReviseOutreachDraftRequestSchema.safeParse({
        editedBodyText: value.editedBodyText,
      });
      if (!result.success) {
        return;
      }
      await mutation.mutateAsync(result.data);
      onRevised?.();
    },
  });

  return (
    <form
      className="revise-draft-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.Field name="editedBodyText">
        {(field) => (
          <label className="field">
            <span>Edit message</span>
            <textarea
              rows={8}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
        )}
      </form.Field>
      {mutationError ? <div className="banner inline">{mutationError}</div> : null}
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
            <button type="submit" className="tab on" disabled={mutation.isPending || isSubmitting}>
              {mutation.isPending || isSubmitting ? "revising…" : "revise draft"}
            </button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
