import { STAGES, STAGE_STATES } from "@jobhunter/contracts";
import { useNavigate } from "@tanstack/react-router";

import type { JobsSearch } from "../../routes/-jobs.search.js";

const STATE_OPTIONS = ["all", ...STAGE_STATES] as const;
const SCORE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export interface JobFilterBarProps {
  search: JobsSearch;
}

export function JobFilterBar({ search }: JobFilterBarProps) {
  const navigate = useNavigate({ from: "/jobs" });
  const apply = (next: Partial<JobsSearch>) => {
    void navigate({ search: (prev: JobsSearch) => ({ ...prev, page: 1, ...next }) });
  };
  const applyMinScore = (value: string) => {
    const minFitScore = value ? Number(value) : undefined;
    apply({
      minFitScore,
      maxFitScore:
        minFitScore !== undefined && search.maxFitScore !== undefined && search.maxFitScore < minFitScore
          ? undefined
          : search.maxFitScore,
    });
  };
  const applyMaxScore = (value: string) => {
    const maxFitScore = value ? Number(value) : undefined;
    apply({
      minFitScore:
        maxFitScore !== undefined && search.minFitScore !== undefined && search.minFitScore > maxFitScore
          ? undefined
          : search.minFitScore,
      maxFitScore,
    });
  };
  return (
    <div className="toolbar">
      <select
        value={search.stage}
        onChange={(event) => apply({ stage: event.target.value as JobsSearch["stage"] })}
      >
        <option value="all">all stages</option>
        {STAGES.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      <select
        value={search.state}
        onChange={(event) => apply({ state: event.target.value as JobsSearch["state"] })}
      >
        {STATE_OPTIONS.map((item) => (
          <option key={item} value={item}>
            {item} states
          </option>
        ))}
      </select>
      <select
        aria-label="Minimum fit score"
        value={search.minFitScore ?? ""}
        onChange={(event) => applyMinScore(event.target.value)}
      >
        <option value="">any score</option>
        <option value="1">scored only</option>
        {SCORE_OPTIONS.filter((score) => score > 1).map((score) => (
          <option key={score} value={score}>
            {score}+ score
          </option>
        ))}
      </select>
      <select
        aria-label="Maximum fit score"
        value={search.maxFitScore ?? ""}
        onChange={(event) => applyMaxScore(event.target.value)}
      >
        <option value="">no max score</option>
        {SCORE_OPTIONS.map((score) => (
          <option key={score} value={score}>
            {score} or below
          </option>
        ))}
      </select>
    </div>
  );
}
