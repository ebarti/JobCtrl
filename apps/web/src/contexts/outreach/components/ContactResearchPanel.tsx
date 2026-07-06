import type { ContactResearchTaskSummary } from "@jobhunter/contracts";
import { useState, type JSX } from "react";

import { Empty } from "../../../shared/ui/empty.js";
import { formatDateTime } from "../../../shared/lib/formatters.js";
import { useResearchTaskQuery } from "../hooks/useResearchTaskQuery.js";
import { useResearchTasksListQuery } from "../hooks/useResearchTasksListQuery.js";
import { researchTaskStatusLabel } from "../lib/research-copy.js";
import { CandidateReviewList } from "./CandidateReviewList.js";
import { RunResearchButton } from "./RunResearchButton.js";

export interface ContactResearchPanelProps {
  jobId?: string;
  employer?: string;
}

function ResearchTaskDetail({ taskId }: { taskId: string }): JSX.Element {
  const detailQuery = useResearchTaskQuery(taskId);
  if (detailQuery.error instanceof Error) {
    return <div className="banner inline">{detailQuery.error.message}</div>;
  }
  if (!detailQuery.data) {
    return <Empty title="Loading research candidates." />;
  }
  return <CandidateReviewList task={detailQuery.data.task} />;
}

function ResearchTaskRow({ task }: { task: ContactResearchTaskSummary }): JSX.Element {
  const [open, setOpen] = useState(task.status === "needs_review");
  return (
    <li className="research-task-row">
      <div className="research-task-head">
        <span className="tag">{researchTaskStatusLabel(task.status)}</span>
        <span className="research-task-counts">
          {task.candidateCount} proposed · {task.needsReviewCount} awaiting review
        </span>
        <span className="research-task-time">{formatDateTime(task.updatedAt ?? "")}</span>
        <button
          type="button"
          className="tab"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "hide candidates" : "review candidates"}
        </button>
      </div>
      {open ? <ResearchTaskDetail taskId={task.taskId} /> : null}
    </li>
  );
}

// Context-owned composer for the supervised-research surface: start a run, then
// review + confirm proposed candidates. Views compose this; it owns its reads
// and mutations (frontend conventions in CLAUDE.md).
export function ContactResearchPanel({ jobId, employer }: ContactResearchPanelProps): JSX.Element {
  const listQuery = useResearchTasksListQuery(jobId ? { jobId } : {});
  const tasks = listQuery.data?.items ?? [];
  const errorMessage = listQuery.error instanceof Error ? listQuery.error.message : "";

  return (
    <section className="section job-research-section" aria-label="Contact research">
      <div className="job-research-head">
        <h3>Contact research</h3>
        <RunResearchButton {...(jobId ? { jobId } : {})} {...(employer ? { employer } : {})} />
      </div>
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {tasks.length === 0 && !errorMessage ? (
        <Empty title="No research runs yet. Start one to propose contacts for review." />
      ) : (
        <ul className="research-task-list">
          {tasks.map((task) => (
            <ResearchTaskRow key={task.taskId} task={task} />
          ))}
        </ul>
      )}
    </section>
  );
}
