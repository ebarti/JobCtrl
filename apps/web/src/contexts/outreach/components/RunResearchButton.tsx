import type { RunContactResearchRequest } from "@jobctrl/contracts";
import { useId, useState, type FormEvent, type JSX } from "react";

import {
  getApiCapabilityAvailability,
  LOCAL_INSTALL_GUIDE_URL,
} from "../../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useRunResearchMutation } from "../hooks/useRunResearchMutation.js";

export interface RunResearchButtonProps {
  jobId?: string;
  employer?: string;
}

// Starts a supervised research run. A public source is fetched ONLY when the
// user supplies its URL here (per-source opt-in, INV-3); with no URL the run
// records the attempt audit and proposes nothing to auto-fetch. Login-walled
// URLs are routed to manual capture server-side, never auto-fetched.
export function RunResearchButton({ jobId, employer }: RunResearchButtonProps): JSX.Element {
  const [url, setUrl] = useState("");
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(
    featureFlags,
    "runContactResearch",
  );
  const unavailableReasonId = useId();
  const mutation = useRunResearchMutation();
  const errorMessage = mutation.error instanceof Error ? mutation.error.message : "";
  const blocked = mutation.isPending || !availability.available;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked) {
      return;
    }
    const trimmed = url.trim();
    const request: RunContactResearchRequest = {
      ...(employer ? { employer } : {}),
      ...(jobId ? { jobId } : {}),
      sources: trimmed ? [{ category: "public_web_page", url: trimmed, label: "" }] : [],
    };
    mutation.mutate(request, { onSuccess: () => setUrl("") });
  };

  return (
    <form className="run-research" onSubmit={onSubmit}>
      <label className="run-research-field">
        <span className="run-research-label">Public source URL (optional)</span>
        <input
          aria-describedby={availability.available ? undefined : unavailableReasonId}
          disabled={!availability.available}
          type="url"
          value={url}
          placeholder="https://company.example/team"
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <button
        aria-describedby={availability.available ? undefined : unavailableReasonId}
        type="submit"
        className="primary"
        disabled={blocked}
      >
        {mutation.isPending ? "starting…" : "run research"}
      </button>
      {!availability.available ? (
        <span className="meta" id={unavailableReasonId}>
          Contact research is available in the local app. This public demo does
          not fetch source URLs or process contact information. {" "}
          <a href={LOCAL_INSTALL_GUIDE_URL}>Install JobCtrl</a>.
        </span>
      ) : null}
      {errorMessage ? (
        <span role="alert" className="banner inline">
          {errorMessage}
        </span>
      ) : null}
    </form>
  );
}
