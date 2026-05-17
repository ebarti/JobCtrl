import { test, expect } from "@playwright/test";
import type { PipelineStageRunResponse, RunPipelineStagesRequest } from "@jobhunter/contracts";

const PIPELINE_JOB_KEY = "pipeline";
const SMOKE_RUN_ID = "smoke-score-run";

function queuedScoreResponse(command: RunPipelineStagesRequest): PipelineStageRunResponse {
  return {
    ok: true,
    action: "run_stage",
    status: "queued",
    jobKey: PIPELINE_JOB_KEY,
    count: 1,
    command,
    actions: [
      {
        ok: true,
        runId: SMOKE_RUN_ID,
        actionId: "smoke-score-action",
        action: "run_stage",
        status: "queued",
        jobKey: PIPELINE_JOB_KEY,
        command: {
          action: "run_stage",
          jobKey: PIPELINE_JOB_KEY,
          stage: "score",
          limit: command.limit,
          workers: command.workers,
          minScore: command.minScore,
          validationMode: command.validationMode,
          dryRun: command.dryRun,
          rescore: command.rescore,
          retailor: command.retailor,
        },
      },
    ],
  };
}

test("Pipeline action status: run-stage shows pending feedback before queued response", async ({
  page,
}) => {
  let releaseRunStageResponse!: () => void;
  const runStageResponseGate = new Promise<void>((resolve) => {
    releaseRunStageResponse = resolve;
  });

  await page.route("**/v1/pipeline/actions/run-stage", async (route) => {
    const command = route.request().postDataJSON() as RunPipelineStagesRequest;
    expect(route.request().method()).toBe("POST");
    expect(command.stages).toEqual(["score"]);

    await runStageResponseGate;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(queuedScoreResponse(command)),
    });
  });

  await page.goto("/pipelines");
  await expect(page.getByRole("heading", { name: "Pipeline actions" })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("tab", { name: "Score" }).click();
  await page.getByRole("button", { name: "Run Score" }).click();

  await expect(page.getByRole("status")).toHaveText(
    "Starting Score... waiting for local worker response.",
  );

  releaseRunStageResponse();

  await expect(page.getByRole("status")).toHaveText(
    `Score queued successfully (run ${SMOKE_RUN_ID}).`,
  );
});
