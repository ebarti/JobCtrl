import {
  LogOutreachSendRequestSchema,
  OUTREACH_SEND_CHANNELS,
  type OutreachSendChannel,
} from "@jobhunter/contracts";
import { useForm } from "@tanstack/react-form";
import type { JSX } from "react";

import { useLogSendMutation } from "../hooks/useLogSendMutation.js";

export interface SendLogFormProps {
  threadId: string;
  contactId: string;
  draftId: string;
  jobId?: string;
  onLogged?: () => void;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

const SEND_CHANNEL_LABELS: Record<OutreachSendChannel, string> = {
  email: "Email",
  personal_email: "Personal email",
  work_email: "Work email",
  linkedin_message: "LinkedIn message",
  phone_call: "Phone call",
  other: "Other",
};

// TanStack Form + Zod safeParse (no zod-form-adapter). Records a user-attested
// send of an APPROVED draft. JobHunter never sends: this only writes down that
// the user sent it themselves through their own channel (INV-1). `channel` is a
// controlled label, never an address.
export function SendLogForm({
  threadId,
  contactId,
  draftId,
  jobId,
  onLogged,
}: SendLogFormProps): JSX.Element {
  const mutation = useLogSendMutation(threadId, contactId, jobId);
  const mutationError = mutation.error instanceof Error ? mutation.error.message : "";
  const form = useForm({
    defaultValues: { channel: "email" as OutreachSendChannel, sentAt: todayIsoDate() },
    validators: {
      onSubmit: ({ value }) => {
        const result = LogOutreachSendRequestSchema.safeParse({
          draftId,
          channel: value.channel,
          sentAt: value.sentAt,
        });
        return result.success ? undefined : (result.error.issues[0]?.message ?? "Invalid send log.");
      },
    },
    onSubmit: async ({ value }) => {
      const result = LogOutreachSendRequestSchema.safeParse({
        draftId,
        channel: value.channel,
        sentAt: value.sentAt,
      });
      if (!result.success) {
        return;
      }
      await mutation.mutateAsync(result.data);
      onLogged?.();
    },
  });

  return (
    <form
      className="send-log-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <p className="muted send-log-note">
        You send this yourself through your own channel; JobHunter only records that you sent it.
      </p>
      <form.Field name="channel">
        {(field) => (
          <label className="field">
            <span>Channel</span>
            <select
              name={field.name}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value as OutreachSendChannel)}
            >
              {OUTREACH_SEND_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {SEND_CHANNEL_LABELS[channel]}
                </option>
              ))}
            </select>
          </label>
        )}
      </form.Field>
      <form.Field name="sentAt">
        {(field) => (
          <label className="field">
            <span>Date you sent it</span>
            <input
              type="date"
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
              {mutation.isPending || isSubmitting ? "recording…" : "record send"}
            </button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
