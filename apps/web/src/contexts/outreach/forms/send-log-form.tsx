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
          <label className="field">
            <span>Channel</span>
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
          </label>
        )}
      </form.Field>
      <form.Field name="sentAt">
        {(field) => (
          <label className="field">
            <span>Date you sent it</span>
            <input
              aria-describedby={availability.available ? undefined : unavailableReasonId}
              disabled={!availability.available}
              type="date"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
          </label>
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
            <button
              aria-describedby={availability.available ? undefined : unavailableReasonId}
              type="submit"
              className="tab on"
              disabled={mutation.isPending || isSubmitting || !availability.available}
            >
              {mutation.isPending || isSubmitting
                ? "recording…"
                : "record send"}
            </button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
