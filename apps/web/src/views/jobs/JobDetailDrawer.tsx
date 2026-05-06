import type { ArtifactSummary, JobDetail } from "@jobhunter/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { artifactStatusTone } from "../../contexts/materials/lib/artifact-status-tone.js";
import { ScoreReasoning } from "../../contexts/scoring/components/ScoreReasoning.js";
import { useEscapeKey } from "../../shared/hooks/useEscapeKey.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { Empty } from "../../shared/ui/empty.js";
import { Section } from "../../shared/ui/section.js";
import { StatusDot } from "../../shared/ui/status-dot.js";
import { JobDescription } from "./JobDescription.js";
import { JobOverview } from "./JobOverview.js";

export interface JobDetailDrawerProps {
  jobId: string;
}

export function JobDetailDrawer({ jobId }: JobDetailDrawerProps) {
  const ports = usePorts();
  const navigate = useNavigate();
  const search = useSearch({ from: "/jobs" });
  const close = useCallback(() => {
    void navigate({ to: "/jobs", search });
  }, [navigate, search]);
  useEscapeKey(true, close);

  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const [actionBusy, setActionBusy] = useState("");

  const loadDetail = useCallback(async () => {
    setDetail(null);
    setError("");
    try {
      setDetail(await ports.api.job(jobId));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load job.");
    }
  }, [jobId, ports.api]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const runAction = async (label: string, action: () => Promise<{ status: string }>) => {
    setActionBusy(label);
    setActionStatus("");
    setError("");
    try {
      const result = await action();
      setActionStatus(`${label} ${result.status}`);
      await loadDetail();
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : `Unable to ${label}.`,
      );
    } finally {
      setActionBusy("");
    }
  };

  const openArtifact = async (artifact: ArtifactSummary) => {
    await runAction("open artifact", async () => {
      const result = await ports.api.openArtifact(artifact.artifactId);
      return { status: result.opened ? "opened" : "failed" };
    });
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
        {error ? <Empty title={error} /> : null}
        {!detail && !error ? <Empty title="Loading job." /> : null}
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
                disabled={Boolean(actionBusy)}
                onClick={() =>
                  void runAction("retry stage", () =>
                    ports.api.retryStage(detail.job.jobKey, {
                      stage: detail.job.currentStage,
                      resetAttempts: false,
                      runAfter: false,
                      dryRun: false,
                    }),
                  )
                }
              >
                retry
              </button>
              <button
                className="tab"
                type="button"
                disabled={Boolean(actionBusy)}
                onClick={() =>
                  void runAction("apply dry-run", () =>
                    ports.api.applyJob(detail.job.jobKey, { dryRun: true }),
                  )
                }
              >
                dry-run
              </button>
              <button
                className="tab"
                type="button"
                disabled={Boolean(actionBusy)}
                onClick={() =>
                  void runAction("mark applied", () => ports.api.markApplied(detail.job.jobKey))
                }
              >
                applied
              </button>
              <button
                className="tab"
                type="button"
                disabled={Boolean(actionBusy)}
                onClick={() =>
                  void runAction("mark skipped", () => ports.api.markSkipped(detail.job.jobKey))
                }
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
                    disabled={Boolean(actionBusy) || artifact.status === "missing"}
                    title={
                      artifact.status === "missing"
                        ? "Local file is missing; regenerate this artifact before opening it."
                        : undefined
                    }
                    onClick={() => void openArtifact(artifact)}
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
