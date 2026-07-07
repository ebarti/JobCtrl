import type { RunContactResearchRequest } from "@jobctl/contracts";
import { useState, type FormEvent, type JSX } from "react";

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
  const mutation = useRunResearchMutation();
  const errorMessage = mutation.error instanceof Error ? mutation.error.message : "";

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
          type="url"
          value={url}
          placeholder="https://company.example/team"
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <button type="submit" className="primary" disabled={mutation.isPending}>
        {mutation.isPending ? "starting…" : "run research"}
      </button>
      {errorMessage ? (
        <span role="alert" className="banner inline">
          {errorMessage}
        </span>
      ) : null}
    </form>
  );
}
