import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { useDryRunApplyMutation } from "../../contexts/apply/hooks/useDryRunApplyMutation.js";
import { artifactStatusTone } from "../../contexts/materials/lib/artifact-status-tone.js";
import { useOpenArtifactMutation } from "../../contexts/materials/hooks/useOpenArtifactMutation.js";
import { useJobDetailQuery } from "../../contexts/operations/hooks/useJobDetailQuery.js";
import type { ArtifactSummary } from "../../contexts/operations/types.js";
import { useMarkAppliedMutation } from "../../contexts/pipeline/hooks/useMarkAppliedMutation.js";
import { useMarkSkippedMutation } from "../../contexts/pipeline/hooks/useMarkSkippedMutation.js";
import { useRetryStageMutation } from "../../contexts/pipeline/hooks/useRetryStageMutation.js";
import { ScoreReasoning } from "../../contexts/scoring/components/ScoreReasoning.js";
import { useEscapeKey } from "../../shared/hooks/useEscapeKey.js";
import { Empty } from "../../shared/ui/empty.js";
import { Section } from "../../shared/ui/section.js";
import { StatusDot } from "../../shared/ui/status-dot.js";
import { JobDescription } from "./JobDescription.js";
import { JobOverview } from "./JobOverview.js";

export interface JobDetailDrawerProps {
  jobId: string;
}

export function JobDetailDrawer({ jobId }: JobDetailDrawerProps) {
  const navigate = useNavigate();
  const search = useSearch({ from: "/jobs" });
  const close = useCallback(() => {
    void navigate({ to: "/jobs", search });
  }, [navigate, search]);
  useEscapeKey(true, close);

  const { data: detail, error: detailError } = useJobDetailQuery(jobId);
  const retryStage = useRetryStageMutation();
  const dryRun = useDryRunApplyMutation();
  const markApplied = useMarkAppliedMutation();
  const markSkipped = useMarkSkippedMutation();
  const openArtifact = useOpenArtifactMutation();
  const [actionStatus, setActionStatus] = useState("");

  const errorMessage =
    detailError instanceof Error
      ? detailError.message
      : retryStage.error?.message ||
        dryRun.error?.message ||
        markApplied.error?.message ||
        markSkipped.error?.message ||
        openArtifact.error?.message ||
        "";

  const actionBusy =
    retryStage.isPending ||
    dryRun.isPending ||
    markApplied.isPending ||
    markSkipped.isPending ||
    openArtifact.isPending;

  const handleOpenArtifact = (artifact: ArtifactSummary) => {
    setActionStatus("");
    openArtifact.mutate(
      { artifactId: artifact.artifactId },
      {
        onSuccess: (result) =>
          setActionStatus(`open artifact ${result.opened ? "opened" : "failed"}`),
      },
    );
  };

  return (
    <div className="drawer-backdrop">
      <aside className="drawer">
        <button
          aria-label="Close job details"
          className="drawer-close"
          type="button"
          onClick={close}
        >
          x
        </button>
        {errorMessage ? <Empty title={errorMessage} /> : null}
        {!detail && !errorMessage ? <Empty title="Loading job." /> : null}
        {detail ? (
          <>
            <JobOverview detail={detail} />
            <div className="action-panel">
              <span>
                <b>{detail.job.nextAction || "Local actions"}</b>
                <small>
                  {detail.job.currentStage} · {detail.job.currentState}
                </small>
              </span>
              <button
                className="tab on"
                type="button"
                disabled={actionBusy}
                onClick={() => {
                  setActionStatus("");
                  retryStage.mutate(
                    {
                      jobId: detail.job.jobKey,
                      stage: detail.job.currentStage,
                      resetAttempts: false,
                      runAfter: false,
                      dryRun: false,
                    },
                    {
                      onSuccess: (result) => setActionStatus(`retry stage ${result.status}`),
                    },
                  );
                }}
              >
                retry
              </button>
              <button
                className="tab"
                type="button"
                disabled={actionBusy}
                onClick={() => {
                  setActionStatus("");
                  dryRun.mutate(
                    { jobId: detail.job.jobKey },
                    {
                      onSuccess: (result) => setActionStatus(`apply dry-run ${result.status}`),
                    },
                  );
                }}
              >
                dry-run
              </button>
              <button
                className="tab"
                type="button"
                disabled={actionBusy}
                onClick={() => {
                  setActionStatus("");
                  markApplied.mutate(
                    { jobId: detail.job.jobKey },
                    {
                      onSuccess: (result) => setActionStatus(`mark applied ${result.status}`),
                    },
                  );
                }}
              >
                applied
              </button>
              <button
                className="tab"
                type="button"
                disabled={actionBusy}
                onClick={() => {
                  setActionStatus("");
                  markSkipped.mutate(
                    { jobId: detail.job.jobKey },
                    {
                      onSuccess: (result) => setActionStatus(`mark skipped ${result.status}`),
                    },
                  );
                }}
              >
                skip
              </button>
            </div>
            {actionStatus ? <div className="status-line">{actionStatus}</div> : null}
            <div className="timeline">
              {detail.stages.map((stage) => (
                <div key={stage.stage}>
                  <StatusDot state={stage.state} />
                  <b>{stage.stage}</b>
                  <span>{stage.state}</span>
                </div>
              ))}
            </div>
            <Section title="Artifacts">
              {detail.artifacts.map((artifact) => (
                <div className="mini-row" key={artifact.artifactId}>
                  <span className={`tag ${artifactStatusTone(artifact.status)}`}>
                    {artifact.status}
                  </span>
                  <span>{artifact.type}</span>
                  <code>{artifact.localPath}</code>
                  <button
                    className="tab on"
                    type="button"
                    disabled={actionBusy || artifact.status === "missing"}
                    title={
                      artifact.status === "missing"
                        ? "Local file is missing; regenerate this artifact before opening it."
                        : undefined
                    }
                    onClick={() => handleOpenArtifact(artifact)}
                  >
                    open
                  </button>
                </div>
              ))}
            </Section>
            <Section title="Score reasoning">
              <ScoreReasoning text={detail.job.scoreReasoning} fitScore={detail.job.fitScore} />
            </Section>
            <Section title="Description">
              <JobDescription text={detail.job.descriptionPreview} />
            </Section>
          </>
        ) : null}
      </aside>
    </div>
  );
}
