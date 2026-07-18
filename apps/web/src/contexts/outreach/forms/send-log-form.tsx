import {
  LogOutreachSendRequestSchema,
  OUTREACH_SEND_CHANNELS,
  type OutreachSendChannel,
} from "@jobctrl/contracts";
import { useForm } from "@tanstack/react-form";
import { useId, type JSX } from "react";

import {
  getApiCapabilityAvailability,
  LOCAL_INSTALL_GUIDE_URL,
} from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../shared/ui/select.js";
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
// send of an APPROVED draft. JobCtrl never sends: this only writes down that
// the user sent it themselves through their own channel (INV-1). `channel` is a
// controlled label, never an address.
export function SendLogForm({
  threadId,
  contactId,
  draftId,
  jobId,
  onLogged,
}: SendLogFormProps): JSX.Element {
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(
    featureFlags,
    "logOutreachSend",
  );
  const formId = useId();
  const unavailableReasonId = useId();
  const mutation = useLogSendMutation(threadId, contactId, jobId);
  const mutationError =
    mutation.error instanceof Error ? mutation.error.message : "";
  const form = useForm({
    defaultValues: {
      channel: "email" as OutreachSendChannel,
      sentAt: todayIsoDate(),
    },
    validators: {
      onSubmit: ({ value }) => {
        const result = LogOutreachSendRequestSchema.safeParse({
          draftId,
          channel: value.channel,
          sentAt: value.sentAt,
        });
        return result.success
          ? undefined
          : (result.error.issues[0]?.message ?? "Invalid send log.");
      },
    },
    onSubmit: async ({ value }) => {
      if (!availability.available) {
        return;
      }
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
        if (!availability.available) {
          return;
        }
        void form.handleSubmit();
      }}
    >
      <p className="muted send-log-note">
        You send this yourself through your own channel; JobCtrl only records
        that you sent it.
      </p>
      <form.Field name="channel">
        {(field) => (
          <Field className="field">
            <FieldLabel htmlFor={`${formId}-channel`}>Channel</FieldLabel>
            <Select
              disabled={!availability.available}
              items={OUTREACH_SEND_CHANNELS.map((channel) => ({
                label: SEND_CHANNEL_LABELS[channel],
                value: channel,
              }))}
              name={field.name}
              value={field.state.value}
              onValueChange={(value) => {
                if (value !== null)
                  field.handleChange(value as OutreachSendChannel);
              }}
            >
              <SelectTrigger
                id={`${formId}-channel`}
                aria-describedby={availability.available ? undefined : unavailableReasonId}
                aria-label="Channel"
                className="w-full"
                disabled={!availability.available}
                onBlur={field.handleBlur}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {OUTREACH_SEND_CHANNELS.map((channel) => (
                    <SelectItem key={channel} value={channel}>
                      {SEND_CHANNEL_LABELS[channel]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      <form.Field name="sentAt">
        {(field) => (
          <Field className="field">
            <FieldLabel htmlFor={`${formId}-sent-at`}>Date you sent it</FieldLabel>
            <Input
              id={`${formId}-sent-at`}
              aria-describedby={availability.available ? undefined : unavailableReasonId}
              disabled={!availability.available}
              type="date"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </Field>
        )}
      </form.Field>
      {!availability.available ? (
        <span className="meta" id={unavailableReasonId}>
          Send logging is available in the local app. JobCtrl never sends
          outreach, and this public demo does not record your personal
          communication activity. {" "}
          <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a>.
        </span>
      ) : null}
      {mutationError ? (
        <div className="banner inline">{mutationError}</div>
      ) : null}
      <form.Subscribe selector={(state) => state.errors}>
        {(errors) => {
          const message = errors
            .flat()
            .filter((entry): entry is string => typeof entry === "string")
            .at(0);
          return message ? (
            <div className="banner inline">{message}</div>
          ) : null;
        }}
      </form.Subscribe>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <div className="form-actions">
            <Button
              aria-describedby={availability.available ? undefined : unavailableReasonId}
              type="submit"
              disabled={mutation.isPending || isSubmitting || !availability.available}
            >
              {mutation.isPending || isSubmitting
                ? "Recording…"
                : "Record send"}
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
