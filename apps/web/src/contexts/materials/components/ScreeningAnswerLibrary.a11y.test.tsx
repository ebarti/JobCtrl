import { fireEvent } from "@testing-library/react";
import { axe } from "jest-axe";
import { expect, it } from "vitest";
import { renderWithProviders } from "../../../test/render.js";
import { ScreeningAnswerLibrary } from "./ScreeningAnswerLibrary.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import type { ApiClientPort } from "../../../shared/ports/ApiClientPort.js";
const binding = { profileVersion: 1, profileHash: "a".repeat(64), postingHash: "b".repeat(64), destination: "https://example.test/apply", posting: "Synthetic posting", materials: [], facts: [], sensitiveFactIds: [] };
const answer = { answerId: "answer", text: "Reviewed answer", uncertainty: "", binding, question: "Question", context: "Context", determinationIds: ["a".repeat(64), "b".repeat(64), "c".repeat(64)], libraryId: null, reviewId: "review", staleReason: null };
const read: Awaited<ReturnType<ApiClientPort["screeningAnswers"]>> = { ok: true, jobId: "job-1", questions: [{ questionId: "question", jobId: "job-1", applicationId: "attempt", revision: 1, question: "Question", context: "Context", captureBinding: binding, accepted: answer, draft: answer, action: "review", snapshotId: "snapshot", recordedAt: "2026-10-08" }], history: [], library: [], facts: [], sourceBinding: binding, sourceFailure: null, determinations: [], failures: [] };

it("has no accessibility violations for sources, review and manual-use controls", async () => {
  const view = renderWithProviders(<main><ScreeningAnswerLibrary jobId="job-1" /></main>, { ports: buildTestPorts({ api: { screeningAnswers: async () => read } }) });
  fireEvent.click(view.getByRole("button", { name: "Open screening answers" }));
  await view.findByRole("button", { name: "Copy reviewed answer" });
  expect(await axe(view.container)).toHaveNoViolations();
});
